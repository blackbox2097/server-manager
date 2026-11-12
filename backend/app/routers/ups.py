# app/routers/ups.py
# UPS uredjaji -- sopstvena kategorija (odluka 9.11.2026). Prva faza samo NUT
# izvor. Obrazac preslikan iz network_devices.py; dozvola perm_ups_manage.
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, field_validator
from app.database import fetch, fetchrow
from app.services.auth import get_current_user, check_tenant_perm
from app.services.crypto import encrypt
from app.services.audit import log_event
from app.services.bgtasks import create_bg_task

router = APIRouter(prefix="/api/tenants", tags=["ups"])


def _n(v): return None if v == "" else v
def _ip(req: Request) -> str | None: return req.client.host if req.client else None


class UpsIn(BaseModel):
    name: str
    host: str
    source: str = "nut"
    description: str | None = None
    location: str | None = None
    port: int = 3493
    deviceName: str = "ups"
    username: str | None = None
    password: str | None = None
    pollIntervalSec: int = 60
    rawRetentionHours: int = 72
    rollupBucketMinutes: int = 5
    rollupRetentionDays: int = 90

    @field_validator("name", "host", "deviceName")
    @classmethod
    def not_empty(cls, v):
        if not v or not v.strip():
            raise ValueError("Polje je obavezno")
        return v.strip()

    @field_validator("port")
    @classmethod
    def check_port(cls, v):
        if not 1 <= v <= 65535:
            raise ValueError("Port mora biti 1-65535")
        return v

    @field_validator("pollIntervalSec")
    @classmethod
    def check_interval(cls, v):
        if v < 10:
            raise ValueError("Minimalni interval osvezavanja je 10 sekundi")
        return v


    @field_validator("source")
    @classmethod
    def check_source(cls, v):
        if v not in ("nut", "viewpower"):
            raise ValueError("Izvor mora biti nut ili viewpower")
        return v


class UpsTestIn(BaseModel):
    host: str
    source: str = "nut"
    port: int = 3493
    deviceName: str = "ups"
    username: str | None = None
    password: str | None = None


_LIST_SELECT = """
    SELECT u.id, u.name, u.description, u.location, u.source, u.host, u.port, u.device_name,
           u.username, (u.password_enc IS NOT NULL) AS has_password,
           u.poll_interval_sec, u.status, u.ups_status_raw, u.replace_battery,
           u.manufacturer, u.model, u.firmware, u.ups_type,
           u.last_seen_at, u.last_error, u.created_at,
           m.battery_charge, m.battery_runtime_sec, m.load_percent,
           m.input_voltage, m.output_voltage, m.temperature, m.collected_at AS last_metric_at
    FROM ups_devices u
    LEFT JOIN LATERAL (
        SELECT battery_charge, battery_runtime_sec, load_percent,
               input_voltage, output_voltage, temperature, collected_at
        FROM ups_metrics WHERE ups_id = u.id ORDER BY collected_at DESC LIMIT 1
    ) m ON true
"""


@router.get("/{tid}/ups")
async def list_ups(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    rows = await fetch(_LIST_SELECT + " WHERE u.tenant_id=$1 AND u.active=true ORDER BY u.name", tid)
    return [dict(r) for r in rows]


@router.post("/{tid}/ups/test-connection")
async def test_ups_connection(tid: str, body: UpsTestIn, user=Depends(get_current_user)):
    """Proba NUT konekcije PRE cuvanja -- podaci direktno iz forme."""
    await check_tenant_perm(tid, user, "perm_ups_manage")
    host, dev = body.host.strip(), body.deviceName.strip()
    try:
        if body.source == "viewpower":
            from app.services.viewpower import fetch as vp_fetch
            r = await vp_fetch({"host": host, "port": body.port, "device_name": dev})
            return {
                "ok": True, "varCount": len(r["raw_vars"]), "status": r["status"],
                "reason": r["reason"], "replaceBattery": r["replace_battery"],
                "upsStatusRaw": r["status_raw"], "manufacturer": None,
                "model": r["raw_vars"].get("viewpower.version"),
            }
        from app.services.nut import nut_list_vars, derive_status
        v = await nut_list_vars(host, body.port, dev, _n(body.username), _n(body.password))
    except Exception as e:
        raise HTTPException(502, str(e))
    status, replace_battery, reason = derive_status(v)
    return {
        "ok": True, "varCount": len(v), "status": status, "reason": reason,
        "replaceBattery": replace_battery, "upsStatusRaw": v.get("ups.status"),
        "manufacturer": v.get("device.mfr") or v.get("ups.mfr"),
        "model": v.get("device.model") or v.get("ups.model"),
    }


class UpsDiscoverIn(BaseModel):
    host: str
    port: int = 15178
    source: str = "viewpower"


@router.post("/{tid}/ups/discover")
async def discover_ups(tid: str, body: UpsDiscoverIn, user=Depends(get_current_user)):
    """Autodetekcija uredjaja na izvoru (ViewPower): spisak UPS-ova na racunaru,
    uz oznaku onih koji su vec dodati u ovom tenantu. Vidi viewpower.vp_discover."""
    await check_tenant_perm(tid, user, "perm_ups_manage")
    if body.source != "viewpower":
        raise HTTPException(400, "Autodetekcija je trenutno podrzana samo za ViewPower")
    from app.services.viewpower import vp_discover
    host = body.host.strip()
    try:
        res = await vp_discover(host, body.port)
    except Exception as e:
        raise HTTPException(502, str(e))
    if not res["devices"]:
        raise HTTPException(404, "ViewPower nije vratio nijedan UPS")
    rows = await fetch(
        "SELECT name, device_name FROM ups_devices WHERE tenant_id=$1 AND source='viewpower' "
        "AND host=$2 AND active=true", tid, host)
    existing = {r["device_name"]: r["name"] for r in rows}
    for dev in res["devices"]:
        dev["existing"] = existing.get(dev["deviceName"])
    return res


@router.get("/{tid}/ups/{uid}")
async def get_ups(tid: str, uid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    row = await fetchrow(
        _LIST_SELECT.replace("u.created_at,",
            "u.created_at, u.raw_vars::text AS raw_vars_json, u.raw_retention_hours, "
            "u.rollup_bucket_minutes, u.rollup_retention_days,")
        + " WHERE u.id=$1 AND u.tenant_id=$2 AND u.active=true", uid, tid)
    if not row:
        raise HTTPException(404, "UPS nije pronadjen")
    return dict(row)


@router.post("/{tid}/ups", status_code=201)
async def create_ups(tid: str, req: Request, body: UpsIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_ups_manage")
    row = await fetchrow(
        """INSERT INTO ups_devices
             (tenant_id, name, description, location, host, port, device_name,
              username, password_enc, poll_interval_sec, raw_retention_hours,
              rollup_bucket_minutes, rollup_retention_days, created_by, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id, name, host, status, created_at""",
        tid, body.name, _n(body.description), _n(body.location), body.host, body.port,
        body.deviceName, _n(body.username),
        encrypt(body.password) if body.password else None,
        body.pollIntervalSec, body.rawRetentionHours, body.rollupBucketMinutes,
        body.rollupRetentionDays, user["id"], body.source)
    await log_event("ups.create", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req), resource_type="ups",
                    resource_id=str(row["id"]), details={"name": body.name, "host": body.host})
    from app.services.ups_poller import poll_ups_single
    create_bg_task(poll_ups_single(str(row["id"])))  # prvi poll odmah, ne ceka 60s
    return dict(row)


@router.put("/{tid}/ups/{uid}")
async def update_ups(tid: str, uid: str, req: Request, body: UpsIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_ups_manage")
    row = await fetchrow(
        """UPDATE ups_devices SET
             name=$1, description=$2, location=$3, host=$4, port=$5, device_name=$6,
             username=$7, password_enc = COALESCE($8, password_enc),
             poll_interval_sec=$9, raw_retention_hours=$10, rollup_bucket_minutes=$11,
             rollup_retention_days=$12, source=$15, updated_at=NOW()
           WHERE id=$13 AND tenant_id=$14 AND active=true
           RETURNING id, name, host, status""",
        body.name, _n(body.description), _n(body.location), body.host, body.port,
        body.deviceName, _n(body.username),
        encrypt(body.password) if body.password else None,
        body.pollIntervalSec, body.rawRetentionHours, body.rollupBucketMinutes,
        body.rollupRetentionDays, uid, tid, body.source)
    if not row:
        raise HTTPException(404, "UPS nije pronadjen")
    await log_event("ups.update", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req), resource_type="ups",
                    resource_id=uid, details={"name": body.name})
    return dict(row)


@router.delete("/{tid}/ups/{uid}")
async def delete_ups(tid: str, uid: str, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_ups_manage")
    row = await fetchrow(
        "UPDATE ups_devices SET active=false, updated_at=NOW() WHERE id=$1 AND tenant_id=$2 AND active=true RETURNING id, name",
        uid, tid)
    if not row:
        raise HTTPException(404, "UPS nije pronadjen")
    await log_event("ups.delete", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req), resource_type="ups",
                    resource_id=uid, details={"name": row["name"]})
    return {"ok": True}


@router.post("/{tid}/ups/{uid}/test")
async def test_ups(tid: str, uid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    row = await fetchrow("SELECT id FROM ups_devices WHERE id=$1 AND tenant_id=$2 AND active=true", uid, tid)
    if not row:
        raise HTTPException(404, "UPS nije pronadjen")
    from app.services.ups_poller import poll_ups_single
    try:
        await poll_ups_single(uid)
    except Exception as e:
        raise HTTPException(502, str(e))
    fresh = await fetchrow(
        "SELECT status, ups_status_raw, manufacturer, model, last_error FROM ups_devices WHERE id=$1", uid)
    return dict(fresh)
