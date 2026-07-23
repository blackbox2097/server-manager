# app/services/monitor.py
import asyncio, logging, time
from datetime import datetime, timezone
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from app.config import get_settings
from app.database import fetch, fetchrow, execute
from app.services.crypto import decrypt
from app.services.ws_manager import ws_manager

logger    = logging.getLogger(__name__)
scheduler = AsyncIOScheduler()

# Memorijski kes za racunanje mrezne brzine (rx/tx su kumulativni brojaci
# od pokretanja mrezne kartice, pa nam treba razlika kroz vreme da dobijemo B/s)
# server_id -> {"rx": int, "tx": int, "ts": float}
_net_prev: dict[str, dict] = {}

# Debounce kes za promene statusa — izbegava "flapping" alarme za kratke skokove.
# Promena statusa se potvrdjuje tek posle N uzastopnih poll-ova sa istim novim stanjem.
# server_id -> {"candidate": status_str, "count": int}
_status_pending: dict[str, dict] = {}


def _net_rate(server_id: str, rx_bytes: int, tx_bytes: int) -> tuple[float, float]:
    """Vrati (rx_kbps, tx_kbps) na osnovu razlike od prethodnog poll-a."""
    now  = time.time()
    prev = _net_prev.get(server_id)
    _net_prev[server_id] = {"rx": rx_bytes, "tx": tx_bytes, "ts": now}

    if not prev:
        return 0.0, 0.0

    elapsed = now - prev["ts"]
    if elapsed <= 0:
        return 0.0, 0.0

    rx_delta = max(0, rx_bytes - prev["rx"])
    tx_delta = max(0, tx_bytes - prev["tx"])

    rx_kbps = round((rx_delta / 1024) / elapsed, 2)
    tx_kbps = round((tx_delta / 1024) / elapsed, 2)
    return rx_kbps, tx_kbps


def _confirm_status(server_id, old_status: str | None, raw_status: str) -> str | None:
    """Debounce logika za promenu statusa.
    Vraca POTVRDJEN novi status ako je promena potvrdjena ovim poll-om
    (raw_status se ponovio dovoljno puta zaredom), ili None ako:
      - nema promene u odnosu na trenutni potvrdjeni status, ili
      - promena je jos u toku potvrdjivanja (treba jos poll-ova).
    Prva klasifikacija servera (old_status prazan/unknown) se potvrdjuje odmah."""
    sid = str(server_id)
    cfg = get_settings()

    if not old_status or old_status == "unknown":
        _status_pending.pop(sid, None)
        return raw_status

    if raw_status == old_status:
        _status_pending.pop(sid, None)
        return None

    pending = _status_pending.get(sid)
    if pending and pending["candidate"] == raw_status:
        pending["count"] += 1
    else:
        pending = {"candidate": raw_status, "count": 1}
    _status_pending[sid] = pending

    if pending["count"] >= cfg.status_debounce_polls:
        _status_pending.pop(sid, None)
        return raw_status
    return None


async def _log_status_transition(srv: dict, old_status: str, new_status: str,
                                  metrics: dict | None = None, error: str | None = None):
    """Upisuje potvrdjenu promenu statusa u audit log i salje email notifikaciju.
    Jasno razlikuje POCETAK problema (status_warning/status_offline) od
    KRAJA problema (recovery), ukljucujuci trajanje incidenta kad je poznato."""
    from app.services.audit import log_event
    from app.services.notify import notify_server_status

    is_recovery = new_status == "online" and old_status in ("warning", "offline")
    action = "server.recovery" if is_recovery else f"server.status_{new_status}"

    details = {"name": srv["name"], "from": old_status, "to": new_status}
    if metrics:
        details["cpuPercent"]  = metrics["cpuPercent"]
        details["ramPercent"]  = metrics["ramPercent"]
        details["diskPercent"] = metrics["diskPercent"]

    if is_recovery:
        incident_start = await fetchrow(
            """SELECT occurred_at FROM audit_log
               WHERE resource_id=$1 AND action IN ('server.status_warning','server.status_offline')
               ORDER BY occurred_at DESC LIMIT 1""",
            str(srv["id"])
        )
        if incident_start:
            duration = (datetime.now(timezone.utc) - incident_start["occurred_at"]).total_seconds()
            details["durationSeconds"] = round(duration)

    asyncio.create_task(log_event(
        action, tenant_id=str(srv["tenant_id"]),
        resource_type="server", resource_id=str(srv["id"]),
        details=details, success=(new_status != "offline"), error_message=error
    ))

    notify_srv = dict(srv)
    if error:
        notify_srv["last_error"] = error
    asyncio.create_task(notify_server_status(notify_srv, old_status, new_status))


async def _poll(server: dict):
    srv = dict(server)
    old_status = srv.get("status")  # POTVRDJEN status pre ovog poll-a
    if srv.get("private_key_enc"): srv["_private_key"]    = decrypt(srv["private_key_enc"])
    if srv.get("ssh_password"):    srv["_ssh_password"]   = decrypt(srv["ssh_password"])
    if srv.get("sudo_password"):   srv["_sudo_password"]  = decrypt(srv["sudo_password"])
    if srv.get("winrm_password"):  srv["_winrm_password"] = decrypt(srv["winrm_password"])
    try:
        if srv["os_type"] == "windows":
            from app.services.winrm import get_metrics
        else:
            from app.services.ssh import get_metrics
        m = await get_metrics(srv)
        high = m["cpuPercent"] >= 90 or m["ramPercent"] >= 90 or m["diskPercent"] >= 90
        raw_status = "warning" if high else "online"

        rx_kbps, tx_kbps = _net_rate(
            str(srv["id"]), m.get("netRxBytes", 0), m.get("netTxBytes", 0)
        )

        # Sirove metrike se UVEK upisuju, bez obzira na debounce statusa
        await execute(
            """INSERT INTO metrics
                 (server_id, cpu_percent, ram_percent, disk_percent, uptime_seconds,
                  load_avg_1m, load_avg_5m, load_avg_15m,
                  net_rx_kbps, net_tx_kbps, process_count, disks)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)""",
            srv["id"], m["cpuPercent"], m["ramPercent"], m["diskPercent"],
            m["uptimeSeconds"], m.get("loadAvg1m"), m.get("loadAvg5m"), m.get("loadAvg15m"),
            rx_kbps, tx_kbps, m.get("processCount"), m.get("disks") or [],
        )

        confirmed = _confirm_status(srv["id"], old_status, raw_status)
        display_status = confirmed or old_status or raw_status

        await execute(
            "UPDATE servers SET status=$1, last_seen_at=NOW(), last_error=NULL, os_name=COALESCE($2,os_name) WHERE id=$3",
            display_status, m.get("osName"), srv["id"]
        )
        await ws_manager.broadcast("metrics", {
            "serverId": str(srv["id"]), "tenantId": str(srv["tenant_id"]),
            "status": display_status,
            "metrics": {"cpu": m["cpuPercent"], "ram": m["ramPercent"],
                        "disk": m["diskPercent"], "disks": m.get("disks") or [],
                        "uptime": m["uptimeSeconds"],
                        "netRxKbps": rx_kbps, "netTxKbps": tx_kbps,
                        "processCount": m.get("processCount")},
        }, tenant_id=str(srv["tenant_id"]))

        if confirmed and old_status and old_status != confirmed:
            await _log_status_transition(srv, old_status, confirmed, metrics=m)
    except Exception as e:
        err = str(e)[:500]
        confirmed = _confirm_status(srv["id"], old_status, "offline")
        display_status = confirmed or old_status or "offline"

        await execute("UPDATE servers SET status=$1, last_error=$2 WHERE id=$3", display_status, err, srv["id"])
        await ws_manager.broadcast("metrics", {
            "serverId": str(srv["id"]), "tenantId": str(srv["tenant_id"]),
            "status": display_status, "error": err,
        }, tenant_id=str(srv["tenant_id"]))
        logger.warning(f"Poll neuspjesan: {srv['name']} - {err}")

        if confirmed and old_status and old_status != "offline":
            await _log_status_transition(srv, old_status, "offline", error=err)


async def poll_all():
    cfg = get_settings()
    try:
        rows = await fetch(
            """SELECT s.*, sk.private_key_enc, sk.key_file_path
               FROM servers s LEFT JOIN ssh_keys sk ON sk.id=s.ssh_key_id
               WHERE s.active=true ORDER BY s.tenant_id, s.id"""
        )
    except Exception as e:
        logger.error(f"Greska dohvatanja servera: {e}")
        return
    if not rows:
        return
    mp = cfg.monitor_max_parallel
    for i in range(0, len(rows), mp):
        await asyncio.gather(*[_poll(dict(r)) for r in rows[i:i+mp]], return_exceptions=True)


async def poll_single(server_id: str):
    rows = await fetch(
        """SELECT s.*, sk.private_key_enc, sk.key_file_path
           FROM servers s LEFT JOIN ssh_keys sk ON sk.id=s.ssh_key_id
           WHERE s.id=$1 AND s.active=true""", server_id)
    if not rows:
        raise ValueError("Server nije pronadjen")
    await _poll(dict(rows[0]))
    return {"ok": True}


async def cleanup_metrics():
    cfg = get_settings()
    r = await execute(f"DELETE FROM metrics WHERE collected_at < NOW() - INTERVAL '{cfg.metrics_retention_days} days'")
    logger.info(f"Metrike ociscene: {r}")


async def get_latest(tenant_id: str) -> list:
    rows = await fetch(
        """SELECT s.id, s.name, s.hostname, s.ip_address, s.os_type, s.os_name,
                  s.status, s.last_seen_at, s.last_error, s.tags, s.environment,
                  m.cpu_percent, m.ram_percent, m.disk_percent, m.disks,
                  m.uptime_seconds, m.load_avg_1m, m.collected_at AS metric_at,
                  m.net_rx_kbps, m.net_tx_kbps, m.process_count
           FROM servers s
           LEFT JOIN LATERAL (
               SELECT cpu_percent, ram_percent, disk_percent, disks, uptime_seconds, load_avg_1m,
                      collected_at, net_rx_kbps, net_tx_kbps, process_count
               FROM metrics WHERE server_id=s.id ORDER BY collected_at DESC LIMIT 1
           ) m ON true
           WHERE s.tenant_id=$1 AND s.active=true ORDER BY s.os_type, s.name""", tenant_id)
    return [dict(r) for r in rows]


async def get_history(server_id: str, limit: int = 60) -> list:
    rows = await fetch(
        """SELECT collected_at, cpu_percent, ram_percent, disk_percent,
                  uptime_seconds, load_avg_1m, net_rx_kbps, net_tx_kbps, process_count
           FROM metrics WHERE server_id=$1 ORDER BY collected_at DESC LIMIT $2""",
        server_id, min(limit, 1440))
    return [dict(r) for r in reversed(rows)]


def start():
    cfg = get_settings()
    if not cfg.module_monitoring:
        logger.info("Monitoring ISKLJUCEN")
        return
    scheduler.add_job(poll_all, "interval", seconds=cfg.monitor_interval_sec, id="poll")
    scheduler.add_job(cleanup_metrics, "cron", hour=3, minute=0, id="cleanup")

    from app.services.audit import cleanup_old_logs
    scheduler.add_job(cleanup_old_logs, "cron", hour=3, minute=15, id="cleanup_logs")
    scheduler.start()
    logger.info(f"Monitoring pokrenut (interval: {cfg.monitor_interval_sec}s, debounce: {cfg.status_debounce_polls} poll-a)")
    asyncio.get_event_loop().create_task(poll_all())
