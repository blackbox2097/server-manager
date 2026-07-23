# app/services/winrm.py
import asyncio, base64, re, time, uuid
import aiohttp
from app.config import get_settings
from app.services.crypto import decrypt

RESOURCE_URI = "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd"
WSA = "http://schemas.xmlsoap.org/ws/2004/08/addressing"
WSMAN = "http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"
RSP = "http://schemas.microsoft.com/wbem/wsman/1/windows/shell"


def _soap(action, hdr, body, t):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:wsa="{WSA}" xmlns:wsman="{WSMAN}" xmlns:rsp="{RSP}">
  <s:Header>
    <wsa:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
    <wsman:ResourceURI s:mustUnderstand="true">{RESOURCE_URI}</wsman:ResourceURI>
    <wsa:ReplyTo><wsa:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo>
    <wsa:Action s:mustUnderstand="true">{action}</wsa:Action>
    <wsman:OperationTimeout>PT{t}.000S</wsman:OperationTimeout>
    <wsa:MessageID>uuid:{uuid.uuid4()}</wsa:MessageID>
    {hdr}
  </s:Header>
  <s:Body>{body}</s:Body>
</s:Envelope>"""


def _tag(xml, tag):
    m = re.search(rf"<[^>]*{re.escape(tag)}[^>]*>([^<]+)<", xml)
    return m.group(1) if m else None


def _streams(xml):
    def dec(name):
        return "".join(
            base64.b64decode(p).decode("utf-8", errors="replace")
            for p in re.findall(rf'<rsp:Stream Name="{name}"[^>]*>([^<]*)</rsp:Stream>', xml)
        )
    ec = re.search(r"ExitCode>(\d+)", xml)
    return {
        "stdout":   dec("stdout"),
        "stderr":   dec("stderr"),
        "exitCode": int(ec.group(1)) if ec else None,
        "done":     "CommandState" in xml and "Done" in xml,
    }


async def _post(server, body):
    cfg   = get_settings()
    https = bool(server.get("winrm_https"))
    port  = int(server.get("winrm_port") or (5986 if https else 5985))
    user  = server.get("winrm_user", "")
    pw    = server.get("_winrm_password") or (
        decrypt(server["winrm_password"]) if server.get("winrm_password") else ""
    )
    proto = "https" if https else "http"
    url   = f"{proto}://{str(server['ip_address'])}:{port}/wsman"
    auth_type = server.get("winrm_auth_type") or "local"
    timeout   = cfg.winrm_connect_timeout_ms / 1000

    if auth_type == "domain":
        # NTLM je jedini nacin da domenski nalozi rade preko WinRM-a — Basic auth
        # (ispod) fundamentalno ne podrzava domenske naloge, bez obzira na format
        # korisnickog imena. Koristimo sinhroni 'requests' u thread executor-u
        # (isti obrazac kao Paramiko SSH), jer 'requests-ntlm' nije async-nativan.
        return await asyncio.get_event_loop().run_in_executor(None, _post_ntlm_sync, url, body, user, pw, timeout)

    auth = base64.b64encode(f"{user}:{pw}".encode()).decode()
    conn = aiohttp.TCPConnector(ssl=False)
    async with aiohttp.ClientSession(connector=conn) as sess:
        async with sess.post(url, data=body.encode(),
                             headers={"Content-Type": "application/soap+xml;charset=UTF-8",
                                      "Authorization": f"Basic {auth}"},
                             timeout=aiohttp.ClientTimeout(total=timeout)) as r:
            text = await r.text()
            if r.status >= 400:
                raise RuntimeError(f"WinRM HTTP {r.status}")
            return text


def _post_ntlm_sync(url: str, body: str, user: str, pw: str, timeout: float) -> str:
    """NTLM POST preko 'requests' — mora biti domenski nalog u formatu DOMEN\\korisnik."""
    import requests
    from requests_ntlm import HttpNtlmAuth
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    resp = requests.post(
        url, data=body.encode(),
        headers={"Content-Type": "application/soap+xml;charset=UTF-8"},
        auth=HttpNtlmAuth(user, pw),
        verify=False,  # samopotpisani sertifikati su cesti u internim mrezama
        timeout=timeout,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"WinRM HTTP {resp.status_code}")
    return resp.text


async def execute_script(server, script) -> dict:
    cfg = get_settings()
    t   = cfg.winrm_exec_timeout_ms // 1000
    start = time.time()
    sid = None
    is_cmd = re.match(r"@echo (off|on)", script.strip(), re.IGNORECASE) is not None
    ps_enc = None if is_cmd else base64.b64encode(script.encode("utf-16-le")).decode()

    try:
        r = await _post(server, _soap(
            "http://schemas.xmlsoap.org/ws/2004/09/transfer/Create", "",
            "<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams>"
            "<rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>", t))
        sid = _tag(r, "ShellId")
        if not sid:
            raise RuntimeError("Ne mogu otvoriti WinRM shell")

        sel = f'<wsman:SelectorSet><wsman:Selector Name="ShellId">{sid}</wsman:Selector></wsman:SelectorSet>'
        cmd_body = (
            f'<rsp:CommandLine><rsp:Command>powershell.exe</rsp:Command>'
            f'<rsp:Arguments>-NonInteractive -NoProfile -EncodedCommand {ps_enc}</rsp:Arguments></rsp:CommandLine>'
        ) if ps_enc else (
            f'<rsp:CommandLine><rsp:Command>cmd.exe</rsp:Command>'
            f'<rsp:Arguments>/c "{script.replace(chr(34), chr(92)+chr(34))}"</rsp:Arguments></rsp:CommandLine>'
        )

        r2  = await _post(server, _soap("http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command", sel, cmd_body, t))
        cid = _tag(r2, "CommandId")
        if not cid:
            raise RuntimeError("Ne mogu dobiti CommandId")

        stdout = stderr = ""
        ec = None
        deadline = time.time() + t
        while ec is None and time.time() < deadline:
            await asyncio.sleep(0.5)
            r3 = await _post(server, _soap(
                "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive", sel,
                f'<rsp:Receive><rsp:DesiredStream CommandId="{cid}">stdout stderr</rsp:DesiredStream></rsp:Receive>', t))
            s = _streams(r3)
            stdout += s["stdout"]; stderr += s["stderr"]
            if s["done"]: ec = s["exitCode"] if s["exitCode"] is not None else 0

        return {"exitCode": ec if ec is not None else -1, "stdout": stdout, "stderr": stderr,
                "durationMs": int((time.time()-start)*1000)}
    except Exception as e:
        return {"exitCode": -1, "stdout": "", "stderr": str(e),
                "durationMs": int((time.time()-start)*1000)}
    finally:
        if sid:
            try:
                await _post(server, _soap(
                    "http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete",
                    f'<wsman:SelectorSet><wsman:Selector Name="ShellId">{sid}</wsman:Selector></wsman:SelectorSet>',
                    "", t))
            except Exception:
                pass


async def get_metrics(server) -> dict:
    ps = "\n".join([
        "$ErrorActionPreference='SilentlyContinue'",
        "$cpu=[math]::Round((Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average)",
        "$os=Get-CimInstance Win32_OperatingSystem",
        "$ram=[math]::Round((($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/$os.TotalVisibleMemorySize)*100)",
        "$disk=(Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3 AND DeviceID='C:'\"| ForEach-Object{[math]::Round((($_.Size-$_.FreeSpace)/$_.Size)*100)}|Select-Object -First 1)",
        "$up=[int]((Get-Date)-$os.LastBootUpTime).TotalSeconds",
        "$procs=(Get-Process).Count",
        "$netStats=Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Where-Object {$_.ReceivedBytes -gt 0 -or $_.SentBytes -gt 0}",
        "$rx=($netStats | Measure-Object -Property ReceivedBytes -Sum).Sum",
        "$tx=($netStats | Measure-Object -Property SentBytes -Sum).Sum",
        "if (-not $rx) {$rx=0}; if (-not $tx) {$tx=0}",
        "Write-Output \"SM_CPU:$cpu|SM_RAM:$ram|SM_DISK:$disk|SM_UP:$up|SM_PROCS:$procs|SM_RX:$rx|SM_TX:$tx|SM_OS:$($os.Caption)\"",
    ])
    r = await execute_script(server, ps)
    if "SM_CPU" not in r["stdout"]:
        raise RuntimeError(r["stderr"] or "WinRM metrike neuspjesne")
    def g(k):
        m = re.search(rf"SM_{k}:([^|\r\n]+)", r["stdout"])
        return m.group(1).strip() if m else None
    return {
        "cpuPercent": min(100, int(g("CPU") or 0)),
        "ramPercent": min(100, int(g("RAM") or 0)),
        "diskPercent": min(100, int(g("DISK") or 0)),
        "uptimeSeconds": int(g("UP") or 0),
        "loadAvg1m": None, "loadAvg5m": None, "loadAvg15m": None,
        "netRxBytes": int(g("RX") or 0),
        "netTxBytes": int(g("TX") or 0),
        "processCount": int(g("PROCS") or 0),
        "osName": g("OS") or "Windows",
    }


async def list_processes(server, limit: int = 50) -> list[dict]:
    ps = "\n".join([
        f"Get-Process | Sort-Object CPU -Descending | Select-Object -First {limit} | "
        "ForEach-Object { \"$($_.Id)|$($_.ProcessName)|$([math]::Round($_.CPU,1))|$([math]::Round($_.WorkingSet/1MB,1))\" }",
    ])
    r = await execute_script(server, ps)
    procs = []
    for line in r["stdout"].strip().split("\n"):
        parts = line.strip().split("|")
        if len(parts) < 4:
            continue
        try:
            procs.append({
                "pid":   int(parts[0]),
                "name":  parts[1],
                "cpu":   float(parts[2]),
                "mem":   float(parts[3]),
                "rssKb": None,
            })
        except ValueError:
            continue
    return procs


async def test_connection(server) -> dict:
    start = time.time()
    try:
        r  = await execute_script(server, 'Write-Output "sm_ok_$(hostname)"')
        ok = "sm_ok_" in r["stdout"]
        hn = re.search(r"sm_ok_(.+)", r["stdout"])
        return {"ok": ok, "hostname": hn.group(1).strip() if hn else None,
                "durationMs": int((time.time()-start)*1000)}
    except Exception as e:
        return {"ok": False, "error": str(e), "durationMs": int((time.time()-start)*1000)}
