"""Tests for the daily build limit: main._take_build_slot and the one call
site inside regenerate. Runs against the throwaway sqlite database
conftest.py points SHADOW_DATA_DIR at.
"""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import main
import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


@pytest.fixture
def device() -> str:
    """A fresh device id per test. The builds table has no per-test reset
    (it lives in the same throwaway sqlite file for the whole run), so two
    tests sharing one id would see each other's counts."""
    return uuid.uuid4().hex


OWNER = "00000000-0000-4000-8000-00000000000f"


def test_two_creates_pass_then_the_third_is_429(monkeypatch, device):
    monkeypatch.setattr(main, "DAILY_CREATES", 2)

    main._take_build_slot(device, "create")
    main._take_build_slot(device, "create")

    with pytest.raises(HTTPException) as exc_info:
        main._take_build_slot(device, "create")

    assert exc_info.value.status_code == 429
    assert exc_info.value.detail == (
        "Daily limit reached: 2 new islands a day. Try again tomorrow."
    )


def test_reworks_count_separately_from_creates(monkeypatch, device):
    monkeypatch.setattr(main, "DAILY_CREATES", 1)
    monkeypatch.setattr(main, "DAILY_REWORKS", 1)

    main._take_build_slot(device, "create")
    with pytest.raises(HTTPException):
        main._take_build_slot(device, "create")

    # The rework cap is untouched by the create above.
    main._take_build_slot(device, "rework")
    with pytest.raises(HTTPException) as exc_info:
        main._take_build_slot(device, "rework")
    assert exc_info.value.detail == (
        "Daily limit reached: 1 rebuilds a day. Try again tomorrow."
    )


def test_owner_device_never_hits_the_limit(monkeypatch):
    monkeypatch.setattr(main, "DAILY_CREATES", 1)
    monkeypatch.setattr(main, "OWNER_DEVICE", OWNER)

    for _ in range(5):
        main._take_build_slot(OWNER, "create")  # never raises


def test_a_build_dated_yesterday_does_not_count(monkeypatch, device):
    monkeypatch.setattr(main, "DAILY_CREATES", 1)
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(timespec="seconds")
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO builds (device, kind, created_at) VALUES (?, 'create', ?)",
            (device, yesterday),
        )

    main._take_build_slot(device, "create")  # today's first, still under the cap of 1


def test_regenerate_with_zero_reworks_is_429_before_any_line_is_cleared(monkeypatch, device):
    monkeypatch.setattr(main, "DAILY_REWORKS", 0)
    island_id = store.create_island("simple", 3, device=device)
    store.add_line(island_id, 0, {"ja": "a"}, 1.0, [])
    store.set_ready(island_id, "Title")
    wav = store.AUDIO_DIR / island_id / "source.wav"
    wav.parent.mkdir(parents=True, exist_ok=True)
    wav.write_bytes(b"not-really-a-wav")

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.regenerate(
            island_id, background=None, complexity="complex", count=8,
            authorization=f"Bearer {main.SHADOW_TOKEN}", x_shadow_device=device,
        ))

    assert exc_info.value.status_code == 429
    island = store.get_island(island_id)
    assert island["lines"] != []
