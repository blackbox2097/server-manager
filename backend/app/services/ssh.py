# app/services/ssh.py
import asyncio
import io
import random
import string
import time
import logging
from typing import Any

import paramiko
import re
from app.config import get_settings

logger = logging.getLogger(__name__)


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

    client.connect(**kw)
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
            }
        finally:
            client.close()

    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def execute_script(server: dict, script_content: str) -> dict:
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


async def list_processes(server: dict, limit: int = 50) -> list[dict]:
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


async def test_connection(server: dict) -> dict:
    def _run():
        start = time.time()
        try:
            client = _connect(server)
            out, _, _ = _exec(client, "echo sm_ok && hostname", timeout=5)
            client.close()
            ok = out.startswith("sm_ok")
            hn = out.split("\n")[1].strip() if ok and "\n" in out else None
            return {"ok": ok, "hostname": hn,
                    "durationMs": int((time.time()-start)*1000)}
        except Exception as e:
            return {"ok": False, "error": str(e),
                    "durationMs": int((time.time()-start)*1000)}

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
        "Write-Output \"SM_CPU:$cpu|SM_RAM:$ram|SM_DISK:$diskMax|SM_DISKS:$disksStr|SM_UP:$up|SM_PROCS:$procs|SM_RX:$rx|SM_TX:$tx|SM_OS:$($os.Caption)\"",
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
            }
        finally:
            client.close()
    return await asyncio.get_event_loop().run_in_executor(None, _run)


async def get_metrics(server: dict) -> dict:
    """Dispatch po os_type -- Linux i Windows sada oba idu preko SSH (paramiko)."""
    if server.get("os_type") == "windows":
        return await _get_metrics_windows(server)
    return await _get_metrics_linux(server)
