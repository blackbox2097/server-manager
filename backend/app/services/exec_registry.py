# app/services/exec_registry.py
# Registruje aktivne SSH klijente po execution_result.id (rid) da bi mogli
# nasilno da se prekinu -- ili automatski (hard timeout) ili rucno (korisnik
# klikne "Otkazi"). Zatvaranje soketa iz drugog konteksta (async strana)
# prekida blokirajuci read()/exec_command() poziv u thread-u gde stvarno
# radi paramiko, oslobadjajuci ga umesto da zauvek visi u pozadini.
import threading

_lock = threading.Lock()
_active: dict[int, object] = {}   # rid -> paramiko.SSHClient
_cancelled: set[int] = set()      # rid-ovi za koje je zatrazen prekid


def register(rid, client):
    if rid is None:
        return
    with _lock:
        _active[rid] = client
        _cancelled.discard(rid)


def unregister(rid):
    if rid is None:
        return
    with _lock:
        _active.pop(rid, None)
        _cancelled.discard(rid)


def cancel(rid) -> bool:
    if rid is None:
        return False
    with _lock:
        client = _active.get(rid)
        if client is None:
            return False
        _cancelled.add(rid)
    try:
        client.close()
    except Exception:
        pass
    return True


def was_cancelled(rid) -> bool:
    if rid is None:
        return False
    with _lock:
        return rid in _cancelled
