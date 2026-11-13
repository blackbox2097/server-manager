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
                "SELECT room_id, rack_id, rack_position, model_id FROM infra_devices WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
                did, tid)
            if not cur:
                raise HTTPException(404, "Uredjaj nije pronadjen")
            if (cur["model_id"] or None) != model_id:
                await _check_cables_fit(conn, did, model_id)
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


# ── portovi i kablovi (pecovanje) ────────────────────────────────────────────
# Spisak portova dolazi iz modela; u bazi su samo uneti podaci o portu (modul,
# oznaka) i kablovi. Port = kljuc iz modela (vidi dm.port_key).

MODULES = ["none", "1G-SX", "1G-LX", "1G-T", "10G-SR", "10G-LR", "10G-DAC", "10G-T",
           "25G-SR", "25G-LR", "40G-SR4", "40G-LR4", "BiDi", "other"]
SIDES = ("front", "rear")


class PortInfoIn(BaseModel):
    deviceId: str
    port: str
    module: str | None = None
    label: str | None = None
    notes: str | None = None


class EndIn(BaseModel):
    deviceId: str
    port: str
    side: str = "front"


class CablePropsIn(BaseModel):
    cableType: str | None = None
    color: str | None = None
    lengthM: float | None = None
    label: str | None = None
    notes: str | None = None

    @field_validator("lengthM")
    @classmethod
    def _len(cls, v):
        if v is not None and not 0 < v < 100000:
            raise ValueError("Duzina mora biti pozitivna")
        return v


class CableIn(CablePropsIn):
    a: EndIn
    b: EndIn


def _port_label(key: str) -> str:
    return key[:-4] + " (SFP)" if key.endswith("@sfp") else key


async def _device_with_model(conn, tid: str, did: str):
    row = await conn.fetchrow(
        "SELECT id, name, model_id, room_id FROM infra_devices WHERE id=$1 AND tenant_id=$2", did, tid)
    if not row:
        raise HTTPException(404, "Uredjaj nije pronadjen")
    model = dm.get_model(row["model_id"]) if row["model_id"] else None
    return row, model


def _check_port(dev, model, key: str, side: str = "front") -> dict:
    if not model:
        raise HTTPException(400, f"{dev['name']}: uredjaj nema model -- portovi nisu poznati")
    port = model.cable_ports().get(key)
    if not port:
        raise HTTPException(400, f"{dev['name']}: port '{_port_label(key)}' ne postoji u modelu")
    if side not in SIDES:
        raise HTTPException(400, "Strana mora biti 'front' ili 'rear'")
    if side == "rear" and not model.passthrough:
        raise HTTPException(400, f"{dev['name']}: zadnja strana postoji samo kod panela")
    return port


async def _check_cables_fit(conn, did: str, model_id: str | None):
    """Promena modela ne sme da ostavi kabl na portu koji vise ne postoji."""
    ends = await conn.fetch("SELECT port_key, side FROM infra_cable_ends WHERE device_id=$1", did)
    if not ends:
        return
    model = dm.get_model(model_id) if model_id else None
    ports = model.cable_ports() if model else {}
    bad = sorted({_port_label(e["port_key"]) for e in ends
                  if e["port_key"] not in ports or (e["side"] == "rear" and not model.passthrough)})
    if bad:
        raise HTTPException(409, "Novi model nema portove na kojima su kablovi: "
                                 + ", ".join(bad) + " -- prvo otkaci te kablove")


def _cable_dict(c) -> dict:
    return {"id": str(c["id"]), "cableType": c["cable_type"], "color": c["color"],
            "lengthM": float(c["length_m"]) if c["length_m"] is not None else None,
            "label": c["label"], "notes": c["notes"]}


@router.get("/{tid}/infra/rooms/{rid}/cabling")
async def room_cabling(tid: str, rid: str, user=Depends(get_current_user)):
    """Podaci o portovima i svi kablovi koji imaju bar jedan kraj u lokaciji
    (drugi kraj moze biti u drugoj lokaciji)."""
    await check_tenant_perm(tid, user)
    await _check_room(tid, rid)
    info = await fetch(
        """SELECT p.device_id, p.port_key, p.module, p.label, p.notes FROM infra_port_info p
           JOIN infra_devices d ON d.id = p.device_id WHERE d.room_id=$1 AND d.tenant_id=$2""", rid, tid)
    rows = await fetch(
        """SELECT c.id, c.cable_type, c.color, c.length_m, c.label, c.notes,
                  e.end_no, e.device_id, e.port_key, e.side,
                  d.name AS device_name, d.room_id, ro.name AS room_name, r.name AS rack_name
           FROM infra_cables c
           JOIN infra_cable_ends e ON e.cable_id = c.id
           JOIN infra_devices d    ON d.id = e.device_id
           JOIN infra_rooms ro     ON ro.id = d.room_id
           LEFT JOIN infra_racks r ON r.id = d.rack_id
           WHERE c.tenant_id = $2 AND c.id IN (
               SELECT e2.cable_id FROM infra_cable_ends e2
               JOIN infra_devices d2 ON d2.id = e2.device_id WHERE d2.room_id = $1)
           ORDER BY c.id, e.end_no""", rid, tid)
    ports: dict[str, dict] = {}
    for r in info:
        ports.setdefault(str(r["device_id"]), {})[r["port_key"]] = {
            "module": r["module"], "label": r["label"], "notes": r["notes"]}
    cables: dict[str, dict] = {}
    for r in rows:
        c = cables.setdefault(str(r["id"]), {**_cable_dict(r), "ends": []})
        c["ends"].append({"deviceId": str(r["device_id"]), "deviceName": r["device_name"],
                          "port": r["port_key"], "side": r["side"],
                          "roomId": str(r["room_id"]), "roomName": r["room_name"], "rackName": r["rack_name"]})
    return {"ports": ports, "cables": [c for c in cables.values() if len(c["ends"]) == 2],
            "modules": MODULES}


@router.put("/{tid}/infra/port-info")
async def set_port_info(tid: str, req: Request, body: PortInfoIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    pool = await get_pool()
    async with pool.acquire() as conn:
        dev, model = await _device_with_model(conn, tid, body.deviceId)
        port = _check_port(dev, model, body.port)
        module = _n(body.module)
        if module is not None:
            if port["type"] not in dm.MODULE_TYPES:
                raise HTTPException(400, "Modul se unosi samo za SFP/QSFP slotove")
            if module not in MODULES:
                raise HTTPException(400, f"Nepoznat tip modula '{module}'")
        label, notes = _n(body.label), _n(body.notes)
        if module is None and label is None and notes is None:
            await conn.execute("DELETE FROM infra_port_info WHERE device_id=$1 AND port_key=$2",
                               body.deviceId, body.port)
        else:
            await conn.execute(
                """INSERT INTO infra_port_info (device_id, port_key, module, label, notes)
                   VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (device_id, port_key) DO UPDATE
                   SET module=$3, label=$4, notes=$5, updated_at=NOW()""",
                body.deviceId, body.port, module, label, notes)
    await _log("infra.port.update", req, user, tid, body.deviceId,
               {"device": dev["name"], "port": body.port, "module": module, "label": label})
    return {"ok": True}


@router.post("/{tid}/infra/cables", status_code=201)
async def create_cable(tid: str, req: Request, body: CableIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    if body.a.deviceId == body.b.deviceId and body.a.port == body.b.port:
        raise HTTPException(400, "Kabl ne moze da spaja port sam sa sobom")
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            ends = []
            for e in (body.a, body.b):
                dev, model = await _device_with_model(conn, tid, e.deviceId)
                _check_port(dev, model, e.port, e.side)
                busy = await conn.fetchrow(
                    """SELECT od.name, o.port_key FROM infra_cable_ends x
                       JOIN infra_cable_ends o ON o.cable_id = x.cable_id AND o.end_no <> x.end_no
                       JOIN infra_devices od ON od.id = o.device_id
                       WHERE x.device_id=$1 AND x.port_key=$2 AND x.side=$3""",
                    e.deviceId, e.port, e.side)
                if busy:
                    raise HTTPException(409, f"{dev['name']} / {_port_label(e.port)} je vec povezan "
                                             f"(sa {busy['name']} / {_port_label(busy['port_key'])})")
                ends.append((dev, e))
            row = await conn.fetchrow(
                """INSERT INTO infra_cables (tenant_id, cable_type, color, length_m, label, notes)
                   VALUES ($1,$2,$3,$4,$5,$6) RETURNING id""",
                tid, _n(body.cableType), _n(body.color), body.lengthM, _n(body.label), _n(body.notes))
            try:
                for no, (dev, e) in enumerate(ends, 1):
                    await conn.execute(
                        """INSERT INTO infra_cable_ends (cable_id, end_no, device_id, port_key, side)
                           VALUES ($1,$2,$3,$4,$5)""", row["id"], no, e.deviceId, e.port, e.side)
            except asyncpg.UniqueViolationError:
                raise HTTPException(409, "Port je u medjuvremenu povezan -- osvezi prikaz")
    a, b = ends
    await _log("infra.cable.create", req, user, tid, row["id"], {
        "a": f"{a[0]['name']} / {_port_label(a[1].port)} ({a[1].side})",
        "b": f"{b[0]['name']} / {_port_label(b[1].port)} ({b[1].side})"})
    return {"id": str(row["id"])}


@router.put("/{tid}/infra/cables/{cid}")
async def update_cable(tid: str, cid: str, req: Request, body: CablePropsIn, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    row = await fetchrow(
        """UPDATE infra_cables SET cable_type=$1, color=$2, length_m=$3, label=$4, notes=$5, updated_at=NOW()
           WHERE id=$6 AND tenant_id=$7 RETURNING id""",
        _n(body.cableType), _n(body.color), body.lengthM, _n(body.label), _n(body.notes), cid, tid)
    if not row:
        raise HTTPException(404, "Kabl nije pronadjen")
    await _log("infra.cable.update", req, user, tid, cid, {"label": _n(body.label)})
    return {"ok": True}


@router.delete("/{tid}/infra/cables/{cid}")
async def delete_cable(tid: str, cid: str, req: Request, user=Depends(get_current_user)):
    await check_tenant_perm(tid, user, PERM)
    ends = await fetch(
        """SELECT d.name, e.port_key FROM infra_cable_ends e JOIN infra_devices d ON d.id=e.device_id
           JOIN infra_cables c ON c.id=e.cable_id WHERE e.cable_id=$1 AND c.tenant_id=$2 ORDER BY e.end_no""",
        cid, tid)
    row = await fetchrow("DELETE FROM infra_cables WHERE id=$1 AND tenant_id=$2 RETURNING id", cid, tid)
    if not row:
        raise HTTPException(404, "Kabl nije pronadjen")
    await _log("infra.cable.delete", req, user, tid, cid,
               {"ends": [f"{e['name']} / {_port_label(e['port_key'])}" for e in ends]})
    return {"ok": True}


@router.get("/{tid}/infra/trace")
async def trace(tid: str, deviceId: str, port: str, user=Depends(get_current_user)):
    """Putanja od porta do krajnjih uredjaja, kroz panele (prednja -> zadnja
    strana). Za port na panelu ide u oba smera. Vraca naizmenicno
    [port, kabl, port, kabl, ... port]."""
    await check_tenant_perm(tid, user)
    pool = await get_pool()
    async with pool.acquire() as conn:
        dev, model = await _device_with_model(conn, tid, deviceId)
        _check_port(dev, model, port)
        devs: dict[str, dict] = {}

        async def point(did, key):
            if did not in devs:
                r = await conn.fetchrow(
                    """SELECT d.name, d.model_id, d.rack_position, ro.id AS room_id, ro.name AS room_name,
                              r.name AS rack_name
                       FROM infra_devices d JOIN infra_rooms ro ON ro.id=d.room_id
                       LEFT JOIN infra_racks r ON r.id=d.rack_id WHERE d.id=$1""", did)
                m = dm.get_model(r["model_id"]) if r["model_id"] else None
                devs[did] = {"deviceName": r["name"], "roomId": str(r["room_id"]), "roomName": r["room_name"],
                             "rackName": r["rack_name"], "rackPosition": r["rack_position"],
                             "passthrough": bool(m and m.passthrough)}
            return {"kind": "port", "deviceId": did, "port": key, "portName": _port_label(key), **devs[did]}

        async def walk(did, key, side):
            out, seen = [], {(did, key)}
            while len(out) < 64:
                c = await conn.fetchrow(
                    """SELECT c.id, c.cable_type, c.color, c.length_m, c.label, c.notes,
                              o.device_id, o.port_key, o.side
                       FROM infra_cable_ends e JOIN infra_cables c ON c.id = e.cable_id
                       JOIN infra_cable_ends o ON o.cable_id = e.cable_id AND o.end_no <> e.end_no
                       WHERE e.device_id=$1 AND e.port_key=$2 AND e.side=$3""", did, key, side)
                if not c:
                    break
                d2, k2 = str(c["device_id"]), c["port_key"]
                p = await point(d2, k2)
                out += [{"kind": "cable", **_cable_dict(c), "sides": [side, c["side"]]}, p]
                if not p["passthrough"] or (d2, k2) in seen:
                    break
                seen.add((d2, k2))
                did, key, side = d2, k2, "front" if c["side"] == "rear" else "rear"
            return out

        start = await point(deviceId, port)
        if start["passthrough"]:
            back = await walk(deviceId, port, "rear")
            back = [{**x, "sides": x["sides"][::-1]} if x["kind"] == "cable" else x for x in back[::-1]]
            path = back + [start] + await walk(deviceId, port, "front")
        else:
            path = [start] + await walk(deviceId, port, "front")
    return {"path": path}
