# app/routers/dashboard.py
# Cross-tenant "samo problemi" dashboard -- agregira stanje preko svih tenanta
# na koje ulogovan operater ima pristup (superadmin = svi tenanti).

import socket
from datetime import datetime, timezone
import psutil
from fastapi import APIRouter, Depends, HTTPException, Query
from app.database import fetch, fetchrow, execute
from app.services.auth import get_current_user

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("/host-status")
async def host_status(user=Depends(get_current_user)):
    """Sat + CPU/RAM zauzece masine na kojoj SAMA APLIKACIJA radi (ne
    monitorisanih servera -- za to postoji /problems)."""
    return {
        "time": datetime.now(timezone.utc).isoformat(),
        "cpuPercent": psutil.cpu_percent(interval=None),
        "ramPercent": psutil.virtual_memory().percent,
        "hostname": socket.gethostname(),
    }


async def _accessible_tenant_ids(user: dict) -> list[str] | None:
    """None = superadmin (svi tenanti), inace lista tenant_id-jeva na koje
    operater ima perm_view."""
    if user["role"] == "superadmin":
        return None
    rows = await fetch(
        "SELECT tenant_id FROM operator_tenants WHERE operator_id=$1 AND perm_view=true",
        user["id"])
    return [str(r["tenant_id"]) for r in rows]


@router.get("/stats")
async def stats(user=Depends(get_current_user)):
    tids = await _accessible_tenant_ids(user)
    if tids is None:
        rows = await fetch("SELECT status, environment, os_type FROM servers WHERE active=true")
    else:
        rows = await fetch(
            """SELECT status, environment, os_type FROM servers
               WHERE active=true AND tenant_id = ANY($1::uuid[])""", tids)

    env_counts, os_counts = {}, {}
    online = warning = offline = 0
    for r in rows:
        if r["status"] == "online": online += 1
        elif r["status"] == "warning": warning += 1
        elif r["status"] == "offline": offline += 1
        env_counts[r["environment"]] = env_counts.get(r["environment"], 0) + 1
        os_counts[r["os_type"]] = os_counts.get(r["os_type"], 0) + 1

    return {
        "total": len(rows), "online": online, "warning": warning, "offline": offline,
        "envCounts": env_counts, "osCounts": os_counts,
    }


_PROBLEMS_SELECT = """
    SELECT s.id, s.name, s.ip_address, s.os_type, s.status, s.last_error,
           s.last_seen_at, s.tenant_id, t.name AS tenant_name,
           m.cpu_percent, m.ram_percent, m.disk_percent, m.disks, m.uptime_seconds
    FROM servers s
    JOIN tenants t ON t.id = s.tenant_id
    LEFT JOIN LATERAL (
        SELECT cpu_percent, ram_percent, disk_percent, disks, uptime_seconds
        FROM metrics WHERE server_id=s.id ORDER BY collected_at DESC LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
        SELECT MAX(occurred_at) AS last_transition FROM audit_log
        WHERE resource_id = s.id::text AND action IN ('server.status_warning','server.status_offline')
    ) lt ON true
    LEFT JOIN dashboard_dismissals d ON d.server_id = s.id AND d.operator_id = $1
    WHERE s.active=true AND s.status IN ('warning','offline')
      AND (d.dismissed_at IS NULL OR lt.last_transition IS NULL OR d.dismissed_at < lt.last_transition)
"""


@router.get("/problems")
async def problems(user=Depends(get_current_user)):
    tids = await _accessible_tenant_ids(user)
    if tids is None:
        rows = await fetch(
            _PROBLEMS_SELECT + " ORDER BY t.name, (s.status = 'offline') DESC, s.name",
            user["id"])
    else:
        rows = await fetch(
            _PROBLEMS_SELECT + " AND s.tenant_id = ANY($2::uuid[])"
                                " ORDER BY t.name, (s.status = 'offline') DESC, s.name",
            user["id"], tids)
    return [dict(r) for r in rows]


@router.post("/dismiss/{server_id}")
async def dismiss(server_id: str, user=Depends(get_current_user)):
    row = await fetchrow("SELECT tenant_id FROM servers WHERE id=$1 AND active=true", server_id)
    if not row:
        raise HTTPException(404, "Server nije pronadjen")
    if user["role"] != "superadmin":
        perm = await fetchrow(
            "SELECT 1 FROM operator_tenants WHERE operator_id=$1 AND tenant_id=$2 AND perm_view=true",
            user["id"], row["tenant_id"])
        if not perm:
            raise HTTPException(403, "Nemate pristup ovom serveru")
    await execute(
        """INSERT INTO dashboard_dismissals (operator_id, server_id, dismissed_at)
           VALUES ($1,$2,NOW())
           ON CONFLICT (operator_id, server_id) DO UPDATE SET dismissed_at=NOW()""",
        user["id"], server_id)
    return {"ok": True}
@router.get("/network-stats")
async def network_stats(user=Depends(get_current_user)):
    tids = await _accessible_tenant_ids(user)
    if tids is None:
        rows = await fetch("SELECT status FROM network_devices WHERE active=true")
    else:
        rows = await fetch(
            "SELECT status FROM network_devices WHERE active=true AND tenant_id = ANY($1::uuid[])", tids)
    online = warning = offline = 0
    for r in rows:
        if r["status"] == "online": online += 1
        elif r["status"] == "warning": warning += 1
        elif r["status"] == "offline": offline += 1
    return {"total": len(rows), "online": online, "warning": warning, "offline": offline}
_NETWORK_PROBLEMS_SELECT = """
    SELECT nd.id, nd.name, nd.ip_address, nd.device_type, nd.vendor, nd.model, nd.location,
           nd.status, nd.last_error, nd.last_seen_at, nd.tenant_id, t.name AS tenant_name
    FROM network_devices nd
    JOIN tenants t ON t.id = nd.tenant_id
    LEFT JOIN LATERAL (
        SELECT MAX(occurred_at) AS last_transition FROM audit_log
        WHERE resource_id = nd.id::text AND action IN ('networkdevice.status_warning','networkdevice.status_offline')
    ) lt ON true
    LEFT JOIN dashboard_dismissals d ON d.device_id = nd.id AND d.operator_id = $1
    WHERE nd.active=true AND nd.status IN ('warning','offline')
      AND (d.dismissed_at IS NULL OR lt.last_transition IS NULL OR d.dismissed_at < lt.last_transition)
"""
@router.get("/network-problems")
async def network_problems(user=Depends(get_current_user)):
    tids = await _accessible_tenant_ids(user)
    if tids is None:
        rows = await fetch(
            _NETWORK_PROBLEMS_SELECT + " ORDER BY t.name, (nd.status = 'offline') DESC, nd.name",
            user["id"])
    else:
        rows = await fetch(
            _NETWORK_PROBLEMS_SELECT + " AND nd.tenant_id = ANY($2::uuid[])"
                                        " ORDER BY t.name, (nd.status = 'offline') DESC, nd.name",
            user["id"], tids)
    return [dict(r) for r in rows]
@router.post("/dismiss-device/{device_id}")
async def dismiss_device(device_id: str, user=Depends(get_current_user)):
    row = await fetchrow("SELECT tenant_id FROM network_devices WHERE id=$1 AND active=true", device_id)
    if not row:
        raise HTTPException(404, "Uredjaj nije pronadjen")
    if user["role"] != "superadmin":
        perm = await fetchrow(
            "SELECT 1 FROM operator_tenants WHERE operator_id=$1 AND tenant_id=$2 AND perm_view=true",
            user["id"], row["tenant_id"])
        if not perm:
            raise HTTPException(403, "Nemate pristup ovom uredjaju")
    await execute(
        """INSERT INTO dashboard_dismissals (operator_id, device_id, dismissed_at)
           VALUES ($1,$2,NOW())
           ON CONFLICT (operator_id, device_id) DO UPDATE SET dismissed_at=NOW()""",
        user["id"], device_id)
    return {"ok": True}


@router.get("/executions")
async def dashboard_executions(limit: int = Query(5, ge=1, le=50), user=Depends(get_current_user)):
    tids = await _accessible_tenant_ids(user)
    base = """SELECT e.id, e.script_name, e.status, e.server_count, e.success_count,
                     e.error_count, e.started_at, e.finished_at, e.tenant_id,
                     t.name AS tenant_name, u.username AS started_by_name
              FROM executions e
              JOIN tenants t ON t.id = e.tenant_id
              LEFT JOIN users u ON u.id = e.started_by"""
    if tids is None:
        rows = await fetch(base + " ORDER BY e.started_at DESC LIMIT $1", min(limit, 50))
    else:
        rows = await fetch(
            base + " WHERE e.tenant_id = ANY($1::uuid[]) ORDER BY e.started_at DESC LIMIT $2",
            tids, min(limit, 50))
    return [dict(r) for r in rows]


@router.get("/logs")
async def dashboard_logs(limit: int = Query(6, ge=1, le=50), user=Depends(get_current_user)):
    tids = await _accessible_tenant_ids(user)
    base = """SELECT a.*, t.name AS tenant_name FROM audit_log a
              LEFT JOIN tenants t ON t.id=a.tenant_id"""
    if tids is None:
        rows = await fetch(base + " ORDER BY a.occurred_at DESC LIMIT $1", min(limit, 50))
    else:
        rows = await fetch(
            base + " WHERE a.tenant_id = ANY($1::uuid[]) ORDER BY a.occurred_at DESC LIMIT $2",
            tids, min(limit, 50))
    return [dict(r) for r in rows]
@router.get("/servers-by-status")
async def servers_by_status(status: str = Query(...), user=Depends(get_current_user)):
    if status not in ("online", "warning", "offline"):
        raise HTTPException(400, "Nevazeci status")
    tids = await _accessible_tenant_ids(user)
    base = """
        SELECT s.id, s.name, s.ip_address, s.os_type, s.status, s.last_error, s.virt_type,
               s.last_seen_at, s.tenant_id, t.name AS tenant_name,
               m.cpu_percent, m.ram_percent, m.disk_percent, m.disks, m.uptime_seconds
        FROM servers s
        JOIN tenants t ON t.id = s.tenant_id
        LEFT JOIN LATERAL (
            SELECT cpu_percent, ram_percent, disk_percent, disks, uptime_seconds
            FROM metrics WHERE server_id=s.id ORDER BY collected_at DESC LIMIT 1
        ) m ON true
        WHERE s.active=true AND s.status=$1
    """
    if tids is None:
        rows = await fetch(base + " ORDER BY t.name, s.name", status)
    else:
        rows = await fetch(base + " AND s.tenant_id = ANY($2::uuid[]) ORDER BY t.name, s.name", status, tids)
    return [dict(r) for r in rows]
@router.get("/network-devices-by-status")
async def network_devices_by_status(status: str = Query(...), user=Depends(get_current_user)):
    if status not in ("online", "warning", "offline"):
        raise HTTPException(400, "Nevazeci status")
    tids = await _accessible_tenant_ids(user)
    base = """
        SELECT nd.id, nd.name, nd.ip_address, nd.device_type, nd.vendor, nd.model, nd.location,
               nd.status, nd.last_error, nd.last_seen_at, nd.tenant_id, t.name AS tenant_name,
               (SELECT COUNT(*) FROM network_device_interfaces WHERE device_id=nd.id) AS interface_count
        FROM network_devices nd
        JOIN tenants t ON t.id = nd.tenant_id
        WHERE nd.active=true AND nd.status=$1
    """
    if tids is None:
        rows = await fetch(base + " ORDER BY t.name, nd.name", status)
    else:
        rows = await fetch(base + " AND nd.tenant_id = ANY($2::uuid[]) ORDER BY t.name, nd.name", status, tids)
    return [dict(r) for r in rows]
