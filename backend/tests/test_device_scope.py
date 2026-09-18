"""Tests for per-device islands: store-level scoping, the route-level
_require_device/_own_island guards, the DeviceGuard ASGI middleware, and the
owner claim. Runs against the throwaway sqlite database conftest.py points
SHADOW_DATA_DIR at.
"""

import asyncio

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
import schedule
import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    schedule.init()


AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV_A = "aaaaaaaa-0000-4000-8000-000000000001"
DEV_B = "bbbbbbbb-0000-4000-8000-000000000002"


# --- store ---


def test_island_created_with_device_a_is_listed_for_a_not_b():
    iid = store.create_island("simple", 3, device=DEV_A)

    assert any(i["id"] == iid for i in store.list_islands(DEV_A))
    assert not any(i["id"] == iid for i in store.list_islands(DEV_B))
    assert any(i["id"] == iid for i in store.list_islands())


def test_claim_unowned_moves_only_empty_device_rows():
    unowned = store.create_island("simple", 3)
    owned = store.create_island("simple", 3, device=DEV_B)

    n = store.claim_unowned(DEV_A)

    assert n == 1
    assert store.get_island(unowned)["device"] == DEV_A
    assert store.get_island(owned)["device"] == DEV_B


# --- direct route calls ---


def _ready_island(device: str = DEV_A) -> str:
    iid = store.create_island("simple", 3, device=device)
    store.add_line(iid, 0, {"ja": "a"}, 1.0, [])
    store.set_ready(iid, "Title")
    return iid


def test_get_island_on_another_devices_id_is_404():
    iid = _ready_island()
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.get_island(iid, authorization=AUTH, x_shadow_device=DEV_B))
    assert exc_info.value.status_code == 404


def test_get_island_with_empty_device_is_401():
    iid = _ready_island()
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.get_island(iid, authorization=AUTH, x_shadow_device=""))
    assert exc_info.value.status_code == 401


def test_delete_island_on_another_devices_id_is_404_and_island_survives():
    iid = _ready_island()
    with pytest.raises(HTTPException) as exc_info:
        main.delete_island(iid, authorization=AUTH, x_shadow_device=DEV_B)
    assert exc_info.value.status_code == 404
    assert store.get_island(iid) is not None


def test_rename_island_on_another_devices_id_is_404():
    iid = _ready_island()
    with pytest.raises(HTTPException) as exc_info:
        main.rename_island(iid, title="New", authorization=AUTH, x_shadow_device=DEV_B)
    assert exc_info.value.status_code == 404


def test_regenerate_on_another_devices_id_is_404():
    iid = _ready_island()
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.regenerate(
            iid, background=None, complexity="complex", count=8,
            authorization=AUTH, x_shadow_device=DEV_B,
        ))
    assert exc_info.value.status_code == 404


def test_revoice_on_another_devices_id_is_404():
    iid = _ready_island()
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.revoice(
            iid, background=None, speaker=3, authorization=AUTH, x_shadow_device=DEV_B,
        ))
    assert exc_info.value.status_code == 404


def test_take_clean_on_another_devices_id_is_404():
    iid = _ready_island()
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.take_clean(iid, 0, authorization=AUTH, x_shadow_device=DEV_B))
    assert exc_info.value.status_code == 404


def test_line_audio_on_another_devices_id_is_404():
    iid = _ready_island()
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.line_audio(iid, 0, authorization=AUTH, x_shadow_device=DEV_B))
    assert exc_info.value.status_code == 404


# --- TestClient (through the ASGI app, exercises the DeviceGuard middleware) ---

client = TestClient(main.app)


def test_health_without_device_is_200():
    resp = client.get("/shadow/health")
    assert resp.status_code == 200


def test_list_islands_with_token_but_no_device_is_401():
    resp = client.get("/shadow/islands", headers={"Authorization": AUTH})
    assert resp.status_code == 401
    assert resp.json() == {"detail": "missing device id"}


def test_list_islands_with_device_header_is_200_empty_list():
    # A device no other test in this file ever creates an island for: other
    # tests share DEV_A and DEV_B across the same throwaway database.
    fresh_device = "cccccccc-0000-4000-8000-000000000003"
    resp = client.get(
        "/shadow/islands",
        headers={"Authorization": AUTH, "X-Shadow-Device": fresh_device},
    )
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_islands_with_device_query_is_200():
    fresh_device = "dddddddd-0000-4000-8000-000000000004"
    resp = client.get(f"/shadow/islands?device={fresh_device}", headers={"Authorization": AUTH})
    assert resp.status_code == 200


# --- owner claim ---


def test_claim_owner_moves_unowned_island_and_practice_row(monkeypatch):
    iid = store.create_island("simple", 3)
    # log_practice now requires a device; write the unowned schedule row
    # directly instead, the way a pre-feature install would have left it.
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO schedule_state (island_id, level, due_on, last_practiced_on, updated_at)"
            " VALUES (?, 1, '2000-01-01', '2000-01-01', '2000-01-01T00:00:00+00:00')",
            (iid,),
        )

    monkeypatch.setattr(main, "OWNER_DEVICE", DEV_A)
    main._claim_owner()

    assert store.get_island(iid)["device"] == DEV_A
    with schedule.connect() as conn:
        row = conn.execute(
            "SELECT device FROM schedule_state WHERE island_id=?", (iid,)
        ).fetchone()
    assert row["device"] == DEV_A

    # Idempotent: running it again changes nothing (there is nothing left to claim).
    n_before = store.claim_unowned("")  # no-op probe: nothing left at ''
    assert n_before == 0
    main._claim_owner()
    assert store.get_island(iid)["device"] == DEV_A


# --- schedule ---


def test_practice_logged_by_a_is_due_for_a_not_b():
    asyncio.run(schedule.log_practice(
        island_id="sched-island", seconds=10.0, authorization=AUTH, x_shadow_device=DEV_A,
    ))

    # Freshly logged practice is due tomorrow, not today, so force it due now
    # to check ownership rather than the ladder's timing.
    with schedule.connect() as conn:
        conn.execute(
            "UPDATE schedule_state SET due_on='2000-01-01' WHERE island_id='sched-island'"
        )
    due_a = asyncio.run(schedule.due_today(authorization=AUTH, x_shadow_device=DEV_A))
    due_b = asyncio.run(schedule.due_today(authorization=AUTH, x_shadow_device=DEV_B))
    assert any(r["island_id"] == "sched-island" for r in due_a)
    assert not any(r["island_id"] == "sched-island" for r in due_b)


# --- per-device take profile ---


def _profile(delay: int):
    import numpy as np

    import aec

    return aec.Profile(delay=delay, W=np.zeros(4), erle_db=1.0)


def test_take_profile_is_per_device(monkeypatch):
    import aec

    monkeypatch.setattr(main, "OWNER_DEVICE", "")
    aec.save_profile(main._take_profile_name(DEV_A), _profile(7))

    assert main._load_take_profile(aec, DEV_A).delay == 7
    assert main._load_take_profile(aec, DEV_B) is None


def test_owner_device_falls_back_to_the_shared_default_profile(monkeypatch):
    import aec

    owner = "cccccccc-0000-4000-8000-000000000003"
    monkeypatch.setattr(main, "OWNER_DEVICE", owner)
    aec.save_profile(main.LEGACY_TAKE_PROFILE, _profile(11))
    try:
        assert main._load_take_profile(aec, owner).delay == 11
        assert main._load_take_profile(aec, DEV_B) is None
    finally:
        (aec.AEC_DIR / f"{main.LEGACY_TAKE_PROFILE}.npz").unlink(missing_ok=True)


def test_require_device_rejects_a_malformed_id():
    with pytest.raises(HTTPException) as exc:
        main._require_device("../../etc")
    assert exc.value.status_code == 401
    assert main._require_device(DEV_A) == DEV_A
