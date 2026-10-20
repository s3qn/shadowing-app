"""BL-58 "Easy for me": the known_lines store, the mark and unmark routes,
the once-only award, and what get_island and get_progress carry. Runs on the
throwaway SHADOW_DATA_DIR."""

import asyncio
import uuid

import pytest
from fastapi import HTTPException

import main
import progression
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    progression.init()


def _dev() -> str:
    return f"user_{uuid.uuid4().hex}"


def _island(dev: str, n: int = 3) -> str:
    iid = store.create_island("simple", 3, source="voice", device=dev)
    for i in range(n):
        store.add_line(iid, i, {"ja": f"j{i}", "kana": f"k{i}", "romaji": "r", "en": f"e{i}"},
                       2.0, [], words=[])
    store.set_ready(iid, "T")
    return iid


def _mark(dev: str, iid: str, idx: int) -> dict:
    return asyncio.run(main.mark_known(
        island_id=iid, idx=idx, authorization=AUTH, x_shadow_device=dev))


def _unmark(dev: str, iid: str, idx: int) -> dict:
    return asyncio.run(main.unmark_known(
        island_id=iid, idx=idx, authorization=AUTH, x_shadow_device=dev))


def _xp(dev: str) -> int:
    return progression.snapshot(dev)["xp"]


def _take(dev: str, iid: str, idx: int, whole_line: bool) -> None:
    store.add_take_score(dev, iid, idx, "ja", {"total": 80}, 1.0, whole_line)


def test_mark_is_idempotent_and_returns_the_list_and_total():
    dev = _dev()
    iid = _island(dev)
    assert _mark(dev, iid, 1) == {"known": [1], "total": 1, "award": None}
    assert _mark(dev, iid, 1) == {"known": [1], "total": 1, "award": None}
    other = _island(dev)
    assert _mark(dev, other, 0)["total"] == 2
    assert _mark(dev, iid, 0) == {"known": [0, 1], "total": 3, "award": None}
    assert store.known_by_island(dev) == {iid: {0, 1}, other: {0}}


def test_award_pays_once_and_only_for_a_line_taken_whole():
    dev = _dev()
    iid = _island(dev)
    before = _xp(dev)
    assert _mark(dev, iid, 0)["award"] is None  # never taken
    _take(dev, iid, 1, whole_line=False)
    assert _mark(dev, iid, 1)["award"] is None  # a phrase take does not count
    assert _xp(dev) == before
    _take(dev, iid, 2, whole_line=True)
    award = _mark(dev, iid, 2)["award"]
    assert (award["xp"], award["coins"]) == (progression.KNOWN_XP, progression.KNOWN_COINS)
    assert _xp(dev) == before + progression.KNOWN_XP
    # Unmark keeps the XP, and marking again pays nothing more.
    assert _unmark(dev, iid, 2) == {"known": [0, 1], "total": 2}
    assert _xp(dev) == before + progression.KNOWN_XP
    assert _mark(dev, iid, 2)["award"]["xp"] == 0
    assert _xp(dev) == before + progression.KNOWN_XP
    # A line marked before its first take pays when it is marked again after one.
    _unmark(dev, iid, 0)
    _take(dev, iid, 0, whole_line=True)
    assert _mark(dev, iid, 0)["award"]["xp"] == progression.KNOWN_XP


def test_award_is_outside_the_daily_cap():
    dev = _dev()
    iid = _island(dev)
    progression._run_awards(dev, [("seed:cap", progression.DAILY_XP_CAP, 0)], progression._today())
    assert progression.snapshot(dev)["xp_today"] == progression.DAILY_XP_CAP
    _take(dev, iid, 0, whole_line=True)
    assert _mark(dev, iid, 0)["award"]["xp"] == progression.KNOWN_XP


def test_unmark_is_idempotent_and_island_and_progress_carry_known():
    dev = _dev()
    iid = _island(dev)
    _mark(dev, iid, 2)
    assert _unmark(dev, iid, 2) == {"known": [], "total": 0}
    assert _unmark(dev, iid, 2) == {"known": [], "total": 0}
    _mark(dev, iid, 0)
    island = asyncio.run(main.get_island(iid, authorization=AUTH, x_shadow_device=dev))
    assert island["known"] == [0]
    progress = asyncio.run(main.get_progress(authorization=AUTH, x_shadow_device=dev))
    assert progress["known_lines"] == 1
    assert "xp" in progress


def test_404_for_another_devices_island_and_a_missing_line():
    dev = _dev()
    iid = _island(dev)
    for call in (_mark, _unmark):
        with pytest.raises(HTTPException) as err:
            call(_dev(), iid, 0)
        assert err.value.status_code == 404
        with pytest.raises(HTTPException) as err:
            call(dev, iid, 9)
        assert err.value.status_code == 404
    assert store.known_idxs(dev, iid) == []


def test_delete_owner_rows_and_delete_island_clear_known():
    dev = _dev()
    a, b = _island(dev), _island(dev)
    _mark(dev, a, 0)
    _mark(dev, b, 0)
    store.delete_island(a)
    assert store.known_by_island(dev) == {b: {0}}
    store.delete_owner_rows(dev)
    assert store.count_known(dev) == 0
