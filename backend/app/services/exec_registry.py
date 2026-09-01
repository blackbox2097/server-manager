# app/services/exec_registry.py
# Registruje aktivne SSH klijente po execution_result.id (rid) da bi mogli
# nasilno da se prekinu -- ili automatski (hard timeout) ili rucno (korisnik
# klikne "Otkazi"). Zatvaranje soketa iz drugog konteksta (async strana)
# prekida blokirajuci read()/exec_command() poziv u thread-u gde stvarno
# radi paramiko, oslobadjajuci ga umesto da zauvek visi u pozadini.
#
# VAZNO: zatvaranje SSH konekcije NE garantuje da se proces na udaljenom
# serveru stvarno prekine (npr. sudo cesto izoluje decu procesa od SIGHUP-a
# koji sshd salje pri zatvaranju kanala). Zato se, ako je PID poznat (via
# set_pid(), koji ssh.py poziva nakon sto skripta upise svoj PID u pidfile),
# uz zatvaranje konekcije POKUSAVA i eksplicitan kill na udaljenoj strani
# preko NOVE, kratke SSH konekcije (best-effort, u pozadinskom thread-u).
import logging
import threading

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_active: dict[int, dict] = {}     # rid -> {"client": ..., "server": ..., "pid": None}
_cancelled: set[int] = set()      # rid-ovi za koje je zatrazen prekid


def register(rid, client, server=None):
    if rid is None:
        return
    with _lock:
        _active[rid] = {"client": client, "server": server, "pid": None}
        _cancelled.discard(rid)


def set_pid(rid, pid):
    """Belezi PID (grupe) udaljenog procesa cim ga skripta prijavi preko
    pidfile-a -- omogucava cancel() da posalje pravi kill signal, ne samo
    da zatvori konekciju."""
    if rid is None:
        return
    with _lock:
        entry = _active.get(rid)
        if entry:
            entry["pid"] = pid


def unregister(rid):
    if rid is None:
        return
    with _lock:
        _active.pop(rid, None)
        _cancelled.discard(rid)


def _kill_remote(server, pid):
    """Best-effort: otvara NOVU SSH konekciju i salje TERM pa KILL signal
    procesnoj grupi na udaljenom serveru. Radi u pozadinskom thread-u
    (fire-and-forget) da ne blokira cancel() pozivaoca.
    Ako je original izvrsen preko sudo (server ima _sudo_password), kill
    MORA takodje ici preko sudo -- ciljani proces je root-vlasnistvo, obican
    korisnik (ssh_user) nema dozvolu da mu posalje signal."""
    try:
        import shlex
        from app.services.ssh import _connect, _write_remote
        client = _connect(server)
        try:
            sudo_pw  = server.get("_sudo_password")
            ssh_user = server.get("ssh_user", "")
            if sudo_pw and ssh_user != "root":
                askpass = f"/tmp/.sm_killask_{pid}.sh"
                _write_remote(client, askpass, f"#!/bin/bash\necho {shlex.quote(sudo_pw)}\n")
                cmd = (
                    f"export SUDO_ASKPASS={askpass}; "
                    f"sudo -A kill -TERM -{pid} 2>/dev/null; sleep 1; "
                    f"sudo -A kill -KILL -{pid} 2>/dev/null; "
                    f"rm -f {askpass}"
                )
            else:
                cmd = f"kill -TERM -{pid} 2>/dev/null; sleep 1; kill -KILL -{pid} 2>/dev/null"
            client.exec_command(cmd, timeout=10)
        finally:
            client.close()
    except Exception:
        logger.warning(f"exec_registry: neuspesno slanje kill signala za PID {pid} (best-effort)")


def cancel(rid) -> bool:
    if rid is None:
        return False
    with _lock:
        entry = _active.get(rid)
        if entry is None:
            return False
        _cancelled.add(rid)
        client = entry["client"]
        server = entry.get("server")
        pid    = entry.get("pid")
    try:
        client.close()
    except Exception:
        pass
    if server and pid:
        threading.Thread(target=_kill_remote, args=(server, pid), daemon=True).start()
    return True


def was_cancelled(rid) -> bool:
    if rid is None:
        return False
    with _lock:
        return rid in _cancelled
