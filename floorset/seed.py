"""
Seed data for the trial: one venue with two floors and two upcoming nights.

Everything a club is lives in this one object. Onboarding another venue means
adding another object like it, never a code change.
"""

from __future__ import annotations

import datetime as dt
from typing import Any


def upcoming(weekday: int, today: dt.date | None = None) -> dt.date:
    """
    The next date (today included) that falls on ``weekday`` (Mon=0 .. Sun=6).

    >>> upcoming(4, dt.date(2026, 10, 9)).isoformat()   # a Friday
    '2026-10-09'
    >>> upcoming(5, dt.date(2026, 10, 9)).isoformat()
    '2026-10-10'
    """
    today = today or dt.date.today()
    return today + dt.timedelta(days=(weekday - today.weekday()) % 7)


def night_label(day: dt.date) -> str:
    """
    >>> night_label(dt.date(2026, 10, 9))
    'Fri 9 Oct'
    """
    return f"{day:%a} {day.day} {day:%b}"


def quarter_lounge(today: dt.date | None = None) -> dict[str, Any]:
    fri = upcoming(4, today)
    sat = fri + dt.timedelta(days=1)
    return {
        "id": "quarter",
        "name": "Quarter Lounge",
        "mark": "QL",
        "markShape": "circle",
        "meta": "Jubilee Hills · 350 capacity",
        "brand": {
            "primary": "#E0B341",
            "accent": "#7FD8C8",
            "surface": "midnight",
            "font": "editorial",
        },
        "entry": {
            "price": 1500,
            "label": "General Entry",
            "note": "Dance floor and standing bar",
        },
        "redeemable": True,
        "holdUntil": "23:30",
        "tax": {"rate": 18, "inclusive": True},
        "policy": {"freeCancelHours": 24, "lateRefundPct": 50},
        "nights": [
            {
                "id": "n" + fri.strftime("%Y%m%d"),
                "date": fri.isoformat(),
                "label": night_label(fri),
                "headline": "Friday Social",
                "lineup": "DJ Ananya · DJ Rohit (b2b)",
                "doors": "21:00",
                "lastEntry": "00:30",
                "dress": "Smart casual. No shorts or flip-flops.",
                "age": 21,
                "note": "",
            },
            {
                "id": "n" + sat.strftime("%Y%m%d"),
                "date": sat.isoformat(),
                "label": night_label(sat),
                "headline": "Saturday Headliner",
                "lineup": "Guest DJ — Kayan (Mumbai)",
                "doors": "21:00",
                "lastEntry": "00:30",
                "dress": "Dress to impress.",
                "age": 21,
                "note": "Expect a queue after 11pm — book a table.",
            },
        ],
        "floors": [
            {
                "id": "m",
                "name": "Main Room",
                "short": "G",
                "w": 100,
                "h": 64,
                "door": {"x": 44, "w": 14, "wall": "s"},
                "zones": [
                    _zone("z0", "stage", "DJ", 38, 5, 24, 8),
                    _zone("z1", "dance", "Dance Floor", 31, 17, 38, 26),
                    _zone("z2", "bar", "Bar", 6, 16, 9, 30, "v"),
                    _zone("z3", "wc", "WC", 6, 50, 9, 8),
                ],
                "tables": [
                    _table("v1", "V1", "cabana", "vip", 10, 40000, 9, 5, 20, 9),
                    _table("v2", "V2", "cabana", "vip", 10, 40000, 71, 5, 20, 9),
                    _table("b1", "B1", "booth", "premium", 6, 18000, 79, 17, 16, 6.5),
                    _table("b2", "B2", "booth", "premium", 6, 18000, 79, 26, 16, 6.5),
                    _table("b3", "B3", "booth", "premium", 6, 18000, 79, 35, 16, 6.5),
                    _table("b4", "B4", "booth", "premium", 6, 18000, 79, 44, 16, 6.5),
                    _table("h1", "H1", "hitop", "standard", 4, 8000, 19, 18, 9, 9),
                    _table("h2", "H2", "hitop", "standard", 4, 8000, 19, 30, 9, 9),
                    _table("h3", "H3", "hitop", "standard", 4, 8000, 19, 42, 9, 9),
                    _table("l1", "L1", "sofa", "premium", 8, 22000, 26, 49, 16, 8),
                    _table("l2", "L2", "sofa", "premium", 8, 22000, 61, 49, 16, 8),
                ],
                "types": [],
            },
            {
                "id": "t",
                "name": "Terrace",
                "short": "T",
                "w": 100,
                "h": 64,
                "zones": [
                    _zone("z0", "bar", "Terrace Bar", 36, 5, 28, 8),
                    _zone("z1", "stairs", "Stairs", 6, 50, 12, 10),
                    _zone("z2", "smoking", "Smoking", 80, 48, 14, 12),
                ],
                "tables": [
                    _table("t1", "T1", "round", "standard", 6, 10000, 10, 10, 10, 10),
                    _table("t2", "T2", "round", "standard", 6, 10000, 10, 28, 10, 10),
                    _table("t3", "T3", "round", "standard", 6, 10000, 80, 10, 10, 10),
                    _table("t4", "T4", "round", "standard", 6, 10000, 80, 28, 10, 10),
                    _table("s1", "S1", "sofa", "premium", 8, 24000, 30, 38, 16, 8),
                    _table("s2", "S2", "sofa", "premium", 8, 24000, 54, 38, 16, 8),
                ],
                "types": [],
            },
        ],
    }


def _zone(
    zid: str, kind: str, label: str, x: float, y: float, w: float, h: float, d=None
) -> dict[str, Any]:
    zone: dict[str, Any] = {
        "id": zid,
        "kind": kind,
        "label": label,
        "x": x,
        "y": y,
        "w": w,
        "h": h,
    }
    if d:
        zone["dir"] = d
    return zone


def _table(
    tid: str,
    code: str,
    kind: str,
    tier: str,
    seats: int,
    cover: int,
    x: float,
    y: float,
    w: float,
    h: float,
) -> dict[str, Any]:
    return {
        "id": tid,
        "code": code,
        "kind": kind,
        "tier": tier,
        "seats": seats,
        "cover": cover,
        "x": x,
        "y": y,
        "w": w,
        "h": h,
    }


VENUES = [quarter_lounge]
