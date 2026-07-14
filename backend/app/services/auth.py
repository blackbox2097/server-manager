# app/services/auth.py
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.config import get_settings
from app.database import fetchrow

bearer = HTTPBearer()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(12)).decode()


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False


def make_access_token(user_id: str, role: str, username: str) -> str:
    cfg = get_settings()
    raw = cfg.jwt_expires_in
    if raw.endswith("h"):
        delta = timedelta(hours=int(raw[:-1]))
    elif raw.endswith("m"):
        delta = timedelta(minutes=int(raw[:-1]))
    else:
        delta = timedelta(hours=8)
    payload = {
        "sub":  str(user_id),
        "role": role,
        "name": username,
        "exp":  datetime.now(timezone.utc) + delta,
    }
    return jwt.encode(payload, cfg.jwt_secret, algorithm="HS256")


def make_refresh_token() -> str:
    return secrets.token_hex(48)


async def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
) -> dict[str, Any]:
    cfg = get_settings()
    try:
        payload = jwt.decode(creds.credentials, cfg.jwt_secret, algorithms=["HS256"])
    except JWTError as e:
        msg = "Token je istekao" if "expired" in str(e) else "Nevazeci token"
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=msg)

    row = await fetchrow(
        "SELECT id, username, role, active FROM users WHERE id = $1", payload["sub"]
    )
    if not row or not row["active"]:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Korisnik ne postoji ili je deaktiviran")

    return {"id": str(row["id"]), "username": row["username"],
            "role": row["role"], "name": payload.get("name", "")}


def require_superadmin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "superadmin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Samo superadmin moze ovo")
    return user


async def check_tenant_perm(tenant_id: str, user: dict, perm: str | None = None):
    if user["role"] == "superadmin":
        return
    row = await fetchrow(
        """SELECT perm_view, perm_scripts_run, perm_scripts_manage,
                  perm_servers_manage, perm_keys_manage
           FROM operator_tenants WHERE operator_id = $1 AND tenant_id = $2""",
        user["id"], tenant_id
    )
    if not row:
        raise HTTPException(403, "Nemate pristup ovom tenantu")
    if perm and not row[perm]:
        raise HTTPException(403, f"Nemate dozvolu: {perm}")
