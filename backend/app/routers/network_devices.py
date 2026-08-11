# app/routers/network_devices.py
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, field_validator
from app.database import fetch, fetchrow, execute
from app.services.auth import get_current_user, check_tenant_perm
from app.services.crypto import encrypt
from app.services.audit import log_event

router = APIRouter(prefix="/api/tenants", tags=["network-devices"])


def _n(v): return None if v == "" else v
def _ip(req: Request) -> str | None: return req.client.host if req.client else None


class NetworkDeviceIn(BaseModel):
    name: str
    ipAddress: str
    description: str | None = None
    deviceType: str = "other"
    vendor: str | None = None
    location: str | None = None
    snmpPort: int = 161
    snmpVersion: str = "v2c"
    community: str | None = None
    v3Username: str | None = None
    v3SecurityLevel: str | None = None
    v3AuthProtocol: str | None = None
    v3AuthPassword: str | None = None
    v3PrivProtocol: str | None = None
    v3PrivPassword: str | None = None
    pollIntervalSec: int = 60
    rawRetentionHours: int = 72
    rollupBucketMinutes: int = 1
    rollupRetentionDays: int = 90

    @field_validator("snmpVersion")
    @classmethod
    def check_version(cls, v):
        if v not in ("v2c", "v3"):
            raise ValueError("snmpVersion mora biti v2c ili v3")
        return v

    @field_validator("pollIntervalSec")
    @classmethod
    def check_interval(cls, v):
        if v < 10:
            raise ValueError("Minimalni interval osvezavanja je 10 sekundi")
        return v


class NetworkDeviceUp(NetworkDeviceIn):
    pass


@router.get("/{tid}/network-devices")
async def list_network_devices(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    rows = await fetch(
        """SELECT id, name, description, ip_address, device_type, vendor, location,
                  snmp_port, snmp_version, poll_interval_sec, status, sys_descr,
                  sys_uptime_ticks, last_seen_at, last_error, active, created_at,
                  (SELECT COUNT(*) FROM network_device_interfaces WHERE device_id=network_devices.id) AS interface_count
           FROM network_devices WHERE tenant_id=$1 AND active=true ORDER BY name""",
        tid)
    return [dict(r) for r in rows]


@router.post("/{tid}/network-devices", status_code=201)
async def create_network_device(tid: str, req: Request, body: NetworkDeviceIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_network_manage")
    try:
        row = await fetchrow(
            """INSERT INTO network_devices
                 (tenant_id, name, description, ip_address, device_type, vendor, location,
                  snmp_port, snmp_version, community_enc, v3_username, v3_security_level,
                  v3_auth_protocol, v3_auth_password_enc, v3_priv_protocol, v3_priv_password_enc,
                  poll_interval_sec, raw_retention_hours, rollup_bucket_minutes,
                  rollup_retention_days, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
               RETURNING id, name, ip_address, device_type, snmp_version, status, created_at""",
            tid, body.name, _n(body.description), body.ipAddress, body.deviceType, _n(body.vendor), _n(body.location),
            body.snmpPort, body.snmpVersion,
            encrypt(body.community) if body.community else None,
            _n(body.v3Username), _n(body.v3SecurityLevel), _n(body.v3AuthProtocol),
            encrypt(body.v3AuthPassword) if body.v3AuthPassword else None,
            _n(body.v3PrivProtocol),
            encrypt(body.v3PrivPassword) if body.v3PrivPassword else None,
            body.pollIntervalSec, body.rawRetentionHours, body.rollupBucketMinutes,
            body.rollupRetentionDays, user["id"])
        await log_event("networkdevice.create", user_id=user["id"], username=user.get("username"),
                        tenant_id=tid, ip_address=_ip(req), resource_type="network_device",
                        resource_id=str(row["id"]), details={"name": body.name})
        return dict(row)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(409, "Uredjaj sa tim imenom vec postoji")
        raise HTTPException(500, str(e))


@router.put("/{tid}/network-devices/{did}")
async def update_network_device(tid: str, did: str, req: Request, body: NetworkDeviceUp, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_network_manage")
    row = await fetchrow(
        """UPDATE network_devices SET
             name=$1, description=$2, ip_address=$3, device_type=$4, vendor=$5, location=$6,
             snmp_port=$7, snmp_version=$8,
             community_enc = COALESCE($9, community_enc),
             v3_username=$10, v3_security_level=$11, v3_auth_protocol=$12,
             v3_auth_password_enc = COALESCE($13, v3_auth_password_enc),
             v3_priv_protocol=$14,
             v3_priv_password_enc = COALESCE($15, v3_priv_password_enc),
             poll_interval_sec=$16, raw_retention_hours=$17, rollup_bucket_minutes=$18,
             rollup_retention_days=$19
           WHERE id=$20 AND tenant_id=$21
           RETURNING id, name, ip_address, device_type, snmp_version, status""",
        body.name, _n(body.description), body.ipAddress, body.deviceType, _n(body.vendor), _n(body.location),
        body.snmpPort, body.snmpVersion,
        encrypt(body.community) if body.community else None,
        _n(body.v3Username), _n(body.v3SecurityLevel), _n(body.v3AuthProtocol),
        encrypt(body.v3AuthPassword) if body.v3AuthPassword else None,
        _n(body.v3PrivProtocol),
        encrypt(body.v3PrivPassword) if body.v3PrivPassword else None,
        body.pollIntervalSec, body.rawRetentionHours, body.rollupBucketMinutes,
        body.rollupRetentionDays, did, tid)
    if not row:
        raise HTTPException(404, "Uredjaj nije pronadjen")
    await log_event("networkdevice.update", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req), resource_type="network_device",
                    resource_id=did, details={"name": body.name})
    return dict(row)


@router.delete("/{tid}/network-devices/{did}")
async def delete_network_device(tid: str, did: str, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_network_manage")
    row = await fetchrow(
        "UPDATE network_devices SET active=false WHERE id=$1 AND tenant_id=$2 RETURNING id, name",
        did, tid)
    if not row:
        raise HTTPException(404, "Uredjaj nije pronadjen")
    await log_event("networkdevice.delete", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req), resource_type="network_device",
                    resource_id=did, details={"name": row["name"]})
    return {"ok": True}


@router.post("/{tid}/network-devices/{did}/test")
async def test_network_device(tid: str, did: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    row = await fetchrow(
        "SELECT id FROM network_devices WHERE id=$1 AND tenant_id=$2 AND active=true", did, tid)
    if not row:
        raise HTTPException(404, "Uredjaj nije pronadjen")
    from app.services.snmp import poll_snmp_single
    try:
        await poll_snmp_single(did)
    except Exception as e:
        raise HTTPException(502, str(e))
    fresh = await fetchrow(
        "SELECT status, sys_descr, last_error FROM network_devices WHERE id=$1", did)
    return dict(fresh)


@router.get("/{tid}/network-devices/{did}/interfaces")
async def list_interfaces(tid: str, did: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    dev = await fetchrow(
        "SELECT id, name FROM network_devices WHERE id=$1 AND tenant_id=$2", did, tid)
    if not dev:
        raise HTTPException(404, "Uredjaj nije pronadjen")
    rows = await fetch(
        """SELECT i.id, i.if_index, i.if_name, i.if_descr, i.if_alias, i.if_type,
                  i.if_speed_bps, i.mac_address, i.admin_status, i.oper_status,
                  i.last_change_at, i.last_polled_at,
                  m.in_kbps, m.out_kbps, m.in_errors, m.out_errors,
                  m.in_discards, m.out_discards, m.collected_at AS last_metric_at
           FROM network_device_interfaces i
           LEFT JOIN LATERAL (
               SELECT in_kbps, out_kbps, in_errors, out_errors, in_discards, out_discards, collected_at
               FROM network_device_interface_metrics
               WHERE interface_id = i.id ORDER BY collected_at DESC LIMIT 1
           ) m ON true
           WHERE i.device_id=$1 ORDER BY i.if_index""",
        did)
    return {"deviceName": dev["name"], "interfaces": [dict(r) for r in rows]}
