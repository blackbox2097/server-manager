# app/services/ws_manager.py
import json, logging
from datetime import datetime
from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WSManager:
    def __init__(self):
        self._clients: dict[WebSocket, dict] = {}

    async def connect(self, ws: WebSocket, user_id: str, role: str, tenant_ids: list | None):
        self._clients[ws] = {"user_id": user_id, "role": role, "tenant_ids": tenant_ids}
        await ws.send_text(json.dumps({
            "event": "connected",
            "data":  {"userId": user_id, "role": role},
            "ts":    datetime.utcnow().isoformat(),
        }))

    def disconnect(self, ws: WebSocket):
        self._clients.pop(ws, None)

    async def broadcast(self, event: str, data, tenant_id: str | None = None):
        msg  = json.dumps({"event": event, "data": data, "ts": datetime.utcnow().isoformat()})
        dead = []
        for ws, meta in self._clients.items():
            if tenant_id and meta["tenant_ids"] is not None:
                if tenant_id not in meta["tenant_ids"]:
                    continue
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.pop(ws, None)


ws_manager = WSManager()
