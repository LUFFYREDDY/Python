#!/usr/bin/env python3
"""
Floorset trial server. Standard library only, so it runs anywhere Python 3.11+ is.

    python3 -m floorset.server            # http://localhost:8000

Two separate interfaces, served from one process:

    /v/<venue>      the club's public booking page (the club's brand only)
    /owner          the club owner's dashboard (sign-in required)

Environment:
    FLOORSET_DB              SQLite file (default floorset/floorset.db)
    FLOORSET_PORT            port (default 8000)
    FLOORSET_OWNER_PASSWORD  password for the seeded owner account
    FLOORSET_TRIAL           "1" (default) shows the SMS code on screen and takes
                             no payment. Set "0" once SMS and payments are wired.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import secrets
import threading
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from floorset.store import (
    Conflict,
    FloorsetError,
    NotFound,
    Store,
    find_night,
    open_store,
    policy_text,
)

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
COOKIE = "floorset_owner"
MAX_BODY = 4 * 1024 * 1024
TRIAL = os.environ.get("FLOORSET_TRIAL", "1") != "0"

_local = threading.local()


def store() -> Store:
    """One SQLite connection per server thread."""
    if not hasattr(_local, "store"):
        _local.store = open_store(Handler.db_path, seed=False)
    return _local.store


def public_venue(venue: dict[str, Any]) -> dict[str, Any]:
    """What the guest page may see: no table templates, no internal flags."""
    out = json.loads(json.dumps(venue))
    for floor in out["floors"]:
        floor.pop("types", None)
        for table in floor["tables"]:
            for key in ("auto", "gen", "blocked"):
                table.pop(key, None)
        for zone in floor["zones"]:
            zone.pop("auto", None)
    out["policyText"] = policy_text(venue)
    out["trial"] = TRIAL
    return out


class Handler(BaseHTTPRequestHandler):
    db_path = str(HERE / "floorset.db")
    server_version = "Floorset"

    # ---------------------------------------------------------- plumbing

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter logs
        if os.environ.get("FLOORSET_QUIET") != "1":
            super().log_message(fmt, *args)

    def send_json(self, data: Any, status: int = 200, headers: dict | None = None):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".js":
            ctype = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.end_headers()
        self.wfile.write(body)

    def body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise FloorsetError("That request is too large.")
        if length and "json" not in (self.headers.get("Content-Type") or ""):
            raise FloorsetError("Send JSON.")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError as err:
            raise FloorsetError(f"That is not valid JSON: {err.msg}.") from None
        if not isinstance(data, dict):
            raise FloorsetError("Send a JSON object.")
        return data

    def token(self) -> str | None:
        cookie = SimpleCookie(self.headers.get("Cookie") or "")
        return cookie[COOKIE].value if COOKIE in cookie else None

    def owner(self) -> dict[str, str]:
        return store().session(self.token())

    def do_GET(self) -> None:  # noqa: N802
        self.route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self.route("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self.route("PUT")

    def route(self, method: str) -> None:
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if path.startswith("/api/"):
                self.api(method, path[4:], query)
            elif method == "GET":
                self.page(path)
            else:
                self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
        except Conflict as err:
            self.send_json({"error": str(err), "tables": err.tables}, err.status)
        except FloorsetError as err:
            self.send_json({"error": str(err)}, err.status)
        except Exception as err:  # never leak a traceback to a guest
            self.log_error("unhandled: %r", err)
            self.send_json({"error": "Something went wrong. Please try again."}, 500)

    # ---------------------------------------------------------- pages

    def page(self, path: str) -> None:
        if path == "/":
            ids = store().venue_ids()
            self.send_response(302)
            self.send_header("Location", f"/v/{ids[0]}" if ids else "/owner")
            self.end_headers()
        elif re.fullmatch(r"/v/[a-z0-9-]+", path):
            self.send_file(STATIC / "guest.html")
        elif path == "/owner":
            self.send_file(STATIC / "owner.html")
        elif path.startswith("/static/") and ".." not in path:
            self.send_file(STATIC / path[len("/static/") :])
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    # ---------------------------------------------------------- api

    def api(self, method: str, path: str, query: dict[str, str]) -> None:
        parts = path.strip("/").split("/")
        if parts[0] == "v" and len(parts) >= 2:
            name = "/".join(parts[2:])
            handler = GUEST_ROUTES.get((method, name))
            if handler:
                return self.send_json(handler(self, store(), parts[1], query))
        if parts[0] == "owner":
            rest = parts[1:]
            name = "/".join(rest)
            if (method, name) in OPEN_OWNER_ROUTES:
                return OPEN_OWNER_ROUTES[(method, name)](self, store())
            venue_id = self.owner()["venue"]
            if len(rest) == 3 and rest[0] == "booking":
                return self.send_json(booking_action(self, venue_id, rest[1], rest[2]))
            owner_handler = OWNER_ROUTES.get((method, name))
            if owner_handler:
                return self.send_json(owner_handler(self, store(), venue_id, query))
        self.send_json({"error": "Not found."}, 404)


def _num(value: Any, field: str) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        raise FloorsetError(f"{field} must be a whole number.") from None


# ---------------------------------------------------------------- guest routes


def g_venue(h: Handler, s: Store, slug: str, q: dict) -> Any:
    return public_venue(s.get_venue(slug))


def g_availability(h: Handler, s: Store, slug: str, q: dict) -> Any:
    night = find_night(s.get_venue(slug), q.get("night", ""))
    return {"unavailable": s.unavailable(slug, night["id"])}


def g_hold(h: Handler, s: Store, slug: str, q: dict) -> Any:
    data = h.body()
    return s.hold(
        slug,
        str(data.get("night", "")),
        [str(t) for t in data.get("tables") or []],
        _num(data.get("entryQty"), "General entry"),
        str(data.get("occasion") or ""),
        str(data.get("note") or ""),
    )


def g_release(h: Handler, s: Store, slug: str, q: dict) -> Any:
    s.release(str(h.body().get("holdId", "")))
    return {"ok": True}


def g_otp(h: Handler, s: Store, slug: str, q: dict) -> Any:
    code = s.send_otp(str(h.body().get("phone", "")))
    # Trial only: no SMS gateway yet, so the code is shown on screen.
    return {"sent": True, "trialCode": code} if TRIAL else {"sent": True}


def g_confirm(h: Handler, s: Store, slug: str, q: dict) -> Any:
    if not TRIAL:
        raise FloorsetError("Payments are not connected yet.")
    data = h.body()
    return s.confirm(
        str(data.get("holdId", "")),
        str(data.get("name", "")),
        str(data.get("phone", "")),
        str(data.get("code", "")),
        str(data.get("arrival", "")),
        bool(data.get("consent")),
        "trial-" + secrets.token_hex(6),
    )


def g_lookup(h: Handler, s: Store, slug: str, q: dict) -> Any:
    data = h.body()
    return s.guest_lookup(slug, str(data.get("ref", "")), str(data.get("phone", "")))


def g_cancel(h: Handler, s: Store, slug: str, q: dict) -> Any:
    data = h.body()
    ref, phone = str(data.get("ref", "")), str(data.get("phone", ""))
    s.cancel(slug, ref, phone)
    return s.guest_lookup(slug, ref, phone)


GUEST_ROUTES = {
    ("GET", ""): g_venue,
    ("GET", "availability"): g_availability,
    ("POST", "hold"): g_hold,
    ("POST", "release"): g_release,
    ("POST", "otp"): g_otp,
    ("POST", "confirm"): g_confirm,
    ("POST", "lookup"): g_lookup,
    ("POST", "cancel"): g_cancel,
}


# ---------------------------------------------------------------- owner routes


def o_login(h: Handler, s: Store) -> None:
    data = h.body()
    token = s.login(str(data.get("username", "")), str(data.get("password", "")))
    cookie = (
        f"{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/api/owner; Max-Age=43200"
    )
    h.send_json({"ok": True, **s.session(token)}, headers={"Set-Cookie": cookie})


def o_logout(h: Handler, s: Store) -> None:
    s.logout(h.token())
    h.send_json(
        {"ok": True},
        headers={"Set-Cookie": f"{COOKIE}=; Path=/api/owner; Max-Age=0"},
    )


OPEN_OWNER_ROUTES = {("POST", "login"): o_login, ("POST", "logout"): o_logout}


def o_me(h: Handler, s: Store, venue_id: str, q: dict) -> Any:
    return {**s.session(h.token()), "trial": TRIAL}


def o_venue(h: Handler, s: Store, venue_id: str, q: dict) -> Any:
    return s.get_venue(venue_id)


def o_save(h: Handler, s: Store, venue_id: str, q: dict) -> Any:
    return s.replace_layout(venue_id, h.body())


def o_night(h: Handler, s: Store, venue_id: str, q: dict) -> Any:
    return s.night_report(venue_id, q.get("night", ""))


def o_manual(h: Handler, s: Store, venue_id: str, q: dict) -> Any:
    data = h.body()
    return s.manual_booking(
        venue_id,
        str(data.get("night", "")),
        [str(t) for t in data.get("tables") or []],
        _num(data.get("entryQty"), "General entry"),
        str(data.get("name", "")),
        str(data.get("phone", "")),
        str(data.get("occasion", "")),
        str(data.get("note", "")),
        bool(data.get("comp")),
    )


OWNER_ROUTES = {
    ("GET", "me"): o_me,
    ("GET", "venue"): o_venue,
    ("PUT", "venue"): o_save,
    ("GET", "night"): o_night,
    ("POST", "bookings"): o_manual,
}


def booking_action(h: Handler, venue_id: str, ref: str, action: str) -> Any:
    if h.command != "POST":
        raise NotFound("Not found.")
    if action == "cancel":
        refund = h.body().get("refund")
        amount = None if refund is None else _num(refund, "Refund")
        return store().cancel(venue_id, ref, None, amount)
    if action in ("arrived", "no-show", "confirmed"):
        return store().mark(venue_id, ref, action)
    raise NotFound("Not found.")


def main() -> None:
    db_path = os.environ.get("FLOORSET_DB", str(HERE / "floorset.db"))
    port = int(os.environ.get("FLOORSET_PORT", "8000"))
    Handler.db_path = db_path
    s = open_store(db_path)
    password = os.environ.get("FLOORSET_OWNER_PASSWORD")
    for venue_id in s.venue_ids():
        if password or not s.has_owner(venue_id):
            chosen = password or secrets.token_urlsafe(9)
            s.set_owner(venue_id, venue_id, chosen)
            print(f"Owner login: username {venue_id!r}, password {chosen!r}")
    s.close()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Guest page:      http://localhost:{port}/v/<venue>")
    print(f"Owner dashboard: http://localhost:{port}/owner")
    if TRIAL:
        print("Trial mode: SMS codes are shown on screen and no payment is taken.")
    server.serve_forever()


if __name__ == "__main__":
    main()
