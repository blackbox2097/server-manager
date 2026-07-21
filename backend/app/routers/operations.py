# app/routers/operations.py
from fastapi import APIRouter, HTTPException, Depends, Query, Request
from pydantic import BaseModel
from app.database import fetch, fetchrow, execute
from app.services.auth import get_current_user, check_tenant_perm
from app.services.executor import run, list_execs, get_exec
from app.services.audit import log_event

router = APIRouter(prefix="/api/tenants", tags=["operations"])


def _ip(req: Request) -> str | None: return req.client.host if req.client else None


class ScriptIn(BaseModel):
    name: str; content: str
    description: str | None = None; osType: str = "linux"

class ScriptUp(BaseModel):
    name: str | None = None; description: str | None = None
    osType: str | None = None; content: str | None = None

class ExecReq(BaseModel):
    serverIds: list[str]
    scriptId: str | None = None; scriptContent: str | None = None; scriptName: str | None = None


@router.get("/{tid}/scripts")
async def list_scripts(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    rows = await fetch(
        """SELECT s.id, s.name, s.description, s.os_type, s.content, s.is_builtin,
                  s.created_at, u.username AS created_by_name
           FROM scripts s LEFT JOIN users u ON u.id=s.created_by
           WHERE s.tenant_id=$1 ORDER BY s.is_builtin DESC, s.name""", tid)
    return [dict(r) for r in rows]


@router.post("/{tid}/scripts", status_code=201)
async def create_script(tid: str, body: ScriptIn, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_manage")
    try:
        row = await fetchrow(
            "INSERT INTO scripts (tenant_id, name, description, os_type, content, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
            tid, body.name, body.description, body.osType, body.content, user["id"])
        await log_event("script.create", user_id=user["id"], username=user.get("username"),
                        tenant_id=tid, ip_address=_ip(req),
                        resource_type="script", resource_id=str(row["id"]), details={"name": body.name})
        return dict(row)
    except Exception as e:
        if "unique" in str(e).lower(): raise HTTPException(409, "Skripta vec postoji")
        raise HTTPException(500, str(e))


@router.put("/{tid}/scripts/{scid}")
async def update_script(tid: str, scid: str, body: ScriptUp, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_manage")
    row = await fetchrow(
        """UPDATE scripts SET name=COALESCE($1,name), description=COALESCE($2,description),
           os_type=COALESCE($3,os_type), content=COALESCE($4,content)
           WHERE id=$5 AND tenant_id=$6 AND is_builtin=false RETURNING *""",
        body.name, body.description, body.osType, body.content, scid, tid)
    if not row: raise HTTPException(404, "Skripta nije pronadjena ili je sistemska")
    await log_event("script.update", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req),
                    resource_type="script", resource_id=scid, details={"name": row["name"]})
    return dict(row)


@router.delete("/{tid}/scripts/{scid}")
async def delete_script(tid: str, scid: str, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_manage")
    row = await fetchrow(
        "DELETE FROM scripts WHERE id=$1 AND tenant_id=$2 AND is_builtin=false RETURNING id, name", scid, tid)
    if not row: raise HTTPException(404, "Skripta nije pronadjena ili je sistemska")
    await log_event("script.delete", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req),
                    resource_type="script", resource_id=scid, details={"name": row["name"]})
    return {"ok": True}


@router.post("/{tid}/execute")
async def execute_script(tid: str, body: ExecReq, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_scripts_run")
    if not body.serverIds: raise HTTPException(400, "Nisi odabrao nijedan server")
    content = body.scriptContent
    name    = body.scriptName or "Ad-hoc"
    if body.scriptId and not content:
        row = await fetchrow("SELECT content, name FROM scripts WHERE id=$1 AND tenant_id=$2", body.scriptId, tid)
        if not row: raise HTTPException(404, "Skripta nije pronadjena")
        content = row["content"]; name = row["name"]
    if not content or not content.strip():
        raise HTTPException(400, "Sadrzaj skripte je prazan")
    try:
        eid = await run(tid, body.serverIds, content, name, body.scriptId, user["id"],
                       started_by_username=user.get("username"))
        return {"executionId": eid, "message": f"Pokrenuto na {len(body.serverIds)} servera"}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/{tid}/executions")
async def executions(tid: str, limit: int = Query(20, ge=1, le=100),
                     offset: int = Query(0, ge=0), user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    return await list_execs(tid, limit, offset)


@router.get("/{tid}/executions/{eid}")
async def execution(tid: str, eid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    data = await get_exec(eid, tid)
    if not data: raise HTTPException(404, "Execution nije pronadjen")
    return data
