"""offline-first: client operation ids (store.client_ops).

A phone flushing its outbox may post the same practice chunk or the same
take twice (a reply lost in flight, a retry after a kill). A post that
carries an `op` is claimed once per owner and its reply is kept, so the
replay writes no row, pays nothing and gets the first reply back. Without
an op every post is new, as before. Calls the route functions directly,
like test_schedule.py and test_bl51_score.py.
"""

import asyncio
import io
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException, UploadFile

import main
import progression
import schedule
import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    progression.init()
    schedule.init()


AUTH = f"Bearer {main.SHADOW_TOKEN}"


def _own(island_id: str, device: str) -> None:
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO islands (id, status, created_at, device)"
            " VALUES (?, 'ready', ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET device = excluded.device",
            (island_id, datetime.now(timezone.utc).isoformat(), device),
        )


def _owner() -> str:
    # main._require_device accepts only the app's own device id shape.
    return f"user_{uuid.uuid4().hex}"


def _practice(island_id: str, device: str, op: str = "", seconds: float = 70.0) -> dict:
    return asyncio.run(schedule.log_practice(
        island_id=island_id, seconds=seconds, op=op,
        authorization=AUTH, x_shadow_device=device,
    ))


def _practice_rows(device: str) -> int:
    with schedule.connect() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS n FROM practice_events WHERE device=?", (device,)
        ).fetchone()["n"]


def _award_keys(owner: str) -> list[str]:
    with progression.connect() as conn:
        return [r["key"] for r in conn.execute(
            "SELECT key FROM awards WHERE owner=? ORDER BY key", (owner,)
        )]


def test_practice_replayed_with_one_op_writes_one_row_and_pays_once():
    dev = _owner()
    _own("isl-a", dev)
    first = _practice("isl-a", dev, op="chunk-1:0")
    paid = _award_keys(dev)
    assert _practice_rows(dev) == 1 and paid

    again = _practice("isl-a", dev, op="chunk-1:0")

    assert again == first
    assert _practice_rows(dev) == 1
    assert _award_keys(dev) == paid


def test_practice_with_two_ops_writes_two_rows():
    dev = _owner()
    _own("isl-a", dev)
    _practice("isl-a", dev, op="chunk-1:0")
    second = _practice("isl-a", dev, op="chunk-1:1")
    assert _practice_rows(dev) == 2
    assert second["seconds_today"] == 140.0


def test_the_same_op_from_two_owners_is_two_posts():
    dev_a, dev_b = _owner(), _owner()
    _own("isl-a", dev_a)
    _own("isl-b", dev_b)
    _practice("isl-a", dev_a, op="shared-op")
    _practice("isl-b", dev_b, op="shared-op")
    assert _practice_rows(dev_a) == 1 and _practice_rows(dev_b) == 1


def test_practice_without_an_op_is_unchanged():
    dev = _owner()
    _own("isl-a", dev)
    _practice("isl-a", dev)
    _practice("isl-a", dev)
    assert _practice_rows(dev) == 2


@pytest.mark.parametrize("op", ["has space", "a" * 65, "émoji", "semi;colon"])
def test_a_bad_practice_op_is_a_400(op):
    dev = _owner()
    _own("isl-a", dev)
    with pytest.raises(HTTPException) as err:
        _practice("isl-a", dev, op=op)
    assert err.value.status_code == 400
    assert _practice_rows(dev) == 0


def test_an_op_claimed_by_a_run_that_died_replays_as_accepted():
    dev = _owner()
    assert store.claim_op(dev, "lost") is True
    assert store.claim_op(dev, "lost") is False
    assert store.op_reply(dev, "lost") == {}
    assert store.op_reply(dev, "never") is None


def test_prune_drops_only_old_ops():
    dev = _owner()
    store.claim_op(dev, "fresh")
    store.claim_op(dev, "stale")
    with store.connect() as conn:
        conn.execute(
            "UPDATE client_ops SET created_at='2000-01-01T00:00:00+00:00' WHERE op='stale'"
        )
    assert store.prune_ops() == 1
    assert store.op_reply(dev, "fresh") == {} and store.op_reply(dev, "stale") is None


# Takes


def _fake_take(monkeypatch, tmp_path, owner: str, calls: list) -> None:
    island = {"id": "isl", "device": owner, "language": "ja", "lines": [{"idx": 0}]}

    async def fake_audio(*a, **k):
        return tmp_path / "ref.wav"

    def clean(*a, **k):
        calls.append(1)
        return {
            "score": {"words": ["ok"], "total": 88,
                      "parts": {"content": 90, "timing": 80, "pitch": None}},
            "analysis": {"note": "", "coverage": 1.0, "curve": {"line": [1, 2], "take": [3]}},
        }

    monkeypatch.setattr(main, "_own_island", lambda island_id, device: island)
    monkeypatch.setattr(main, "_load_take_profile", lambda aec, device: None)
    monkeypatch.setattr(main, "_take_use_slot", lambda device, kind: None)
    monkeypatch.setattr(main, "_resolve_line_audio", fake_audio)
    monkeypatch.setattr(main, "_run_clean", clean)


def _upload(owner: str, op: str = "") -> dict:
    return asyncio.run(main.upload_take(
        island_id="isl", idx=0, speed=1.0, calibrate="0", start=-1, end=-1, lag=0,
        line_start=-1, guide="0", silent="0", op=op,
        take=UploadFile(file=io.BytesIO(b"RIFF"), filename="t.wav"),
        authorization=AUTH, x_shadow_device=owner,
    ))


def test_take_replayed_with_one_op_scores_once(monkeypatch, tmp_path):
    owner = _owner()
    calls: list = []
    _fake_take(monkeypatch, tmp_path, owner, calls)

    first = _upload(owner, op="take-1")
    again = _upload(owner, op="take-1")

    assert len(calls) == 1
    assert len(store.list_take_scores(owner)) == 1
    keys = _award_keys(owner)
    assert any(k.startswith("take:") for k in keys)
    assert not any(k.startswith("rep:") for k in keys)
    # The replay is the first reply minus the analysis curve.
    assert "curve" in first["analysis"]
    assert again == {**first, "analysis": {"note": "", "coverage": 1.0}}
    assert again["award"] == first["award"]


def test_take_without_an_op_pays_the_repeat_award(monkeypatch, tmp_path):
    owner = _owner()
    calls: list = []
    _fake_take(monkeypatch, tmp_path, owner, calls)
    _upload(owner)
    _upload(owner)
    assert len(calls) == 2
    assert len(store.list_take_scores(owner)) == 2
    assert any(k.startswith("rep:") for k in _award_keys(owner))


def test_a_bad_take_op_is_a_400_before_any_work(monkeypatch, tmp_path):
    owner = _owner()
    calls: list = []
    _fake_take(monkeypatch, tmp_path, owner, calls)
    with pytest.raises(HTTPException) as err:
        _upload(owner, op="not ok")
    assert err.value.status_code == 400
    assert calls == [] and store.list_take_scores(owner) == []
