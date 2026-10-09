"""
Floorset storage, pricing and the booking ledger.

The rule this module exists to enforce: a table can be held or sold only once
per night. The database enforces it with a partial unique index over
(venue, night, table) for every active row, so two guests racing for the same
table cannot both win, whatever the application code does.

Money is whole rupees as ``int`` everywhere. Never floats, never paise.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import string
import time
from collections.abc import Callable, Iterable
from typing import Any

HOLD_SECONDS = 10 * 60
SESSION_SECONDS = 12 * 60 * 60
OTP_SECONDS = 5 * 60
OTP_ATTEMPTS = 5
ENTRY_MAX = 30

TABLE_KINDS = ("cabana", "booth", "sofa", "round", "hitop")
TIERS = ("standard", "premium", "vip")
ZONE_KINDS = (
    "dance",
    "stage",
    "bar",
    "lounge",
    "backstage",
    "smoking",
    "stairs",
    "wc",
    "void",
)
SURFACES = ("midnight", "charcoal", "plum", "ivory")
FONTS = ("editorial", "modern", "classic")
MARK_SHAPES = ("circle", "soft", "none")
OCCASIONS = (
    "Birthday",
    "Anniversary",
    "Night out",
    "Corporate",
    "Bachelor / ette",
    "Just because",
)
MARGIN = 2.5

SCHEMA = """
CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    layout TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS owners (
    username TEXT PRIMARY KEY,
    venue TEXT NOT NULL REFERENCES venues(id),
    salt TEXT NOT NULL,
    pw_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES owners(username),
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    ref TEXT UNIQUE,
    venue TEXT NOT NULL,
    night TEXT NOT NULL,
    status TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'online',
    created_at REAL NOT NULL,
    expires_at REAL,
    confirmed_at REAL,
    arrived_at REAL,
    cancelled_at REAL,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    arrival TEXT NOT NULL DEFAULT '',
    occasion TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    entry_qty INTEGER NOT NULL DEFAULT 0,
    seated INTEGER NOT NULL DEFAULT 0,
    lines TEXT NOT NULL DEFAULT '[]',
    subtotal INTEGER NOT NULL DEFAULT 0,
    tax INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    refund INTEGER NOT NULL DEFAULT 0,
    payment_id TEXT NOT NULL DEFAULT '',
    consent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bookings_night ON bookings(venue, night);
CREATE TABLE IF NOT EXISTS booking_tables (
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    venue TEXT NOT NULL,
    night TEXT NOT NULL,
    table_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS one_party_per_table
    ON booking_tables(venue, night, table_id) WHERE active = 1;
CREATE TABLE IF NOT EXISTS otps (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    verified_until REAL NOT NULL DEFAULT 0
);
"""

ACTIVE = ("held", "confirmed", "arrived")


class FloorsetError(Exception):
    """An error whose message is safe and useful to show to the person."""

    status = 400


class NotFound(FloorsetError):
    status = 404


class Conflict(FloorsetError):
    status = 409

    def __init__(self, message: str, tables: Iterable[str] = ()) -> None:
        super().__init__(message)
        self.tables = list(tables)


class Unauthorised(FloorsetError):
    status = 401


# ---------------------------------------------------------------- formatting


def inr(amount: int) -> str:
    """
    Indian digit grouping, written by hand on purpose (no locale dependency).

    >>> inr(150000)
    '₹1,50,000'
    >>> inr(1500)
    '₹1,500'
    >>> inr(999)
    '₹999'
    >>> inr(12345678)
    '₹1,23,45,678'
    >>> inr(-2500)
    '-₹2,500'
    """
    sign = "-" if amount < 0 else ""
    digits = str(abs(int(amount)))
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups: list[str] = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        digits = ",".join(groups) + "," + tail
    return f"{sign}₹{digits}"


def normalise_phone(raw: str) -> str:
    """
    Indian mobile numbers only, stored as +91XXXXXXXXXX.

    >>> normalise_phone("98480 22338")
    '+919848022338'
    >>> normalise_phone("+91-98480-22338")
    '+919848022338'
    >>> normalise_phone("12345")
    Traceback (most recent call last):
    ...
    floorset.store.FloorsetError: Enter a 10-digit Indian mobile number.
    """
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) != 10 or digits[0] not in "6789":
        raise FloorsetError("Enter a 10-digit Indian mobile number.")
    return "+91" + digits


# ---------------------------------------------------------------- pricing


def tax_split(amount: int, rate: float, inclusive: bool) -> tuple[int, int]:
    """
    Return (tax, line total) for one line, in whole rupees.

    >>> tax_split(1180, 18, True)
    (180, 1180)
    >>> tax_split(1000, 18, False)
    (180, 1180)
    >>> tax_split(1000, 0, True)
    (0, 1000)
    """
    if rate <= 0:
        return 0, amount
    if inclusive:
        tax = round(amount * rate / (100 + rate))
        return tax, amount
    tax = round(amount * rate / 100)
    return tax, amount + tax


def find_table(venue: dict[str, Any], table_id: str) -> tuple[dict, dict] | None:
    for floor in venue["floors"]:
        for table in floor["tables"]:
            if table["id"] == table_id:
                return floor, table
    return None


def _code(venue: dict[str, Any], table_id: str) -> str:
    found = find_table(venue, table_id)
    return found[1]["code"] if found else table_id


def find_night(venue: dict[str, Any], night_id: str) -> dict[str, Any]:
    for night in venue["nights"]:
        if night["id"] == night_id:
            return night
    raise NotFound("That night is not on sale.")


def price_basket(
    venue: dict[str, Any], table_ids: list[str], entry_qty: int, comp: bool = False
) -> dict[str, Any]:
    """
    Price a basket on the server. The browser's arithmetic is never trusted.

    total  = entry.price x entryQty + sum(table.cover)
    seated = sum(table.seats)
    """
    if not 0 <= entry_qty <= ENTRY_MAX:
        raise FloorsetError(f"General entry is 0 to {ENTRY_MAX} people.")
    if len(set(table_ids)) != len(table_ids):
        raise FloorsetError("A table is in the basket twice.")
    if not table_ids and entry_qty == 0:
        raise FloorsetError("The basket is empty.")
    rate = float(venue.get("tax", {}).get("rate", 0))
    inclusive = bool(venue.get("tax", {}).get("inclusive", True))
    lines = []
    seated = 0
    for table_id in table_ids:
        found = find_table(venue, table_id)
        if not found:
            raise Conflict("A table in your basket no longer exists.", [table_id])
        floor, table = found
        amount = 0 if comp else int(table["cover"])
        tax, line_total = tax_split(amount, rate, inclusive)
        seated += int(table["seats"])
        lines.append(
            {
                "kind": "table",
                "tableId": table["id"],
                "code": table["code"],
                "floor": floor["name"],
                "label": f"{table['code']} · {floor['name']}",
                "seats": int(table["seats"]),
                "qty": 1,
                "unit": amount,
                "amount": line_total,
                "tax": tax,
            }
        )
    if entry_qty:
        unit = 0 if comp else int(venue["entry"]["price"])
        tax, line_total = tax_split(unit * entry_qty, rate, inclusive)
        lines.insert(
            0,
            {
                "kind": "entry",
                "label": f"{venue['entry']['label']} × {entry_qty}",
                "qty": entry_qty,
                "unit": unit,
                "amount": line_total,
                "tax": tax,
            },
        )
    total = sum(line["amount"] for line in lines)
    tax = sum(line["tax"] for line in lines)
    return {
        "lines": lines,
        "subtotal": total - tax,
        "tax": tax,
        "taxRate": rate,
        "taxInclusive": inclusive,
        "total": total,
        "seated": seated,
        "entryQty": entry_qty,
    }


def night_start(night: dict[str, Any]) -> dt.datetime:
    """
    >>> night_start({"date": "2026-10-09", "doors": "21:00"}).isoformat()
    '2026-10-09T21:00:00'
    """
    hh, mm = (night.get("doors") or "21:00").split(":")
    day = dt.date.fromisoformat(night["date"])
    return dt.datetime.combine(day, dt.time(int(hh), int(mm)))


def refund_for(
    venue: dict[str, Any], night: dict[str, Any], total: int, now: dt.datetime
) -> tuple[int, str]:
    """
    How much a guest gets back for cancelling now, and the sentence explaining it.

    >>> v = {"policy": {"freeCancelHours": 24, "lateRefundPct": 50}}
    >>> n = {"date": "2026-10-09", "doors": "21:00"}
    >>> refund_for(v, n, 10000, dt.datetime(2026, 10, 8, 12, 0))[0]
    10000
    >>> refund_for(v, n, 10000, dt.datetime(2026, 10, 9, 12, 0))[0]
    5000
    >>> refund_for(v, n, 10000, dt.datetime(2026, 10, 9, 22, 0))[0]
    0
    """
    policy = venue.get("policy", {})
    free_hours = int(policy.get("freeCancelHours", 24))
    late_pct = int(policy.get("lateRefundPct", 0))
    start = night_start(night)
    if now >= start:
        return 0, "The night has started, so this booking can no longer be cancelled."
    if start - now >= dt.timedelta(hours=free_hours):
        return total, "Cancelled in time for a full refund."
    return (
        total * late_pct // 100,
        f"Cancelled within {free_hours} hours of doors: {late_pct}% is refunded.",
    )


def policy_text(venue: dict[str, Any]) -> str:
    """
    >>> policy_text({"policy": {"freeCancelHours": 24, "lateRefundPct": 50}})
    'Free cancellation until 24 hours before doors. After that, 50% is refunded.'
    >>> policy_text({"policy": {"freeCancelHours": 48, "lateRefundPct": 0}})
    'Free cancellation until 48 hours before doors. After that, no refund.'
    """
    policy = venue.get("policy", {})
    hours = int(policy.get("freeCancelHours", 24))
    pct = int(policy.get("lateRefundPct", 0))
    after = f"{pct}% is refunded" if pct else "no refund"
    return f"Free cancellation until {hours} hours before doors. After that, {after}."


# ---------------------------------------------------------------- validation


def _snap(value: Any, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise FloorsetError(f"{field} must be a number.") from None
    if number != number or number in (float("inf"), float("-inf")):
        raise FloorsetError(f"{field} must be a number.")
    snapped = round(number * 2) / 2
    return int(snapped) if snapped == int(snapped) else snapped


def _text(value: Any, field: str, max_len: int, required: bool = True) -> str:
    text = str(value if value is not None else "").strip()
    if required and not text:
        raise FloorsetError(f"{field} is required.")
    if len(text) > max_len:
        raise FloorsetError(f"{field} is longer than {max_len} characters.")
    return text


def _int(value: Any, field: str, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise FloorsetError(f"{field} must be a whole number.") from None
    if float(value) != number:
        raise FloorsetError(f"{field} must be a whole number.")
    if not low <= number <= high:
        raise FloorsetError(f"{field} must be between {low} and {high}.")
    return number


def _choice(value: Any, field: str, options: Iterable[str]) -> str:
    options = tuple(options)
    if value not in options:
        raise FloorsetError(f"{field} must be one of: {', '.join(options)}.")
    return value


def _colour(value: Any, field: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
        raise FloorsetError(f"{field} must be a colour like #E0B341.")
    return value.upper()


def _clock(value: Any, field: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(
        r"([01]\d|2[0-3]):[0-5]\d", value
    ):
        raise FloorsetError(f"{field} must be a time like 21:00.")
    return value


def _box(item: dict[str, Any], floor: dict[str, Any], where: str, min_size: float):
    box = {k: _snap(item.get(k), f"{where} {k}") for k in ("x", "y", "w", "h")}
    if box["w"] < min_size or box["h"] < min_size:
        raise FloorsetError(f"{where} is smaller than {min_size} units.")
    if (
        box["x"] < MARGIN
        or box["y"] < MARGIN
        or box["x"] + box["w"] > floor["w"] - MARGIN
        or box["y"] + box["h"] > floor["h"] - MARGIN
    ):
        raise FloorsetError(f"{where} is outside the room walls.")
    return box


def validate_venue(raw: Any, venue_id: str) -> dict[str, Any]:
    """
    Re-apply every editor rule on the server. A layout pasted by a person is
    rejected with a readable message, never stored half-valid.
    """
    if not isinstance(raw, dict):
        raise FloorsetError("The venue config must be a JSON object.")
    brand = raw.get("brand") or {}
    entry = raw.get("entry") or {}
    tax = raw.get("tax") or {}
    policy = raw.get("policy") or {}
    venue: dict[str, Any] = {
        "id": venue_id,
        "name": _text(raw.get("name"), "Venue name", 60),
        "mark": _text(raw.get("mark"), "Logo mark", 3).upper(),
        "markShape": _choice(raw.get("markShape", "circle"), "Mark shape", MARK_SHAPES),
        "meta": _text(raw.get("meta"), "Meta line", 120, required=False),
        "brand": {
            "primary": _colour(brand.get("primary"), "Primary colour"),
            "accent": _colour(brand.get("accent"), "Accent colour"),
            "surface": _choice(brand.get("surface"), "Surface", SURFACES),
            "font": _choice(brand.get("font"), "Typeface", FONTS),
        },
        "entry": {
            "price": _int(entry.get("price"), "Entry price", 0, 1_000_000),
            "label": _text(entry.get("label", "General Entry"), "Entry label", 40),
            "note": _text(entry.get("note"), "Entry note", 160, required=False),
        },
        "redeemable": bool(raw.get("redeemable")),
        "holdUntil": _clock(raw.get("holdUntil", "23:30"), "Table held until"),
        "tax": {
            "rate": _int(tax.get("rate", 18), "GST rate", 0, 40),
            "inclusive": bool(tax.get("inclusive", True)),
        },
        "policy": {
            "freeCancelHours": _int(
                policy.get("freeCancelHours", 24), "Free cancellation hours", 0, 720
            ),
            "lateRefundPct": _int(
                policy.get("lateRefundPct", 0), "Late refund percent", 0, 100
            ),
        },
        "nights": [],
        "floors": [],
    }

    venue["nights"] = _validate_nights(raw.get("nights"))
    floors = raw.get("floors")
    if not isinstance(floors, list) or not floors:
        raise FloorsetError("A venue needs at least one floor.")
    floor_ids: set[str] = set()
    table_ids: set[str] = set()
    for fi, floor in enumerate(floors):
        venue["floors"].append(_validate_floor(floor, fi, floor_ids, table_ids))
    return venue


def _validate_nights(nights: Any) -> list[dict[str, Any]]:
    if not isinstance(nights, list):
        raise FloorsetError("nights must be a list.")
    out: list[dict[str, Any]] = []
    night_ids: set[str] = set()
    for i, night in enumerate(nights):
        where = f"Night {i + 1}"
        if not isinstance(night, dict):
            raise FloorsetError(f"{where} must be an object.")
        nid = _text(night.get("id"), f"{where} id", 40)
        if nid in night_ids:
            raise FloorsetError(f"Two nights share the id {nid}.")
        night_ids.add(nid)
        try:
            date = dt.date.fromisoformat(str(night.get("date"))).isoformat()
        except ValueError:
            raise FloorsetError(f"{where} needs a date like 2026-10-09.") from None
        out.append(
            {
                "id": nid,
                "date": date,
                "label": _text(night.get("label"), f"{where} label", 40),
                "headline": _text(
                    night.get("headline"), f"{where} headline", 80, False
                ),
                "lineup": _text(night.get("lineup"), f"{where} line-up", 200, False),
                "doors": _clock(night.get("doors", "21:00"), f"{where} doors"),
                "lastEntry": _clock(
                    night.get("lastEntry", "00:30"), f"{where} last entry"
                ),
                "dress": _text(night.get("dress"), f"{where} dress code", 160, False),
                "age": _int(night.get("age", 21), f"{where} age", 0, 30),
                "note": _text(night.get("note"), f"{where} note", 200, False),
            }
        )
    return out


def _validate_floor(
    floor: Any, fi: int, floor_ids: set[str], table_ids: set[str]
) -> dict[str, Any]:
    if not isinstance(floor, dict):
        raise FloorsetError(f"Floor {fi + 1} must be an object.")
    fid = _text(floor.get("id"), f"Floor {fi + 1} id", 20)
    if fid in floor_ids:
        raise FloorsetError(f"Two floors share the id {fid}.")
    floor_ids.add(fid)
    name = _text(floor.get("name"), f"Floor {fi + 1} name", 40)
    out: dict[str, Any] = {
        "id": fid,
        "name": name,
        "short": _text(floor.get("short") or str(fi), f"{name} short code", 2),
        "w": _int(floor.get("w", 100), f"{name} width", 40, 400),
        "h": _int(floor.get("h", 64), f"{name} height", 30, 400),
        "zones": [],
        "tables": [],
        "types": [],
    }
    door = floor.get("door")
    if door:
        dx = _snap(door.get("x"), f"{name} door x")
        dw = _snap(door.get("w"), f"{name} door width")
        if dw < 4 or dx < MARGIN or dx + dw > out["w"] - MARGIN:
            raise FloorsetError(f"The {name} door does not fit in the south wall.")
        out["door"] = {"x": dx, "w": dw, "wall": "s"}
    zone_ids: set[str] = set()
    for zone in floor.get("zones") or []:
        zid = _text(zone.get("id"), f"{name} zone id", 20)
        where = f"{name} zone {zone.get('label') or zid}"
        if zid in zone_ids:
            raise FloorsetError(f"Two zones on {name} share the id {zid}.")
        zone_ids.add(zid)
        z = {
            "id": zid,
            "kind": _choice(zone.get("kind"), f"{where} kind", ZONE_KINDS),
            "label": _text(zone.get("label"), f"{where} label", 30, False),
            **_box(zone, out, where, 2),
        }
        if zone.get("dir") == "v":
            z["dir"] = "v"
        if zone.get("auto"):
            z["auto"] = True
        out["zones"].append(z)
    codes: set[str] = set()
    for table in floor.get("tables") or []:
        tid = _text(table.get("id"), f"{name} table id", 20)
        code = _text(table.get("code"), f"{name} table code", 4).upper()
        where = f"Table {code} on {name}"
        if tid in table_ids:
            raise FloorsetError(f"Two tables share the id {tid}.")
        if code in codes:
            raise FloorsetError(f"Two tables on {name} are both called {code}.")
        table_ids.add(tid)
        codes.add(code)
        t = {
            "id": tid,
            "code": code,
            "kind": _choice(table.get("kind"), f"{where} kind", TABLE_KINDS),
            "tier": _choice(table.get("tier"), f"{where} tier", TIERS),
            "seats": _int(table.get("seats"), f"{where} seats", 1, 30),
            "cover": _int(table.get("cover"), f"{where} cover", 0, 10_000_000),
            **_box(table, out, where, 3),
        }
        if table.get("blocked"):
            t["blocked"] = True
        for flag in ("auto", "gen"):
            if table.get(flag):
                t[flag] = True
        out["tables"].append(t)
    for ty in floor.get("types") or []:
        label = _text(ty.get("label"), f"{name} table type", 30)
        out["types"].append(
            {
                "id": _text(ty.get("id"), f"{label} id", 20),
                "label": label,
                "kind": _choice(ty.get("kind"), f"{label} shape", TABLE_KINDS),
                "tier": _choice(ty.get("tier"), f"{label} tier", TIERS),
                "seats": _int(ty.get("seats"), f"{label} seats", 1, 30),
                "cover": _int(ty.get("cover"), f"{label} cover", 0, 10_000_000),
                "count": _int(ty.get("count"), f"{label} how many", 0, 40),
                "size": max(6.0, min(24.0, float(_snap(ty.get("size"), label)))),
            }
        )
    return out


# ---------------------------------------------------------------- database


def _hash_password(password: str, salt: str) -> str:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
    return digest.hex()


class Store:
    """All persistence. One connection per Store; make one per request thread."""

    def __init__(self, path: str, clock: Callable[[], float] = time.time) -> None:
        self.db = sqlite3.connect(path, timeout=10, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        self.clock = clock

    def close(self) -> None:
        self.db.close()

    def init(self) -> None:
        self.db.executescript(SCHEMA)

    def now_local(self) -> dt.datetime:
        return dt.datetime.fromtimestamp(self.clock())

    # ---------------------------------------------------------- venues

    def put_venue(self, venue: dict[str, Any]) -> dict[str, Any]:
        clean = validate_venue(venue, venue["id"])
        self.db.execute(
            "INSERT INTO venues(id, layout, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET layout = excluded.layout, "
            "version = version + 1, updated_at = excluded.updated_at",
            (clean["id"], json.dumps(clean), self.clock()),
        )
        return clean

    def get_venue(self, venue_id: str) -> dict[str, Any]:
        row = self.db.execute(
            "SELECT layout FROM venues WHERE id = ?", (venue_id,)
        ).fetchone()
        if not row:
            raise NotFound("No venue at this address.")
        return json.loads(row["layout"])

    def venue_ids(self) -> list[str]:
        return [r["id"] for r in self.db.execute("SELECT id FROM venues ORDER BY id")]

    def replace_layout(self, venue_id: str, raw: Any) -> dict[str, Any]:
        """Owner save. Refuses to delete a table or night that has live bookings."""
        clean = validate_venue(raw, venue_id)
        self.sweep()
        live = self.db.execute(
            "SELECT DISTINCT bt.night, bt.table_id FROM booking_tables bt "
            "JOIN bookings b ON b.id = bt.booking_id "
            "WHERE bt.venue = ? AND bt.active = 1",
            (venue_id,),
        ).fetchall()
        tables = {t["id"] for f in clean["floors"] for t in f["tables"]}
        nights = {n["id"] for n in clean["nights"]}
        old = self.get_venue(venue_id)
        codes = {t["id"]: t["code"] for f in old["floors"] for t in f["tables"]}
        lost_tables = sorted(
            {
                codes.get(r["table_id"], r["table_id"])
                for r in live
                if r["table_id"] not in tables
            }
        )
        if lost_tables:
            raise Conflict(
                "These tables have live bookings and cannot be deleted: "
                + ", ".join(lost_tables)
                + ". Cancel those bookings first.",
                lost_tables,
            )
        live_nights = {
            r["night"]
            for r in self.db.execute(
                "SELECT DISTINCT night FROM bookings WHERE venue = ? AND status IN "
                "('held','confirmed','arrived')",
                (venue_id,),
            )
        }
        lost_nights = sorted(live_nights - nights)
        if lost_nights:
            raise Conflict(
                "A night you removed still has live bookings. "
                "Cancel those bookings first."
            )
        return self.put_venue(clean)

    # ---------------------------------------------------------- owners

    def set_owner(self, username: str, venue_id: str, password: str) -> None:
        salt = secrets.token_hex(16)
        self.db.execute(
            "INSERT INTO owners(username, venue, salt, pw_hash) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(username) DO UPDATE SET venue = excluded.venue, "
            "salt = excluded.salt, pw_hash = excluded.pw_hash",
            (username, venue_id, salt, _hash_password(password, salt)),
        )

    def has_owner(self, username: str) -> bool:
        return bool(
            self.db.execute(
                "SELECT 1 FROM owners WHERE username = ?", (username,)
            ).fetchone()
        )

    def login(self, username: str, password: str) -> str:
        row = self.db.execute(
            "SELECT * FROM owners WHERE username = ?", (username.strip().lower(),)
        ).fetchone()
        given = _hash_password(password, row["salt"] if row else "x")
        if not row or not hmac.compare_digest(given, row["pw_hash"]):
            raise Unauthorised("That username and password do not match.")
        token = secrets.token_urlsafe(32)
        self.db.execute(
            "INSERT INTO sessions(token, username, expires_at) VALUES (?, ?, ?)",
            (token, row["username"], self.clock() + SESSION_SECONDS),
        )
        return token

    def session(self, token: str | None) -> dict[str, str]:
        if not token:
            raise Unauthorised("Please sign in.")
        row = self.db.execute(
            "SELECT o.username, o.venue FROM sessions s "
            "JOIN owners o ON o.username = s.username "
            "WHERE s.token = ? AND s.expires_at > ?",
            (token, self.clock()),
        ).fetchone()
        if not row:
            raise Unauthorised("Your session has ended. Please sign in again.")
        return {"username": row["username"], "venue": row["venue"]}

    def logout(self, token: str | None) -> None:
        self.db.execute("DELETE FROM sessions WHERE token = ?", (token or "",))

    # ---------------------------------------------------------- otp

    def send_otp(self, phone: str) -> str:
        """Issue a 6-digit code. In production this goes out by SMS (DLT template)."""
        phone = normalise_phone(phone)
        code = f"{secrets.randbelow(1_000_000):06d}"
        self.db.execute(
            "INSERT INTO otps(phone, code, expires_at) VALUES (?, ?, ?) "
            "ON CONFLICT(phone) DO UPDATE SET code = excluded.code, "
            "expires_at = excluded.expires_at, attempts = 0",
            (phone, code, self.clock() + OTP_SECONDS),
        )
        return code

    def verify_otp(self, phone: str, code: str) -> str:
        phone = normalise_phone(phone)
        row = self.db.execute("SELECT * FROM otps WHERE phone = ?", (phone,)).fetchone()
        now = self.clock()
        if row and row["verified_until"] > now:
            return phone
        if not row or row["expires_at"] < now:
            raise FloorsetError("Ask for a new code — that one has expired.")
        if row["attempts"] >= OTP_ATTEMPTS:
            raise FloorsetError("Too many tries. Ask for a new code.")
        if not hmac.compare_digest(str(code or "").strip(), row["code"]):
            self.db.execute(
                "UPDATE otps SET attempts = attempts + 1 WHERE phone = ?", (phone,)
            )
            raise FloorsetError("That code is not right.")
        self.db.execute(
            "UPDATE otps SET verified_until = ? WHERE phone = ?",
            (now + 30 * 60, phone),
        )
        return phone

    # ---------------------------------------------------------- ledger

    def sweep(self) -> None:
        """Expire holds whose time has run out and free their tables."""
        now = self.clock()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            expired = [
                r["id"]
                for r in self.db.execute(
                    "SELECT id FROM bookings WHERE status = 'held' AND expires_at < ?",
                    (now,),
                )
            ]
            for booking_id in expired:
                self.db.execute(
                    "UPDATE bookings SET status = 'expired' WHERE id = ?", (booking_id,)
                )
                self.db.execute(
                    "UPDATE booking_tables SET active = 0 WHERE booking_id = ?",
                    (booking_id,),
                )
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def unavailable(self, venue_id: str, night_id: str) -> list[str]:
        """Table ids that cannot be booked for this night (sold, held or blocked)."""
        self.sweep()
        venue = self.get_venue(venue_id)
        taken = {
            r["table_id"]
            for r in self.db.execute(
                "SELECT table_id FROM booking_tables "
                "WHERE venue = ? AND night = ? AND active = 1",
                (venue_id, night_id),
            )
        }
        blocked = {
            t["id"] for f in venue["floors"] for t in f["tables"] if t.get("blocked")
        }
        return sorted(taken | blocked)

    def _new_ref(self, venue: dict[str, Any]) -> str:
        letters = re.sub(r"[^A-Z]", "", venue["name"].upper())[:2].ljust(2, "X")
        alphabet = string.ascii_uppercase + string.digits
        for _ in range(20):
            ref = letters + "-" + "".join(secrets.choice(alphabet) for _ in range(5))
            if not self.db.execute(
                "SELECT 1 FROM bookings WHERE ref = ?", (ref,)
            ).fetchone():
                return ref
        raise FloorsetError("Could not issue a reference. Please try again.")

    def _claim(
        self,
        venue: dict[str, Any],
        night_id: str,
        table_ids: list[str],
        fields: dict[str, Any],
    ) -> str:
        """Insert a booking and claim its tables atomically, or raise Conflict."""
        blocked = {
            t["id"] for f in venue["floors"] for t in f["tables"] if t.get("blocked")
        }
        clash = [tid for tid in table_ids if tid in blocked]
        booking_id = secrets.token_urlsafe(16)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            if not clash:
                taken = {
                    r["table_id"]
                    for r in self.db.execute(
                        "SELECT table_id FROM booking_tables WHERE venue = ? "
                        "AND night = ? AND active = 1",
                        (venue["id"], night_id),
                    )
                }
                clash = [tid for tid in table_ids if tid in taken]
            if clash:
                raise sqlite3.IntegrityError("taken")
            cols = ["id", "venue", "night", "created_at", *fields]
            vals = [booking_id, venue["id"], night_id, self.clock(), *fields.values()]
            self.db.execute(
                f"INSERT INTO bookings({', '.join(cols)}) "
                f"VALUES ({', '.join('?' * len(cols))})",
                vals,
            )
            for tid in table_ids:
                self.db.execute(
                    "INSERT INTO booking_tables(booking_id, venue, night, table_id) "
                    "VALUES (?, ?, ?, ?)",
                    (booking_id, venue["id"], night_id, tid),
                )
            self.db.execute("COMMIT")
        except sqlite3.IntegrityError:
            self.db.execute("ROLLBACK")
            codes = [_code(venue, t) for t in clash]
            names = ", ".join(codes) or "A table"
            raise Conflict(
                f"{names} was just taken by someone else. Pick another table.", clash
            ) from None
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        return booking_id

    def hold(
        self,
        venue_id: str,
        night_id: str,
        table_ids: list[str],
        entry_qty: int,
        occasion: str = "",
        note: str = "",
    ) -> dict[str, Any]:
        """Hold the basket for HOLD_SECONDS while the guest gives details and pays."""
        self.sweep()
        venue = self.get_venue(venue_id)
        night = find_night(venue, night_id)
        if self.now_local() >= night_start(night) + dt.timedelta(hours=6):
            raise FloorsetError("Bookings for this night have closed.")
        if occasion and occasion not in OCCASIONS:
            raise FloorsetError("Pick an occasion from the list.")
        priced = price_basket(venue, table_ids, int(entry_qty))
        expires = self.clock() + HOLD_SECONDS
        booking_id = self._claim(
            venue,
            night_id,
            table_ids,
            {
                "status": "held",
                "expires_at": expires,
                "occasion": occasion,
                "note": _text(note, "Note", 300, required=False),
                "entry_qty": priced["entryQty"],
                "seated": priced["seated"],
                "lines": json.dumps(priced["lines"]),
                "subtotal": priced["subtotal"],
                "tax": priced["tax"],
                "total": priced["total"],
            },
        )
        return {
            "holdId": booking_id,
            "expiresAt": expires,
            "expiresIn": HOLD_SECONDS,
            "price": priced,
            "policy": policy_text(venue),
        }

    def release(self, hold_id: str) -> None:
        self.db.execute("BEGIN IMMEDIATE")
        self.db.execute(
            "UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'held'",
            (hold_id,),
        )
        self.db.execute(
            "UPDATE booking_tables SET active = 0 WHERE booking_id = ? AND "
            "booking_id IN (SELECT id FROM bookings WHERE status = 'expired')",
            (hold_id,),
        )
        self.db.execute("COMMIT")

    def confirm(
        self,
        hold_id: str,
        name: str,
        phone: str,
        code: str,
        arrival: str,
        consent: bool,
        payment_id: str,
    ) -> dict[str, Any]:
        """
        Turn a hold into a booking. In production this runs from the payment
        gateway's server-side webhook, never from the browser's redirect.
        """
        self.sweep()
        row = self.db.execute(
            "SELECT * FROM bookings WHERE id = ?", (hold_id,)
        ).fetchone()
        if not row:
            raise NotFound("That hold does not exist.")
        if row["status"] == "confirmed":
            return self.booking_view(row["ref"])
        if row["status"] != "held":
            raise Conflict(
                "Your hold ran out and the tables were released. Start again."
            )
        if not consent:
            raise FloorsetError(
                "Please agree to the club keeping your details for this booking."
            )
        name = _text(name, "Name", 60)
        verified = self.verify_otp(phone, code)
        venue = self.get_venue(row["venue"])
        night = find_night(venue, row["night"])
        if arrival:
            arrival = _clock(arrival, "Arrival time")
        ref = self._new_ref(venue)
        self.db.execute("BEGIN IMMEDIATE")
        cur = self.db.execute(
            "UPDATE bookings SET status = 'confirmed', ref = ?, name = ?, phone = ?, "
            "arrival = ?, consent = 1, payment_id = ?, confirmed_at = ?, "
            "expires_at = NULL WHERE id = ? AND status = 'held'",
            (
                ref,
                name,
                verified,
                arrival or night["doors"],
                payment_id,
                self.clock(),
                hold_id,
            ),
        )
        self.db.execute("COMMIT")
        if cur.rowcount != 1:
            raise Conflict(
                "Your hold ran out and the tables were released. Start again."
            )
        return self.booking_view(ref)

    def manual_booking(
        self,
        venue_id: str,
        night_id: str,
        table_ids: list[str],
        entry_qty: int,
        name: str,
        phone: str,
        occasion: str,
        note: str,
        comp: bool,
    ) -> dict[str, Any]:
        """A walk-in or comp entered by the venue. Same ledger, same uniqueness."""
        self.sweep()
        venue = self.get_venue(venue_id)
        night = find_night(venue, night_id)
        priced = price_basket(venue, table_ids, int(entry_qty), comp=comp)
        ref = self._new_ref(venue)
        self._claim(
            venue,
            night_id,
            table_ids,
            {
                "ref": ref,
                "status": "confirmed",
                "source": "comp" if comp else "walk-in",
                "confirmed_at": self.clock(),
                "name": _text(name, "Name", 60),
                "phone": normalise_phone(phone) if phone else "",
                "arrival": night["doors"],
                "occasion": occasion if occasion in OCCASIONS else "",
                "note": _text(note, "Note", 300, required=False),
                "entry_qty": priced["entryQty"],
                "seated": priced["seated"],
                "lines": json.dumps(priced["lines"]),
                "subtotal": priced["subtotal"],
                "tax": priced["tax"],
                "total": priced["total"],
                "payment_id": "at-venue" if not comp else "",
            },
        )
        return self.booking_view(ref)

    def _row(self, ref: str) -> sqlite3.Row:
        row = self.db.execute(
            "SELECT * FROM bookings WHERE ref = ?", (ref.strip().upper(),)
        ).fetchone()
        if not row:
            raise NotFound("No booking with that reference.")
        return row

    def booking_view(self, ref: str, private: bool = True) -> dict[str, Any]:
        row = self._row(ref)
        venue = self.get_venue(row["venue"])
        night = next((n for n in venue["nights"] if n["id"] == row["night"]), None)
        tables = [
            r["table_id"]
            for r in self.db.execute(
                "SELECT table_id FROM booking_tables WHERE booking_id = ?", (row["id"],)
            )
        ]
        view = {
            "ref": row["ref"],
            "status": row["status"],
            "source": row["source"],
            "night": row["night"],
            "nightLabel": night["label"] if night else row["night"],
            "date": night["date"] if night else "",
            "doors": night["doors"] if night else "",
            "arrival": row["arrival"],
            "occasion": row["occasion"],
            "note": row["note"],
            "name": row["name"],
            "entryQty": row["entry_qty"],
            "seated": row["seated"],
            "tables": tables,
            "lines": json.loads(row["lines"]),
            "subtotal": row["subtotal"],
            "tax": row["tax"],
            "total": row["total"],
            "refund": row["refund"],
            "createdAt": row["created_at"],
            "arrivedAt": row["arrived_at"],
            "venue": {"id": venue["id"], "name": venue["name"]},
            "redeemable": venue["redeemable"],
        }
        if private:
            view["phone"] = row["phone"]
            view["paymentId"] = row["payment_id"]
        return view

    def guest_lookup(self, venue_id: str, ref: str, phone: str) -> dict[str, Any]:
        row = self._row(ref)
        if row["venue"] != venue_id or row["phone"] != normalise_phone(phone):
            raise NotFound("No booking matches that reference and number.")
        view = self.booking_view(ref, private=False)
        venue = self.get_venue(venue_id)
        night = next((n for n in venue["nights"] if n["id"] == row["night"]), None)
        if night and row["status"] == "confirmed":
            view["refundIfCancelled"], view["refundText"] = refund_for(
                venue, night, row["total"], self.now_local()
            )
        return view

    def cancel(
        self,
        venue_id: str,
        ref: str,
        phone: str | None = None,
        refund: int | None = None,
    ) -> dict[str, Any]:
        """
        Guest cancel (phone given): refund follows the venue policy.
        Owner cancel (no phone): refund is whatever the owner chose, default full.
        """
        row = self._row(ref)
        if row["venue"] != venue_id:
            raise NotFound("No booking with that reference.")
        if phone is not None and row["phone"] != normalise_phone(phone):
            raise NotFound("No booking matches that reference and number.")
        if row["status"] != "confirmed":
            raise FloorsetError(
                f"This booking is {row['status']} and cannot be cancelled."
            )
        venue = self.get_venue(venue_id)
        if phone is not None:
            night = find_night(venue, row["night"])
            amount, text = refund_for(venue, night, row["total"], self.now_local())
            if text.startswith("The night has started"):
                raise FloorsetError(text)
        else:
            amount = (
                row["total"]
                if refund is None
                else max(0, min(int(refund), row["total"]))
            )
        self.db.execute("BEGIN IMMEDIATE")
        self.db.execute(
            "UPDATE bookings SET status = 'cancelled', refund = ?, cancelled_at = ? "
            "WHERE id = ?",
            (amount, self.clock(), row["id"]),
        )
        self.db.execute(
            "UPDATE booking_tables SET active = 0 WHERE booking_id = ?", (row["id"],)
        )
        self.db.execute("COMMIT")
        return self.booking_view(ref)

    def mark(self, venue_id: str, ref: str, status: str) -> dict[str, Any]:
        """Door actions: 'arrived', 'no-show', or 'confirmed' to undo."""
        row = self._row(ref)
        if row["venue"] != venue_id:
            raise NotFound("No booking with that reference.")
        allowed = {
            "arrived": ("confirmed", "no-show"),
            "no-show": ("confirmed",),
            "confirmed": ("arrived", "no-show"),
        }
        if status not in allowed:
            raise FloorsetError("Unknown status.")
        if row["status"] not in allowed[status]:
            raise FloorsetError(f"This booking is {row['status']}.")
        self.db.execute(
            "UPDATE bookings SET status = ?, arrived_at = ? WHERE id = ?",
            (status, self.clock() if status == "arrived" else None, row["id"]),
        )
        return self.booking_view(ref)

    def night_report(self, venue_id: str, night_id: str) -> dict[str, Any]:
        self.sweep()
        venue = self.get_venue(venue_id)
        refs = [
            r["ref"]
            for r in self.db.execute(
                "SELECT ref FROM bookings WHERE venue = ? AND night = ? "
                "AND ref IS NOT NULL ORDER BY confirmed_at",
                (venue_id, night_id),
            )
        ]
        bookings = [self.booking_view(ref) for ref in refs]
        live = [b for b in bookings if b["status"] in ("confirmed", "arrived")]
        all_tables = [t for f in venue["floors"] for t in f["tables"]]
        held = self.db.execute(
            "SELECT COUNT(*) AS n FROM bookings WHERE venue = ? AND night = ? "
            "AND status = 'held'",
            (venue_id, night_id),
        ).fetchone()["n"]
        sold = sum(b["total"] for b in bookings if b["status"] != "held")
        refunds = sum(b["refund"] for b in bookings)
        return {
            "bookings": bookings,
            "summary": {
                "bookings": len(live),
                "guests": sum(b["seated"] + b["entryQty"] for b in live),
                "arrived": sum(
                    b["seated"] + b["entryQty"]
                    for b in live
                    if b["status"] == "arrived"
                ),
                "tablesSold": len({t for b in live for t in b["tables"]}),
                "tablesTotal": len(all_tables),
                "revenue": sold - refunds,
                "tax": sum(b["tax"] for b in live),
                "refunds": refunds,
                "noShows": sum(1 for b in bookings if b["status"] == "no-show"),
                "occasions": sum(1 for b in live if b["occasion"]),
                "holds": held,
            },
            "unavailable": self.unavailable(venue_id, night_id),
        }


def open_store(path: str, seed: bool = True) -> Store:
    from floorset import seed as seed_data

    store = Store(path)
    store.init()
    if seed and not store.venue_ids():
        for make in seed_data.VENUES:
            store.put_venue(make())
    return store
