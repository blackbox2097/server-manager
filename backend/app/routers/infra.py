# app/routers/infra.py
# Infrastruktura (13.11.2026): lokacije (sobe), rackovi i uredjaji u racku.
# Fizicka dokumentacija, po tenantu. Izgled uredjaja iz biblioteke modela.
# Dozvola za izmene: perm_network_manage (isti domen kao mrezni uredjaji;
# moze se kasnije odvojiti u sopstvenu dozvolu).
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
import asyncpg

from app.database import fetch, fetchrow, get_pool
from app.services.auth import get_current_user, check_tenant_perm
from app.services.audit import log_event
from app.services import device_models as dm

router = APIRouter(prefix="/api/tenants", tags=["infra"])
PERM = "perm_network_manage"


def _n(v):
    if isinstance(v, str):
        v = v.strip()
    return None if v in ("", None) else v


def _ip(req: Request) -> str | None:
    return req.client.host if req.client else None


async def _log(action, req, user, tid, rid, details):
    await log_event(action, user_id=user["id"], username=user.get("username"), tenant_id=tid,
                    ip_address=_ip(req), resource_type="infra", resource_id=str(rid), details=details)


class _Name(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def _not_empty(cls, v):
        if not v or not v.strip():
            raise ValueError("Naziv je obavezan")
        return v.strip()


class RoomIn(_Name):
    location: str | None = None
    floor: str | None = None
    notes: str | None = None


class RackIn(_Name):
    roomId: str
    heightU: int = 42
    unitsFromTop: bool = False
    notes: str | None = None

    @field_validator("heightU")
    @classmethod
    def _h(cls, v):
        if not 1 <= v <= 60:
            raise ValueError("Visina racka mora biti 1-60 U")
        return v


class DeviceIn(_Name):
    roomId: str
    modelId: str | None = None
    heightU: int | None = None          # samo bez modela
    serialNumber: str | None = None
    notes: str | None = None
    networkDeviceId: str | None = None
    serverId: str | None = None
    upsId: str | None = None
    rackId: str | None = None           # samo pri kreiranju (posle: /place)
    rackPosition: int | None = None


class PlaceIn(BaseModel):
    rackId: str | None = None
    position: int | None = None


# ── pomocne ──────────────────────────────────────────────────────────────────

def _height_for(model_id: str | None, height_u: int | None) -> int:
    if model_id:
        m = dm.get_model(model_id)
        if not m:
            raise HTTPException(400, f"Model '{model_id}' ne postoji u biblioteci")
        if m.form.height_u < 1:
            return 0  # ne ide u rack (AP, SXT...)
        return m.form.height_u
    h = height_u or 1
    if not 1 <= h <= 60:
        raise HTTPException(400, "Visina uredjaja mora biti 1-60 U")
    return h


async def _check_room(tid: str, room_id: str):
    row = await fetchrow("SELECT id, name FROM infra_rooms WHERE id=$1 AND tenant_id=$2", room_id, tid)
    if not row:
        raise HTTPException(404, "Lokacija nije pronadjena")
    return row


async def _check_links(tid: str, body: DeviceIn):
    links = [(body.networkDeviceId, "network_devices", "Mrezni uredjaj"),
             (body.serverId, "servers", "Server"), (body.upsId, "ups_devices", "UPS")]
    given = [l for l in links if _n(l[0])]
    if len(given) > 1:
        raise HTTPException(400, "Uredjaj moze biti povezan sa najvise jednom stavkom iz monitoringa")
    for lid, table, label in given:
        ok = await fetchrow(f"SELECT 1 FROM {table} WHERE id=$1 AND tenant_id=$2", lid, tid)
        if not ok:
            raise HTTPException(400, f"{label} nije pronadjen u ovom tenantu")


async def _place(conn, tid: str, device_id: str | None, room_id: str, rack_id: str,
                 position: int, height: int):
    """Provera da uredjaj staje na poziciju (u transakciji, rack zakljucan)."""
    rack = await conn.fetchrow(
        """SELECT r.id, r.name, r.height_u, r.room_id FROM infra_racks r
           JOIN infra_rooms ro ON ro.id = r.room_id
           WHERE r.id=$1 AND ro.tenant_id=$2 FOR UPDATE OF r""", rack_id, tid)
    if not rack:
        raise HTTPException(404, "Rack nije pronadjen")
    if str(rack["room_id"]) != str(room_id):
        raise HTTPException(400, "Rack nije u istoj lokaciji kao uredjaj")
    if height < 1:
        raise HTTPException(400, "Ovaj model ne ide u rack")
    if position is None or position < 1:
        raise HTTPException(400, "Pozicija mora biti >= 1")
    top = position + height - 1
    if top > rack["height_u"]:
        raise HTTPException(409, f"Uredjaj ne staje: zauzimao bi U{position}-U{top}, a rack ima {rack['height_u']} U")
    clash = await conn.fetchrow(
        """SELECT name, rack_position, height_u FROM infra_devices
           WHERE rack_id=$1 AND ($2::uuid IS NULL OR id <> $2::uuid)
             AND rack_position <= $4 AND rack_position + height_u - 1 >= $3
           ORDER BY rack_position LIMIT 1""",
        rack_id, device_id, position, top)
    if clash:
        c_top = clash["rack_position"] + clash["height_u"] - 1
        span = f"U{clash['rack_position']}" + (f"-U{c_top}" if c_top != clash["rack_position"] else "")
        raise HTTPException(409, f"Mesto je zauzeto: {clash['name']} ({span})")


def _unique_msg(e: asyncpg.UniqueViolationError) -> str:
    c = e.constraint_name or ""
    return {
        "infra_rooms_name_unique": "Lokacija sa tim nazivom vec postoji",
        "infra_racks_name_unique": "Rack sa tim nazivom vec postoji u ovoj lokaciji",
        "infra_devices_netdev_unique": "Taj mrezni uredjaj je vec povezan sa drugim uredjajem u racku",
        "infra_devices_server_unique": "Taj server je vec povezan sa drugim uredjajem u racku",
        "infra_devices_ups_unique": "Taj UPS je vec povezan sa drugim uredjajem u racku",
    }.get(c, "Zapis vec postoji")


# ── lokacije ─────────────────────────────────────────────────────────────────

@router.get("/{tid}/infra/rooms")
async def list_rooms(tid: str, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user)
    rows = await fetch(
        """SELECT ro.id, ro.name, ro.location, ro.floor, ro.notes, ro.created_at,
                  (SELECT COUNT(*) FROM infra_racks r WHERE r.room_id = ro.id) AS rack_count,
                  (SELECT COUNT(*) FROM infra_devices d WHERE d.room_id = ro.id) AS device_count,
                  (SELECT COALESCE(SUM(r.height_u), 0) FROM infra_racks r WHERE r.room_id = ro.id) AS units_total,
                  (SELECT COALESCE(SUM(d.height_u), 0) FROM infra_devices d
                    WHERE d.room_id = ro.id AND d.rack_id IS NOT NULL) AS units_used
           FROM infra_rooms ro WHERE ro.tenant_id=$1 ORDER BY ro.location NULLS LAST, ro.name""", tid)
    return [dict(r) for r in rows]


@router.post("/{tid}/infra/rooms", status_code=201)
async def create_room(tid: str, req: Request, body: RoomIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    try:
        row = await fetchrow(
            """INSERT INTO infra_rooms (tenant_id, name, location, floor, notes)
               VALUES ($1,$2,$3,$4,$5) RETURNING id, name""",
            tid, body.name, _n(body.location), _n(body.floor), _n(body.notes))
    except asyncpg.UniqueViolationError as e:
        raise HTTPException(409, _unique_msg(e))
    await _log("infra.room.create", req, user, tid, row["id"], {"name": body.name})
    return dict(row)


@router.put("/{tid}/infra/rooms/{rid}")
async def update_room(tid: str, rid: str, req: Request, body: RoomIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    try:
        row = await fetchrow(
            """UPDATE infra_rooms SET name=$1, location=$2, floor=$3, notes=$4, updated_at=NOW()
               WHERE id=$5 AND tenant_id=$6 RETURNING id, name""",
            body.name, _n(body.location), _n(body.floor), _n(body.notes), rid, tid)
    except asyncpg.UniqueViolationError as e:
        raise HTTPException(409, _unique_msg(e))
    if not row:
        raise HTTPException(404, "Lokacija nije pronadjena")
    await _log("infra.room.update", req, user, tid, rid, {"name": body.name})
    return dict(row)


@router.delete("/{tid}/infra/rooms/{rid}")
async def delete_room(tid: str, rid: str, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    room = await _check_room(tid, rid)
    n = await fetchrow("SELECT COUNT(*) AS c FROM infra_devices WHERE room_id=$1", rid)
    if n["c"]:
        raise HTTPException(409, f"Lokacija ima {n['c']} uredjaja -- prvo ih obrisi ili premesti")
    await fetchrow("DELETE FROM infra_rooms WHERE id=$1 AND tenant_id=$2 RETURNING id", rid, tid)
    await _log("infra.room.delete", req, user, tid, rid, {"name": room["name"]})
    return {"ok": True}


@router.get("/{tid}/infra/rooms/{rid}")
async def get_room(tid: str, rid: str, user=Depends(get_current_user)):
    """Sve za prikaz lokacije: rackovi + uredjaji (sa stanjem povezanog monitoringa)."""
    await check_tenant_perm(tid, user)
    room = await fetchrow(
        "SELECT id, name, location, floor, notes FROM infra_rooms WHERE id=$1 AND tenant_id=$2", rid, tid)
    if not room:
        raise HTTPException(404, "Lokacija nije pronadjena")
    racks = await fetch(
        """SELECT id, name, height_u, units_from_top, sort_order, notes FROM infra_racks
           WHERE room_id=$1 ORDER BY sort_order, name""", rid)
    devices = await fetch(
        """SELECT d.id, d.name, d.model_id, d.height_u, d.rack_id, d.rack_position,
                  d.serial_number, d.notes,
                  d.network_device_id, d.server_id, d.ups_id,
                  COALESCE(nd.name, s.name, u.name)       AS linked_name,
                  COALESCE(nd.status, s.status, u.status) AS linked_status,
                  COALESCE(host(nd.ip_address), host(s.ip_address), u.host) AS linked_ip,
                  CASE WHEN d.network_device_id IS NOT NULL THEN 'network'
                       WHEN d.server_id IS NOT NULL THEN 'server'
                       WHEN d.ups_id IS NOT NULL THEN 'ups' END AS linked_kind
           FROM infra_devices d
           LEFT JOIN network_devices nd ON nd.id = d.network_device_id
           LEFT JOIN servers s          ON s.id  = d.server_id
           LEFT JOIN ups_devices u      ON u.id  = d.ups_id
           WHERE d.room_id=$1 ORDER BY d.name""", rid)
    return {"room": dict(room), "racks": [dict(r) for r in racks], "devices": [dict(d) for d in devices]}


@router.get("/{tid}/infra/rooms/{rid}/port-states")
async def room_port_states(tid: str, rid: str, user=Depends(get_current_user)):
    """SNMP interfejsi svih uredjaja u lokaciji koji su povezani sa mreznim
    uredjajem -- jednim upitom, da rack prikaz odmah oboji portove."""
    await check_tenant_perm(tid, user)
    await _check_room(tid, rid)
    rows = await fetch(
        """SELECT d.id AS infra_id, i.if_index, i.if_name, i.if_type, i.if_alias,
                  i.oper_status, i.admin_status, i.if_speed_bps
           FROM infra_devices d
           JOIN network_device_interfaces i ON i.device_id = d.network_device_id
           WHERE d.room_id = $1 AND d.tenant_id = $2
           ORDER BY d.id, i.if_index""", rid, tid)
    out: dict[str, list] = {}
    for r in rows:
        out.setdefault(str(r["infra_id"]), []).append(
            {k: r[k] for k in ("if_index", "if_name", "if_type", "if_alias",
                               "oper_status", "admin_status", "if_speed_bps")})
    return out


# ── rackovi ──────────────────────────────────────────────────────────────────

@router.post("/{tid}/infra/racks", status_code=201)
async def create_rack(tid: str, req: Request, body: RackIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    await _check_room(tid, body.roomId)
    try:
        row = await fetchrow(
            """INSERT INTO infra_racks (room_id, name, height_u, units_from_top, notes, sort_order)
               VALUES ($1,$2,$3,$4,$5,
                       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM infra_racks WHERE room_id=$1))
               RETURNING id, name""",
            body.roomId, body.name, body.heightU, body.unitsFromTop, _n(body.notes))
    except asyncpg.UniqueViolationError as e:
        raise HTTPException(409, _unique_msg(e))
    await _log("infra.rack.create", req, user, tid, row["id"], {"name": body.name, "heightU": body.heightU})
    return dict(row)


@router.put("/{tid}/infra/racks/{kid}")
async def update_rack(tid: str, kid: str, req: Request, body: RackIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            rack = await conn.fetchrow(
                """SELECT r.id, r.room_id FROM infra_racks r JOIN infra_rooms ro ON ro.id=r.room_id
                   WHERE r.id=$1 AND ro.tenant_id=$2 FOR UPDATE OF r""", kid, tid)
            if not rack:
                raise HTTPException(404, "Rack nije pronadjen")
            if str(rack["room_id"]) != body.roomId:
                raise HTTPException(400, "Rack se ne premesta izmedju lokacija")
            over = await conn.fetchrow(
                """SELECT name FROM infra_devices WHERE rack_id=$1
                   AND rack_position + height_u - 1 > $2 LIMIT 1""", kid, body.heightU)
            if over:
                raise HTTPException(409, f"Rack ne moze biti nizi od {body.heightU} U: {over['name']} bi ostao van racka")
            try:
                await conn.execute(
                    """UPDATE infra_racks SET name=$1, height_u=$2, units_from_top=$3, notes=$4,
                       updated_at=NOW() WHERE id=$5""",
                    body.name, body.heightU, body.unitsFromTop, _n(body.notes), kid)
            except asyncpg.UniqueViolationError as e:
                raise HTTPException(409, _unique_msg(e))
    await _log("infra.rack.update", req, user, tid, kid, {"name": body.name, "heightU": body.heightU})
    return {"ok": True}


@router.delete("/{tid}/infra/racks/{kid}")
async def delete_rack(tid: str, kid: str, req: Request, user=Depends(get_current_user)):
    """Brisanje racka NE brise uredjaje -- ostaju u lokaciji, bez mesta."""
    await check_tenant_perm(tid, user, PERM)
    row = await fetchrow(
        """DELETE FROM infra_racks r USING infra_rooms ro
           WHERE r.id=$1 AND ro.id=r.room_id AND ro.tenant_id=$2 RETURNING r.name""", kid, tid)
    if not row:
        raise HTTPException(404, "Rack nije pronadjen")
    await _log("infra.rack.delete", req, user, tid, kid, {"name": row["name"]})
    return {"ok": True}


# ── uredjaji ─────────────────────────────────────────────────────────────────

@router.post("/{tid}/infra/devices", status_code=201)
async def create_device(tid: str, req: Request, body: DeviceIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    await _check_room(tid, body.roomId)
    await _check_links(tid, body)
    model_id = _n(body.modelId)
    height = _height_for(model_id, body.heightU)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            rack_id = _n(body.rackId)
            if rack_id:
                await _place(conn, tid, None, body.roomId, rack_id, body.rackPosition, height)
            try:
                row = await conn.fetchrow(
                    """INSERT INTO infra_devices
                         (tenant_id, room_id, rack_id, rack_position, height_u, model_id, name,
                          serial_number, notes, network_device_id, server_id, ups_id)
                       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, name""",
                    tid, body.roomId, rack_id, body.rackPosition if rack_id else None,
                    max(height, 1), model_id, body.name, _n(body.serialNumber), _n(body.notes),
                    _n(body.networkDeviceId), _n(body.serverId), _n(body.upsId))
            except asyncpg.UniqueViolationError as e:
                raise HTTPException(409, _unique_msg(e))
    await _log("infra.device.create", req, user, tid, row["id"], {"name": body.name, "model": model_id})
    return dict(row)


@router.put("/{tid}/infra/devices/{did}")
async def update_device(tid: str, did: str, req: Request, body: DeviceIn, user=Depends(get_current_user)):
    """Izmena podataka. Promena lokacije skida uredjaj iz racka; promena modela
    (visine) se proverava na trenutnoj poziciji."""
    await check_tenant_perm(tid, user, PERM)
    await _check_room(tid, body.roomId)
    await _check_links(tid, body)
    model_id = _n(body.modelId)
    height = _height_for(model_id, body.heightU)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            cur = await conn.fetchrow(
                "SELECT room_id, rack_id, rack_position FROM infra_devices WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
                did, tid)
            if not cur:
                raise HTTPException(404, "Uredjaj nije pronadjen")
            rack_id, pos = cur["rack_id"], cur["rack_position"]
            if str(cur["room_id"]) != body.roomId:
                rack_id, pos = None, None
            if rack_id:
                await _place(conn, tid, did, body.roomId, str(rack_id), pos, height)
            try:
                await conn.execute(
                    """UPDATE infra_devices SET room_id=$1, rack_id=$2, rack_position=$3, height_u=$4,
                         model_id=$5, name=$6, serial_number=$7, notes=$8,
                         network_device_id=$9, server_id=$10, ups_id=$11, updated_at=NOW()
                       WHERE id=$12""",
                    body.roomId, rack_id, pos, max(height, 1), model_id, body.name,
                    _n(body.serialNumber), _n(body.notes),
                    _n(body.networkDeviceId), _n(body.serverId), _n(body.upsId), did)
            except asyncpg.UniqueViolationError as e:
                raise HTTPException(409, _unique_msg(e))
    await _log("infra.device.update", req, user, tid, did, {"name": body.name, "model": model_id})
    return {"ok": True}


@router.patch("/{tid}/infra/devices/{did}/place")
async def place_device(tid: str, did: str, req: Request, body: PlaceIn, user=Depends(get_current_user)):
    """Premestanje (drag & drop): u rack na poziciju, ili rackId=null = skini iz racka."""
    await check_tenant_perm(tid, user, PERM)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            cur = await conn.fetchrow(
                """SELECT name, room_id, model_id, height_u FROM infra_devices
                   WHERE id=$1 AND tenant_id=$2 FOR UPDATE""", did, tid)
            if not cur:
                raise HTTPException(404, "Uredjaj nije pronadjen")
            rack_id = _n(body.rackId)
            if rack_id:
                height = _height_for(cur["model_id"], cur["height_u"])
                await _place(conn, tid, did, str(cur["room_id"]), rack_id, body.position, height)
                await conn.execute(
                    "UPDATE infra_devices SET rack_id=$1, rack_position=$2, updated_at=NOW() WHERE id=$3",
                    rack_id, body.position, did)
            else:
                await conn.execute(
                    "UPDATE infra_devices SET rack_id=NULL, rack_position=NULL, updated_at=NOW() WHERE id=$1", did)
    await _log("infra.device.move", req, user, tid, did,
               {"name": cur["name"], "rackId": rack_id, "position": body.position if rack_id else None})
    return {"ok": True}


@router.delete("/{tid}/infra/devices/{did}")
async def delete_device(tid: str, did: str, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    row = await fetchrow("DELETE FROM infra_devices WHERE id=$1 AND tenant_id=$2 RETURNING name", did, tid)
    if not row:
        raise HTTPException(404, "Uredjaj nije pronadjen")
    await _log("infra.device.delete", req, user, tid, did, {"name": row["name"]})
    return {"ok": True}


@router.get("/{tid}/infra/link-candidates")
async def link_candidates(tid: str, user=Depends(get_current_user)):
    """Stavke iz monitoringa koje mogu da se povezu sa uredjajem u racku, uz
    predlog modela (prepoznavanje iz biblioteke) i oznaku vec povezanih."""
    await check_tenant_perm(tid, user)
    linked = await fetch(
        """SELECT network_device_id, server_id, ups_id, id FROM infra_devices WHERE tenant_id=$1""", tid)
    used = {}
    for r in linked:
        for k in ("network_device_id", "server_id", "ups_id"):
            if r[k]:
                used[str(r[k])] = str(r["id"])
    net = await fetch(
        """SELECT id, name, ip_address, vendor, model, status, sys_descr, sys_object_id
           FROM network_devices WHERE tenant_id=$1 AND active=true ORDER BY name""", tid)
    srv = await fetch(
        "SELECT id, name, ip_address, status FROM servers WHERE tenant_id=$1 AND active=true ORDER BY name", tid)
    ups = await fetch(
        "SELECT id, name, host, status, manufacturer, model FROM ups_devices WHERE tenant_id=$1 AND active=true ORDER BY name", tid)

    def net_row(r):
        m = dm.match_model(r["sys_descr"], r["sys_object_id"])
        return {"id": str(r["id"]), "name": r["name"], "ip": str(r["ip_address"]), "status": r["status"],
                "vendor": r["vendor"], "model": r["model"], "suggestedModel": m.id if m else None,
                "linkedTo": used.get(str(r["id"]))}
    return {
        "network": [net_row(r) for r in net],
        "servers": [{"id": str(r["id"]), "name": r["name"], "ip": str(r["ip_address"]), "status": r["status"],
                     "linkedTo": used.get(str(r["id"]))} for r in srv],
        "ups": [{"id": str(r["id"]), "name": r["name"], "ip": r["host"], "status": r["status"],
                 "model": " ".join(x for x in (r["manufacturer"], r["model"]) if x) or None,
                 "linkedTo": used.get(str(r["id"]))} for r in ups],
    }
