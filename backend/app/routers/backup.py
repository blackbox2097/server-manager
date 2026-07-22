# app/routers/backup.py
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.services.auth import require_superadmin
from app.services.audit import log_event
from app.services import backup as backup_svc

router = APIRouter(prefix="/api/admin/backup", tags=["backup"])


def _ip(req: Request) -> str | None:
    return req.client.host if req.client else None


@router.get("")
async def list_backups(user=Depends(require_superadmin)):
    return backup_svc.list_backups()


@router.post("", status_code=201)
async def create_backup(req: Request, user=Depends(require_superadmin)):
    try:
        result = await backup_svc.create_backup()
    except Exception as e:
        raise HTTPException(500, str(e))
    await log_event("backup.create", user_id=user["id"], username=user.get("username"),
                    ip_address=_ip(req), resource_type="backup", resource_id=result["filename"],
                    details={"sizeBytes": result["sizeBytes"]})
    return result


@router.get("/summary")
async def db_summary(user=Depends(require_superadmin)):
    return await backup_svc.get_db_summary()


@router.get("/{filename}/download")
async def download_backup(filename: str, user=Depends(require_superadmin)):
    try:
        path = backup_svc.get_backup_path(filename)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))
    return FileResponse(path, filename=filename, media_type="application/octet-stream")


@router.delete("/{filename}")
async def delete_backup(filename: str, req: Request, user=Depends(require_superadmin)):
    try:
        backup_svc.delete_backup(filename)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))
    await log_event("backup.delete", user_id=user["id"], username=user.get("username"),
                    ip_address=_ip(req), resource_type="backup", resource_id=filename)
    return {"ok": True}


@router.post("/upload", status_code=201)
async def upload_backup(req: Request, file: UploadFile = File(...), user=Depends(require_superadmin)):
    content = await file.read()
    if len(content) < 100:
        raise HTTPException(400, "Fajl deluje prazan ili nevalidan")
    result = await backup_svc.save_uploaded_backup(file.filename, content)
    await log_event("backup.upload", user_id=user["id"], username=user.get("username"),
                    ip_address=_ip(req), resource_type="backup", resource_id=result["filename"],
                    details={"sizeBytes": result["sizeBytes"], "originalName": file.filename})
    return result


class RestoreConfirm(BaseModel):
    confirmText: str


@router.post("/{filename}/restore")
async def restore_backup(filename: str, body: RestoreConfirm, req: Request, user=Depends(require_superadmin)):
    if body.confirmText != "RESTORE":
        raise HTTPException(400, 'Potrebno je uneti tacno "RESTORE" da potvrdis ovu akciju')
    try:
        backup_svc.get_backup_path(filename)  # samo provera da fajl postoji
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(404, str(e))

    await log_event("backup.restore", user_id=user["id"], username=user.get("username"),
                    ip_address=_ip(req), resource_type="backup", resource_id=filename,
                    details={"warning": "Baza je vracena na stanje iz backup-a, aplikacija je restartovana"})

    backup_svc.trigger_restore(filename)
    return {"ok": True, "message": "Restore pokrenut — aplikacija ce biti nedostupna par minuta"}
