# app/services/device_models.py
# Biblioteka modela uredjaja (rack modul, 13.11.2026).
#
# Model je PODATAK, ne kod: JSON fajl u app/device_models/<vendor>/<slug>.json
# opisuje oblik uredjaja (visina u U, nacin montaze), prednju (i opciono zadnju)
# plocu kao niz blokova portova, i pravila za prepoznavanje preko SNMP-a.
# Jedan opsti renderer na frontendu crta plocu iz definicije.
#
# Fajlovi se ucitavaju lenjo, jednom, i validiraju -- neispravna definicija
# NE rusi aplikaciju: preskace se i ostaje u listi gresaka (vidljivo kroz
# /api/device-models/_errors), da se odmah vidi sta ne valja.
#
# Geometrija je u milimetrima (merljivo na stvarnom uredjaju); renderer
# sam preracunava u piksele.

import json
import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)

MODELS_DIR = Path(__file__).resolve().parent.parent / "device_models"
SCHEMA_VERSION = 1

PortType = Literal["rj45", "sfp", "sfp+", "sfp28", "qsfp+", "console", "usb", "power", "mgmt",
                   "lc", "sc", "outlet"]  # lc/sc: opticki paneli; outlet: uticnica na PDU-u
DeviceType = Literal["switch", "router", "firewall", "ap", "patch_panel", "fiber_panel",
                     "ups", "server", "nas", "pdu", "shelf", "blank", "cable_manager", "other"]
# Tipovi "porta" koji nisu mrezni -- crtaju se, ali se ne mapiraju na SNMP i ne pecuju
NON_NETWORK = {"usb", "power", "outlet"}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Layout(_Strict):
    rows: Literal[1, 2] = 1
    # odd-top:   1 gore, 2 dole, 3 gore...      (Aruba, HPE, Allied)
    # even-top:  2 gore, 1 dole, 4 gore...      (noviji MikroTik: CCR2004, CSS318, CSS610)
    # row-major: ceo gornji red pa ceo donji    (Cisco RV345: 1-8 gore, 9-16 dole)
    order: Literal["odd-top", "even-top", "row-major"] = "odd-top"
    group_cols: int = Field(0, ge=0)   # razmak posle svakih N kolona (0 = bez grupa)


class Block(_Strict):
    name: str                          # "ether{n}" za opseg, ili tacno ime za jedan port
    from_: int | None = Field(None, alias="from", ge=0)
    to: int | None = Field(None, ge=0)
    type: PortType
    speed: str | None = None           # "100M", "1G", "2.5G", "10G"...
    poe: Literal["in", "out"] | None = None
    poe_in: list[str] = []             # pojedinacni portovi sa PoE-in (npr. ["Port1"])
    combo: bool = False                # SFP koji deli interfejs sa istoimenim RJ45 portom
    snmp_name: str | None = None       # obrazac ifName ako se razlikuje od name ("Slot0/{n}")
    layout: Layout = Layout()
    gap_before_mm: float = Field(2.0, ge=0)
    valign: Literal["center", "bottom"] = "center"

    @model_validator(mode="after")
    def _range(self):
        has_n = "{n}" in self.name
        if (self.from_ is None) != (self.to is None):
            raise ValueError(f"blok '{self.name}': 'from' i 'to' idu zajedno")
        if self.from_ is not None:
            if not has_n:
                raise ValueError(f"blok '{self.name}': opseg trazi {{n}} u imenu")
            if self.to < self.from_:
                raise ValueError(f"blok '{self.name}': to < from")
        elif has_n:
            raise ValueError(f"blok '{self.name}': {{n}} u imenu trazi from/to")
        if self.snmp_name and ("{n}" in self.snmp_name) != has_n:
            raise ValueError(f"blok '{self.name}': snmp_name i name moraju oba imati ili nemati {{n}}")
        return self

    def names(self) -> list[tuple[str, str]]:
        """[(ime, snmp_ime)] za sve portove bloka."""
        snmp = self.snmp_name or self.name
        if self.from_ is None:
            return [(self.name, snmp)]
        return [(self.name.replace("{n}", str(n)), snmp.replace("{n}", str(n)))
                for n in range(self.from_, self.to + 1)]


class Label(_Strict):
    text: str
    x: float = Field(0.02, ge=0, le=1)  # udeo sirine kucista
    y: float = Field(0.25, ge=0, le=1)


class Decor(_Strict):
    """Elementi izgleda bez portova (diskovi, ventilacija, ekran, dugmad...).
    x_mm je od leve ivice kucista; vertikalno je centrirano."""
    kind: Literal["bays", "vent", "lcd", "button", "leds", "status_led", "handles"]
    x_mm: float = 0
    w_mm: float = 0                  # bays: sirina jednog lezista; vent/lcd: sirina
    h_mm: float = 0                  # bays: visina jednog lezista; lcd: visina
    cols: int = Field(1, ge=1)
    rows: int = Field(1, ge=1)
    gap_mm: float = 1.5
    count: int = Field(1, ge=1)      # leds


class Face(_Strict):
    start_mm: float = Field(10.0, ge=0)  # od leve ivice KUCISTA do prvog bloka
    blocks: list[Block] = []
    decor: list[Decor] = []
    leds_mm: tuple[float, float] | None = None  # LED panel (od, do) -- samo izgled
    label: Label | None = None


class Form(_Strict):
    height_u: int = Field(1, ge=0, le=48)     # 0 = ne ide u rack (AP, SXT, hEX na polici...)
    # rack:    rack-mount kuciste (sopstvene usi)
    # ears:    stoni uredjaj sa montiranim usima
    # bracket: nosac (npr. MikroTik za RB5009) -- zauzima ceo U
    # none:    van racka
    mount: Literal["rack", "ears", "bracket", "none"] = "rack"
    body_width_mm: float = Field(442.0, gt=0, le=482.6)
    body_height_mm: float | None = Field(None, gt=0)  # None = puna visina height_u
    body_align: Literal["left", "center", "right"] = "center"

    @model_validator(mode="after")
    def _mount(self):
        if (self.mount == "none") != (self.height_u == 0):
            raise ValueError("mount 'none' ide uz height_u 0 (i obrnuto)")
        return self


class Look(_Strict):
    chassis: str = "#e9e8e4"
    text: str = "#444441"


class Match(_Strict):
    sys_descr: list[str] = []         # podstring (bez obzira na velika/mala slova)
    sys_object_id: list[str] = []     # prefiks OID-a


class Snmp(_Strict):
    # name:           port <-> ifName po imenu (snmp_name obrazac)
    # ethernet-order: po imenu, a gde ne nadje -- po redosledu ethernet
    #                 interfejsa po ifIndex (preimenovani portovi na MikroTiku)
    map: Literal["name", "ethernet-order"] = "name"


class DeviceModel(_Strict):
    schema_: int = Field(SCHEMA_VERSION, alias="schema")
    id: str
    vendor: str
    model: str
    sku: str | None = None
    type: DeviceType
    match: Match = Match()
    form: Form = Form()
    look: Look = Look()
    front: Face = Face()
    rear: Face | None = None
    snmp: Snmp = Snmp()
    notes: str | None = None

    @model_validator(mode="after")
    def _check(self):
        if self.schema_ != SCHEMA_VERSION:
            raise ValueError(f"nepodrzana verzija seme {self.schema_}")
        if not re.fullmatch(r"[a-z0-9-]+/[a-z0-9.-]+", self.id):
            raise ValueError("id mora biti 'vendor/slug' (mala slova, cifre, crtica)")
        seen: dict[str, str] = {}
        for face_name, face in (("front", self.front), ("rear", self.rear)):
            if face is None:
                continue
            for b in face.blocks:
                for name, _ in b.names():
                    if b.combo:
                        continue  # combo SFP NAMERNO nosi isto ime kao RJ45 par
                    if name in seen:
                        raise ValueError(f"port '{name}' se ponavlja ({seen[name]} i {face_name})")
                    seen[name] = face_name
        # combo SFP mora imati RJ45 par istog imena
        for face in (self.front, self.rear):
            if face is None:
                continue
            for b in face.blocks:
                if b.combo:
                    for name, _ in b.names():
                        if name not in seen:
                            raise ValueError(f"combo port '{name}' nema RJ45 par")
        return self

    def ports(self) -> list[dict]:
        """Razvijena lista portova (redosled = redosled na ploci)."""
        out = []
        for face_name, face in (("front", self.front), ("rear", self.rear)):
            if face is None:
                continue
            for bi, b in enumerate(face.blocks):
                for name, snmp in b.names():
                    out.append({
                        "name": name,
                        "snmp_name": None if b.type in NON_NETWORK else snmp,
                        "type": b.type,
                        "speed": b.speed,
                        "poe": "in" if name in b.poe_in else b.poe,
                        "combo": b.combo,
                        "face": face_name,
                        "block": bi,
                    })
        return out


class _Library:
    def __init__(self):
        self.models: dict[str, DeviceModel] = {}
        self.errors: list[dict] = []


@lru_cache(maxsize=1)
def _load() -> _Library:
    lib = _Library()
    if not MODELS_DIR.is_dir():
        logger.warning(f"Biblioteka modela: direktorijum ne postoji ({MODELS_DIR})")
        return lib
    for path in sorted(MODELS_DIR.glob("*/*.json")):
        rel = f"{path.parent.name}/{path.stem}"
        try:
            m = DeviceModel.model_validate(json.loads(path.read_text(encoding="utf-8")))
            if m.id != rel:
                raise ValueError(f"id '{m.id}' se ne slaze sa putanjom '{rel}'")
            lib.models[m.id] = m
        except Exception as e:
            lib.errors.append({"file": rel, "error": str(e)[:1000]})
            logger.error(f"Biblioteka modela: {rel}.json preskocen -- {e}")
    logger.info(f"Biblioteka modela: {len(lib.models)} modela, {len(lib.errors)} gresaka")
    return lib


def reload_library():
    _load.cache_clear()
    return _load()


def all_models() -> list[DeviceModel]:
    return list(_load().models.values())


def get_model(model_id: str) -> DeviceModel | None:
    return _load().models.get(model_id)


def load_errors() -> list[dict]:
    return list(_load().errors)


def match_model(sys_descr: str | None, sys_object_id: str | None = None) -> DeviceModel | None:
    """Najbolje poklapanje: sysObjectID (najduzi prefiks) ima prednost nad
    sys_descr (najduzi podstring) -- duzi token = specificniji model."""
    best, best_score = None, (-1, -1)
    descr = (sys_descr or "").lower()
    oid = sys_object_id or ""
    for m in _load().models.values():
        for p in m.match.sys_object_id:
            if oid and (oid == p or oid.startswith(p + ".")):
                score = (1, len(p))
                if score > best_score:
                    best, best_score = m, score
        for t in m.match.sys_descr:
            if t and t.lower() in descr:
                score = (0, len(t))
                if score > best_score:
                    best, best_score = m, score
    return best
