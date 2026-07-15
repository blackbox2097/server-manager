# app/routers/schedules.py
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, field_validator

from app.database import fetch, fetchrow, execute
from app.services.auth import get_current_user, check_tenant_perm
from app.services.scheduler import (
    register_job, unregister_job, get_next_run
)
from app.services.executor import run as executor_run

router = APIRouter(prefix="/api/tenants", tags=["schedules"])


class ScheduleIn(BaseModel):
    name:           str
    scriptId:       str
    serverIds:      list[str]
    cronExpression: str
    active:         bool = True

    @field_validator("serverIds")
    @classmethod
    def not_empty(cls, v):
        if not v:
            raise ValueError("Odaberi bar jedan server")
        return v


class ScheduleUp(BaseModel):
    name:           str | None = None
    scriptId:       str | None = None
    serverIds:      list[str] | None = None
    cronExpression: str | None = None
    active:         bool | None = None


async def _with_next_run(rows) -> list[dict]:
    out = []
    for r in rows:
        d = dict(r)
        nr = get_next_run(str(d["id"])) if d["active"] else None
        d["next_run_at"] = nr.isoformat() if nr else None
        out.append(d)
    return out


@router.get("/{tid}/schedules")
async def list_schedules(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    rows = await fetch(
        """SELECT sj.*, s.name AS script_name, u.username AS created_by_name,
                  e.status AS last_status
           FROM scheduled_jobs sj
           JOIN scripts s ON s.id = sj.script_id
           LEFT JOIN users u ON u.id = sj.created_by
           LEFT JOIN executions e ON e.id = sj.last_execution_id
           WHERE sj.tenant_id = $1
           ORDER BY sj.name""", tid)
    return await _with_next_run(rows)


@router.post("/{tid}/schedules", status_code=201)
async def create_schedule(tid: str, body: ScheduleIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_manage")

    script = await fetchrow("SELECT id FROM scripts WHERE id=$1 AND tenant_id=$2", body.scriptId, tid)
    if not script:
        raise HTTPException(404, "Skripta nije pronadjena")

    servers = await fetch(
        "SELECT id FROM servers WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND active=true",
        tid, body.serverIds)
    if len(servers) != len(body.serverIds):
        raise HTTPException(400, "Jedan ili vise odabranih servera ne postoji u ovom tenantu")

    try:
        row = await fetchrow(
            """INSERT INTO scheduled_jobs (tenant_id, name, script_id, server_ids, cron_expression, active, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *""",
            tid, body.name, body.scriptId, body.serverIds,
            body.cronExpression, body.active, user["id"])
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(409, "Zakazani posao sa tim nazivom vec postoji")
        raise HTTPException(500, str(e))

    job = dict(row)
    if job["active"]:
        try:
            register_job(job)
        except ValueError as e:
            await execute("DELETE FROM scheduled_jobs WHERE id=$1", job["id"])
            raise HTTPException(400, str(e))

    return job


@router.put("/{tid}/schedules/{sid}")
async def update_schedule(tid: str, sid: str, body: ScheduleUp, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_manage")

    if body.scriptId:
        script = await fetchrow("SELECT id FROM scripts WHERE id=$1 AND tenant_id=$2", body.scriptId, tid)
        if not script:
            raise HTTPException(404, "Skripta nije pronadjena")

    if body.serverIds is not None:
        if not body.serverIds:
            raise HTTPException(400, "Odaberi bar jedan server")
        servers = await fetch(
            "SELECT id FROM servers WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND active=true",
            tid, body.serverIds)
        if len(servers) != len(body.serverIds):
            raise HTTPException(400, "Jedan ili vise odabranih servera ne postoji u ovom tenantu")

    row = await fetchrow(
        """UPDATE scheduled_jobs SET
             name            = COALESCE($1, name),
             script_id       = COALESCE($2, script_id),
             server_ids      = COALESCE($3, server_ids),
             cron_expression = COALESCE($4, cron_expression),
             active          = COALESCE($5, active)
           WHERE id=$6 AND tenant_id=$7 RETURNING *""",
        body.name, body.scriptId, body.serverIds, body.cronExpression, body.active,
        sid, tid)
    if not row:
        raise HTTPException(404, "Zakazani posao nije pronadjen")

    job = dict(row)
    unregister_job(sid)
    if job["active"]:
        try:
            register_job(job)
        except ValueError as e:
            raise HTTPException(400, str(e))

    return job


@router.delete("/{tid}/schedules/{sid}")
async def delete_schedule(tid: str, sid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_manage")
    row = await fetchrow("DELETE FROM scheduled_jobs WHERE id=$1 AND tenant_id=$2 RETURNING id", sid, tid)
    if not row:
        raise HTTPException(404, "Zakazani posao nije pronadjen")
    unregister_job(sid)
    return {"ok": True}


@router.post("/{tid}/schedules/{sid}/toggle")
async def toggle_schedule(tid: str, sid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_manage")
    row = await fetchrow(
        "UPDATE scheduled_jobs SET active = NOT active WHERE id=$1 AND tenant_id=$2 RETURNING *",
        sid, tid)
    if not row:
        raise HTTPException(404, "Zakazani posao nije pronadjen")

    job = dict(row)
    if job["active"]:
        try:
            register_job(job)
        except ValueError as e:
            raise HTTPException(400, str(e))
    else:
        unregister_job(sid)

    return job


@router.post("/{tid}/schedules/{sid}/run-now")
async def run_schedule_now(tid: str, sid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_run")
    row = await fetchrow(
        """SELECT sj.*, s.name AS script_name, s.content AS script_content
           FROM scheduled_jobs sj JOIN scripts s ON s.id = sj.script_id
           WHERE sj.id=$1 AND sj.tenant_id=$2""", sid, tid)
    if not row:
        raise HTTPException(404, "Zakazani posao nije pronadjen")

    exec_id = await executor_run(
        tenant_id      = tid,
        server_ids     = [str(s) for s in row["server_ids"]],
        content        = row["script_content"],
        script_name    = f"[Rucno pokrenuto] {row['script_name']}",
        script_id      = str(row["script_id"]),
        started_by     = user["id"],
    )
    await execute(
        "UPDATE scheduled_jobs SET last_run_at=NOW(), last_execution_id=$1 WHERE id=$2",
        exec_id, sid
    )
    return {"executionId": exec_id}
