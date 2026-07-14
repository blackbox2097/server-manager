# app/routers/servers.py
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form
from pydantic import BaseModel, field_validator
from app.database import fetch, fetchrow, execute
from app.services.auth import get_current_user, check_tenant_perm
from app.services.crypto import encrypt, decrypt, ssh_fingerprint

router = APIRouter(prefix="/api/tenants", tags=["servers"])

# prazan string -> None
def _n(v): return None if v == "" else v
def _uuid(v): return None if not v or v == "" else v


class ServerIn(BaseModel):
    name: str; ipAddress: str; osType: str
    description: str | None = None; hostname: str | None = None
    osName: str | None = None; environment: str = "production"; tags: list[str] = []
    sshPort: int = 22; sshUser: str | None = None; sshAuthType: str = "key"
    sshKeyId: str | None = None; sshPassword: str | None = None; sudoPassword: str | None = None
    winrmPort: int = 5985; winrmHttps: bool = False; winrmAuthType: str = "local"
    winrmUser: str | None = None; winrmPassword: str | None = None

    @field_validator("osType")
    @classmethod
    def check_os(cls, v):
        if v not in ("linux", "windows"): raise ValueError("linux ili windows")
        return v

    @field_validator("sshKeyId", "sshPassword", "sudoPassword", "winrmPassword",
                     "winrmUser", "sshUser", "hostname", "description", "osName", mode="before")
    @classmethod
    def empty_to_none(cls, v): return None if v == "" else v


class ServerUp(BaseModel):
    name: str | None = None; description: str | None = None; hostname: str | None = None
    ipAddress: str | None = None; osName: str | None = None; environment: str | None = None
    tags: list[str] | None = None
    sshPort: int | None = None; sshUser: str | None = None; sshAuthType: str | None = None
    sshKeyId: str | None = None; sshPassword: str | None = None; sudoPassword: str | None = None
    winrmPort: int | None = None; winrmHttps: bool | None = None; winrmAuthType: str | None = None
    winrmUser: str | None = None; winrmPassword: str | None = None

    @field_validator("sshKeyId", "sshPassword", "sudoPassword", "winrmPassword",
                     "winrmUser", "sshUser", "hostname", "description", "osName",
                     "ipAddress", "sshAuthType", "winrmAuthType", "environment", "name", mode="before")
    @classmethod
    def empty_to_none(cls, v): return None if v == "" else v


# ── Serveri ───────────────────────────────────────────────────────────────────

@router.get("/{tid}/servers")
async def list_servers(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    rows = await fetch(
        """SELECT s.id, s.name, s.description, s.hostname, s.ip_address,
                  s.os_type, s.os_name, s.tags, s.environment,
                  s.ssh_port, s.ssh_user, s.ssh_auth_type, s.ssh_key_id,
                  s.winrm_port, s.winrm_https, s.winrm_auth_type, s.winrm_user,
                  s.status, s.last_seen_at, s.last_error, s.active, s.created_at,
                  sk.name AS ssh_key_name,
                  (s.sudo_password IS NOT NULL) AS has_sudo_password,
                  m.cpu_percent, m.ram_percent, m.disk_percent, m.uptime_seconds, m.collected_at,
                  m.net_rx_kbps, m.net_tx_kbps, m.process_count
           FROM servers s
           LEFT JOIN ssh_keys sk ON sk.id=s.ssh_key_id
           LEFT JOIN LATERAL (
               SELECT cpu_percent, ram_percent, disk_percent, uptime_seconds, collected_at,
                      net_rx_kbps, net_tx_kbps, process_count
               FROM metrics WHERE server_id=s.id ORDER BY collected_at DESC LIMIT 1
           ) m ON true
           WHERE s.tenant_id=$1 AND s.active=true ORDER BY s.os_type, s.name""", tid)
    return [dict(r) for r in rows]


@router.post("/{tid}/servers", status_code=201)
async def create_server(tid: str, body: ServerIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_servers_manage")
    try:
        row = await fetchrow(
            """INSERT INTO servers
                 (tenant_id, name, description, hostname, ip_address, os_type, os_name,
                  tags, environment, ssh_port, ssh_user, ssh_auth_type, ssh_key_id,
                  ssh_password, sudo_password, winrm_port, winrm_https, winrm_auth_type,
                  winrm_user, winrm_password, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
               RETURNING id, name, ip_address, os_type, status""",
            tid, body.name, _n(body.description), _n(body.hostname), body.ipAddress,
            body.osType, _n(body.osName), body.tags, body.environment,
            body.sshPort, _n(body.sshUser), body.sshAuthType, _uuid(body.sshKeyId),
            encrypt(body.sshPassword)  if body.sshPassword  else None,
            encrypt(body.sudoPassword) if body.sudoPassword else None,
            body.winrmPort, body.winrmHttps, body.winrmAuthType,
            _n(body.winrmUser),
            encrypt(body.winrmPassword) if body.winrmPassword else None,
            user["id"])
        return dict(row)
    except Exception as e:
        if "unique" in str(e).lower(): raise HTTPException(409, "Server vec postoji u ovom tenantu")
        raise HTTPException(500, str(e))


@router.put("/{tid}/servers/{sid}")
async def update_server(tid: str, sid: str, body: ServerUp, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_servers_manage")
    row = await fetchrow(
        """UPDATE servers SET
             name=COALESCE($1,name), description=COALESCE($2,description),
             hostname=COALESCE($3,hostname), ip_address=COALESCE($4,ip_address),
             os_name=COALESCE($5,os_name), tags=COALESCE($6,tags),
             environment=COALESCE($7,environment),
             ssh_port=COALESCE($8,ssh_port), ssh_user=COALESCE($9,ssh_user),
             ssh_auth_type=COALESCE($10,ssh_auth_type), ssh_key_id=COALESCE($11,ssh_key_id),
             ssh_password  = CASE WHEN $12::text IS NOT NULL THEN $12 ELSE ssh_password END,
             sudo_password = CASE WHEN $13::text IS NOT NULL THEN $13 ELSE sudo_password END,
             winrm_port=COALESCE($14,winrm_port), winrm_https=COALESCE($15,winrm_https),
             winrm_auth_type=COALESCE($16,winrm_auth_type), winrm_user=COALESCE($17,winrm_user),
             winrm_password = CASE WHEN $18::text IS NOT NULL THEN $18 ELSE winrm_password END
           WHERE id=$19 AND tenant_id=$20 AND active=true
           RETURNING id, name, ip_address, os_type""",
        _n(body.name), _n(body.description), _n(body.hostname), _n(body.ipAddress),
        _n(body.osName), body.tags, _n(body.environment),
        body.sshPort, _n(body.sshUser), _n(body.sshAuthType), _uuid(body.sshKeyId),
        encrypt(body.sshPassword)   if body.sshPassword   else None,
        encrypt(body.sudoPassword)  if body.sudoPassword  else None,
        body.winrmPort, body.winrmHttps, _n(body.winrmAuthType), _n(body.winrmUser),
        encrypt(body.winrmPassword) if body.winrmPassword else None,
        sid, tid)
    if not row: raise HTTPException(404, "Server nije pronadjen")
    return dict(row)


@router.delete("/{tid}/servers/{sid}")
async def delete_server(tid: str, sid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_servers_manage")
    row = await fetchrow(
        "UPDATE servers SET active=false WHERE id=$1 AND tenant_id=$2 RETURNING id", sid, tid)
    if not row: raise HTTPException(404, "Server nije pronadjen")
    return {"ok": True}


@router.post("/{tid}/servers/{sid}/test")
async def test_server(tid: str, sid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    row = await fetchrow(
        """SELECT s.*, sk.private_key_enc, sk.key_file_path
           FROM servers s LEFT JOIN ssh_keys sk ON sk.id=s.ssh_key_id
           WHERE s.id=$1 AND s.tenant_id=$2 AND s.active=true""", sid, tid)
    if not row: raise HTTPException(404, "Server nije pronadjen")
    srv = dict(row)
    if srv.get("private_key_enc"): srv["_private_key"]    = decrypt(srv["private_key_enc"])
    if srv.get("ssh_password"):    srv["_ssh_password"]   = decrypt(srv["ssh_password"])
    if srv.get("sudo_password"):   srv["_sudo_password"]  = decrypt(srv["sudo_password"])
    if srv.get("winrm_password"):  srv["_winrm_password"] = decrypt(srv["winrm_password"])
    if srv["os_type"] == "windows":
        from app.services.winrm import test_connection
    else:
        from app.services.ssh import test_connection
    return await test_connection(srv)


@router.get("/{tid}/servers/{sid}/processes")
async def server_processes(tid: str, sid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    row = await fetchrow(
        """SELECT s.*, sk.private_key_enc, sk.key_file_path
           FROM servers s LEFT JOIN ssh_keys sk ON sk.id=s.ssh_key_id
           WHERE s.id=$1 AND s.tenant_id=$2 AND s.active=true""", sid, tid)
    if not row: raise HTTPException(404, "Server nije pronadjen")
    srv = dict(row)
    if srv.get("private_key_enc"): srv["_private_key"]    = decrypt(srv["private_key_enc"])
    if srv.get("ssh_password"):    srv["_ssh_password"]   = decrypt(srv["ssh_password"])
    if srv.get("sudo_password"):   srv["_sudo_password"]  = decrypt(srv["sudo_password"])
    if srv.get("winrm_password"):  srv["_winrm_password"] = decrypt(srv["winrm_password"])
    try:
        if srv["os_type"] == "windows":
            from app.services.winrm import list_processes
        else:
            from app.services.ssh import list_processes
        procs = await list_processes(srv)
        return {"osType": srv["os_type"], "processes": procs}
    except Exception as e:
        raise HTTPException(502, f"Ne mogu da dobijem listu procesa: {e}")


# ── SSH kljucevi ──────────────────────────────────────────────────────────────

@router.get("/{tid}/ssh-keys")
async def list_keys(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_keys_manage")
    rows = await fetch(
        """SELECT id, name, description, public_key, key_type, fingerprint,
                  key_file_path, created_at, last_used_at,
                  (SELECT COUNT(*) FROM servers WHERE ssh_key_id=ssh_keys.id) AS usage_count
           FROM ssh_keys WHERE tenant_id=$1 ORDER BY name""", tid)
    return [dict(r) for r in rows]


@router.post("/{tid}/ssh-keys", status_code=201)
async def create_key(
    tid: str,
    name: str = Form(...), description: str | None = Form(None),
    keyType: str = Form("ed25519"), keyFilePath: str | None = Form(None),
    privateKeyContent: str | None = Form(None), publicKeyContent: str | None = Form(None),
    privateKey: UploadFile | None = File(None), publicKey: UploadFile | None = File(None),
    user=Depends(get_current_user)
):
    await check_tenant_perm(tid, user, "perm_keys_manage")
    pk_enc = pub = fp = None
    if privateKey:
        pk_enc = encrypt((await privateKey.read()).decode())
    elif privateKeyContent:
        pk_enc = encrypt(privateKeyContent)
    elif not keyFilePath:
        raise HTTPException(400, "Potreban je kljuc ili putanja")
    if publicKey:
        pub = (await publicKey.read()).decode(); fp = ssh_fingerprint(pub)
    elif publicKeyContent:
        pub = publicKeyContent; fp = ssh_fingerprint(pub)
    try:
        row = await fetchrow(
            """INSERT INTO ssh_keys (tenant_id, name, description, public_key, private_key_enc,
                 key_type, fingerprint, key_file_path, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               RETURNING id, name, description, public_key, key_type, fingerprint, key_file_path, created_at""",
            tid, name, _n(description), pub, pk_enc, keyType, fp, _n(keyFilePath), user["id"])
        return dict(row)
    except Exception as e:
        if "unique" in str(e).lower(): raise HTTPException(409, "Kljuc vec postoji")
        raise HTTPException(500, str(e))


@router.delete("/{tid}/ssh-keys/{kid}")
async def delete_key(tid: str, kid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, "perm_keys_manage")
    u = await fetchrow("SELECT COUNT(*) AS c FROM servers WHERE ssh_key_id=$1", kid)
    if u and int(u["c"]) > 0:
        raise HTTPException(409, f"Kljuc je u upotrebi na {u['c']} servera")
    row = await fetchrow("DELETE FROM ssh_keys WHERE id=$1 AND tenant_id=$2 RETURNING id", kid, tid)
    if not row: raise HTTPException(404, "Kljuc nije pronadjen")
    return {"ok": True}
