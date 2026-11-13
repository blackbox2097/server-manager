# app/services/viewpower.py
# ViewPower (Voltronic) ADAPTER za ups_poller.py (12.11.2026).
# ViewPower nema zvanican API -- citamo isti interni endpoint koji koristi
# njegov web GUI: POST /ViewPower/workstatus/reqMonitorData (portName=...),
# JSON odgovor, bez sesije. Potvrdjeno na ViewPowerHTML V1.04-25210.
# Endpoint je nedokumentovan i moze se promeniti sa verzijom -- zato je
# parsiranje defanzivno, a nepoznato stanje NIKAD ne postaje tiho "online".

import html
import logging
import re
from datetime import date, datetime, timedelta

import httpx

logger = logging.getLogger(__name__)

VP_TIMEOUT_SEC  = 10
LOW_BATTERY_PCT = 20   # Ivanova odluka 12.11.2026: na bateriji + kapacitet <= 20% = low_battery


class ViewPowerError(Exception):
    pass


async def vp_monitor_data(host: str, port: int, port_name: str, timeout: int = VP_TIMEOUT_SEC) -> dict:
    url = f"http://{host}:{port}/ViewPower/workstatus/reqMonitorData"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, data={"portName": port_name},
                                     headers={"X-Requested-With": "XMLHttpRequest"})
    except httpx.TimeoutException:
        raise ViewPowerError(f"Timeout ({timeout}s)")
    except httpx.HTTPError as e:
        raise ViewPowerError(f"Konekcija neuspesna: {e}")
    if resp.status_code != 200:
        raise ViewPowerError(f"HTTP {resp.status_code}")
    try:
        d = resp.json()
    except ValueError:
        raise ViewPowerError("Odgovor nije JSON (druga verzija ViewPower-a ili zahteva prijavu?)")
    if not isinstance(d, dict):
        raise ViewPowerError("Neocekivan format odgovora")
    return d


def _num(v) -> float | None:
    """'040.8' -> 40.8, '014' -> 14.0; '', None, bool i '[label.x]' -> None."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s or s.startswith("["):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _text(v) -> str:
    if v is None or isinstance(v, (dict, list, bool)):
        return ""
    s = str(v).strip()
    return "" if s.startswith("[label.") else s


def derive_status(wi: dict) -> tuple[str, bool, str | None]:
    """workMode (tekst) -> (status, replace_battery, razlog). Vidi tabelu u
    komentaru modula; nepoznat rezim -> warning sa originalnim tekstom."""
    mode_raw = _text(wi.get("workMode"))
    mode = mode_raw.lower()
    if not mode:
        raise ViewPowerError("ViewPower ne vraca rezim rada (UPS nije povezan ili pogresan portName)")

    warnings = [str(w).strip() for w in (wi.get("warnings") or []) if str(w).strip()]
    fault = _text(wi.get("faultType"))
    replace = any("replace" in w.lower() for w in warnings)
    charge = _num(wi.get("batteryCapacity"))

    if "battery" in mode and "test" in mode:
        status, reason = "warning", f"Test baterije ({mode_raw})"
    elif "battery" in mode:
        if charge is not None and charge <= LOW_BATTERY_PCT:
            status, reason = "low_battery", "PRAZNA BATERIJA"
        else:
            status, reason = "on_battery", "Na bateriji"
    elif "fault" in mode:
        status, reason = "warning", f"Kvar{': ' + fault if fault else ''} ({mode_raw})"
    elif "bypass" in mode:
        status, reason = "warning", f"Bypass rezim ({mode_raw})"
    elif any(k in mode for k in ("line", "eco", "converter")):
        status, reason = "online", None
    else:
        status, reason = "warning", f"Nepoznat rezim rada: {mode_raw}"

    extra = warnings + ([f"Kvar: {fault}"] if fault and "fault" not in mode else [])
    if extra:
        if status == "online":
            status, reason = "warning", ", ".join(extra)
        else:
            reason = f"{reason} | {', '.join(extra)}"
    return status, replace, reason


_LABEL_RE = re.compile(r"^\[label\.([^\]]+)\]$")
_LABELS = {"enable": "uključeno", "disable": "isključeno"}


def _label(v) -> str:
    """'[label.enable]' -> 'uključeno'; ostali '[label.x]' -> 'x'. Samo za prikaz."""
    s = str(v).strip()
    m = _LABEL_RE.match(s)
    return (_LABELS.get(m.group(1), m.group(1))) if m else s


def _flatten(d: dict, wi: dict) -> dict[str, str]:
    """Za prikaz 'svih promenljivih' u detaljima -- samo skalarne, neprazne vrednosti."""
    out: dict[str, str] = {}
    for k in ("version", "protocolType", "hostName", "portName"):
        if d.get(k) not in (None, ""):
            out[f"viewpower.{k}"] = str(d[k])
    for k, v in wi.items():
        if isinstance(v, dict):
            continue
        if isinstance(v, list):
            if k == "warnings" and v:
                out[k] = ", ".join(str(x) for x in v)
            continue
        if v is None or v == "":
            continue
        out[k] = _label(v)
    return out


async def fetch(ups: dict) -> dict:
    """Ugovor adaptera (vidi ups_poller.py)."""
    d = await vp_monitor_data(ups["host"], ups["port"], ups["device_name"])
    wi = d.get("workInfo")
    if not isinstance(wi, dict) or not wi:
        raise ViewPowerError("Odgovor nema workInfo (pogresan portName?)")
    status, replace_battery, reason = derive_status(wi)
    # Dnevnik dogadjaja -- greska ovde NE sme da obori status UPS-a
    events = None
    try:
        events = await vp_events(ups["host"], ups["port"], ups["device_name"],
                                 d.get("protocolType") or wi.get("ptid"))
    except Exception as e:
        logger.warning(f"ViewPower {ups.get('name', ups['host'])}: dnevnik dogadjaja nedostupan: {e}")
    runtime_min = _num(wi.get("batteryRemainTime"))
    return {
        "status": status,
        "replace_battery": replace_battery,
        "reason": reason,
        "status_raw": _text(wi.get("workMode")) or None,
        "metrics": {
            "battery_charge":      _num(wi.get("batteryCapacity")),
            "battery_runtime_sec": int(runtime_min * 60) if runtime_min is not None else None,
            "battery_voltage":     _num(wi.get("batteryVoltage")),
            "load_percent":        _num(wi.get("outputLoadPercent")),
            "input_voltage":       _num(wi.get("inputVoltage")),
            "output_voltage":      _num(wi.get("outputVoltage")),
            "input_frequency":     _num(wi.get("inputFrequency")),
            "temperature":         _num(wi.get("temperature")),
        },
        "identity": {
            "manufacturer": None,
            "model":        None,
            "firmware":     _text(wi.get("fwversion")) or None,
            "ups_type":     _text(wi.get("morphological")) or None,
        },
        "raw_vars": _flatten(d, wi),
        "events": events,
    }


# ---------------------------------------------------------------------------
# Autodetekcija UPS-ova na ViewPower racunaru (12.11.2026)
# ---------------------------------------------------------------------------
_TREE_LEAF_RE = re.compile(r'^\s*([A-Za-z]+)\s*\(id=([^)_]+)(?:_[^)]*)?\)\s*$')


async def _device_tree(host: str, port: int, timeout: int = VP_TIMEOUT_SEC) -> list[dict]:
    url = f"http://{host}:{port}/ViewPower/initDeviceTree"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(url, headers={"X-Requested-With": "XMLHttpRequest"})
    resp.raise_for_status()
    nodes = resp.json()
    if not isinstance(nodes, list):
        raise ViewPowerError("Neocekivan format stabla uredjaja")
    return [n for n in nodes if isinstance(n, dict)]


def _tree_candidates(nodes: list[dict]) -> list[str]:
    """CURRENT -> <hostName> -> 'USB (id=160CD9D7_P01)' => 'USB160CD9D7'.
    LAN/INTERNET grane su DRUGE ViewPower instance -- ne diramo ih."""
    current = {str(n.get("id")) for n in nodes if n.get("name") == "CURRENT"}
    hosts = {str(n.get("id")) for n in nodes if str(n.get("pId")) in current}
    out: list[str] = []
    for n in nodes:
        if str(n.get("pId")) in hosts:
            m = _TREE_LEAF_RE.match(str(n.get("name") or ""))
            if m and (m.group(1) + m.group(2)) not in out:
                out.append(m.group(1) + m.group(2))
    return out


def _device_info(pn: str, d: dict) -> dict:
    wi = d.get("workInfo") or {}
    return {
        "deviceName": pn,
        "serial":   _text(wi.get("deviceId")) or None,
        "workMode": _text(wi.get("workMode")) or None,
        "type":     _text(wi.get("morphological")) or None,
    }


async def vp_discover(host: str, port: int) -> dict:
    """Spisak UPS-ova na ViewPower racunaru. Primarno iz stabla (initDeviceTree);
    SVAKI kandidat se proverava preko reqMonitorData (portName u odgovoru mora
    da se poklopi i mora postojati workMode) -- format imena cvora zato ne mora
    biti tacno pogodjen. Ako stablo ne uspe ili nista ne prodje proveru:
    fallback na reqMonitorData bez portName (trenutni/jedini UPS).
    Vise UPS-ova: implementirano, NETESTIRANO na masini sa vise UPS-ova."""
    devices: list[dict] = []
    meta: dict = {}
    method = "tree"
    try:
        candidates = _tree_candidates(await _device_tree(host, port))
    except Exception as e:
        logger.info(f"ViewPower {host}: stablo uredjaja nedostupno ({e}), koristim fallback")
        candidates = []
    for pn in candidates:
        try:
            d = await vp_monitor_data(host, port, pn)
        except Exception:
            continue
        if str(d.get("portName") or "") == pn and _text((d.get("workInfo") or {}).get("workMode")):
            devices.append(_device_info(pn, d))
            meta = meta or d
    if not devices:
        method = "fallback"
        d = await vp_monitor_data(host, port, "")
        pn = str(d.get("portName") or "").strip()
        if pn:
            devices.append(_device_info(pn, d))
            meta = d
    return {"version": meta.get("version"), "hostName": meta.get("hostName"),
            "method": method, "devices": devices}


# ---------------------------------------------------------------------------
# Dnevnik dogadjaja (13.11.2026) -- SAMO CITANJE preko qryEventRecords.
# NIKAD ne zvati delRecord / delEventRecordAll: brisu ViewPower dnevnik.
# ---------------------------------------------------------------------------
_ROW_RE  = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_CELL_RE = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S | re.I)
_TAG_RE  = re.compile(r"<[^>]+>")


def _parse_vp_datetime(s: str, lo: datetime, hi: datetime) -> datetime | None:
    """Format datuma zavisi od podesavanja ViewPower-a (DD/MM ili MM/DD).
    Od mogucih tumacenja uzima ono koje upada u traženi opseg."""
    s = s.strip()
    cands = []
    for f in ("%d/%m/%Y %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
        try:
            cands.append(datetime.strptime(s, f))
        except ValueError:
            pass
    inside = [c for c in cands if lo <= c < hi]
    return (inside or cands or [None])[0]


async def vp_events(host: str, port: int, port_name: str, prodid: str | None,
                    timeout: int = VP_TIMEOUT_SEC) -> list[dict]:
    """Dogadjaji za juce + danas: [{id, at, at_raw, event, type}]. ID raste."""
    today = date.today()
    start = today - timedelta(days=1)
    d2s = lambda d: f"{d.year}-{d.month}-{d.day}"
    url = f"http://{host}:{port}/ViewPower/history/qryEventRecords"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, data={
                "startDate": d2s(start), "endDate": d2s(today),
                "comPort": port_name, "prodid": prodid or "", "sn": "",
            }, headers={"X-Requested-With": "XMLHttpRequest"})
    except httpx.HTTPError as e:
        raise ViewPowerError(f"Dnevnik: {e}")
    if resp.status_code != 200:
        raise ViewPowerError(f"Dnevnik: HTTP {resp.status_code}")

    lo = datetime.combine(start, datetime.min.time())
    hi = datetime.combine(today + timedelta(days=1), datetime.min.time())
    idx, out = None, []
    for row in _ROW_RE.findall(resp.text):
        cells = [html.unescape(_TAG_RE.sub("", c)).strip() for c in _CELL_RE.findall(row)]
        if not cells:
            continue
        if idx is None and "Date" in cells and "Event" in cells:
            idx = {"date": cells.index("Date"), "event": cells.index("Event"),
                   "type": cells.index("Type") if "Type" in cells else None}
            continue
        if idx is None or not cells[0].isdigit() or len(cells) <= max(idx["date"], idx["event"]):
            continue
        t = idx["type"]
        out.append({
            "id": int(cells[0]),
            "at": _parse_vp_datetime(cells[idx["date"]], lo, hi),
            "at_raw": cells[idx["date"]],
            "event": cells[idx["event"]],
            "type": cells[t] if t is not None and t < len(cells) else "",
        })
    return out
