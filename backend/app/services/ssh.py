# app/services/ssh.py
import asyncio
import io
import random
import shlex
import string
import time
import logging
from typing import Any

import paramiko
import re
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization
from app.config import get_settings

logger = logging.getLogger(__name__)


class SSHConnectionError(Exception):
    """Konekcija (handshake/auth/mreza) nije uspela -- za razliku od greske
    u samoj komandi/skripti koja se izvrsava posle uspesne konekcije.
    Koristi se za auto-fallback SSH -> WinRM."""
    pass


def _connect(server: dict) -> paramiko.SSHClient:
    cfg      = get_settings()
    auth     = server.get("ssh_auth_type") or "key"
    client   = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    kw: dict[str, Any] = {
        "hostname":       str(server["ip_address"]),
        "port":           int(server.get("ssh_port") or 22),
        "username":       server.get("ssh_user"),
        "timeout":        cfg.ssh_connect_timeout_ms / 1000,
        "look_for_keys":  False,
        "allow_agent":    False,
    }

    if auth in ("key", "key_and_password"):
        pk = server.get("_private_key")
        if pk:
            buf = io.StringIO(pk)
            for cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
                try:
                    buf.seek(0)
                    kw["pkey"] = cls.from_private_key(buf)
                    break
                except Exception:
                    continue
        elif server.get("key_file_path"):
            kw["key_filename"] = server["key_file_path"]

    if auth in ("password", "key_and_password"):
        pw = server.get("_ssh_password")
        if pw:
            kw["password"] = pw

    try:
        client.connect(**kw)
    except Exception as e:
        raise SSHConnectionError(str(e)) from e
    return client


def _exec(client: paramiko.SSHClient, cmd: str, timeout: int = 60) -> tuple[str, str, int]:
    _, out, err = client.exec_command(cmd, timeout=timeout)
    code = out.channel.recv_exit_status()
    return (out.read().decode("utf-8", errors="replace"),
            err.read().decode("utf-8", errors="replace"),
            code)


def _write_remote(client: paramiko.SSHClient, path: str, content: str, mode: int = 0o700):
    """Piše fajl na remote server kroz SFTP — pouzdanije od exec_command stdin pipe-a."""
    sftp = client.open_sftp()
    try:
        with sftp.open(path, "w") as f:
            f.write(content)
            f.flush()
        sftp.chmod(path, mode)
    finally:
        sftp.close()


async def _get_metrics_linux(server: dict) -> dict:
    def _run():
        client = _connect(server)
        try:
            cmd = "\n".join([
                "set -e",
                'echo "---CPU---"',
                "cpu=$(top -bn2 -d0.5 | grep 'Cpu(s)' | tail -1 | awk '{print $2+$4}' | tr -d '%')",
                'printf "%s\\n" "${cpu:-0}"',
                'echo "---RAM---"',
                "free | awk '/^Mem:/{printf \"%.0f\\n\", ($3/$2)*100}'",
                'echo "---DISKS---"',
                # Sve realne particije (bez virtuelnih fs kao tmpfs/overlay), format: mount|procenat
                "df -x tmpfs -x devtmpfs -x squashfs -x overlay -x proc -x sysfs -x cgroup -x cgroup2 "
                "--output=target,pcent 2>/dev/null | tail -n +2 | awk '{gsub(\"%\",\"\",$NF); print $1\"|\"$NF}'",
                'echo "---UPTIME---"',
                "awk '{print int($1)}' /proc/uptime",
                'echo "---LOAD---"',
                "awk '{print $1,$2,$3}' /proc/loadavg",
                'echo "---NET---"',
                "awk 'NR>2{gsub(\":\",\" \"); if ($1!=\"lo\"){rx+=$2; tx+=$10}} END{print rx\"|\"tx}' /proc/net/dev",
                'echo "---PROCS---"',
                "ps -e --no-headers | wc -l",
                'echo "---OSNAME---"',
                ". /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\" || uname -sr",
                'echo "---VIRT---"',
                "systemd-detect-virt 2>/dev/null || echo none",
            ])
            stdout, stderr, code = _exec(client, cmd)
            if code != 0 and stderr and not stdout:
                raise RuntimeError(stderr[:200])

            # Parsiraj izlaz u sekcije po ---MARKER--- oznakama (podrzava vise linija po sekciji)
            sections: dict[str, list[str]] = {}
            current = None
            for raw in stdout.split("\n"):
                line = raw.strip()
                if line.startswith("---") and line.endswith("---") and len(line) > 6:
                    current = line.strip("-")
                    sections[current] = []
                elif current is not None:
                    if line:
                        sections[current].append(line)

            def first(key, default="0"):
                vals = sections.get(key, [])
                return vals[0] if vals else default

            disks = []
            for line in sections.get("DISKS", []):
                if "|" not in line:
                    continue
                name, pct = line.rsplit("|", 1)
                try:
                    disks.append({"name": name, "percent": min(100, max(0, float(pct)))})
                except ValueError:
                    continue
            system_disk = next((d for d in disks if d["name"] == "/"), None)
            disk_percent = system_disk["percent"] if system_disk else max((d["percent"] for d in disks), default=0)

            load = first("LOAD").split()
            net_parts = first("NET").split("|")

            return {
                "cpuPercent":    min(100, max(0, float(first("CPU") or 0))),
                "ramPercent":    min(100, max(0, int(first("RAM") or 0))),
                "diskPercent":   disk_percent,
                "disks":         disks,
                "uptimeSeconds": int(first("UPTIME") or 0),
                "loadAvg1m":     float(load[0]) if load else 0,
                "loadAvg5m":     float(load[1]) if len(load) > 1 else 0,
                "loadAvg15m":    float(load[2]) if len(load) > 2 else 0,
                "netRxBytes":    int(net_parts[0]) if len(net_parts) > 0 and net_parts[0].isdigit() else 0,
                "netTxBytes":    int(net_parts[1]) if len(net_parts) > 1 and net_parts[1].isdigit() else 0,
                "processCount":  int(first("PROCS") or 0),
                "osName":        first("OSNAME") or "Linux",
                "virtType":      first("VIRT", "unknown"),
            }
        finally:
            client.close()

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def _execute_script_linux(server: dict, script_content: str) -> dict:
    cfg = get_settings()

    def _run():
        start  = time.time()
        client = _connect(server)
        try:
            rand    = "".join(random.choices(string.ascii_lowercase, k=8))
            ts      = int(time.time() * 1000)
            tmp     = f"/tmp/.sm_{ts}_{rand}.sh"
            sudo_pw = server.get("_sudo_password")
            ssh_user = server.get("ssh_user", "")

            _write_remote(client, tmp, script_content)

            if sudo_pw and ssh_user != "root":
                askpass = f"/tmp/.sm_ask_{ts}.sh"
                wrapper = f"/tmp/.sm_wrap_{ts}.sh"

                _write_remote(client, askpass, f"#!/bin/bash\necho {sudo_pw!r}\n")
                _write_remote(client, wrapper, (
                    f"#!/bin/bash\n"
                    f"export SUDO_ASKPASS={askpass}\n"
                    f"sudo -A bash {tmp}\n"
                    f"EC=$?\n"
                    f"rm -f {askpass} {wrapper} {tmp} 2>/dev/null\n"
                    f"exit $EC\n"
                ))
                cmd = f"bash {wrapper}"
            else:
                cmd = f"bash {tmp}; EC=$?; rm -f {tmp}; exit $EC"

            stdout, stderr, code = _exec(
                client, cmd,
                timeout=cfg.ssh_exec_timeout_ms // 1000
            )
            stderr = "\n".join(
                l for l in stderr.splitlines()
                if not l.startswith("[sudo]")
            ).strip()

            return {"exitCode": code, "stdout": stdout,
                    "stderr": stderr, "durationMs": int((time.time()-start)*1000)}
        except Exception as e:
            return {"exitCode": -1, "stdout": "",
                    "stderr": f"Greska konekcije: {e}",
                    "durationMs": int((time.time()-start)*1000)}
        finally:
            client.close()

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def _list_processes_linux(server: dict, limit: int = 50) -> list[dict]:
    def _run():
        client = _connect(server)
        try:
            cmd = f"ps -eo pid,comm,pcpu,pmem,rss --no-headers --sort=-pcpu | head -{limit}"
            stdout, stderr, code = _exec(client, cmd, timeout=15)
            if code != 0 and stderr and not stdout:
                raise RuntimeError(stderr[:200])

            procs = []
            for line in stdout.strip().split("\n"):
                parts = line.split()
                if len(parts) < 5:
                    continue
                try:
                    procs.append({
                        "pid":    int(parts[0]),
                        "name":   parts[1],
                        "cpu":    float(parts[2]),
                        "mem":    float(parts[3]),
                        "rssKb":  int(parts[4]),
                    })
                except ValueError:
                    continue
            return procs
        finally:
            client.close()

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def _test_connection_linux(server: dict) -> dict:
    def _run():
        start = time.time()
        client = _connect(server)
        try:
            out, _, _ = _exec(client, "echo sm_ok && hostname", timeout=5)
            ok = out.startswith("sm_ok")
            hn = out.split("\n")[1].strip() if ok and "\n" in out else None
            return {"ok": ok, "hostname": hn,
                    "durationMs": int((time.time()-start)*1000)}
        except Exception as e:
            return {"ok": False, "error": str(e),
                    "durationMs": int((time.time()-start)*1000)}
        finally:
            client.close()

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def _get_metrics_windows(server: dict) -> dict:
    """Windows metrike preko SSH (PowerShell skripta se upise kao .ps1 i izvrsi).
    Zamena za winrm.get_metrics -- izbegava unencrypted WinRM basic auth."""
    ps_lines = [
        "$ErrorActionPreference='SilentlyContinue'",
        "$cpu=[math]::Round((Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average)",
        "$os=Get-CimInstance Win32_OperatingSystem",
        "$ram=[math]::Round((($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/$os.TotalVisibleMemorySize)*100)",
        "$diskParts=@()",
        "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | ForEach-Object {",
        "  if ($_.Size -gt 0) { $p=[math]::Round((($_.Size-$_.FreeSpace)/$_.Size)*100) } else { $p=0 }",
        "  $diskParts += \"$($_.DeviceID)=$p\"",
        "}",
        "$disksStr=($diskParts -join ';'); if (-not $disksStr) { $disksStr='NONE' }",
        "$diskMax=0",
        "foreach ($dp in $diskParts) { $v=[int]($dp.Split('=')[1]); if ($v -gt $diskMax) { $diskMax=$v } }",
        "$up=[int]((Get-Date)-$os.LastBootUpTime).TotalSeconds",
        "$procs=(Get-Process).Count",
        "$netStats=Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Where-Object {$_.ReceivedBytes -gt 0 -or $_.SentBytes -gt 0}",
        "$rx=($netStats | Measure-Object -Property ReceivedBytes -Sum).Sum",
        "$tx=($netStats | Measure-Object -Property SentBytes -Sum).Sum",
        "if (-not $rx) {$rx=0}; if (-not $tx) {$tx=0}",
        "$cs=Get-CimInstance Win32_ComputerSystem",
        "$model=$cs.Model",
        "$mfg=$cs.Manufacturer",
        "Write-Output \"SM_CPU:$cpu|SM_RAM:$ram|SM_DISK:$diskMax|SM_DISKS:$disksStr|SM_UP:$up|SM_PROCS:$procs|SM_RX:$rx|SM_TX:$tx|SM_OS:$($os.Caption)|SM_MODEL:$model|SM_MFG:$mfg\"",
    ]
    ps_script = "\r\n".join(ps_lines) + "\r\n"

    def _run():
        client = _connect(server)
        try:
            rand = "".join(random.choices(string.ascii_lowercase, k=8))
            ts   = int(time.time() * 1000)
            tmp  = f"C:/Windows/Temp/.sm_{ts}_{rand}.ps1"
            _write_remote(client, tmp, ps_script, mode=0o700)
            cmd = (
                f'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{tmp}"'
            )
            stdout, stderr, code = _exec(client, cmd, timeout=30)
            try:
                sftp = client.open_sftp()
                sftp.remove(tmp)
                sftp.close()
            except Exception:
                pass
            if "SM_CPU" not in stdout:
                raise RuntimeError(stderr[:200] or "SSH Windows metrike neuspjesne")

            def g(k):
                m = re.search(rf"SM_{k}:([^|\r\n]+)", stdout)
                return m.group(1).strip() if m else None

            disks = []
            disks_raw = g("DISKS")
            if disks_raw and disks_raw != "NONE":
                for part in disks_raw.split(";"):
                    if "=" not in part:
                        continue
                    name, pct = part.split("=", 1)
                    try:
                        disks.append({"name": name, "percent": min(100, max(0, float(pct)))})
                    except ValueError:
                        continue
            model_str = f"{g('MFG') or ''} {g('MODEL') or ''}".lower()
            if "qemu" in model_str or "kvm" in model_str:
                virt_type = "kvm"
            elif "vmware" in model_str:
                virt_type = "vmware"
            elif "virtual machine" in model_str:
                virt_type = "microsoft"
            elif "virtualbox" in model_str or "innotek" in model_str:
                virt_type = "oracle"
            elif "xen" in model_str:
                virt_type = "xen"
            else:
                virt_type = "none"
            return {
                "cpuPercent": min(100, int(g("CPU") or 0)),
                "ramPercent": min(100, int(g("RAM") or 0)),
                "diskPercent": min(100, int(g("DISK") or 0)),
                "disks": disks,
                "uptimeSeconds": int(g("UP") or 0),
                "loadAvg1m": None, "loadAvg5m": None, "loadAvg15m": None,
                "netRxBytes": int(g("RX") or 0),
                "netTxBytes": int(g("TX") or 0),
                "processCount": int(g("PROCS") or 0),
                "osName": g("OS") or "Windows",
                "virtType": virt_type,
            }
        finally:
            client.close()
    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def get_metrics(server: dict) -> dict:
    """Dispatch po os_type -- Linux, Windows i Hyper-V (host je Windows) idu preko SSH (paramiko)."""
    if server.get("os_type") in ("windows", "hyperv"):
        return await _get_metrics_windows(server)
    return await _get_metrics_linux(server)


async def _execute_script_windows(server: dict, script_content: str) -> dict:
    """Izvrsava PowerShell skriptu na Windows serveru preko SSH (paramiko).
    Zamena za winrm.execute_script."""
    cfg = get_settings()
    def _run():
        start  = time.time()
        client = _connect(server)
        try:
            rand = "".join(random.choices(string.ascii_lowercase, k=8))
            ts   = int(time.time() * 1000)
            tmp  = f"C:/Windows/Temp/.sm_{ts}_{rand}.ps1"
            _write_remote(client, tmp, script_content, mode=0o700)
            cmd = f'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{tmp}"'
            stdout, stderr, code = _exec(
                client, cmd, timeout=cfg.ssh_exec_timeout_ms // 1000
            )
            try:
                sftp = client.open_sftp()
                sftp.remove(tmp)
                sftp.close()
            except Exception:
                pass
            return {"exitCode": code, "stdout": stdout,
                    "stderr": stderr, "durationMs": int((time.time()-start)*1000)}
        except Exception as e:
            return {"exitCode": -1, "stdout": "",
                    "stderr": f"Greska konekcije: {e}",
                    "durationMs": int((time.time()-start)*1000)}
        finally:
            client.close()
    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def _list_processes_windows(server: dict, limit: int = 50) -> list[dict]:
    """Lista Windows procesa preko SSH (PowerShell). Zamena za winrm.list_processes.
    Koristi .ps1-preko-SFTP izvrsavanje (isti obrazac kao ostale Windows funkcije)
    umesto inline -Command stringa -- izbegava sudar navodnika koji je lomio
    PowerShell parsiranje ("Expressions are only allowed as the first element
    of a pipeline")."""
    ps_lines = [
        "$ErrorActionPreference='SilentlyContinue'",
        "$os=Get-CimInstance Win32_OperatingSystem",
        "$totalKB=$os.TotalVisibleMemorySize",
        f"Get-Process | Sort-Object CPU -Descending | Select-Object -First {int(limit)} | ForEach-Object {{",
        "  $rssKb=[math]::Round($_.WorkingSet64/1KB)",
        "  $memPct=if($totalKB -gt 0){[math]::Round(($rssKb/$totalKB)*100,1)}else{0}",
        "  $cpuVal=if($_.CPU){[math]::Round($_.CPU,1)}else{0}",
        "  Write-Output \"$($_.Id)|$($_.ProcessName)|$cpuVal|$memPct|$rssKb\"",
        "}",
    ]
    ps_script = "\r\n".join(ps_lines) + "\r\n"

    def _run():
        client = _connect(server)
        try:
            rand = "".join(random.choices(string.ascii_lowercase, k=8))
            ts   = int(time.time() * 1000)
            tmp  = f"C:/Windows/Temp/.sm_{ts}_{rand}.ps1"
            _write_remote(client, tmp, ps_script, mode=0o700)
            cmd = f'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{tmp}"'
            stdout, stderr, code = _exec(client, cmd, timeout=15)
            try:
                sftp = client.open_sftp()
                sftp.remove(tmp)
                sftp.close()
            except Exception:
                pass
            if code != 0 and stderr and not stdout:
                raise RuntimeError(stderr[:200])
            procs = []
            for line in stdout.strip().split("\n"):
                parts = line.strip().split("|")
                if len(parts) < 5:
                    continue
                try:
                    procs.append({
                        "pid":   int(parts[0]),
                        "name":  parts[1],
                        "cpu":   float(parts[2]),
                        "mem":   float(parts[3]),
                        "rssKb": int(parts[4]),
                    })
                except ValueError:
                    continue
            return procs
        finally:
            client.close()
    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def _test_connection_windows(server: dict) -> dict:
    """Test SSH konekcije ka Windows serveru. Zamena za winrm.test_connection."""
    def _run():
        start = time.time()
        client = _connect(server)
        try:
            out, _, _ = _exec(client, 'powershell -NoProfile -Command "Write-Output sm_ok; hostname"', timeout=10)
            ok = "sm_ok" in out
            hn = None
            if ok:
                lines = [l.strip() for l in out.strip().split("\n") if l.strip()]
                if len(lines) > 1:
                    hn = lines[-1]
            return {"ok": ok, "hostname": hn,
                    "durationMs": int((time.time()-start)*1000)}
        except Exception as e:
            return {"ok": False, "error": str(e),
                    "durationMs": int((time.time()-start)*1000)}
        finally:
            client.close()
    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def list_vms_hyperv(server: dict) -> list[dict]:
    """Lista Hyper-V VM-ova preko SSH (Get-VM cmdlet). IP adresa preko
    Get-VMNetworkAdapter (zahteva Hyper-V Integration Services u gostu,
    isti preduslov kao VMware Tools/QEMU Guest Agent). Velicina diska po
    disku preko Get-VMHardDiskDrive + Get-VHD (konfigurisana/logicka
    velicina, ne fizicka velicina fajla na disku)."""
    ps_lines = [
        "$ErrorActionPreference='SilentlyContinue'",
        "Get-VM | ForEach-Object {",
        "  $vm=$_",
        "  $mem=Get-VMMemory -VM $vm",
        "  $ram=[math]::Round($mem.Startup/1MB)",
        "  $ips=(Get-VMNetworkAdapter -VM $vm | Select-Object -ExpandProperty IPAddresses) -join ','",
        "  if (-not $ips) { $ips='NONE' }",
        "  $diskSizes=@()",
        "  Get-VMHardDiskDrive -VM $vm | ForEach-Object {",
        "    $vhd=Get-VHD -Path $_.Path -ErrorAction SilentlyContinue",
        "    if ($vhd) { $diskSizes += [math]::Round($vhd.Size/1GB) }",
        "  }",
        "  $diskStr=($diskSizes -join ';'); if (-not $diskStr) { $diskStr='NONE' }",
        "  $osName=$null",
        "  try {",
        "    $kvp=Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_KvpExchangeComponent -Filter \"SystemName='$($vm.Id)'\" -ErrorAction SilentlyContinue",
        "    foreach ($item in $kvp.GuestIntrinsicExchangeItems) {",
        "      $xml=[xml]$item",
        "      $nameProp=$xml.INSTANCE.PROPERTY | Where-Object { $_.NAME -eq 'Name' -and $_.VALUE -eq 'OSName' }",
        "      if ($nameProp) {",
        "        $dataProp=$xml.INSTANCE.PROPERTY | Where-Object { $_.NAME -eq 'Data' }",
        "        $osName=$dataProp.VALUE",
        "      }",
        "    }",
        "  } catch {}",
        "  if (-not $osName) { $osName='NONE' }",
        "  Write-Output \"$($vm.VMId)|$($vm.Name)|$($vm.State)|$($vm.ProcessorCount)|$ram|$diskStr|$ips|$osName\"",
        "}",
    ]
    ps_script = "\r\n".join(ps_lines) + "\r\n"

    def _run():
        client = _connect(server)
        try:
            rand = "".join(random.choices(string.ascii_lowercase, k=8))
            ts   = int(time.time() * 1000)
            tmp  = f"C:/Windows/Temp/.sm_{ts}_{rand}.ps1"
            _write_remote(client, tmp, ps_script, mode=0o700)
            cmd = f'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{tmp}"'
            stdout, stderr, code = _exec(client, cmd, timeout=45)
            try:
                sftp = client.open_sftp()
                sftp.remove(tmp)
                sftp.close()
            except Exception:
                pass

            state_map = {"running": "running", "off": "stopped", "paused": "paused", "saved": "stopped"}
            vms = []
            for line in stdout.strip().split("\n"):
                parts = line.strip().split("|")
                if len(parts) < 7:
                    continue
                vmid, name, state, cpus, ram_mb, disk_str, ips_str = parts[:7]
                os_name_str = parts[7].strip() if len(parts) > 7 else "NONE"

                disk_sizes = []
                if disk_str.strip() and disk_str.strip() != "NONE":
                    for d in disk_str.strip().split(";"):
                        try:
                            disk_sizes.append(int(float(d)))
                        except ValueError:
                            continue
                disk_gb = sum(disk_sizes) if disk_sizes else None

                ip_address = None
                if ips_str.strip() and ips_str.strip() != "NONE":
                    ip_list = [ip.strip() for ip in ips_str.strip().split(",") if ip.strip()]
                    ipv4s = [ip for ip in ip_list if "." in ip and ":" not in ip]
                    ip_address = (ipv4s[0] if ipv4s else ip_list[0]) if ip_list else None

                try:
                    vms.append({
                        "vmIdOnHost": vmid.strip().strip("{}"),
                        "name": name.strip(),
                        "powerState": state_map.get(state.strip().lower(), "unknown"),
                        "cpuCores": int(cpus.strip()) if cpus.strip().isdigit() else None,
                        "ramMb": int(float(ram_mb.strip())) if ram_mb.strip() else None,
                        "diskGb": disk_gb,
                        "diskSizesGb": disk_sizes or None,
                        "guestOs": os_name_str if os_name_str and os_name_str != "NONE" else None,
                        "ipAddress": ip_address,
                    })
                except ValueError:
                    continue
            return vms
        finally:
            client.close()
    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def execute_script(server: dict, script_content: str) -> dict:
    """Dispatch po os_type -- izvrsavanje skripti sad uvek preko SSH."""
    if server.get("os_type") in ("windows", "hyperv"):
        return await _execute_script_windows(server, script_content)
    return await _execute_script_linux(server, script_content)


async def list_processes(server: dict, limit: int = 50) -> list[dict]:
    """Dispatch po os_type -- lista procesa sad uvek preko SSH."""
    if server.get("os_type") in ("windows", "hyperv"):
        return await _list_processes_windows(server, limit)
    return await _list_processes_linux(server, limit)


async def test_connection(server: dict) -> dict:
    """Dispatch po os_type -- test konekcije sad uvek preko SSH."""
    if server.get("os_type") in ("windows", "hyperv"):
        return await _test_connection_windows(server)
    return await _test_connection_linux(server)


def _push_and_verify_key(server: dict, pub_line: str, priv_pem: str, tag: str):
    """Password konekcijom doda javni kljuc u ~/.ssh/authorized_keys, zatim
    OTVORI NOVU konekciju iskljucivo tim kljucem da potvrdi da radi PRE nego
    sto se ista stvar promeni u bazi. Ako verifikacija ne uspe, best-effort
    uklanja upravo dodatu liniju i baca izuzetak -- server ostaje na password
    auth-u, ni baza ni server se ne diraju.

    Pre dodavanja nove linije, uklanja SVAKU raniju liniju sa istim `tag`
    komentarom (npr. ako se generisanje ponovo pokrene na istom serveru) --
    inace se stari auto-generisani kljucevi gomilaju u authorized_keys kao
    beskorisni ostaci posle svakog ponovnog pokretanja."""
    pw_client = _connect(server)
    try:
        setup_cmd = (
            "mkdir -p ~/.ssh && chmod 700 ~/.ssh && "
            "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && "
            f"(grep -v {shlex.quote(chr(32) + tag)} ~/.ssh/authorized_keys || true) "
            "> ~/.ssh/authorized_keys.sm_tmp && "
            "chmod 600 ~/.ssh/authorized_keys.sm_tmp && "
            "mv ~/.ssh/authorized_keys.sm_tmp ~/.ssh/authorized_keys && "
            f"echo {shlex.quote(pub_line)} >> ~/.ssh/authorized_keys"
        )
        _, err, code = _exec(pw_client, setup_cmd, timeout=15)
        if code != 0:
            raise SSHConnectionError(f"Ne mogu da upisem authorized_keys: {err[:300]}")
    finally:
        pw_client.close()

    verify_server = dict(server)
    verify_server["ssh_auth_type"] = "key"
    verify_server["_private_key"] = priv_pem
    verify_server.pop("_ssh_password", None)

    try:
        v_client = _connect(verify_server)
        v_client.close()
    except Exception as e:
        try:
            rb_client = _connect(server)
            try:
                rb_cmd = (
                    f"(grep -vxF {shlex.quote(pub_line)} ~/.ssh/authorized_keys || true) "
                    "> ~/.ssh/authorized_keys.sm_tmp && "
                    "chmod 600 ~/.ssh/authorized_keys.sm_tmp && "
                    "mv ~/.ssh/authorized_keys.sm_tmp ~/.ssh/authorized_keys"
                )
                _exec(rb_client, rb_cmd, timeout=15)
            finally:
                rb_client.close()
        except Exception:
            pass
        raise SSHConnectionError(
            f"Kljuc je dodat na server ali verifikacija nove konekcije nije uspela "
            f"(linija je uklonjena, server ostaje na lozinci): {e}"
        ) from e


def _generate_and_install_key(server: dict) -> dict:
    """Generise NOVI ed25519 par (cryptography lib, paramiko sam ne ume da
    generise ed25519), instalira javni deo preko password konekcije i
    verifikuje ga PRE nego sto vrati rezultat pozivaocu -- pozivalac (ruter)
    tek posle uspesnog povratka upisuje kljuc u ssh_keys i prebacuje server
    na key auth."""
    priv = ed25519.Ed25519PrivateKey.generate()
    pub  = priv.public_key()

    priv_pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.OpenSSH,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()

    comment  = f"servermanager-auto-{server['id']}"
    pub_line = pub.public_bytes(
        encoding=serialization.Encoding.OpenSSH,
        format=serialization.PublicFormat.OpenSSH,
    ).decode() + f" {comment}"

    _push_and_verify_key(server, pub_line, priv_pem, tag=comment)

    return {"private_key_pem": priv_pem, "public_key": pub_line}


async def generate_and_install_key(server: dict) -> dict:
    return await asyncio.get_event_loop().run_in_executor(None, _generate_and_install_key, server)
