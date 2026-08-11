# app/services/snmp.py
# SNMP monitoring mreznih uredjaja -- prvi krug univerzalni MIB-ovi
# (IF-MIB, SNMPv2-MIB). Isti operativni pattern kao monitor.py za servere:
# per-uredjaj interval gating, watchdog timeout, ograniceni paralelizam,
# in-memory kes za racunanje kbps/delta brojaca izmedju pollova.
#
# SNMP je async-native preko pysnmp (v3arch.asyncio) -- za razliku od SSH
# (paramiko, sinhron, treba ThreadPoolExecutor) ovde NIJE potreban executor.

import asyncio
import logging
import time

from pysnmp.hlapi.v3arch.asyncio import (
    SnmpEngine, CommunityData, UsmUserData, UdpTransportTarget, ContextData,
    ObjectType, ObjectIdentity, get_cmd, bulk_walk_cmd,
    usmHMACMD5AuthProtocol, usmHMACSHAAuthProtocol,
    usmHMAC128SHA224AuthProtocol, usmHMAC192SHA256AuthProtocol,
    usmHMAC256SHA384AuthProtocol, usmHMAC384SHA512AuthProtocol,
    usmDESPrivProtocol, usm3DESEDEPrivProtocol,
    usmAesCfb128Protocol, usmAesCfb192Protocol, usmAesCfb256Protocol,
    usmNoAuthProtocol, usmNoPrivProtocol,
)

from app.config import get_settings
from app.database import fetch, fetchrow, execute
from app.services.crypto import decrypt
from app.services.monitor import scheduler

logger = logging.getLogger(__name__)

# device_id -> vreme (time.time()) poslednjeg POKUSAJA poll-a (uspesnog ili ne)
_last_polled: dict[str, float] = {}

# "device_id:if_index" -> {"in": int, "out": int, "in_err": int, "out_err": int,
#                           "in_disc": int, "out_disc": int, "ts": float}
# -- za racunanje kbps i delta brojaca izmedju uzastopnih pollova (isti duh
# kao monitor._net_prev za servere; resetuje se na restart aplikacije, sto
# je prihvatljivo -- prvi poll posle restarta jednostavno vraca 0 za rate).
_iface_prev: dict[str, dict] = {}

IF_TABLE_OID  = "1.3.6.1.2.1.2.2.1"    # ifTable   (32-bit brojaci, univerzalno)
IF_XTABLE_OID = "1.3.6.1.2.1.31.1.1.1"  # ifXTable (64-bit HC brojaci, ifName/ifAlias)
SYS_DESCR_OID   = "1.3.6.1.2.1.1.1.0"
SYS_UPTIME_OID  = "1.3.6.1.2.1.1.3.0"

IF_COLUMNS = {
    "ifDescr":       f"{IF_TABLE_OID}.2",
    "ifType":        f"{IF_TABLE_OID}.3",
    "ifSpeed":       f"{IF_TABLE_OID}.5",
    "ifPhysAddress": f"{IF_TABLE_OID}.6",
    "ifAdminStatus": f"{IF_TABLE_OID}.7",
    "ifOperStatus":  f"{IF_TABLE_OID}.8",
    "ifInOctets":    f"{IF_TABLE_OID}.10",
    "ifInDiscards":  f"{IF_TABLE_OID}.13",
    "ifInErrors":    f"{IF_TABLE_OID}.14",
    "ifOutOctets":   f"{IF_TABLE_OID}.16",
    "ifOutDiscards": f"{IF_TABLE_OID}.19",
    "ifOutErrors":   f"{IF_TABLE_OID}.20",
}
IFX_COLUMNS = {
    "ifName":        f"{IF_XTABLE_OID}.1",
    "ifHCInOctets":  f"{IF_XTABLE_OID}.6",
    "ifHCOutOctets": f"{IF_XTABLE_OID}.10",
    "ifHighSpeed":   f"{IF_XTABLE_OID}.15",   # Mbps
    "ifAlias":       f"{IF_XTABLE_OID}.18",
}

OPER_STATUS_MAP = {
    1: "up", 2: "down", 3: "testing", 4: "unknown",
    5: "dormant", 6: "notPresent", 7: "lowerLayerDown",
}
ADMIN_STATUS_MAP = {1: "up", 2: "down", 3: "testing"}

_AUTH_PROTOCOLS = {
    "MD5": usmHMACMD5AuthProtocol, "SHA": usmHMACSHAAuthProtocol,
    "SHA224": usmHMAC128SHA224AuthProtocol, "SHA256": usmHMAC192SHA256AuthProtocol,
    "SHA384": usmHMAC256SHA384AuthProtocol, "SHA512": usmHMAC384SHA512AuthProtocol,
}
_PRIV_PROTOCOLS = {
    "DES": usmDESPrivProtocol, "3DES": usm3DESEDEPrivProtocol,
    "AES": usmAesCfb128Protocol, "AES128": usmAesCfb128Protocol,
    "AES192": usmAesCfb192Protocol, "AES256": usmAesCfb256Protocol,
}


# device_id -> {"candidate": status_str, "count": int} -- debounce kes,
# isti duh kao monitor._status_pending za servere (izbegava flapping alarme).
_status_pending: dict[str, dict] = {}


def _confirm_status(device_id: str, old_status: str | None, raw_status: str) -> str | None:
    """Identicna logika kao monitor._confirm_status, samo odvojen kes (_status_pending
    iznad) da SNMP i server debounce ne dele stanje -- razlicite skale poll intervala."""
    cfg = get_settings()
    did = str(device_id)

    if not old_status or old_status == "unknown":
        _status_pending.pop(did, None)
        return raw_status

    if raw_status == old_status:
        _status_pending.pop(did, None)
        return None

    pending = _status_pending.get(did)
    if pending and pending["candidate"] == raw_status:
        pending["count"] += 1
    else:
        pending = {"candidate": raw_status, "count": 1}
    _status_pending[did] = pending

    if pending["count"] >= cfg.status_debounce_polls:
        _status_pending.pop(did, None)
        return raw_status
    return None


async def _log_status_transition(device: dict, old_status: str, new_status: str, error: str | None = None):
    from app.services.audit import log_event
    from app.services.notify import notify_network_device_status

    is_recovery = new_status == "online" and old_status in ("warning", "offline")
    action = "networkdevice.recovery" if is_recovery else f"networkdevice.status_{new_status}"

    asyncio.create_task(log_event(
        action, tenant_id=str(device["tenant_id"]),
        resource_type="network_device", resource_id=str(device["id"]),
        details={"name": device["name"], "from": old_status, "to": new_status},
        success=(new_status != "offline"), error_message=error,
    ))

    notify_dev = dict(device)
    if error:
        notify_dev["last_error"] = error
    asyncio.create_task(notify_network_device_status(notify_dev, old_status, new_status))


class SNMPError(Exception):
    pass


def _build_auth(device: dict):
    if device["snmp_version"] == "v3":
        auth_pw = decrypt(device["v3_auth_password_enc"]) if device.get("v3_auth_password_enc") else None
        priv_pw = decrypt(device["v3_priv_password_enc"]) if device.get("v3_priv_password_enc") else None
        auth_proto = _AUTH_PROTOCOLS.get(device.get("v3_auth_protocol"), usmNoAuthProtocol)
        priv_proto = _PRIV_PROTOCOLS.get(device.get("v3_priv_protocol"), usmNoPrivProtocol)
        kwargs = {}
        if auth_pw:
            kwargs["authKey"] = auth_pw
            kwargs["authProtocol"] = auth_proto
        if priv_pw:
            kwargs["privKey"] = priv_pw
            kwargs["privProtocol"] = priv_proto
        return UsmUserData(device["v3_username"], **kwargs)
    community = decrypt(device["community_enc"]) if device.get("community_enc") else "public"
    return CommunityData(community)


async def _walk_column(engine, target, auth, base_oid: str) -> dict[int, object]:
    result: dict[int, object] = {}
    objects = bulk_walk_cmd(
        engine, auth, target, ContextData(),
        0, 25,
        ObjectType(ObjectIdentity(base_oid)),
        lexicographicMode=False,
    )
    async for err_indication, err_status, err_index, var_binds in objects:
        if err_indication:
            raise SNMPError(str(err_indication))
        if err_status:
            raise SNMPError(f"{err_status.prettyPrint()} at {err_index}")
        for vb in var_binds:
            oid_str = str(vb[0])
            if not oid_str.startswith(base_oid + "."):
                continue  # izasli smo iz kolone (kraj tabele)
            if_index = int(oid_str.rsplit(".", 1)[-1])
            result[if_index] = vb[1]
    return result


def _fmt_mac(raw) -> str | None:
    try:
        octets = raw.asOctets()
        if not octets or len(octets) != 6:
            return None
        return ":".join(f"{b:02x}" for b in octets)
    except Exception:
        return None


async def _poll(device: dict) -> dict:
    engine = SnmpEngine()
    try:
        auth   = _build_auth(device)
        target = await UdpTransportTarget.create(
            (str(device["ip_address"]), device["snmp_port"]), timeout=3, retries=1
        )

        err_indication, err_status, err_index, var_binds = await get_cmd(
            engine, auth, target, ContextData(),
            ObjectType(ObjectIdentity(SYS_DESCR_OID)),
            ObjectType(ObjectIdentity(SYS_UPTIME_OID)),
        )
        if err_indication:
            raise SNMPError(str(err_indication))
        if err_status:
            raise SNMPError(f"{err_status.prettyPrint()} pri sys GET")
        sys_descr  = str(var_binds[0][1])
        sys_uptime = int(var_binds[1][1])

        cols: dict[str, dict[int, object]] = {}
        for name, oid in {**IF_COLUMNS, **IFX_COLUMNS}.items():
            try:
                cols[name] = await _walk_column(engine, target, auth, oid)
            except SNMPError:
                cols[name] = {}  # vendor mozda ne podrzava ifXTable -- nastavi bez nje
    finally:
        # KRITICNO: SnmpEngine otvara UDP socket (transport dispatcher) koji
        # se NIKAD ne zatvara sam od sebe. Bez ovoga, svaki poll ostavlja
        # jedan otvoren fajl-deskriptor zauvek -- sa ~10 uredjaja na svakih
        # ~60s to je na hiljade procurelih socket-a kroz par dana rada, sto
        # je izazvalo curenje memorije (12.6GB) i pad aplikacije 11.8.2026.
        # Potvrdjeno testom: 20 poll-ova bez ovoga = +20 FD-ova, sa ovim = +1.
        engine.close_dispatcher()

    if_indexes = set()
    for c in cols.values():
        if_indexes |= set(c.keys())

    now = time.time()
    interfaces = []
    for idx in sorted(if_indexes):
        def g(col, default=None):
            return cols.get(col, {}).get(idx, default)

        in_octets  = int(g("ifHCInOctets") or g("ifInOctets") or 0)
        out_octets = int(g("ifHCOutOctets") or g("ifOutOctets") or 0)
        in_errors  = int(g("ifInErrors") or 0)
        out_errors = int(g("ifOutErrors") or 0)
        in_discards  = int(g("ifInDiscards") or 0)
        out_discards = int(g("ifOutDiscards") or 0)

        cache_key = f"{device['id']}:{idx}"
        prev = _iface_prev.get(cache_key)
        _iface_prev[cache_key] = {
            "in": in_octets, "out": out_octets,
            "in_err": in_errors, "out_err": out_errors,
            "in_disc": in_discards, "out_disc": out_discards,
            "ts": now,
        }
        if prev and now > prev["ts"]:
            elapsed = now - prev["ts"]
            in_kbps  = round(max(0, in_octets  - prev["in"])  / 1024 / elapsed, 2)
            out_kbps = round(max(0, out_octets - prev["out"]) / 1024 / elapsed, 2)
            d_in_err  = max(0, in_errors  - prev["in_err"])
            d_out_err = max(0, out_errors - prev["out_err"])
            d_in_disc  = max(0, in_discards  - prev["in_disc"])
            d_out_disc = max(0, out_discards - prev["out_disc"])
        else:
            in_kbps = out_kbps = 0.0
            d_in_err = d_out_err = d_in_disc = d_out_disc = 0

        speed_bps = g("ifHighSpeed")
        if speed_bps is not None:
            if_speed_bps = int(speed_bps) * 1_000_000  # ifHighSpeed je u Mbps
        else:
            if_speed_bps = int(g("ifSpeed") or 0)

        interfaces.append({
            "if_index":      idx,
            "if_name":       str(g("ifName") or g("ifDescr") or f"if{idx}"),
            "if_descr":      str(g("ifDescr") or ""),
            "if_alias":      str(g("ifAlias") or "") or None,
            "if_type":       str(g("ifType") or ""),
            "if_speed_bps":  if_speed_bps,
            "mac_address":   _fmt_mac(g("ifPhysAddress")) if g("ifPhysAddress") is not None else None,
            "admin_status":  ADMIN_STATUS_MAP.get(int(g("ifAdminStatus") or 0), "unknown"),
            "oper_status":   OPER_STATUS_MAP.get(int(g("ifOperStatus") or 0), "unknown"),
            "in_kbps": in_kbps, "out_kbps": out_kbps,
            "in_errors": d_in_err, "out_errors": d_out_err,
            "in_discards": d_in_disc, "out_discards": d_out_disc,
        })

    return {"sys_descr": sys_descr, "sys_uptime_ticks": sys_uptime, "interfaces": interfaces}


async def _poll_and_save(device: dict):
    did = device["id"]
    old_status = device.get("status")  # POTVRDJEN status pre ovog poll-a
    try:
        result = await _poll(device)
    except Exception as e:
        err = str(e)[:500]
        logger.warning(f"SNMP poll neuspeo za {device.get('name', did)}: {e}")
        confirmed = _confirm_status(did, old_status, "offline")
        display_status = confirmed or old_status or "offline"
        await execute(
            "UPDATE network_devices SET status=$1, last_error=$2 WHERE id=$3",
            display_status, err, did,
        )
        if confirmed and old_status and old_status != "offline":
            await _log_status_transition(device, old_status, "offline", error=err)
        return

    confirmed = _confirm_status(did, old_status, "online")
    display_status = confirmed or old_status or "online"

    await execute(
        """UPDATE network_devices
           SET status=$1, last_seen_at=NOW(), last_error=NULL,
               sys_descr=$2, sys_uptime_ticks=$3
           WHERE id=$4""",
        display_status, result["sys_descr"][:500], result["sys_uptime_ticks"], did,
    )

    if confirmed and old_status and old_status != confirmed:
        await _log_status_transition(device, old_status, confirmed)

    for iface in result["interfaces"]:
        iface_row = await fetchrow(
            """INSERT INTO network_device_interfaces
                 (device_id, if_index, if_name, if_descr, if_alias, if_type,
                  if_speed_bps, mac_address, admin_status, oper_status, last_polled_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
               ON CONFLICT (device_id, if_index) DO UPDATE SET
                 if_name=EXCLUDED.if_name, if_descr=EXCLUDED.if_descr,
                 if_alias=EXCLUDED.if_alias, if_type=EXCLUDED.if_type,
                 if_speed_bps=EXCLUDED.if_speed_bps, mac_address=EXCLUDED.mac_address,
                 admin_status=EXCLUDED.admin_status,
                 last_change_at = CASE WHEN network_device_interfaces.oper_status <> EXCLUDED.oper_status
                                        THEN NOW() ELSE network_device_interfaces.last_change_at END,
                 oper_status=EXCLUDED.oper_status, last_polled_at=NOW()
               RETURNING id""",
            did, iface["if_index"], iface["if_name"], iface["if_descr"], iface["if_alias"],
            iface["if_type"], iface["if_speed_bps"], iface["mac_address"],
            iface["admin_status"], iface["oper_status"],
        )
        await execute(
            """INSERT INTO network_device_interface_metrics
                 (interface_id, in_kbps, out_kbps, in_errors, out_errors,
                  in_discards, out_discards, oper_status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
            iface_row["id"], iface["in_kbps"], iface["out_kbps"],
            iface["in_errors"], iface["out_errors"],
            iface["in_discards"], iface["out_discards"], iface["oper_status"],
        )


async def _poll_guarded(device: dict):
    cfg = get_settings()
    _last_polled[str(device["id"])] = time.time()
    old_status = device.get("status")
    try:
        await asyncio.wait_for(_poll_and_save(device), timeout=cfg.snmp_poll_watchdog_sec)
    except asyncio.TimeoutError:
        err = f"Watchdog timeout ({cfg.snmp_poll_watchdog_sec}s)"
        logger.error(f"{device.get('name', device.get('id'))}: {err}")
        try:
            confirmed = _confirm_status(device["id"], old_status, "offline")
            display_status = confirmed or old_status or "offline"
            await execute(
                "UPDATE network_devices SET status=$1, last_error=$2 WHERE id=$3",
                display_status, err, device["id"],
            )
            if confirmed and old_status and old_status != "offline":
                await _log_status_transition(device, old_status, "offline", error=err)
        except Exception:
            logger.exception("Greska pri obradi SNMP watchdog timeout-a")


async def poll_snmp_all():
    """Scheduler tik -- isti duh kao monitor.poll_all(): zove se cesto
    (snmp_poll_tick_sec), ali stvarno poll-uje samo uredjaje kojima je
    istekao njihov sopstveni poll_interval_sec."""
    cfg = get_settings()
    try:
        rows = await fetch("SELECT * FROM network_devices WHERE active=true ORDER BY tenant_id, id")
    except Exception as e:
        logger.error(f"SNMP: greska dohvatanja uredjaja: {e}")
        return
    if not rows:
        return

    now = time.time()
    due = []
    for r in rows:
        did = str(r["id"])
        interval = r["poll_interval_sec"]
        last = _last_polled.get(did)
        if last is None or (now - last) >= interval:
            due.append(dict(r))
    if not due:
        return

    mp = cfg.snmp_max_parallel
    for i in range(0, len(due), mp):
        await asyncio.gather(*[_poll_guarded(d) for d in due[i:i+mp]], return_exceptions=True)


async def poll_snmp_single(device_id: str):
    row = await fetchrow("SELECT * FROM network_devices WHERE id=$1 AND active=true", device_id)
    if not row:
        raise ValueError("Uredjaj nije pronadjen")
    await _poll_guarded(dict(row))
    return {"ok": True}


def start():
    cfg = get_settings()
    scheduler.add_job(poll_snmp_all, "interval", seconds=cfg.snmp_poll_tick_sec, id="snmp_poll")
    logger.info(f"SNMP monitoring pokrenut (tick: {cfg.snmp_poll_tick_sec}s)")
