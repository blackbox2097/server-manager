# app/routers/terminal.py
import asyncio
import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from jose import jwt, JWTError

from app.config import get_settings
from app.database import fetchrow
from app.services.crypto import decrypt
from app.services.auth import check_tenant_perm
from app.services.terminal import TerminalSession
from app.services.audit import log_event

router = APIRouter(tags=["terminal"])
logger = logging.getLogger(__name__)


@router.websocket("/ws/terminal/{tenant_id}/{server_id}")
async def terminal_ws(ws: WebSocket, tenant_id: str, server_id: str, token: str = Query(...)):
    cfg = get_settings()
    try:
        payload = jwt.decode(token, cfg.jwt_secret, algorithms=["HS256"])
    except JWTError as e:
        logger.warning(f"Terminal WS: JWT decode neuspesan: {e}")
        await ws.close(code=1008)
        return

    user = {"id": payload["sub"], "role": payload.get("role")}
    username = payload.get("name")

    try:
        await check_tenant_perm(tenant_id, user, "perm_scripts_run")
    except Exception as e:
        logger.warning(f"Terminal WS: check_tenant_perm neuspesan (tenant={tenant_id}, user={user}): {e}")
        await ws.close(code=1008)
        return

    try:
        row = await fetchrow(
            """SELECT s.*, sk.private_key_enc, sk.key_file_path
               FROM servers s LEFT JOIN ssh_keys sk ON sk.id = s.ssh_key_id
               WHERE s.id = $1 AND s.tenant_id = $2 AND s.active = true""",
            server_id, tenant_id
        )
    except Exception as e:
        logger.error(f"Terminal WS: greska pri fetchrow (server={server_id}, tenant={tenant_id}): {e}")
        await ws.close(code=1011)
        return

    if not row:
        logger.warning(f"Terminal WS: server nije pronadjen (server={server_id}, tenant={tenant_id})")
        await ws.close(code=1008)
        return

    srv = dict(row)
    if not srv.get("ssh_user"):
        await ws.accept()
        await ws.send_text("\r\n\x1b[31mServer nema podesen SSH nalog — terminal nije dostupan.\x1b[0m\r\n")
        await ws.close(code=1011)
        return

    if srv.get("private_key_enc"):
        srv["_private_key"] = decrypt(srv["private_key_enc"])
    if srv.get("ssh_password"):
        srv["_ssh_password"] = decrypt(srv["ssh_password"])

    await ws.accept()
    session = TerminalSession(srv)

    try:
        await session.start()
    except Exception as e:
        await ws.send_text(f"\r\n\x1b[31mGreska konekcije: {e}\x1b[0m\r\n")
        await log_event("terminal.connect", user_id=user["id"], username=username,
                        tenant_id=tenant_id, resource_type="server", resource_id=server_id,
                        details={"serverName": srv["name"]}, success=False, error_message=str(e))
        await ws.close(code=1011)
        return

    connect_ts = time.time()
    await log_event("terminal.connect", user_id=user["id"], username=username,
                    tenant_id=tenant_id, resource_type="server", resource_id=server_id,
                    details={"serverName": srv["name"], "ipAddress": str(srv["ip_address"])})

    async def on_data(data: bytes):
        try:
            await ws.send_text(data.decode("utf-8", errors="replace"))
        except Exception:
            pass

    reader_task = asyncio.create_task(session.read_loop(on_data))

    try:
        while True:
            msg = await ws.receive_text()
            try:
                envelope = json.loads(msg)
            except Exception:
                continue

            mtype = envelope.get("type")
            if mtype == "input":
                await session.send(envelope.get("data", ""))
            elif mtype == "resize":
                session.resize(int(envelope.get("cols", 80)), int(envelope.get("rows", 24)))
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"Terminal WS greska: {e}")
    finally:
        reader_task.cancel()
        session.close()
        duration_s = round(time.time() - connect_ts)
        await log_event("terminal.disconnect", user_id=user["id"], username=username,
                        tenant_id=tenant_id, resource_type="server", resource_id=server_id,
                        details={"serverName": srv["name"], "durationSeconds": duration_s})
