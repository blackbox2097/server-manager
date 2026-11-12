# app/services/nut.py
# UPS monitoring preko NUT protokola (Network UPS Tools, TCP 3493).
# Prva faza UPS feature-a (9.11.2026): samo NUT izvor -- tipicno Synology/QNAP
# NAS ili Linux server sa USB UPS-om koji izlaze NUT server.
#
# Isti operativni obrazac kao snmp.py: scheduler tik + per-uredjaj
# poll_interval_sec, ograniceni paralelizam. Debounce SAMO za offline
# (NUT nedostupan) -- promene ups.status (OB/LB/RB...) su autoritativne
# i primenjuju se odmah.
#
# Async-native preko asyncio.open_connection -- nema executora. Socket se
# UVEK zatvara u finally (lekcija iz SNMP FD leak incidenta 11.8.2026).

import asyncio
import json
import logging
import re
import time

from app.config import get_settings
from app.database import fetch, fetchrow, execute
from app.services.bgtasks import create_bg_task
from app.services.crypto import decrypt
from app.services.monitor import scheduler
from app.services.ws_manager import ws_manager

logger = logging.getLogger(__name__)

NUT_TICK_SEC     = 5    # koliko cesto scheduler proverava koji UPS-ovi su "dospeli"
NUT_TIMEOUT_SEC  = 10   # cela NUT sesija (connect + LIST VAR)
NUT_MAX_PARALLEL = 10

_last_polled: dict[str, float] = {}
# ups_id -> {"candidate": status, "count": int} -- debounce kes, SAMO za offline
_status_pending: dict[str, dict] = {}

_VAR_RE = re.compile(r'^VAR\s+\S+\s+(\S+)\s+"((?:[^"\\]|\\.)*)"$')
_UNESCAPE_RE = re.compile(r'\\(.)')

STATUS_REASON = {
    "on_battery":  "Na bateriji",
    "low_battery": "PRAZNA BATERIJA",
}
WARNING_TOKENS = {"RB": "Zameni bateriju", "OVER": "Preopterecenje", "BYPASS": "Bypass rezim"}


class NUTError(Exception):
    pass


async def nut_list_vars(host: str, port: int, ups_name: str,
                        username: str | None = None, password: str | None = None,
                        timeout: int = NUT_TIMEOUT_SEC) -> dict[str, str]:
    """Jedna NUT sesija: (opciono USERNAME/PASSWORD) + LIST VAR <ups>.
    Vraca dict promenljiva -> vrednost. Socket se zatvara u finally."""

    async def _session() -> dict[str, str]:
        reader, writer = await asyncio.open_connection(host, port)
        try:
            async def cmd(line: str) -> str:
                writer.write((line + "\n").encode())
                await writer.drain()
                return (await reader.readline()).decode(errors="replace").strip()

            if username:
                r = await cmd(f"USERNAME {username}")
                if not r.startswith("OK"):
                    raise NUTError(f"USERNAME: {r}")
                r = await cmd(f"PASSWORD {password or ''}")
                if not r.startswith("OK"):
                    raise NUTError(f"PASSWORD: {r}")

            first = await cmd(f"LIST VAR {ups_name}")
            if first.startswith("ERR"):
                raise NUTError(first)
            if not first.startswith("BEGIN LIST VAR"):
                raise NUTError(f"Neocekivan odgovor: {first[:100]}")

            out: dict[str, str] = {}
            while True:
                raw = await reader.readline()
                if not raw:
                    raise NUTError("Konekcija prekinuta usred liste")
                s = raw.decode(errors="replace").strip()
                if s.startswith("END LIST VAR"):
                    break
                m = _VAR_RE.match(s)
                if m:
                    out[m.group(1)] = _UNESCAPE_RE.sub(r"\1", m.group(2))
            try:
                writer.write(b"LOGOUT\n")
                await writer.drain()
            except Exception:
                pass
            return out
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    try:
        return await asyncio.wait_for(_session(), timeout=timeout)
    except asyncio.TimeoutError:
        raise NUTError(f"Timeout ({timeout}s)")
    except OSError as e:
        raise NUTError(f"Konekcija neuspesna: {e}")


def derive_status(vars_: dict[str, str]) -> tuple[str, bool, str | None]:
    """ups.status tokeni -> (status, replace_battery, razlog). Prioritet:
    LB > OB > RB/OVER/BYPASS > OL. Nepoznat/prazan status -> warning."""
    tokens = set((vars_.get("ups.status") or "").split())
    replace = "RB" in tokens
    if "LB" in tokens:
        return "low_battery", replace, STATUS_REASON["low_battery"]
    if "OB" in tokens:
        return "on_battery", replace, STATUS_REASON["on_battery"]
    warn = [txt for tok, txt in WARNING_TOKENS.items() if tok in tokens]
    if warn:
        return "warning", replace, ", ".join(warn)
    if "OL" in tokens:
        return "online", replace, None
    return "warning", replace, f"Nepoznat ups.status: {vars_.get('ups.status') or '(prazno)'}"


def _num(vars_: dict[str, str], key: str) -> float | None:
    v = vars_.get(key)
    if v is None or v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def extract_metrics(vars_: dict[str, str]) -> dict:
    tokens = set((vars_.get("ups.status") or "").split())
    charge = _num(vars_, "battery.charge")
    # Sanity: neki drajveri (npr. nutdrv_qx/Megatec) javljaju napon po celiji,
    # pa izracunaju charge=0 iako je baterija puna. 0 uz OL bez LB = nepouzdano.
    if charge == 0 and "OL" in tokens and "LB" not in tokens:
        charge = None
    runtime = _num(vars_, "battery.runtime")
    return {
        "battery_charge":      charge,
        "battery_runtime_sec": int(runtime) if runtime is not None else None,
        "battery_voltage":     _num(vars_, "battery.voltage"),
        "load_percent":        _num(vars_, "ups.load"),
        "input_voltage":       _num(vars_, "input.voltage"),
        "output_voltage":      _num(vars_, "output.voltage"),
        "input_frequency":     _num(vars_, "input.frequency"),
        "temperature":         _num(vars_, "ups.temperature") or _num(vars_, "battery.temperature"),
    }


def _confirm_status(ups_id: str, old_status: str | None, raw_status: str) -> str | None:
    """Vraca novi POTVRDJENI status ili None ako nema promene.
    Ne-offline statusi su autoritativni (dolaze sa samog UPS-a) -> odmah.
    Offline (NUT nedostupan) prolazi kroz debounce kao kod servera/SNMP-a."""
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

    is_recovery = new_status == "online" and old_status in ("warning", "on_battery", "low_battery", "offline")
    action = "ups.recovery" if is_recovery else f"ups.status_{new_status}"
    create_bg_task(log_event(
        action, tenant_id=str(ups["tenant_id"]),
        resource_type="ups", resource_id=str(ups["id"]),
        details={"name": ups["name"], "from": old_status, "to": new_status, "reason": reason},
        success=(new_status not in ("offline", "low_battery")),
        error_message=(reason if new_status != "online" else None),
    ))

    try:
        from app.services.notify import notify_ups_status
    except ImportError:
        notify_ups_status = None
    if notify_ups_status:
        notify_ups = dict(ups)
        notify_ups["last_error"] = reason
        create_bg_task(notify_ups_status(notify_ups, old_status, new_status))
    else:
        logger.info(f"UPS {ups['name']}: {old_status} -> {new_status} (notify_ups_status jos nije implementiran)")


async def _broadcast(ups: dict, status: str, error: str | None):
    await ws_manager.broadcast("ups_status", {
        "upsId": str(ups["id"]), "tenantId": str(ups["tenant_id"]),
        "status": status, "error": error,
    }, tenant_id=str(ups["tenant_id"]))


async def _poll_and_save(ups: dict):
    uid = ups["id"]
    old_status = ups.get("status")
    try:
        pw = decrypt(ups["password_enc"]) if ups.get("password_enc") else None
        vars_ = await nut_list_vars(ups["host"], ups["port"], ups["device_name"],
                                    ups.get("username"), pw)
    except Exception as e:
        err = str(e)[:500]
        logger.warning(f"NUT poll neuspeo za {ups.get('name', uid)}: {err}")
        confirmed = _confirm_status(uid, old_status, "offline")
        display = confirmed or old_status or "offline"
        await execute("UPDATE ups_devices SET status=$1, last_error=$2 WHERE id=$3", display, err, uid)
        await _broadcast(ups, display, err)
        if confirmed and old_status and old_status not in ("offline", "unknown"):
            await _log_status_transition(ups, old_status, "offline", reason=err)
        return

    status, replace_battery, reason = derive_status(vars_)
    confirmed = _confirm_status(uid, old_status, status)
    display = confirmed or old_status or status
    m = extract_metrics(vars_)

    await execute(
        """UPDATE ups_devices
           SET status=$1, ups_status_raw=$2, replace_battery=$3,
               manufacturer=$4, model=$5, firmware=$6, ups_type=$7,
               raw_vars=$8::text::jsonb, last_seen_at=NOW(), last_error=$9
           WHERE id=$10""",
        display, vars_.get("ups.status"), replace_battery,
        vars_.get("device.mfr") or vars_.get("ups.mfr"),
        vars_.get("device.model") or vars_.get("ups.model"),
        vars_.get("ups.firmware"), vars_.get("ups.type"),
        json.dumps(vars_), reason, uid,
    )
    await execute(
        """INSERT INTO ups_metrics
             (ups_id, status, battery_charge, battery_runtime_sec, battery_voltage,
              load_percent, input_voltage, output_voltage, input_frequency, temperature)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)""",
        uid, display, m["battery_charge"], m["battery_runtime_sec"], m["battery_voltage"],
        m["load_percent"], m["input_voltage"], m["output_voltage"], m["input_frequency"], m["temperature"],
    )
    await _broadcast(ups, display, reason)

    if confirmed and old_status and old_status != confirmed:
        # prvi poll novog UPS-a (unknown -> online) nije dogadjaj vredan audita
        if not (old_status == "unknown" and confirmed == "online"):
            await _log_status_transition(ups, old_status, confirmed, reason=reason)


async def _poll_guarded(ups: dict):
    _last_polled[str(ups["id"])] = time.time()
    try:
        await asyncio.wait_for(_poll_and_save(ups), timeout=NUT_TIMEOUT_SEC * 3)
    except Exception:
        logger.exception(f"NUT: neocekivana greska za {ups.get('name', ups.get('id'))}")


async def poll_ups_all():
    try:
        rows = await fetch("SELECT * FROM ups_devices WHERE active=true ORDER BY tenant_id, id")
    except Exception as e:
        logger.error(f"NUT: greska dohvatanja UPS uredjaja: {e}")
        return
    if not rows:
        return
    now = time.time()
    due = []
    for r in rows:
        last = _last_polled.get(str(r["id"]))
        if last is None or (now - last) >= r["poll_interval_sec"]:
            due.append(dict(r))
    for i in range(0, len(due), NUT_MAX_PARALLEL):
        await asyncio.gather(*[_poll_guarded(u) for u in due[i:i + NUT_MAX_PARALLEL]],
                             return_exceptions=True)


async def poll_ups_single(ups_id: str):
    row = await fetchrow("SELECT * FROM ups_devices WHERE id=$1 AND active=true", ups_id)
    if not row:
        raise ValueError("UPS nije pronadjen")
    await _poll_guarded(dict(row))
    return {"ok": True}


def start():
    scheduler.add_job(poll_ups_all, "interval", seconds=NUT_TICK_SEC, id="nut_poll")
    logger.info(f"NUT (UPS) monitoring pokrenut (tick: {NUT_TICK_SEC}s)")
