# conn_dispatch.py -- centralni sloj za izbor SSH vs WinRM vs hipervizor API po serveru.
#
# server["os_type"] == "proxmox" (kasnije "esxi"/"hyperv" za API-bazirane)
#   -> ide direktno na odgovarajuci hipervizor konektor, connection_method
#      se ne primenjuje (nije SSH/WinRM izbor).
#
# server["connection_method"] moze biti:
#   "ssh"   -- uvek SSH, bez fallback-a
#   "winrm" -- uvek WinRM (korisnik eksplicitno forsira)
#   "auto"  -- (default) probaj SSH; ako SSH KONEKCIJA ne uspe (SSHConnectionError)
#              i server je Windows, padni na WinRM. Linux serveri nemaju WinRM
#              fallback (nije primenjivo), pa se greska samo propagira dalje.
#
# Ovo NE hvata greske same skripte/komande (npr. exitCode != 0) -- samo
# greske na nivou same konekcije (server ugasen, pogresna lozinka, port
# zatvoren, itd), zahvaljujuci SSHConnectionError iz ssh.py.

import logging
from app.services import ssh
from app.services.ssh import SSHConnectionError

logger = logging.getLogger(__name__)

_UNSUPPORTED_MSG = "Ova operacija nije podrzana za hipervizore."


def _method(server: dict) -> str:
    return server.get("connection_method") or "auto"


async def get_metrics(server: dict) -> dict:
    if server.get("os_type") == "proxmox":
        from app.services.proxmox import get_metrics as proxmox_get_metrics
        return await proxmox_get_metrics(server)

    method = _method(server)
    if method == "winrm":
        from app.services.winrm import get_metrics as winrm_get_metrics
        return await winrm_get_metrics(server)
    if method == "ssh" or server.get("os_type") != "windows":
        return await ssh.get_metrics(server)
    # auto + windows
    try:
        return await ssh.get_metrics(server)
    except SSHConnectionError as e:
        logger.warning(f"SSH konekcija neuspesna za {server.get('name')}, fallback na WinRM: {e}")
        from app.services.winrm import get_metrics as winrm_get_metrics
        return await winrm_get_metrics(server)


async def execute_script(server: dict, script_content: str) -> dict:
    if server.get("os_type") in ("proxmox", "esxi", "hyperv"):
        return {"exitCode": -1, "stdout": "", "stderr": _UNSUPPORTED_MSG, "durationMs": 0}

    method = _method(server)
    if method == "winrm":
        from app.services.winrm import execute_script as winrm_execute_script
        return await winrm_execute_script(server, script_content)
    if method == "ssh" or server.get("os_type") != "windows":
        return await ssh.execute_script(server, script_content)
    # auto + windows
    try:
        return await ssh.execute_script(server, script_content)
    except SSHConnectionError as e:
        logger.warning(f"SSH konekcija neuspesna za {server.get('name')}, fallback na WinRM: {e}")
        from app.services.winrm import execute_script as winrm_execute_script
        return await winrm_execute_script(server, script_content)


async def test_connection(server: dict) -> dict:
    if server.get("os_type") == "proxmox":
        from app.services.proxmox import test_connection as proxmox_test_connection
        return await proxmox_test_connection(server)

    method = _method(server)
    if method == "winrm":
        from app.services.winrm import test_connection as winrm_test_connection
        return await winrm_test_connection(server)
    if method == "ssh" or server.get("os_type") != "windows":
        return await ssh.test_connection(server)
    # auto + windows
    try:
        return await ssh.test_connection(server)
    except SSHConnectionError as e:
        logger.warning(f"SSH konekcija neuspesna za {server.get('name')}, fallback na WinRM: {e}")
        from app.services.winrm import test_connection as winrm_test_connection
        return await winrm_test_connection(server)


async def list_processes(server: dict, limit: int = 50) -> list[dict]:
    if server.get("os_type") in ("proxmox", "esxi", "hyperv"):
        raise RuntimeError(_UNSUPPORTED_MSG)

    method = _method(server)
    if method == "winrm":
        from app.services.winrm import list_processes as winrm_list_processes
        return await winrm_list_processes(server, limit)
    if method == "ssh" or server.get("os_type") != "windows":
        return await ssh.list_processes(server, limit)
    # auto + windows
    try:
        return await ssh.list_processes(server, limit)
    except SSHConnectionError as e:
        logger.warning(f"SSH konekcija neuspesna za {server.get('name')}, fallback na WinRM: {e}")
        from app.services.winrm import list_processes as winrm_list_processes
        return await winrm_list_processes(server, limit)
