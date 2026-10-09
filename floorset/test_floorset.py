"""
Tests for the booking ledger: the part where real money and real tables are at
stake. Run with:  python3 -m pytest floorset
"""

from __future__ import annotations

import copy
import datetime as dt
import threading

import pytest

from floorset import seed
from floorset.store import (
    HOLD_SECONDS,
    Conflict,
    FloorsetError,
    NotFound,
    Store,
    Unauthorised,
    price_basket,
    validate_venue,
)

TODAY = dt.date(2026, 10, 5)  # a Monday; the seed's nights are Fri 9 and Sat 10
NOON = dt.datetime.combine(TODAY, dt.time(12)).timestamp()


class Clock:
    def __init__(self, at: float = NOON) -> None:
        self.now = at

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def db_path(tmp_path) -> str:
    return str(tmp_path / "test.db")


@pytest.fixture
def store(db_path: str, clock: Clock) -> Store:
    s = Store(db_path, clock=clock)
    s.init()
    s.put_venue(seed.quarter_lounge(TODAY))
    s.set_owner("quarter", "quarter", "correct horse")
    return s


def friday(store: Store) -> str:
    return store.get_venue("quarter")["nights"][0]["id"]


def book(store: Store, tables: list[str], entry: int = 0, phone: str = "9848022338"):
    hold = store.hold("quarter", friday(store), tables, entry, "Birthday", "")
    code = store.send_otp(phone)
    return store.confirm(hold["holdId"], "Asha", phone, code, "22:00", True, "trial-x")


def test_seed_is_valid() -> None:
    venue = seed.quarter_lounge(TODAY)
    assert validate_venue(venue, "quarter")["floors"][0]["tables"][0]["code"] == "V1"


def test_price_matches_spec(store: Store) -> None:
    venue = store.get_venue("quarter")
    price = price_basket(venue, ["b1"], 2)
    # 2 x 1,500 entry + 18,000 booth = 21,000, entry included for 6.
    assert price["total"] == 21000
    assert price["seated"] == 6
    assert price["tax"] == round(1500 * 2 * 18 / 118) + round(18000 * 18 / 118)


def test_exclusive_gst_adds_on_top(store: Store) -> None:
    venue = store.get_venue("quarter")
    venue["tax"] = {"rate": 18, "inclusive": False}
    assert price_basket(venue, ["h1"], 0)["total"] == 8000 + 1440


def test_full_booking_flow(store: Store) -> None:
    booking = book(store, ["b1"], 2)
    assert booking["status"] == "confirmed"
    assert booking["ref"].startswith("QU-") and len(booking["ref"]) == 8
    assert booking["occasion"] == "Birthday"
    assert "b1" in store.unavailable("quarter", friday(store))


def test_same_table_cannot_be_sold_twice(store: Store) -> None:
    book(store, ["b1"])
    with pytest.raises(Conflict) as err:
        store.hold("quarter", friday(store), ["b1", "b2"], 0)
    assert err.value.tables == ["b1"]
    # b2 was not left half-claimed by the failed attempt.
    assert "b2" not in store.unavailable("quarter", friday(store))


def test_same_table_free_on_another_night(store: Store) -> None:
    book(store, ["v1"])
    saturday = store.get_venue("quarter")["nights"][1]["id"]
    assert store.hold("quarter", saturday, ["v1"], 0)["holdId"]


def test_two_racing_guests_one_winner(db_path: str, store: Store) -> None:
    night = friday(store)
    results: list[str] = []
    barrier = threading.Barrier(6)

    def attempt() -> None:
        s = Store(db_path, clock=store.clock)
        barrier.wait()
        try:
            s.hold("quarter", night, ["v2"], 0)
            results.append("won")
        except Conflict:
            results.append("lost")
        finally:
            s.close()

    threads = [threading.Thread(target=attempt) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count("won") == 1
    assert results.count("lost") == 5


def test_hold_expires_and_frees_table(store: Store, clock: Clock) -> None:
    hold = store.hold("quarter", friday(store), ["h1"], 0)
    clock.now += HOLD_SECONDS + 1
    assert "h1" not in store.unavailable("quarter", friday(store))
    code = store.send_otp("9848022338")
    with pytest.raises(Conflict):
        store.confirm(hold["holdId"], "A", "9848022338", code, "", True, "p")


def test_wrong_otp_is_refused(store: Store) -> None:
    hold = store.hold("quarter", friday(store), ["h2"], 0)
    store.send_otp("9848022338")
    with pytest.raises(FloorsetError, match="code"):
        store.confirm(hold["holdId"], "A", "9848022338", "000000x", "", True, "p")


def test_consent_required(store: Store) -> None:
    hold = store.hold("quarter", friday(store), ["h2"], 0)
    code = store.send_otp("9848022338")
    with pytest.raises(FloorsetError, match="agree"):
        store.confirm(hold["holdId"], "A", "9848022338", code, "", False, "p")


def test_blocked_table_is_not_for_sale(store: Store) -> None:
    venue = store.get_venue("quarter")
    venue["floors"][0]["tables"][0]["blocked"] = True
    store.replace_layout("quarter", venue)
    with pytest.raises(Conflict):
        store.hold("quarter", friday(store), ["v1"], 0)


def test_guest_cancel_refund_follows_policy(store: Store, clock: Clock) -> None:
    booking = book(store, ["b3"])
    # Monday noon, doors Friday 9pm: well over 24 hours, so a full refund.
    view = store.guest_lookup("quarter", booking["ref"], "+91 98480 22338")
    assert view["refundIfCancelled"] == 18000
    cancelled = store.cancel("quarter", booking["ref"], "9848022338")
    assert cancelled["refund"] == 18000
    assert "b3" not in store.unavailable("quarter", friday(store))


def test_late_cancel_gets_partial_refund(store: Store, clock: Clock) -> None:
    booking = book(store, ["b4"])
    clock.now = dt.datetime(2026, 10, 9, 15, 0).timestamp()  # 6 hours before doors
    assert store.cancel("quarter", booking["ref"], "9848022338")["refund"] == 9000


def test_lookup_needs_matching_phone(store: Store) -> None:
    booking = book(store, ["l1"])
    with pytest.raises(NotFound):
        store.guest_lookup("quarter", booking["ref"], "9000000000")


def test_door_check_in_and_report(store: Store) -> None:
    booking = book(store, ["l2"], 3)
    store.mark("quarter", booking["ref"], "arrived")
    report = store.night_report("quarter", friday(store))
    assert report["summary"]["arrived"] == 8 + 3
    assert report["summary"]["revenue"] == 22000 + 4500
    assert report["bookings"][0]["status"] == "arrived"


def test_manual_comp_takes_table_off_sale(store: Store) -> None:
    view = store.manual_booking(
        "quarter", friday(store), ["t1"], 0, "Promoter", "", "", "", comp=True
    )
    assert view["total"] == 0 and view["source"] == "comp"
    with pytest.raises(Conflict):
        store.hold("quarter", friday(store), ["t1"], 0)


def test_cannot_delete_table_with_live_booking(store: Store) -> None:
    book(store, ["h3"])
    venue = store.get_venue("quarter")
    venue["floors"][0]["tables"] = [
        t for t in venue["floors"][0]["tables"] if t["id"] != "h3"
    ]
    with pytest.raises(Conflict, match="H3"):
        store.replace_layout("quarter", venue)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda v: v["floors"][0]["tables"][0].update(x=-5), "outside the room"),
        (lambda v: v["floors"][0]["tables"][1].update(code="V1"), "both called V1"),
        (lambda v: v["floors"][0]["zones"][0].update(kind="pool"), "kind must be"),
        (lambda v: v["floors"][0]["tables"][0].update(seats=0), "seats"),
        (lambda v: v["brand"].update(primary="gold"), "colour"),
        (lambda v: v.update(floors=[]), "at least one floor"),
    ],
)
def test_bad_layouts_are_rejected(store: Store, mutate, message: str) -> None:
    venue = copy.deepcopy(store.get_venue("quarter"))
    mutate(venue)
    with pytest.raises(FloorsetError, match=message):
        store.replace_layout("quarter", venue)


def test_geometry_snaps_to_half_units(store: Store) -> None:
    venue = store.get_venue("quarter")
    venue["floors"][0]["tables"][0]["x"] = 9.26
    saved = store.replace_layout("quarter", venue)
    assert saved["floors"][0]["tables"][0]["x"] == 9.5


def test_owner_login(store: Store) -> None:
    token = store.login("Quarter", "correct horse")
    assert store.session(token)["venue"] == "quarter"
    with pytest.raises(Unauthorised):
        store.login("quarter", "wrong")
    store.logout(token)
    with pytest.raises(Unauthorised):
        store.session(token)
