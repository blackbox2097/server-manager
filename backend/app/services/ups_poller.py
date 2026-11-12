# app/services/ups_poller.py
# Opsta UPS logika nezavisna od izvora (odluka 12.11.2026): scheduler tik,
# per-uredjaj poll_interval_sec, debounce SAMO za offline, upis stanja i
# metrika, audit + notify na prelazima.
#
# Izvori su adapteri (nut.py, viewpower.py, ...) sa istim ugovorom:
#     async def fetch(ups: dict) -> dict
# vraca normalizovan rezultat:
#     {"status", "replace_battery", "reason", "status_raw",
#      "metrics": {...}, "identity": {...}, "raw_vars": {...}}
# a na gresku dize izuzetak -> offline (uz debounce).

import asyncio
import json
import logging
import time

from app.config import get_settings
from app.database import fetch, fetchrow, execute
from app.services.bgtasks import create_bg_task
from app.services.monitor import scheduler
from app.services.ws_manager import ws_manager

logger = logging.getLogger(__name__)

POLL_TICK_SEC     = 5     # koliko cesto scheduler proverava koji UPS-ovi su "dospeli"
POLL_WATCHDOG_SEC = 30    # gornja granica za ceo poll jednog UPS-a (adapter + upis)
MAX_PARALLEL      = 10

_last_polled: dict[str, float] = {}
# ups_id -> {"candidate": status, "count": int} -- debounce kes, SAMO za offline
_status_pending: dict[str, dict] = {}


def _adapters() -> dict:
    """Lenji import -- adapteri ne smeju da uvoze ups_poller na nivou modula."""
    from app.services import nut, viewpower
    return {"nut": nut.fetch, "viewpower": viewpower.fetch}


def _confirm_status(ups_id: str, old_status: str | None, raw_status: str) -> str | None:
    """Vraca novi POTVRDJENI status ili None ako nema promene.
    Ne-offline statusi su autoritativni (dolaze sa samog UPS-a) -> odmah.
    Offline (izvor nedostupan) prolazi kroz debounce kao kod servera/SNMP-a."""
    uid = str(ups_id)
    if raw_status != "offline":
        _status_pending.pop(uid, None)
        return raw_status if raw_status != old_status else None

    if not old_status or old_status == "unknown":
        _status_pending.pop(uid, None)
        return raw_status
    if old_status == "offline":
        _status_pending.pop(uid, None)
        return None

    pending = _status_pending.get(uid)
    if pending and pending["candidate"] == raw_status:
        pending["count"] += 1
    else:
        pending = {"candidate": raw_status, "count": 1}
    _status_pending[uid] = pending
    if pending["count"] >= get_settings().status_debounce_polls:
        _status_pending.pop(uid, None)
        return raw_status
    return None


async def _log_status_transition(ups: dict, old_status: str, new_status: str, reason: str | None = None):
    from app.services.audit import log_event
    from app.services.notify import notify_ups_status

    is_recovery = new_status == "online" and old_status in ("warning", "on_battery", "low_battery", "offline")
    action = "ups.recovery" if is_recovery else f"ups.status_{new_status}"
    create_bg_task(log_event(
        action, tenant_id=str(ups["tenant_id"]),
        resource_type="ups", resource_id=str(ups["id"]),
        details={"name": ups["name"], "from": old_status, "to": new_status, "reason": reason},
        success=(new_status not in ("offline", "low_battery")),
        error_message=(reason if new_status != "online" else None),
    ))
    notify_ups = dict(ups)
    notify_ups["last_error"] = reason
    create_bg_task(notify_ups_status(notify_ups, old_status, new_status))


async def _broadcast(ups: dict, status: str, error: str | None):
    await ws_manager.broadcast("ups_status", {
        "upsId": str(ups["id"]), "tenantId": str(ups["tenant_id"]),
        "status": status, "error": error,
    }, tenant_id=str(ups["tenant_id"]))


async def _poll_and_save(ups: dict):
    uid = ups["id"]
    old_status = ups.get("status")
    source = ups.get("source") or "nut"
    try:
        adapter = _adapters().get(source)
        if adapter is None:
            raise ValueError(f"Nepoznat izvor: {source}")
        r = await adapter(ups)
    except Exception as e:
        err = str(e)[:500]
        logger.warning(f"UPS poll ({source}) neuspeo za {ups.get('name', uid)}: {err}")
        confirmed = _confirm_status(uid, old_status, "offline")
        display = confirmed or old_status or "offline"
        await execute("UPDATE ups_devices SET status=$1, last_error=$2 WHERE id=$3", display, err, uid)
        await _broadcast(ups, display, err)
        if confirmed and old_status and old_status not in ("offline", "unknown"):
            await _log_status_transition(ups, old_status, "offline", reason=err)
        return

    status, reason = r["status"], r.get("reason")
    confirmed = _confirm_status(uid, old_status, status)
    display = confirmed or old_status or status
    m, ident = r.get("metrics") or {}, r.get("identity") or {}

    await execute(
        """UPDATE ups_devices
           SET status=$1, ups_status_raw=$2, replace_battery=$3,
               manufacturer=$4, model=$5, firmware=$6, ups_type=$7,
               raw_vars=$8::text::jsonb, last_seen_at=NOW(), last_error=$9
           WHERE id=$10""",
        display, r.get("status_raw"), bool(r.get("replace_battery")),
        ident.get("manufacturer"), ident.get("model"), ident.get("firmware"), ident.get("ups_type"),
        json.dumps(r.get("raw_vars") or {}), reason, uid,
    )
    await execute(
        """INSERT INTO ups_metrics
             (ups_id, status, battery_charge, battery_runtime_sec, battery_voltage,
              load_percent, input_voltage, output_voltage, input_frequency, temperature)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)""",
        uid, display, m.get("battery_charge"), m.get("battery_runtime_sec"), m.get("battery_voltage"),
        m.get("load_percent"), m.get("input_voltage"), m.get("output_voltage"),
        m.get("input_frequency"), m.get("temperature"),
    )
    await _broadcast(ups, display, reason)

    if confirmed and old_status and old_status != confirmed:
        # prvi poll novog UPS-a (unknown -> online) nije dogadjaj vredan audita
        if not (old_status == "unknown" and confirmed == "online"):
            await _log_status_transition(ups, old_status, confirmed, reason=reason)


async def _poll_guarded(ups: dict):
    _last_polled[str(ups["id"])] = time.time()
    try:
        await asyncio.wait_for(_poll_and_save(ups), timeout=POLL_WATCHDOG_SEC)
    except Exception:
        logger.exception(f"UPS: neocekivana greska za {ups.get('name', ups.get('id'))}")


async def poll_ups_all():
    try:
        rows = await fetch("SELECT * FROM ups_devices WHERE active=true ORDER BY tenant_id, id")
    except Exception as e:
        logger.error(f"UPS: greska dohvatanja uredjaja: {e}")
        return
    if not rows:
        return
    now = time.time()
    due = []
    for r in rows:
        last = _last_polled.get(str(r["id"]))
        if last is None or (now - last) >= r["poll_interval_sec"]:
            due.append(dict(r))
    for i in range(0, len(due), MAX_PARALLEL):
        await asyncio.gather(*[_poll_guarded(u) for u in due[i:i + MAX_PARALLEL]],
                             return_exceptions=True)


async def poll_ups_single(ups_id: str):
    row = await fetchrow("SELECT * FROM ups_devices WHERE id=$1 AND active=true", ups_id)
    if not row:
        raise ValueError("UPS nije pronadjen")
    await _poll_guarded(dict(row))
    return {"ok": True}


def start():
    scheduler.add_job(poll_ups_all, "interval", seconds=POLL_TICK_SEC, id="ups_poll")
    logger.info(f"UPS monitoring pokrenut (tick: {POLL_TICK_SEC}s, izvori: {', '.join(_adapters())})")
