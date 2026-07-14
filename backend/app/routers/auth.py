# app/routers/auth.py
from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel
from app.database import fetchrow, fetch, execute
from app.services.auth import (
    verify_password, hash_password, make_access_token,
    make_refresh_token, get_current_user
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


async def _tenants_for(user_id: str, role: str) -> list:
    if role == "superadmin":
        rows = await fetch(
            """SELECT id, name, slug, color,
                      true AS perm_view, true AS perm_scripts_run, true AS perm_scripts_manage,
                      true AS perm_servers_manage, true AS perm_keys_manage
               FROM tenants WHERE active=true ORDER BY name""")
    else:
        rows = await fetch(
            """SELECT t.id, t.name, t.slug, t.color,
                      ot.perm_view, ot.perm_scripts_run, ot.perm_scripts_manage,
                      ot.perm_servers_manage, ot.perm_keys_manage
               FROM operator_tenants ot JOIN tenants t ON t.id=ot.tenant_id
               WHERE ot.operator_id=$1 AND t.active=true ORDER BY t.name""", user_id)
    return [dict(r) for r in rows]


class LoginReq(BaseModel):
    username: str
    password: str

class RefreshReq(BaseModel):
    refreshToken: str

class LogoutReq(BaseModel):
    refreshToken: str | None = None

class ChangePwReq(BaseModel):
    currentPassword: str
    newPassword: str


@router.post("/login")
async def login(body: LoginReq, req: Request):
    user = await fetchrow(
        "SELECT id, username, password_hash, full_name, role, auth_type, active FROM users WHERE username=$1",
        body.username)
    if not user or not user["active"]:
        verify_password("dummy", "$2b$12$dummy_hash_to_prevent_timing")
        raise HTTPException(401, "Pogresan username ili password")
    if user["auth_type"] == "ldap":
        raise HTTPException(400, "Koristite LDAP login")
    if not verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Pogresan username ili password")

    access  = make_access_token(str(user["id"]), user["role"], user["username"])
    refresh = make_refresh_token()
    await execute(
        "INSERT INTO user_sessions (user_id, refresh_token, ip_address, user_agent) VALUES ($1,$2,$3,$4)",
        user["id"], refresh,
        req.client.host if req.client else None,
        req.headers.get("user-agent"))
    await execute("UPDATE users SET last_login_at=NOW(), last_login_ip=$1 WHERE id=$2",
                  req.client.host if req.client else None, user["id"])
    tenants = await _tenants_for(str(user["id"]), user["role"])
    return {
        "accessToken": access, "refreshToken": refresh,
        "user": {"id": str(user["id"]), "username": user["username"],
                 "fullName": user["full_name"], "role": user["role"]},
        "tenants": tenants,
    }


@router.post("/refresh")
async def refresh(body: RefreshReq, req: Request):
    s = await fetchrow(
        """SELECT s.*, u.id AS uid, u.username, u.role, u.active
           FROM user_sessions s JOIN users u ON u.id=s.user_id
           WHERE s.refresh_token=$1 AND s.revoked_at IS NULL AND s.expires_at>NOW()""",
        body.refreshToken)
    if not s or not s["active"]:
        raise HTTPException(401, "Nevazeci refresh token")
    na = make_access_token(str(s["uid"]), s["role"], s["username"])
    nr = make_refresh_token()
    await execute("UPDATE user_sessions SET revoked_at=NOW() WHERE id=$1", s["id"])
    await execute(
        "INSERT INTO user_sessions (user_id, refresh_token, ip_address, user_agent) VALUES ($1,$2,$3,$4)",
        s["user_id"], nr, req.client.host if req.client else None, req.headers.get("user-agent"))
    return {"accessToken": na, "refreshToken": nr}


@router.post("/logout")
async def logout(body: LogoutReq, user: dict = Depends(get_current_user)):
    if body.refreshToken:
        await execute(
            "UPDATE user_sessions SET revoked_at=NOW() WHERE refresh_token=$1 AND user_id=$2",
            body.refreshToken, user["id"])
    return {"ok": True}


@router.post("/change-password")
async def change_pw(body: ChangePwReq, user: dict = Depends(get_current_user)):
    if len(body.newPassword) < 10:
        raise HTTPException(400, "Minimum 10 karaktera")
    row = await fetchrow("SELECT password_hash, auth_type FROM users WHERE id=$1", user["id"])
    if not row or row["auth_type"] == "ldap":
        raise HTTPException(400, "LDAP korisnici ne mogu mijenjati lozinku ovdje")
    if not verify_password(body.currentPassword, row["password_hash"]):
        raise HTTPException(400, "Trenutna lozinka nije ispravna")
    await execute("UPDATE users SET password_hash=$1 WHERE id=$2", hash_password(body.newPassword), user["id"])
    await execute("UPDATE user_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL", user["id"])
    return {"ok": True}


@router.get("/me")
async def me(user: dict = Depends(get_current_user)):
    row = await fetchrow(
        "SELECT id, username, full_name, email, role, last_login_at FROM users WHERE id=$1", user["id"])
    if not row:
        raise HTTPException(404, "Korisnik nije pronadjen")
    tenants = await _tenants_for(str(row["id"]), row["role"])
    return {"user": dict(row), "tenants": tenants}
