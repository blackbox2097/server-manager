from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, field_validator
from app.database import fetch, fetchrow, execute
from app.services.auth import get_current_user, check_tenant_perm
from app.services.audit import log_event

router = APIRouter(prefix="/api/tenants", tags=["automation"])

_TRIGGER_TYPES = ("offline", "recovery", "cpu_high", "ram_high", "disk_high",
                   "exec_failed", "scheduled_exec_failed")
_THRESHOLD_TRIGGERS = ("cpu_high", "ram_high", "disk_high")


def _n(v): return None if v == "" else v
def _ip(req: Request) -> str | None: return req.client.host if req.client else None


class RuleIn(BaseModel):
    name: str
    serverId: str | None = None          # None = svi serveri tenant-a
    triggerType: str
    thresholdPercent: int | None = None  # obavezno za cpu_high/ram_high/disk_high
    scriptId: str
    cooldownMinutes: int = 15
    enabled: bool = True

    @field_validator("triggerType")
    @classmethod
    def check_trigger(cls, v):
        if v not in _TRIGGER_TYPES:
            raise ValueError(f"trigger mora biti jedan od: {', '.join(_TRIGGER_TYPES)}")
        return v

    @field_validator("cooldownMinutes")
    @classmethod
    def check_cooldown(cls, v):
        if v < 0:
            raise ValueError("cooldown ne moze biti negativan")
        return v

    @field_validator("serverId", mode="before")
    @classmethod
    def empty_to_none(cls, v):
        return None if v == "" else v


# ── Pravila automatizacije ──────────────────────────────────────────────────

@router.get("/{tid}/automation-rules")
async def list_rules(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    rows = await fetch(
        """SELECT r.id, r.tenant_id, r.operator_id, r.server_id, r.name,
                  r.trigger_type, r.threshold_percent, r.script_id,
                  r.cooldown_minutes, r.enabled, r.created_at,
                  u.username AS operator_name,
                  s.name AS server_name,
                  sc.name AS script_name
           FROM automation_rules r
           LEFT JOIN users u ON u.id = r.operator_id
           LEFT JOIN servers s ON s.id = r.server_id
           LEFT JOIN scripts sc ON sc.id = r.script_id
           WHERE r.tenant_id=$1
           ORDER BY r.created_at DESC""", tid)
    return [dict(r) for r in rows]


@router.post("/{tid}/automation-rules", status_code=201)
async def create_rule(tid: str, body: RuleIn, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_manage")

    if body.triggerType in _THRESHOLD_TRIGGERS and body.thresholdPercent is None:
        raise HTTPException(400, "Prag (thresholdPercent) je obavezan za ovaj tip trigera")
    if body.thresholdPercent is not None and not (1 <= body.thresholdPercent <= 100):
        raise HTTPException(400, "Prag mora biti izmedju 1 i 100")

    script = await fetchrow("SELECT id FROM scripts WHERE id=$1 AND tenant_id=$2", body.scriptId, tid)
    if not script:
        raise HTTPException(404, "Skripta nije pronadjena u ovom tenantu")

    if body.serverId:
        srv = await fetchrow("SELECT id FROM servers WHERE id=$1 AND tenant_id=$2 AND active=true",
                              body.serverId, tid)
        if not srv:
            raise HTTPException(404, "Server nije pronadjen u ovom tenantu")

    row = await fetchrow(
        """INSERT INTO automation_rules
             (tenant_id, operator_id, server_id, name, trigger_type,
              threshold_percent, script_id, cooldown_minutes, enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, name""",
        tid, user["id"], _n(body.serverId), body.name, body.triggerType,
        body.thresholdPercent, body.scriptId, body.cooldownMinutes, body.enabled
    )
    await log_event("automation.rule_create", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req),
                    resource_type="automation_rule", resource_id=str(row["id"]),
                    details={"name": body.name, "triggerType": body.triggerType})
    return dict(row)


@router.put("/{tid}/automation-rules/{rid}")
async def update_rule(tid: str, rid: str, body: RuleIn, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_manage")

    if body.triggerType in _THRESHOLD_TRIGGERS and body.thresholdPercent is None:
        raise HTTPException(400, "Prag (thresholdPercent) je obavezan za ovaj tip trigera")
    if body.thresholdPercent is not None and not (1 <= body.thresholdPercent <= 100):
        raise HTTPException(400, "Prag mora biti izmedju 1 i 100")

    script = await fetchrow("SELECT id FROM scripts WHERE id=$1 AND tenant_id=$2", body.scriptId, tid)
    if not script:
        raise HTTPException(404, "Skripta nije pronadjena u ovom tenantu")

    if body.serverId:
        srv = await fetchrow("SELECT id FROM servers WHERE id=$1 AND tenant_id=$2 AND active=true",
                              body.serverId, tid)
        if not srv:
            raise HTTPException(404, "Server nije pronadjen u ovom tenantu")

    row = await fetchrow(
        """UPDATE automation_rules SET
             server_id=$1, name=$2, trigger_type=$3, threshold_percent=$4,
             script_id=$5, cooldown_minutes=$6, enabled=$7
           WHERE id=$8 AND tenant_id=$9
           RETURNING id, name""",
        _n(body.serverId), body.name, body.triggerType, body.thresholdPercent,
        body.scriptId, body.cooldownMinutes, body.enabled, rid, tid
    )
    if not row:
        raise HTTPException(404, "Pravilo nije pronadjeno")
    await log_event("automation.rule_update", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req),
                    resource_type="automation_rule", resource_id=rid,
                    details={"name": body.name, "triggerType": body.triggerType})
    return dict(row)


@router.delete("/{tid}/automation-rules/{rid}")
async def delete_rule(tid: str, rid: str, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_manage")
    row = await fetchrow(
        "DELETE FROM automation_rules WHERE id=$1 AND tenant_id=$2 RETURNING id, name",
        rid, tid)
    if not row:
        raise HTTPException(404, "Pravilo nije pronadjeno")
    await log_event("automation.rule_delete", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req),
                    resource_type="automation_rule", resource_id=rid,
                    details={"name": row["name"]})
    return {"ok": True}


# ── Odvojena istorija automatizovanih izvrsavanja ───────────────────────────

@router.get("/{tid}/automation-rules/history")
async def list_automation_history(tid: str, limit: int = 20, offset: int = 0,
                                   user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    rows = await fetch(
        """SELECT e.id, e.script_name, e.status, e.server_count,
                  e.success_count, e.error_count, e.started_at, e.finished_at,
                  e.rule_id, r.name AS rule_name, r.trigger_type
           FROM executions e
           LEFT JOIN automation_rules r ON r.id = e.rule_id
           WHERE e.tenant_id=$1 AND e.trigger_source='automation'
           ORDER BY e.started_at DESC LIMIT $2 OFFSET $3""",
        tid, min(limit, 100), offset)
    return [dict(r) for r in rows]


@router.get("/{tid}/automation-rules/history/{eid}")
async def get_automation_execution(tid: str, eid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    e = await fetchrow(
        """SELECT e.*, r.name AS rule_name, r.trigger_type
           FROM executions e
           LEFT JOIN automation_rules r ON r.id = e.rule_id
           WHERE e.id=$1 AND e.tenant_id=$2 AND e.trigger_source='automation'""", eid, tid)
    if not e:
        return None
    results = await fetch(
        "SELECT * FROM execution_results WHERE execution_id=$1 ORDER BY server_name", eid)
    return dict(e) | {"results": [dict(r) for r in results]}
