# app/services/terminal.py
# Interaktivna SSH terminal sesija — bridge izmedju WebSocket-a i Paramiko shell-a
# Radi identicno za Linux i Windows (ako Windows ima OpenSSH server + PowerShell shell)

import asyncio
import logging
import paramiko

from app.services.ssh import _connect  # koristi istu connect logiku kao izvrsavanje skripti

logger = logging.getLogger(__name__)


class TerminalSession:
    def __init__(self, server: dict):
        self.server  = server
        self.client: paramiko.SSHClient | None = None
        self.channel: paramiko.Channel | None  = None
        self._closed = False

    async def start(self, cols: int = 80, rows: int = 24):
        loop = asyncio.get_event_loop()

        def _open():
            client = _connect(self.server)
            chan = client.invoke_shell(term="xterm-256color", width=cols, height=rows)
            chan.settimeout(0.0)
            return client, chan

        self.client, self.channel = await loop.run_in_executor(None, _open)

    def resize(self, cols: int, rows: int):
        if self.channel:
            try:
                self.channel.resize_pty(width=cols, height=rows)
            except Exception:
                pass

    async def send(self, data: str):
        if self.channel and not self._closed:
            loop = asyncio.get_event_loop()
            try:
                await loop.run_in_executor(None, self.channel.send, data)
            except Exception:
                pass

    async def read_loop(self, on_data):
        """Cita output iz shell-a i prosledjuje ga preko on_data callback-a."""
        loop = asyncio.get_event_loop()

        def _recv():
            try:
                if self.channel.recv_ready():
                    return self.channel.recv(4096)
                if self.channel.exit_status_ready():
                    return None
            except Exception:
                return None
            return b""

        while not self._closed:
            data = await loop.run_in_executor(None, _recv)
            if data is None:
                break
            if data:
                await on_data(data)
            else:
                await asyncio.sleep(0.05)

    def close(self):
        self._closed = True
        try:
            if self.channel:
                self.channel.close()
        except Exception:
            pass
        try:
            if self.client:
                self.client.close()
        except Exception:
            pass
