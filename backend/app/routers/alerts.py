# app/routers/alerts.py
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, EmailStr

from app.database import fetchrow, fetch, execute
from app.services.auth import get_current_user, check_tenant_perm
from app.services.notify import send_execution_report

router = APIRouter(prefix="/api/tenants", tags=["alerts"])


class AlertSettingsUp(BaseModel):
    alertsEnabled:            bool | None = None
    alertOnOffline:           bool | None = None
    alertOnRecovery:          bool | None = None
    alertOnWarning:           bool | None = None
    alertOnExecutionFailure:  bool | None = None
    alertOnExecutionReport:   bool | None = None


class RecipientIn(BaseModel):
    email: EmailStr


# ── Podesavanja alarma ───────────────────────────────────────────────────────

@router.get("/{tid}/alert-settings")
async def get_alert_settings(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    row = await fetchrow(
        """SELECT alerts_enabled, alert_on_offline, alert_on_recovery,
                  alert_on_warning, alert_on_execution_failure, alert_on_execution_report
           FROM tenants WHERE id=$1""", tid)
    if not row:
        raise HTTPException(404, "Tenant nije pronadjen")
    return dict(row)


@router.put("/{tid}/alert-settings")
async def update_alert_settings(tid: str, body: AlertSettingsUp, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_servers_manage")
    row = await fetchrow(
        """UPDATE tenants SET
             alerts_enabled             = COALESCE($1, alerts_enabled),
             alert_on_offline           = COALESCE($2, alert_on_offline),
             alert_on_recovery          = COALESCE($3, alert_on_recovery),
             alert_on_warning           = COALESCE($4, alert_on_warning),
             alert_on_execution_failure = COALESCE($5, alert_on_execution_failure),
             alert_on_execution_report  = COALESCE($6, alert_on_execution_report)
           WHERE id=$7
           RETURNING alerts_enabled, alert_on_offline, alert_on_recovery,
                     alert_on_warning, alert_on_execution_failure, alert_on_execution_report""",
        body.alertsEnabled, body.alertOnOffline, body.alertOnRecovery,
        body.alertOnWarning, body.alertOnExecutionFailure, body.alertOnExecutionReport,
        tid)
    if not row:
        raise HTTPException(404, "Tenant nije pronadjen")
    return dict(row)


# ── Primaoci ──────────────────────────────────────────────────────────────────

@router.get("/{tid}/alert-recipients")
async def list_recipients(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    rows = await fetch(
        "SELECT id, email, active, created_at FROM alert_recipients WHERE tenant_id=$1 ORDER BY email", tid)
    return [dict(r) for r in rows]


@router.post("/{tid}/alert-recipients", status_code=201)
async def add_recipient(tid: str, body: RecipientIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_servers_manage")
    try:
        row = await fetchrow(
            """INSERT INTO alert_recipients (tenant_id, email, created_by)
               VALUES ($1,$2,$3) RETURNING id, email, active, created_at""",
            tid, str(body.email), user["id"])
        return dict(row)
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(409, "Ova email adresa je vec dodata")
        raise HTTPException(500, str(e))


@router.delete("/{tid}/alert-recipients/{rid}")
async def delete_recipient(tid: str, rid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_servers_manage")
    row = await fetchrow(
        "DELETE FROM alert_recipients WHERE id=$1 AND tenant_id=$2 RETURNING id", rid, tid)
    if not row:
        raise HTTPException(404, "Primalac nije pronadjen")
    return {"ok": True}


# ── Rucno slanje izvestaja o izvrsavanju ─────────────────────────────────────

@router.post("/{tid}/executions/{eid}/send-report")
async def manual_send_report(tid: str, eid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    try:
        await send_execution_report(eid, tid)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(400, str(e))
