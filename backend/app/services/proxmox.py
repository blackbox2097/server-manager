# app/services/proxmox.py -- Proxmox VE konektor preko REST API-ja (api2/json).
#
# Autentikacija: API Token (preporuceno od strane Proxmox-a umesto lozinke).
# Token format u Proxmox UI-ju: Datacenter -> Permissions -> API Tokens.
#   hv_auth_id     = "user@realm!tokenname" (npr. "root@pam!servermanager")
#   hv_secret_enc  = enkriptovan token secret (isti crypto.py mehanizam kao
#                    ostale lozinke)
#
# NAPOMENA o klasterima: ova prva verzija pretpostavlja single-node Proxmox
# (uzima prvi node iz /nodes odgovora). Ako API vrati vise od jednog node-a,
# bacamo jasnu gresku umesto da tiho pogresno izaberemo -- multi-node/cluster
# podrska je namerno ostavljena za kasnije.

import logging
import httpx

logger = logging.getLogger(__name__)


class ProxmoxConnectionError(Exception):
    """Konekcija/autentikacija ka Proxmox API-ju nije uspela."""
    pass


def _client(server: dict) -> httpx.AsyncClient:
    auth_id = server.get("hv_auth_id")
    secret = server.get("_hv_secret")  # vec dekriptovano od strane pozivaoca (isti obrazac kao _ssh_password)
    host = server.get("hv_api_host")
    if not auth_id or not secret or not host:
        raise ProxmoxConnectionError("Nedostaju Proxmox API kredencijali (host/auth_id/secret)")

    port = server.get("hv_api_port") or 8006
    base_url = f"https://{host}:{port}/api2/json"

    return httpx.AsyncClient(
        base_url=base_url,
        headers={"Authorization": f"PVEAPIToken={auth_id}={secret}"},
        verify=server.get("hv_verify_tls", True),
        timeout=15.0,
    )


async def _get_single_node(client: httpx.AsyncClient) -> str:
    r = await client.get("/nodes")
    r.raise_for_status()
    nodes = r.json().get("data", [])
    if not nodes:
        raise ProxmoxConnectionError("Proxmox API nije vratio nijedan node")
    if len(nodes) > 1:
        raise ProxmoxConnectionError(
            f"Proxmox API vraca {len(nodes)} node-ova (cluster) -- "
            "multi-node podrska jos nije implementirana, ocekuje se single-node."
        )
    return nodes[0]["node"]


async def get_metrics(server: dict) -> dict:
    """Host-nivo metrike Proxmox node-a. Vraca isti oblik kao ssh.py/winrm.py
    get_metrics -- uklapa se u postojeci monitor.py poll ciklus bez izmena."""
    try:
        async with _client(server) as client:
            node = await _get_single_node(client)

            r = await client.get(f"/nodes/{node}/status")
            r.raise_for_status()
            s = r.json()["data"]

            cpu_percent = round((s.get("cpu") or 0) * 100)
            mem = s.get("memory", {})
            mem_total = mem.get("total") or 0
            mem_used = mem.get("used") or 0
            ram_percent = round((mem_used / mem_total) * 100) if mem_total else 0

            rootfs = s.get("rootfs", {})
            disk_total = rootfs.get("total") or 0
            disk_used = rootfs.get("used") or 0
            disk_percent = round((disk_used / disk_total) * 100) if disk_total else 0

            loadavg = s.get("loadavg") or []
            cpuinfo = s.get("cpuinfo", {})

            return {
                "cpuPercent": min(100, cpu_percent),
                "ramPercent": min(100, ram_percent),
                "diskPercent": min(100, disk_percent),
                "disks": [],
                "uptimeSeconds": int(s.get("uptime") or 0),
                "loadAvg1m": float(loadavg[0]) if len(loadavg) > 0 else None,
                "loadAvg5m": float(loadavg[1]) if len(loadavg) > 1 else None,
                "loadAvg15m": float(loadavg[2]) if len(loadavg) > 2 else None,
                "netRxBytes": 0,
                "netTxBytes": 0,
                "processCount": None,
                "osName": f"Proxmox VE {s.get('pveversion', '')}".strip(),
                # dodatna polja za total_cpu_cores/total_ram_mb/total_disk_gb
                # kolone na servers tabeli -- monitor.py hook ih cita ako postoje
                "totalCpuCores": cpuinfo.get("cpus"),
                "totalRamMb": round(mem_total / (1024 * 1024)) if mem_total else None,
                "totalDiskGb": round(disk_total / (1024 ** 3)) if disk_total else None,
            }
    except httpx.HTTPStatusError as e:
        raise ProxmoxConnectionError(f"Proxmox API HTTP greska: {e.response.status_code}") from e
    except httpx.RequestError as e:
        raise ProxmoxConnectionError(f"Proxmox API konekcija neuspesna: {e}") from e


async def list_vms(server: dict) -> list[dict]:
    """Lista VM-ova (qemu) i kontejnera (lxc) na Proxmox node-u.
    Vraca listu dict-ova spremnih za upis u virtual_machines tabelu."""
    try:
        async with _client(server) as client:
            node = await _get_single_node(client)
            vms: list[dict] = []

            r = await client.get(f"/nodes/{node}/qemu")
            r.raise_for_status()
            for vm in r.json().get("data", []):
                vms.append({
                    "vmIdOnHost": str(vm["vmid"]),
                    "name": vm.get("name") or f"vm-{vm['vmid']}",
                    "powerState": vm.get("status", "unknown"),
                    "cpuCores": vm.get("cpus"),
                    "ramMb": round(vm["maxmem"] / (1024 * 1024)) if vm.get("maxmem") else None,
                    "diskGb": round(vm["maxdisk"] / (1024 ** 3)) if vm.get("maxdisk") else None,
                    "guestOs": None,
                    "ipAddress": None,
                    "vmType": "vm",
                })

            r = await client.get(f"/nodes/{node}/lxc")
            r.raise_for_status()
            for ct in r.json().get("data", []):
                vms.append({
                    "vmIdOnHost": str(ct["vmid"]),
                    "name": ct.get("name") or f"ct-{ct['vmid']}",
                    "powerState": ct.get("status", "unknown"),
                    "cpuCores": ct.get("cpus"),
                    "ramMb": round(ct["maxmem"] / (1024 * 1024)) if ct.get("maxmem") else None,
                    "diskGb": round(ct["maxdisk"] / (1024 ** 3)) if ct.get("maxdisk") else None,
                    "guestOs": "LXC",
                    "ipAddress": None,
                    "vmType": "container",
                })

            return vms
    except httpx.HTTPStatusError as e:
        raise ProxmoxConnectionError(f"Proxmox API HTTP greska: {e.response.status_code}") from e
    except httpx.RequestError as e:
        raise ProxmoxConnectionError(f"Proxmox API konekcija neuspesna: {e}") from e


async def test_connection(server: dict) -> dict:
    """Test konekcije -- isti oblik odgovora kao ssh.py/winrm.py test_connection."""
    import time
    start = time.time()
    try:
        async with _client(server) as client:
            node = await _get_single_node(client)
        return {"ok": True, "hostname": node, "durationMs": int((time.time() - start) * 1000)}
    except Exception as e:
        return {"ok": False, "error": str(e), "durationMs": int((time.time() - start) * 1000)}
