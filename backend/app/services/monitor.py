# app/services/monitor.py
import asyncio, logging, time
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from app.config import get_settings
from app.database import fetch, execute
from app.services.crypto import decrypt
from app.services.ws_manager import ws_manager

logger    = logging.getLogger(__name__)
scheduler = AsyncIOScheduler()

# Memorijski kes za racunanje mrezne brzine (rx/tx su kumulativni brojaci
# od pokretanja mrezne kartice, pa nam treba razlika kroz vreme da dobijemo B/s)
# server_id -> {"rx": int, "tx": int, "ts": float}
_net_prev: dict[str, dict] = {}


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

    # Ako je brojac resetovan (npr. restart mreznog interfejsa), izbegni negativnu brzinu
    rx_delta = max(0, rx_bytes - prev["rx"])
    tx_delta = max(0, tx_bytes - prev["tx"])

    rx_kbps = round((rx_delta / 1024) / elapsed, 2)
    tx_kbps = round((tx_delta / 1024) / elapsed, 2)
    return rx_kbps, tx_kbps


async def _poll(server: dict):
    srv = dict(server)
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
        status = "warning" if high else "online"

        rx_kbps, tx_kbps = _net_rate(
            str(srv["id"]), m.get("netRxBytes", 0), m.get("netTxBytes", 0)
        )

        await execute(
            """INSERT INTO metrics
                 (server_id, cpu_percent, ram_percent, disk_percent, uptime_seconds,
                  load_avg_1m, load_avg_5m, load_avg_15m,
                  net_rx_kbps, net_tx_kbps, process_count)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)""",
            srv["id"], m["cpuPercent"], m["ramPercent"], m["diskPercent"],
            m["uptimeSeconds"], m.get("loadAvg1m"), m.get("loadAvg5m"), m.get("loadAvg15m"),
            rx_kbps, tx_kbps, m.get("processCount"),
        )
        await execute(
            "UPDATE servers SET status=$1, last_seen_at=NOW(), last_error=NULL, os_name=COALESCE($2,os_name) WHERE id=$3",
            status, m.get("osName"), srv["id"]
        )
        await ws_manager.broadcast("metrics", {
            "serverId": str(srv["id"]), "tenantId": str(srv["tenant_id"]),
            "status": status,
            "metrics": {"cpu": m["cpuPercent"], "ram": m["ramPercent"],
                        "disk": m["diskPercent"], "uptime": m["uptimeSeconds"],
                        "netRxKbps": rx_kbps, "netTxKbps": tx_kbps,
                        "processCount": m.get("processCount")},
        }, tenant_id=str(srv["tenant_id"]))
    except Exception as e:
        err = str(e)[:500]
        await execute("UPDATE servers SET status='offline', last_error=$1 WHERE id=$2", err, srv["id"])
        await ws_manager.broadcast("metrics", {
            "serverId": str(srv["id"]), "tenantId": str(srv["tenant_id"]),
            "status": "offline", "error": err,
        }, tenant_id=str(srv["tenant_id"]))
        logger.warning(f"Poll neuspjesan: {srv['name']} - {err}")


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
                  m.cpu_percent, m.ram_percent, m.disk_percent,
                  m.uptime_seconds, m.load_avg_1m, m.collected_at AS metric_at,
                  m.net_rx_kbps, m.net_tx_kbps, m.process_count
           FROM servers s
           LEFT JOIN LATERAL (
               SELECT cpu_percent, ram_percent, disk_percent, uptime_seconds, load_avg_1m,
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
    scheduler.start()
    logger.info(f"Monitoring pokrenut (interval: {cfg.monitor_interval_sec}s)")
    asyncio.get_event_loop().create_task(poll_all())
