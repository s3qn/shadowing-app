"""Tests for spacing.py's pure math and the /shadow/schedule routes in
schedule.py. Calls the route functions directly (plain async def), same
reasoning as test_explain_chat_route.py: no server, no network needed.
"""

import asyncio
from datetime import date

import pytest

import main
import schedule
import spacing


@pytest.fixture(autouse=True)
def _init_db():
    schedule.init()


AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "dev-a"


def test_due_date_advances_by_the_ladder():
    assert spacing.due_date(date(2026, 1, 1), 0) == date(2026, 1, 1)
    assert spacing.due_date(date(2026, 1, 1), 1) == date(2026, 1, 2)
    assert spacing.due_date(date(2026, 1, 1), 3) == date(2026, 1, 5)


def test_due_date_clamps_past_max_level():
    far_future_level = spacing.MAX_LEVEL + 5
    assert spacing.due_date(date(2026, 1, 1), far_future_level) == spacing.due_date(
        date(2026, 1, 1), spacing.MAX_LEVEL
    )


def test_posting_one_practice_event_creates_a_level_one_row_due_tomorrow():
    result = asyncio.run(schedule.log_practice(
        island_id="island-a", seconds=30.0, authorization=AUTH, x_shadow_device=DEV,
    ))

    assert result["level"] == 1
    today = date.today()
    assert result["due_on"] == spacing.due_date(today, 1).isoformat()


def test_posting_twice_moves_the_island_to_level_two():
    asyncio.run(schedule.log_practice(
        island_id="island-b", seconds=30.0, authorization=AUTH, x_shadow_device=DEV,
    ))
    result = asyncio.run(schedule.log_practice(
        island_id="island-b", seconds=30.0, authorization=AUTH, x_shadow_device=DEV,
    ))

    assert result["level"] == 2


def test_due_today_includes_an_island_due_now_and_omits_one_due_next_week():
    asyncio.run(schedule.log_practice(
        island_id="due-soon", seconds=10.0, authorization=AUTH, x_shadow_device=DEV,
    ))
    # Bump this island to a level whose interval is a week or more out.
    for _ in range(5):
        asyncio.run(schedule.log_practice(
            island_id="due-later", seconds=10.0, authorization=AUTH, x_shadow_device=DEV,
        ))

    due = asyncio.run(schedule.due_today(authorization=AUTH, x_shadow_device=DEV))
    ids = {row["island_id"] for row in due}

    assert "due-soon" not in ids  # due tomorrow, not today
    assert "due-later" not in ids


def test_due_today_includes_an_island_due_today_or_earlier(monkeypatch):
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO schedule_state (island_id, level, due_on, last_practiced_on, updated_at, device)"
            " VALUES ('already-due', 1, '2000-01-01', '2000-01-01', '2000-01-01T00:00:00+00:00', ?)",
            (DEV,),
        )

    due = asyncio.run(schedule.due_today(authorization=AUTH, x_shadow_device=DEV))
    ids = {row["island_id"] for row in due}

    assert "already-due" in ids


def test_due_today_omits_another_devices_row():
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO schedule_state (island_id, level, due_on, last_practiced_on, updated_at, device)"
            " VALUES ('someone-elses', 1, '2000-01-01', '2000-01-01', '2000-01-01T00:00:00+00:00', 'dev-b')"
        )

    due = asyncio.run(schedule.due_today(authorization=AUTH, x_shadow_device=DEV))
    ids = {row["island_id"] for row in due}

    assert "someone-elses" not in ids


def test_zero_or_negative_seconds_is_a_400():
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.log_practice(
            island_id="island-c", seconds=0, authorization=AUTH, x_shadow_device=DEV,
        ))
    assert getattr(exc_info.value, "status_code", None) == 400


def test_missing_token_on_practice_is_401():
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.log_practice(
            island_id="island-d", seconds=10.0, authorization=None, x_shadow_device=DEV,
        ))
    assert getattr(exc_info.value, "status_code", None) == 401


def test_bad_token_on_due_today_is_401():
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.due_today(authorization="Bearer wrong", x_shadow_device=DEV))
    assert getattr(exc_info.value, "status_code", None) == 401


def test_missing_device_on_practice_is_401():
    with pytest.raises(Exception) as exc_info:
        asyncio.run(schedule.log_practice(
            island_id="island-e", seconds=10.0, authorization=AUTH, x_shadow_device="",
        ))
    assert getattr(exc_info.value, "status_code", None) == 401


def test_another_devices_practice_post_does_not_move_the_owners_row():
    for _ in range(2):
        asyncio.run(schedule.log_practice(
            island_id="island-owned", seconds=30.0, authorization=AUTH, x_shadow_device=DEV,
        ))
    with schedule.connect() as conn:
        before = dict(conn.execute(
            "SELECT level, due_on, device FROM schedule_state WHERE island_id = 'island-owned'"
        ).fetchone())

    result = asyncio.run(schedule.log_practice(
        island_id="island-owned", seconds=30.0, authorization=AUTH, x_shadow_device="dev-b",
    ))

    # The stranger's read starts from level 0, not the owner's level 2.
    assert result["level"] == 1
    with schedule.connect() as conn:
        after = dict(conn.execute(
            "SELECT level, due_on, device FROM schedule_state WHERE island_id = 'island-owned'"
        ).fetchone())
    assert after == before
    assert after["device"] == DEV
