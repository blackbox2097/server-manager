# app/routers/monitoring.py
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, Depends, Query
from jose import JWTError, jwt
from app.config import get_settings
from app.database import fetchrow, fetch
from app.services.auth import get_current_user, check_tenant_perm
from app.services.ws_manager import ws_manager
from app.services.monitor import get_latest, get_history, poll_single

router = APIRouter(tags=["monitoring"])


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = Query(...)):
    cfg = get_settings()
    try:
        payload = jwt.decode(token, cfg.jwt_secret, algorithms=["HS256"])
    except JWTError:
        await ws.close(code=1008)
        return
    uid  = payload.get("sub")
    role = payload.get("role")
    if role == "superadmin":
        tids = None
    else:
        rows = await fetch("SELECT tenant_id FROM operator_tenants WHERE operator_id=$1", uid)
        tids = [str(r["tenant_id"]) for r in rows]
    await ws.accept()
    await ws_manager.connect(ws, uid, role, tids)
    try:
        while True:
            data = await ws.receive_text()
            if data == '{"type":"ping"}':
                await ws.send_text('{"event":"pong"}')
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)
    except Exception:
        ws_manager.disconnect(ws)


@router.get("/api/tenants/{tid}/monitoring")
async def monitoring(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    return await get_latest(tid)


@router.get("/api/tenants/{tid}/monitoring/{sid}/history")
async def history(tid: str, sid: str, limit: int = Query(60, ge=1, le=1440),
                  user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    row = await fetchrow("SELECT id FROM servers WHERE id=$1 AND tenant_id=$2 AND active=true", sid, tid)
    if not row: raise HTTPException(404, "Server nije pronadjen")
    return await get_history(sid, limit)


@router.post("/api/tenants/{tid}/monitoring/{sid}/poll")
async def manual_poll(tid: str, sid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    try:
        return await poll_single(sid)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))
