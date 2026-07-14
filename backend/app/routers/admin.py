# app/routers/admin.py
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from app.database import fetch, fetchrow, execute, get_pool
from app.services.auth import require_superadmin, hash_password

router = APIRouter(prefix="/api/admin", tags=["admin"])


class TenantIn(BaseModel):
    name: str; slug: str; color: str = "#378ADD"; description: str | None = None

class TenantUp(BaseModel):
    name: str | None = None; color: str | None = None
    description: str | None = None; active: bool | None = None

class UserIn(BaseModel):
    username: str; password: str | None = None; fullName: str | None = None
    email: str | None = None; authType: str = "local"; ldapDn: str | None = None

class UserUp(BaseModel):
    fullName: str | None = None; email: str | None = None
    active: bool | None = None; password: str | None = None

class Assignment(BaseModel):
    tenantId: str; permScriptsRun: bool = False; permScriptsManage: bool = False
    permServersManage: bool = False; permKeysManage: bool = False

class AssignReq(BaseModel):
    assignments: list[Assignment]


# ── Tenanti ───────────────────────────────────────────────────────────────────

@router.get("/tenants")
async def list_tenants(user=Depends(require_superadmin)):
    rows = await fetch(
        """SELECT t.*, COUNT(DISTINCT s.id) FILTER (WHERE s.active) AS server_count,
                  COUNT(DISTINCT ot.operator_id) AS operator_count
           FROM tenants t LEFT JOIN servers s ON s.tenant_id=t.id
           LEFT JOIN operator_tenants ot ON ot.tenant_id=t.id
           GROUP BY t.id ORDER BY t.name""")
    return [dict(r) for r in rows]


@router.post("/tenants", status_code=201)
async def create_tenant(body: TenantIn, user=Depends(require_superadmin)):
    try:
        row = await fetchrow(
            "INSERT INTO tenants (name,slug,color,description) VALUES ($1,$2,$3,$4) RETURNING *",
            body.name, body.slug.lower(), body.color, body.description)
        return dict(row)
    except Exception as e:
        if "unique" in str(e).lower(): raise HTTPException(409, "Tenant vec postoji")
        if "check"  in str(e).lower(): raise HTTPException(400, "Neispravan slug format")
        raise HTTPException(500, str(e))


@router.put("/tenants/{tid}")
async def update_tenant(tid: str, body: TenantUp, user=Depends(require_superadmin)):
    row = await fetchrow(
        "UPDATE tenants SET name=COALESCE($1,name), color=COALESCE($2,color), description=COALESCE($3,description), active=COALESCE($4,active) WHERE id=$5 RETURNING *",
        body.name, body.color, body.description, body.active, tid)
    if not row: raise HTTPException(404, "Tenant nije pronadjen")
    return dict(row)


@router.delete("/tenants/{tid}")
async def delete_tenant(tid: str, user=Depends(require_superadmin)):
    row = await fetchrow("UPDATE tenants SET active=false WHERE id=$1 RETURNING id", tid)
    if not row: raise HTTPException(404, "Tenant nije pronadjen")
    return {"ok": True}


# ── Korisnici ─────────────────────────────────────────────────────────────────

@router.get("/users")
async def list_users(user=Depends(require_superadmin)):
    rows = await fetch(
        """SELECT u.id, u.username, u.full_name, u.email, u.role, u.auth_type,
                  u.active, u.last_login_at, u.last_login_ip, u.created_at,
                  COALESCE(json_agg(json_build_object(
                      'tenantId', t.id, 'tenantName', t.name, 'tenantColor', t.color,
                      'permView', ot.perm_view, 'permScriptsRun', ot.perm_scripts_run,
                      'permScriptsManage', ot.perm_scripts_manage,
                      'permServersManage', ot.perm_servers_manage,
                      'permKeysManage', ot.perm_keys_manage
                  )) FILTER (WHERE t.id IS NOT NULL), '[]') AS tenants
           FROM users u
           LEFT JOIN operator_tenants ot ON ot.operator_id=u.id
           LEFT JOIN tenants t ON t.id=ot.tenant_id
           GROUP BY u.id ORDER BY u.role, u.username""")
    return [dict(r) for r in rows]


@router.post("/users", status_code=201)
async def create_user(body: UserIn, user=Depends(require_superadmin)):
    if not body.username:
        raise HTTPException(400, "username je obavezan")
    if body.authType == "local":
        if not body.password: raise HTTPException(400, "password je obavezan")
        if len(body.password) < 10: raise HTTPException(400, "Minimum 10 karaktera")
    if body.authType == "ldap" and not body.ldapDn:
        raise HTTPException(400, "ldapDn je obavezan za LDAP")
    pw = hash_password(body.password) if body.authType == "local" and body.password else None
    try:
        row = await fetchrow(
            """INSERT INTO users (username, password_hash, full_name, email, role, auth_type, ldap_dn, created_by)
               VALUES ($1,$2,$3,$4,'operator',$5,$6,$7)
               RETURNING id, username, full_name, role, auth_type, active, created_at""",
            body.username, pw, body.fullName, body.email, body.authType, body.ldapDn, user["id"])
        return dict(row)
    except Exception as e:
        if "unique" in str(e).lower(): raise HTTPException(409, "Username vec postoji")
        raise HTTPException(500, str(e))


@router.put("/users/{uid}")
async def update_user(uid: str, body: UserUp, user=Depends(require_superadmin)):
    pw = None
    if body.password:
        if len(body.password) < 10: raise HTTPException(400, "Minimum 10 karaktera")
        pw = hash_password(body.password)
    row = await fetchrow(
        """UPDATE users SET full_name=COALESCE($1,full_name), email=COALESCE($2,email),
           active=COALESCE($3,active), password_hash=COALESCE($4,password_hash)
           WHERE id=$5 AND role='operator' RETURNING id, username, full_name, email, active""",
        body.fullName, body.email, body.active, pw, uid)
    if not row: raise HTTPException(404, "Operater nije pronadjen")
    return dict(row)


@router.delete("/users/{uid}")
async def delete_user(uid: str, user=Depends(require_superadmin)):
    row = await fetchrow(
        "UPDATE users SET active=false WHERE id=$1 AND role='operator' RETURNING id", uid)
    if not row: raise HTTPException(404, "Operater nije pronadjen")
    return {"ok": True}


@router.put("/users/{uid}/tenants")
async def assign_tenants(uid: str, body: AssignReq, user=Depends(require_superadmin)):
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("DELETE FROM operator_tenants WHERE operator_id=$1", uid)
            for a in body.assignments:
                await conn.execute(
                    """INSERT INTO operator_tenants
                         (operator_id, tenant_id, perm_view, perm_scripts_run, perm_scripts_manage,
                          perm_servers_manage, perm_keys_manage, assigned_by)
                       VALUES ($1,$2,true,$3,$4,$5,$6,$7)""",
                    uid, a.tenantId, a.permScriptsRun, a.permScriptsManage,
                    a.permServersManage, a.permKeysManage, user["id"])
    return {"ok": True, "assigned": len(body.assignments)}


@router.get("/audit")
async def audit(limit: int = 50, offset: int = 0, action: str | None = None,
                user=Depends(require_superadmin)):
    cond, params = ["1=1"], []
    if action:
        params.append(action); cond.append(f"action=${len(params)}")
    params += [min(limit, 200), offset]
    rows = await fetch(
        f"SELECT * FROM audit_log WHERE {' AND '.join(cond)} ORDER BY occurred_at DESC LIMIT ${len(params)-1} OFFSET ${len(params)}",
        *params)
    return [dict(r) for r in rows]
