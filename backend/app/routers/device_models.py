# app/routers/device_models.py
# Biblioteka modela uredjaja (rack modul) -- samo citanje. Modeli su globalni
# (nisu po tenantu): opis hardvera je isti za sve. Builder i modeli iz baze
# dolaze kasnije, preko istog endpointa.
from fastapi import APIRouter, Depends, HTTPException

from app.database import fetch
from app.services.auth import get_current_user, require_superadmin
from app.services import device_models as dm

router = APIRouter(prefix="/api/device-models", tags=["device-models"])


def _summary(m: dm.DeviceModel) -> dict:
    ports = m.ports()
    return {
        "id": m.id, "vendor": m.vendor, "model": m.model, "sku": m.sku, "type": m.type,
        "heightU": m.form.height_u, "mount": m.form.mount,
        "portCount": sum(1 for p in ports if p["snmp_name"] and not p["combo"]),
    }


@router.get("")
async def list_models(user=Depends(get_current_user)):
    return sorted((_summary(m) for m in dm.all_models()),
                  key=lambda s: (s["vendor"].lower(), s["model"].lower()))


# -- dijagnostika (superadmin) -- MORA pre /{model_id:path} rute

@router.get("/_errors")
async def load_errors(user=Depends(require_superadmin)):
    return dm.load_errors()


@router.post("/_reload")
async def reload(user=Depends(require_superadmin)):
    lib = dm.reload_library()
    return {"models": len(lib.models), "errors": lib.errors}


@router.get("/_match-report")
async def match_report(user=Depends(require_superadmin)):
    """Koji model biblioteka prepoznaje za svaki postojeci mrezni uredjaj."""
    rows = await fetch(
        """SELECT d.id, d.tenant_id, d.name, t.name AS tenant, d.vendor, d.sys_descr, d.sys_object_id
           FROM network_devices d JOIN tenants t ON t.id = d.tenant_id
           WHERE d.active = true ORDER BY t.name, d.name""")
    out = []
    for r in rows:
        m = dm.match_model(r["sys_descr"], r["sys_object_id"])
        out.append({"id": str(r["id"]), "tenantId": str(r["tenant_id"]),
                    "tenant": r["tenant"], "name": r["name"], "vendor": r["vendor"],
                    "sysObjectId": r["sys_object_id"],
                    "sysDescr": (r["sys_descr"] or "")[:80],
                    "model": m.id if m else None})
    return out


@router.get("/{model_id:path}")
async def get_model(model_id: str, user=Depends(get_current_user)):
    m = dm.get_model(model_id)
    if not m:
        raise HTTPException(404, "Model nije pronadjen")
    return {**m.model_dump(by_alias=True), "ports": m.ports(), "passthrough": m.passthrough}
