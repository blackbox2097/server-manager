# app/services/esxi.py -- ESXi/vCenter konektor preko pyVmomi (VMware SOAP/VIM API).
#
# pyVmomi-ov SmartConnect() je transportno identican bez obzira da li se
# konektujes direktno na standalone ESXi host ili na vCenter Server -- isti
# kod radi za oba slucaja. Jedina razlika: vCenter moze da upravlja VISE
# hostova odjednom, sto kvari pretpostavku "jedan server unos = jedan host".
#
# Zato: ako endpoint vrati TACNO JEDAN host (standalone ESXi, ili vCenter
# koji upravlja samo jednim hostom) -- radi normalno. Ako vrati VISE hostova
# (vCenter sa flotom), baca jasnu gresku umesto da nagadja koji host
# prikazati -- ista filozofija kao Proxmox multi-node zastita.
#
# NAPOMENA: multi-host (cluster) podrska namerno nije implementirana u ovoj
# verziji -- vidi gornji komentar.

import asyncio
import ssl
import time
import logging

logger = logging.getLogger(__name__)


class EsxiConnectionError(Exception):
    """Konekcija/autentikacija ka ESXi/vCenter-u nije uspela."""
    pass


def _ssl_context(server: dict):
    if server.get("hv_verify_tls", True):
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS)
    ctx.verify_mode = ssl.CERT_NONE
    ctx.check_hostname = False
    return ctx


def _connect(server: dict):
    """Vraca ServiceInstance (si). Pozivalac je odgovoran za Disconnect(si)."""
    from pyVim.connect import SmartConnect

    host = server.get("hv_api_host")
    user = server.get("hv_auth_id")
    pwd  = server.get("_hv_secret")
    if not host or not user or not pwd:
        raise EsxiConnectionError("Nedostaju ESXi/vCenter kredencijali (host/korisnik/lozinka)")

    port = server.get("hv_api_port") or 443
    try:
        si = SmartConnect(
            host=host, port=port, user=user, pwd=pwd,
            sslContext=_ssl_context(server),
            connectionPoolTimeout=15,
        )
    except Exception as e:
        raise EsxiConnectionError(str(e)) from e
    return si


def _get_single_host(si):
    """Vraca jedini HostSystem, ili baca gresku ako ih ima 0 ili vise od 1."""
    from pyVmomi import vim
    content = si.RetrieveContent()
    view = content.viewManager.CreateContainerView(content.rootFolder, [vim.HostSystem], True)
    hosts = list(view.view)
    view.Destroy()

    if not hosts:
        raise EsxiConnectionError("Nijedan ESXi host nije pronadjen preko API-ja")
    if len(hosts) > 1:
        raise EsxiConnectionError(
            f"Endpoint upravlja sa {len(hosts)} hostova (vCenter cluster) -- "
            "multi-host podrska jos nije implementirana, ocekuje se single-host."
        )
    return hosts[0]


async def get_metrics(server: dict) -> dict:
    """Host-nivo metrike. Vraca isti oblik kao ssh.py/proxmox.py get_metrics."""
    start = time.time()

    def _run():
        from pyVim.connect import Disconnect
        si = _connect(server)
        try:
            host = _get_single_host(si)
            summary = host.summary
            hw = summary.hardware
            qs = summary.quickStats

            cpu_mhz_total = (hw.cpuMhz or 0) * (hw.numCpuCores or 0)
            cpu_used_mhz  = qs.overallCpuUsage or 0
            cpu_percent   = round((cpu_used_mhz / cpu_mhz_total) * 100) if cpu_mhz_total else 0

            mem_total_mb = round((hw.memorySize or 0) / (1024 * 1024))
            mem_used_mb  = qs.overallMemoryUsage or 0
            ram_percent  = round((mem_used_mb / mem_total_mb) * 100) if mem_total_mb else 0

            product = summary.config.product if summary.config else None
            os_name = product.fullName if product else "VMware ESXi"

            disks = []
            total_disk_gb = None
            try:
                for ds in host.datastore:
                    cap = ds.summary.capacity
                    free = ds.summary.freeSpace
                    if cap:
                        pct = round(((cap - free) / cap) * 100)
                        disks.append({"name": ds.summary.name, "percent": min(100, max(0, pct))})
                if disks:
                    total_disk_gb = round(
                        sum(ds.summary.capacity for ds in host.datastore) / (1024 ** 3)
                    )
            except Exception:
                pass
            disk_percent = max((d["percent"] for d in disks), default=0)

            return {
                "cpuPercent": min(100, max(0, cpu_percent)),
                "ramPercent": min(100, max(0, ram_percent)),
                "diskPercent": disk_percent,
                "disks": disks,
                "uptimeSeconds": int(qs.uptime or 0),
                "loadAvg1m": None, "loadAvg5m": None, "loadAvg15m": None,
                "netRxBytes": 0,
                "netTxBytes": 0,
                "processCount": None,
                "osName": os_name,
                "totalCpuCores": hw.numCpuCores,
                "totalRamMb": mem_total_mb,
                "totalDiskGb": total_disk_gb,
            }
        finally:
            Disconnect(si)

    try:
        return await asyncio.get_event_loop().run_in_executor(None, _run)
    except EsxiConnectionError:
        raise
    except Exception as e:
        raise EsxiConnectionError(str(e)) from e


async def list_vms(server: dict) -> list[dict]:
    """Lista VM-ova na (jedinom) hostu. IP adresa dostupna samo ako VMware Tools
    radi u gostu -- isto ogranicenje kao kod Proxmox QEMU Guest Agent-a."""

    def _run():
        from pyVim.connect import Disconnect
        from pyVmomi import vim
        si = _connect(server)
        try:
            _get_single_host(si)  # samo da potvrdi single-host, ne koristimo direktno

            content = si.RetrieveContent()
            view = content.viewManager.CreateContainerView(content.rootFolder, [vim.VirtualMachine], True)
            vms_raw = list(view.view)
            view.Destroy()

            power_map = {"poweredOn": "running", "poweredOff": "stopped", "suspended": "paused"}
            vms = []
            for vm in vms_raw:
                try:
                    summary = vm.summary
                    cfg = summary.config
                    runtime = summary.runtime
                    guest = summary.guest
                    disk_gb = None
                    try:
                        disk_kb = sum(
                            d.capacityInKB for d in vm.config.hardware.device
                            if isinstance(d, vim.vm.device.VirtualDisk)
                        )
                        disk_gb = round(disk_kb / (1024 ** 2)) if disk_kb else None
                    except Exception:
                        disk_gb = None
                    vms.append({
                        "vmIdOnHost": str(cfg.instanceUuid or cfg.uuid or vm._moId),
                        "name": cfg.name,
                        "powerState": power_map.get(str(runtime.powerState), "unknown"),
                        "cpuCores": cfg.numCpu,
                        "ramMb": cfg.memorySizeMB,
                        "diskGb": disk_gb,
                        "guestOs": cfg.guestFullName,
                        "ipAddress": guest.ipAddress if guest else None,
                    })
                except Exception:
                    continue
            return vms
        finally:
            Disconnect(si)

    try:
        return await asyncio.get_event_loop().run_in_executor(None, _run)
    except EsxiConnectionError:
        raise
    except Exception as e:
        raise EsxiConnectionError(str(e)) from e


async def test_connection(server: dict) -> dict:
    """Test konekcije -- isti oblik odgovora kao ssh.py/proxmox.py test_connection."""
    start = time.time()

    def _run():
        from pyVim.connect import Disconnect
        si = _connect(server)
        try:
            host = _get_single_host(si)
            return host.name
        finally:
            Disconnect(si)

    try:
        hostname = await asyncio.get_event_loop().run_in_executor(None, _run)
        return {"ok": True, "hostname": hostname, "durationMs": int((time.time() - start) * 1000)}
    except Exception as e:
        return {"ok": False, "error": str(e), "durationMs": int((time.time() - start) * 1000)}
