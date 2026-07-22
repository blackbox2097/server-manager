# app/services/backup.py
import asyncio
import logging
import os
import subprocess
from datetime import datetime
from pathlib import Path

from app.config import get_settings
from app.database import fetchval

logger = logging.getLogger(__name__)

SCRIPTS_DIR = "/opt/servermanager/scripts"


def _backup_dir() -> Path:
    cfg = get_settings()
    p = Path(cfg.backup_dir)
    p.mkdir(parents=True, exist_ok=True)
    return p


async def create_backup() -> dict:
    """Pokreće pg_dump preko sudo-ograničenog skripta. Ceka da se zavrsi (obicno par sekundi)."""
    cfg = get_settings()
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"servermanager_{ts}.dump"
    out_path = _backup_dir() / filename

    proc = await asyncio.create_subprocess_exec(
        "sudo", f"{SCRIPTS_DIR}/backup_db.sh", str(out_path), cfg.pm2_user,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        logger.error(f"Backup neuspesan: {stderr.decode()}")
        raise RuntimeError(f"Backup nije uspeo: {stderr.decode()[:300]}")

    size = out_path.stat().st_size if out_path.exists() else 0
    logger.info(f"Backup kreiran: {filename} ({size} bajtova)")
    return {"filename": filename, "sizeBytes": size, "createdAt": datetime.now().isoformat()}


def list_backups() -> list[dict]:
    d = _backup_dir()
    items = []
    for f in sorted(d.glob("servermanager_*.dump"), reverse=True):
        stat = f.stat()
        items.append({
            "filename": f.name,
            "sizeBytes": stat.st_size,
            "createdAt": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    return items


def get_backup_path(filename: str) -> Path:
    # Sprecava path traversal — dozvoljena su samo imena fajlova iz naseg formata
    safe_name = os.path.basename(filename)
    if not safe_name.startswith("servermanager_") or not safe_name.endswith(".dump"):
        raise ValueError("Neispravno ime backup fajla")
    path = _backup_dir() / safe_name
    if not path.exists():
        raise FileNotFoundError("Backup fajl nije pronadjen")
    return path


def delete_backup(filename: str):
    path = get_backup_path(filename)
    path.unlink()


async def save_uploaded_backup(filename: str, content: bytes) -> dict:
    safe_name = os.path.basename(filename)
    if not safe_name.endswith(".dump"):
        safe_name += ".dump"
    if not safe_name.startswith("servermanager_"):
        safe_name = f"servermanager_uploaded_{datetime.now().strftime('%Y%m%d_%H%M%S')}.dump"
    path = _backup_dir() / safe_name
    path.write_bytes(content)
    os.chmod(path, 0o640)
    return {"filename": safe_name, "sizeBytes": len(content), "createdAt": datetime.now().isoformat()}


async def get_db_summary() -> dict:
    """Trenutno stanje baze — za upozorenje pre restore-a."""
    tables = {
        "tenants":  "SELECT COUNT(*) FROM tenants WHERE active=true",
        "servers":  "SELECT COUNT(*) FROM servers WHERE active=true",
        "users":    "SELECT COUNT(*) FROM users",
        "scripts":  "SELECT COUNT(*) FROM scripts",
        "executions": "SELECT COUNT(*) FROM executions",
        "sshKeys":  "SELECT COUNT(*) FROM ssh_keys",
    }
    out = {}
    for key, query in tables.items():
        try:
            out[key] = await fetchval(query)
        except Exception:
            out[key] = None
    return out


def trigger_restore(filename: str):
    """Pokrece restore SKRIPT u pozadini (detached) — nastavlja da radi
    i posle sto ovaj (FastAPI) proces bude ugasen od strane same skripte."""
    cfg = get_settings()
    path = get_backup_path(filename)

    log_dir = Path(cfg.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    subprocess.Popen(
        ["sudo", f"{SCRIPTS_DIR}/restore_db.sh", str(path), cfg.pm2_user],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,  # odvaja od procesa roditelja — prezivljava gasenje FastAPI-ja
    )
    logger.info(f"Restore pokrenut u pozadini za: {filename}")
