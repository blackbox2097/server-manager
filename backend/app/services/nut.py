# app/services/nut.py
# NUT (Network UPS Tools, TCP 3493) ADAPTER za ups_poller.py.
# Ovde je samo citanje i normalizacija -- debounce, upis, audit, notify i
# scheduler su u ups_poller.py (refaktor 12.11.2026).
#
# Async-native preko asyncio.open_connection -- nema executora. Socket se
# UVEK zatvara u finally (lekcija iz SNMP FD leak incidenta 11.8.2026).

import asyncio
import logging
import re

from app.services.crypto import decrypt

logger = logging.getLogger(__name__)

NUT_TIMEOUT_SEC = 10   # cela NUT sesija (connect + LIST VAR)

_VAR_RE = re.compile(r'^VAR\s+\S+\s+(\S+)\s+"((?:[^"\\]|\\.)*)"$')
_UNESCAPE_RE = re.compile(r'\\(.)')

STATUS_REASON = {
    "on_battery":  "Na bateriji",
    "low_battery": "PRAZNA BATERIJA",
}
WARNING_TOKENS = {"RB": "Zameni bateriju", "OVER": "Preopterecenje", "BYPASS": "Bypass rezim"}


class NUTError(Exception):
    pass


async def nut_list_vars(host: str, port: int, ups_name: str,
                        username: str | None = None, password: str | None = None,
                        timeout: int = NUT_TIMEOUT_SEC) -> dict[str, str]:
    """Jedna NUT sesija: (opciono USERNAME/PASSWORD) + LIST VAR <ups>.
    Vraca dict promenljiva -> vrednost. Socket se zatvara u finally."""

    async def _session() -> dict[str, str]:
        reader, writer = await asyncio.open_connection(host, port)
        try:
            async def cmd(line: str) -> str:
                writer.write((line + "\n").encode())
                await writer.drain()
                return (await reader.readline()).decode(errors="replace").strip()

            if username:
                r = await cmd(f"USERNAME {username}")
                if not r.startswith("OK"):
                    raise NUTError(f"USERNAME: {r}")
                r = await cmd(f"PASSWORD {password or ''}")
                if not r.startswith("OK"):
                    raise NUTError(f"PASSWORD: {r}")

            first = await cmd(f"LIST VAR {ups_name}")
            if first.startswith("ERR"):
                raise NUTError(first)
            if not first.startswith("BEGIN LIST VAR"):
                raise NUTError(f"Neocekivan odgovor: {first[:100]}")

            out: dict[str, str] = {}
            while True:
                raw = await reader.readline()
                if not raw:
                    raise NUTError("Konekcija prekinuta usred liste")
                s = raw.decode(errors="replace").strip()
                if s.startswith("END LIST VAR"):
                    break
                m = _VAR_RE.match(s)
                if m:
                    out[m.group(1)] = _UNESCAPE_RE.sub(r"\1", m.group(2))
            try:
                writer.write(b"LOGOUT\n")
                await writer.drain()
            except Exception:
                pass
            return out
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    try:
        return await asyncio.wait_for(_session(), timeout=timeout)
    except asyncio.TimeoutError:
        raise NUTError(f"Timeout ({timeout}s)")
    except OSError as e:
        raise NUTError(f"Konekcija neuspesna: {e}")


def derive_status(vars_: dict[str, str]) -> tuple[str, bool, str | None]:
    """ups.status tokeni -> (status, replace_battery, razlog). Prioritet:
    LB > OB > RB/OVER/BYPASS > OL. Nepoznat/prazan status -> warning."""
    tokens = set((vars_.get("ups.status") or "").split())
    replace = "RB" in tokens
    if "LB" in tokens:
        return "low_battery", replace, STATUS_REASON["low_battery"]
    if "OB" in tokens:
        return "on_battery", replace, STATUS_REASON["on_battery"]
    warn = [txt for tok, txt in WARNING_TOKENS.items() if tok in tokens]
    if warn:
        return "warning", replace, ", ".join(warn)
    if "OL" in tokens:
        return "online", replace, None
    return "warning", replace, f"Nepoznat ups.status: {vars_.get('ups.status') or '(prazno)'}"


def _num(vars_: dict[str, str], key: str) -> float | None:
    v = vars_.get(key)
    if v is None or v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _battery_voltage_total(vars_: dict[str, str]) -> float | None:
    """Neki drajveri (nutdrv_qx/Megatec, npr. BORRI) javljaju napon PO CELIJI
    (~2.2 V) ili po jednoj 12 V bateriji, a ne ceo string. Ako je izmereni napon
    vise od 3x manji od nominalnog, preracunaj na ukupan (celija ~2 V,
    baterija ~12 V). Inace vrati izmereno. Sirova vrednost ostaje u raw_vars."""
    v = _num(vars_, "battery.voltage")
    nom = _num(vars_, "battery.voltage.nominal")
    if v is None or not nom or v <= 0 or nom / v < 3:
        return v
    n = round(nom / (2.0 if v < 3 else 12.0))
    return round(v * n, 2) if n > 1 else v


def extract_metrics(vars_: dict[str, str]) -> dict:
    tokens = set((vars_.get("ups.status") or "").split())
    charge = _num(vars_, "battery.charge")
    # Sanity: neki drajveri (npr. nutdrv_qx/Megatec) javljaju napon po celiji,
    # pa izracunaju charge=0 iako je baterija puna. 0 uz OL bez LB = nepouzdano.
    if charge == 0 and "OL" in tokens and "LB" not in tokens:
        charge = None
    runtime = _num(vars_, "battery.runtime")
    return {
        "battery_charge":      charge,
        "battery_runtime_sec": int(runtime) if runtime is not None else None,
        "battery_voltage":     _battery_voltage_total(vars_),
        "load_percent":        _num(vars_, "ups.load"),
        "input_voltage":       _num(vars_, "input.voltage"),
        "output_voltage":      _num(vars_, "output.voltage"),
        "input_frequency":     _num(vars_, "input.frequency"),
        "temperature":         _num(vars_, "ups.temperature") or _num(vars_, "battery.temperature"),
    }


async def fetch(ups: dict) -> dict:
    """Ugovor adaptera (vidi ups_poller.py)."""
    pw = decrypt(ups["password_enc"]) if ups.get("password_enc") else None
    vars_ = await nut_list_vars(ups["host"], ups["port"], ups["device_name"], ups.get("username"), pw)
    status, replace_battery, reason = derive_status(vars_)
    return {
        "status": status,
        "replace_battery": replace_battery,
        "reason": reason,
        "status_raw": vars_.get("ups.status"),
        "metrics": extract_metrics(vars_),
        "identity": {
            "manufacturer": vars_.get("device.mfr") or vars_.get("ups.mfr"),
            "model":        vars_.get("device.model") or vars_.get("ups.model"),
            "firmware":     vars_.get("ups.firmware"),
            "ups_type":     vars_.get("ups.type"),
        },
        "raw_vars": vars_,
    }
