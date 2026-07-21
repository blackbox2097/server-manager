# app/routers/admin.py
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, EmailStr
from app.database import fetch, fetchrow, execute, get_pool
from app.services.auth import require_superadmin, hash_password
from app.services.crypto import encrypt
from app.services.audit import log_event

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _ip(req: Request) -> str | None:
    return req.client.host if req.client else None


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
async def create_tenant(body: TenantIn, req: Request, user=Depends(require_superadmin)):
    try:
        row = await fetchrow(
            "INSERT INTO tenants (name,slug,color,description) VALUES ($1,$2,$3,$4) RETURNING *",
            body.name, body.slug.lower(), body.color, body.description)
        await log_event("tenant.create", user_id=user["id"], username=user.get("username"),
                        tenant_id=str(row["id"]), ip_address=_ip(req),
                        resource_type="tenant", resource_id=str(row["id"]),
                        details={"name": body.name, "slug": body.slug})
        return dict(row)
    except Exception as e:
        if "unique" in str(e).lower(): raise HTTPException(409, "Tenant vec postoji")
        if "check"  in str(e).lower(): raise HTTPException(400, "Neispravan slug format")
        raise HTTPException(500, str(e))


@router.put("/tenants/{tid}")
async def update_tenant(tid: str, body: TenantUp, req: Request, user=Depends(require_superadmin)):
    row = await fetchrow(
        "UPDATE tenants SET name=COALESCE($1,name), color=COALESCE($2,color), description=COALESCE($3,description), active=COALESCE($4,active) WHERE id=$5 RETURNING *",
        body.name, body.color, body.description, body.active, tid)
    if not row: raise HTTPException(404, "Tenant nije pronadjen")
    await log_event("tenant.update", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req),
                    resource_type="tenant", resource_id=tid,
                    details=body.model_dump(exclude_none=True))
    return dict(row)


@router.delete("/tenants/{tid}")
async def delete_tenant(tid: str, req: Request, user=Depends(require_superadmin)):
    row = await fetchrow("UPDATE tenants SET active=false WHERE id=$1 RETURNING id", tid)
    if not row: raise HTTPException(404, "Tenant nije pronadjen")
    await log_event("tenant.delete", user_id=user["id"], username=user.get("username"),
                    tenant_id=tid, ip_address=_ip(req), resource_type="tenant", resource_id=tid)
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
async def create_user(body: UserIn, req: Request, user=Depends(require_superadmin)):
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
        await log_event("user.create", user_id=user["id"], username=user.get("username"),
                        ip_address=_ip(req), resource_type="user", resource_id=str(row["id"]),
                        details={"username": body.username, "authType": body.authType})
        return dict(row)
    except Exception as e:
        if "unique" in str(e).lower(): raise HTTPException(409, "Username vec postoji")
        raise HTTPException(500, str(e))


@router.put("/users/{uid}")
async def update_user(uid: str, body: UserUp, req: Request, user=Depends(require_superadmin)):
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
    await log_event("user.update", user_id=user["id"], username=user.get("username"),
                    ip_address=_ip(req), resource_type="user", resource_id=uid,
                    details={"passwordChanged": bool(pw), **body.model_dump(exclude={"password"}, exclude_none=True)})
    return dict(row)


@router.delete("/users/{uid}")
async def delete_user(uid: str, req: Request, user=Depends(require_superadmin)):
    row = await fetchrow(
        "UPDATE users SET active=false WHERE id=$1 AND role='operator' RETURNING id", uid)
    if not row: raise HTTPException(404, "Operater nije pronadjen")
    await log_event("user.delete", user_id=user["id"], username=user.get("username"),
                    ip_address=_ip(req), resource_type="user", resource_id=uid)
    return {"ok": True}


@router.put("/users/{uid}/tenants")
async def assign_tenants(uid: str, body: AssignReq, req: Request, user=Depends(require_superadmin)):
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
    await log_event("user.tenant_assign", user_id=user["id"], username=user.get("username"),
                    ip_address=_ip(req), resource_type="user", resource_id=uid,
                    details={"tenantCount": len(body.assignments)})
    return {"ok": True, "assigned": len(body.assignments)}


@router.get("/audit")
async def audit(
    limit: int = 50, offset: int = 0, action: str | None = None,
    tenantId: str | None = None, userId: str | None = None,
    success: bool | None = None, search: str | None = None,
    dateFrom: str | None = None, dateTo: str | None = None,
    user=Depends(require_superadmin),
):
    cond, params = ["1=1"], []
    if action:
        params.append(f"{action}%"); cond.append(f"a.action LIKE ${len(params)}")
    if tenantId:
        params.append(tenantId); cond.append(f"a.tenant_id=${len(params)}")
    if userId:
        params.append(userId); cond.append(f"a.user_id=${len(params)}")
    if success is not None:
        params.append(success); cond.append(f"a.success=${len(params)}")
    if search:
        params.append(f"%{search}%")
        cond.append(f"(a.username ILIKE ${len(params)} OR a.resource_id ILIKE ${len(params)} OR a.details::text ILIKE ${len(params)} OR a.action ILIKE ${len(params)})")
    if dateFrom:
        params.append(dateFrom); cond.append(f"a.occurred_at >= ${len(params)}")
    if dateTo:
        params.append(dateTo); cond.append(f"a.occurred_at <= ${len(params)}")
    params += [min(limit, 500), offset]
    rows = await fetch(
        f"""SELECT a.*, t.name AS tenant_name FROM audit_log a
            LEFT JOIN tenants t ON t.id = a.tenant_id
            WHERE {' AND '.join(cond)}
            ORDER BY a.occurred_at DESC LIMIT ${len(params)-1} OFFSET ${len(params)}""",
        *params)
    return [dict(r) for r in rows]


@router.get("/audit/export")
async def export_audit(
    action: str | None = None, tenantId: str | None = None, userId: str | None = None,
    success: bool | None = None, search: str | None = None,
    dateFrom: str | None = None, dateTo: str | None = None,
    user=Depends(require_superadmin),
):
    import csv, io
    from datetime import datetime
    from fastapi.responses import StreamingResponse

    cond, params = ["1=1"], []
    if action:
        params.append(f"{action}%"); cond.append(f"a.action LIKE ${len(params)}")
    if tenantId:
        params.append(tenantId); cond.append(f"a.tenant_id=${len(params)}")
    if userId:
        params.append(userId); cond.append(f"a.user_id=${len(params)}")
    if success is not None:
        params.append(success); cond.append(f"a.success=${len(params)}")
    if search:
        params.append(f"%{search}%")
        cond.append(f"(a.username ILIKE ${len(params)} OR a.resource_id ILIKE ${len(params)} OR a.details::text ILIKE ${len(params)} OR a.action ILIKE ${len(params)})")
    if dateFrom:
        params.append(dateFrom); cond.append(f"a.occurred_at >= ${len(params)}")
    if dateTo:
        params.append(dateTo); cond.append(f"a.occurred_at <= ${len(params)}")
    rows = await fetch(
        f"""SELECT a.*, t.name AS tenant_name FROM audit_log a
            LEFT JOIN tenants t ON t.id = a.tenant_id
            WHERE {' AND '.join(cond)} ORDER BY a.occurred_at DESC LIMIT 5000""",
        *params)

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Vreme", "Akcija", "Korisnik", "Tenant", "Resurs tip", "Resurs ID", "Uspesno", "Greska", "Detalji"])
    for r in rows:
        writer.writerow([
            r["occurred_at"].isoformat() if r["occurred_at"] else "",
            r["action"], r["username"] or "", r["tenant_name"] or "",
            r["resource_type"] or "", r["resource_id"] or "",
            "DA" if r["success"] else "NE", r["error_message"] or "", r["details"] or "",
        ])
    buf.seek(0)
    filename = f"logovi_svi_tenanti_{datetime.now().strftime('%Y%m%d_%H%M')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


# ── SMTP podesavanja (globalno, superadmin) ──────────────────────────────────

class SmtpSettingsIn(BaseModel):
    host:      str
    port:      int = 587
    username:  str | None = None
    password:  str | None = None  # ako je prazno pri update-u, zadrzava se staro
    fromEmail: EmailStr
    fromName:  str = "Server Manager"
    useTls:    bool = True


class SmtpTestIn(BaseModel):
    to: EmailStr


@router.get("/smtp-settings")
async def get_smtp_settings(user=Depends(require_superadmin)):
    row = await fetchrow("SELECT * FROM smtp_settings WHERE id=1")
    if not row:
        return {"configured": False}
    d = dict(row)
    d.pop("password_enc", None)
    d["passwordSet"] = bool(row["password_enc"])
    return d


@router.put("/smtp-settings")
async def update_smtp_settings(body: SmtpSettingsIn, req: Request, user=Depends(require_superadmin)):
    pw_enc = encrypt(body.password) if body.password else None
    row = await fetchrow(
        """UPDATE smtp_settings SET
             host=$1, port=$2, username=$3,
             password_enc = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE password_enc END,
             from_email=$5, from_name=$6, use_tls=$7,
             configured=true, updated_at=NOW()
           WHERE id=1 RETURNING *""",
        body.host, body.port, body.username, pw_enc,
        str(body.fromEmail), body.fromName, body.useTls)
    d = dict(row)
    d.pop("password_enc", None)
    d["passwordSet"] = True

    await log_event("smtp.update", user_id=user["id"], username=user.get("username"),
                    ip_address=_ip(req), resource_type="smtp_settings",
                    details={"host": body.host, "port": body.port, "passwordChanged": bool(pw_enc)})
    return d


@router.post("/smtp-settings/test")
async def test_smtp_settings(body: SmtpTestIn, user=Depends(require_superadmin)):
    from app.services.notify import send_email
    ok = await send_email(
        [str(body.to)],
        "Server Manager — Test email",
        "<p>Ovo je test email iz Server Manager aplikacije. Ako ovo vidiš, SMTP podešavanja rade ispravno.</p>"
    )
    if not ok:
        raise HTTPException(400, "Slanje nije uspelo — proveri SMTP podešavanja i logove servera")
    return {"ok": True}
