# app/routers/logs.py
import csv
import io
from datetime import datetime

from fastapi import APIRouter, HTTPException, Depends, Query
from fastapi.responses import StreamingResponse

from app.database import fetch
from app.services.audit_query import build_audit_filter
from app.services.auth import get_current_user, check_tenant_perm

router = APIRouter(prefix="/api/tenants", tags=["logs"])


def _build_query(tenant_id: str, action: str | None, user_id: str | None,
                 success: bool | None, search: str | None,
                 date_from: str | None, date_to: str | None,
                 limit: int, offset: int):
    cond, params = build_audit_filter(
        tenant_id=tenant_id, action=action, user_id=user_id, success=success,
        search=search, date_from=date_from, date_to=date_to,
    )

    where = " AND ".join(cond)
    params_list = params + [limit, offset]
    query = (
        f"SELECT * FROM audit_log WHERE {where} "
        f"ORDER BY occurred_at DESC LIMIT ${len(params_list)-1} OFFSET ${len(params_list)}"
    )
    return query, params_list


@router.get("/{tid}/logs")
async def list_logs(
    tid: str,
    action: str | None = None,
    userId: str | None = None,
    success: bool | None = None,
    search: str | None = None,
    dateFrom: str | None = None,
    dateTo: str | None = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user=Depends(get_current_user),
):
    await check_tenant_perm(tid, user)
    query, params = _build_query(tid, action, userId, success, search, dateFrom, dateTo, limit, offset)
    rows = await fetch(query, *params)
    return [dict(r) for r in rows]


@router.get("/{tid}/logs/actions")
async def list_distinct_actions(tid: str, user=Depends(get_current_user)):
    """Vraca listu svih akcija koje se pojavljuju u logu ovog tenanta — za filter dropdown."""
    await check_tenant_perm(tid, user)
    rows = await fetch(
        "SELECT DISTINCT action FROM audit_log WHERE tenant_id=$1 ORDER BY action", tid
    )
    return [r["action"] for r in rows]


@router.get("/{tid}/logs/export")
async def export_logs(
    tid: str,
    action: str | None = None,
    userId: str | None = None,
    success: bool | None = None,
    search: str | None = None,
    dateFrom: str | None = None,
    dateTo: str | None = None,
    user=Depends(get_current_user),
):
    await check_tenant_perm(tid, user)
    query, params = _build_query(tid, action, userId, success, search, dateFrom, dateTo, 5000, 0)
    rows = await fetch(query, *params)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Vreme", "Akcija", "Korisnik", "Resurs tip", "Resurs ID", "Uspesno", "Greska", "Detalji"])
    for r in rows:
        writer.writerow([
            r["occurred_at"].isoformat() if r["occurred_at"] else "",
            r["action"], r["username"] or "", r["resource_type"] or "",
            r["resource_id"] or "", "DA" if r["success"] else "NE",
            r["error_message"] or "", r["details"] or "",
        ])
    buf.seek(0)

    filename = f"logovi_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )
