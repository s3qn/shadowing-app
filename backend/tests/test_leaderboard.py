"""Tests for the cat leaderboard: ranking, the privacy whitelist, the cap,
hidden owners and the caller's own rank. Handles come from a dict-backed fake."""

import asyncio
import json
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


def _owner():
    return f"user_{uuid.uuid4().hex}"


def _seed(xp):
    o = _owner()
    progression.award(o, f"seed:{uuid.uuid4().hex}", xp, 0)
    return o


def _call(monkeypatch, names, owner, limit=50):
    monkeypatch.setattr(main, "_usernames", lambda owners: {o: names[o] for o in owners if o in names})
    return asyncio.run(main.leaderboard(limit=limit, authorization=AUTH, x_shadow_device=owner))


def _named(xps, prefix="cat"):
    owners = [_seed(x) for x in xps]
    return owners, {o: f"{prefix}_{i}_{uuid.uuid4().hex[:6]}" for i, o in enumerate(owners)}


def test_ranking_order(monkeypatch):
    owners, names = _named([59, 1000, 60, 500])
    res = _call(monkeypatch, names, owners[0])
    got = [e["username"] for e in res["entries"]]
    want = [names[owners[i]] for i in (1, 3, 2, 0)]
    assert got == want
    levels = [e["level"] for e in res["entries"]]
    assert levels == sorted(levels, reverse=True)


def test_whitelist(monkeypatch):
    owners, names = _named([1000, 500, 60])
    res = _call(monkeypatch, names, owners[0])
    for e in res["entries"]:
        assert set(e) == {"username", "level", "equipped"}
        assert set(e["equipped"]) == set(progression.SLOTS)
    assert set(res["me"]) == {"rank", "level", "username"}
    blob = json.dumps(res)
    for bad in (*owners, "xp", "coins", "email", "@"):
        assert bad not in blob


def test_cap(monkeypatch):
    owners, names = _named([i for i in range(55)])
    assert len(_call(monkeypatch, names, owners[0])["entries"]) == 50
    assert len(_call(monkeypatch, names, owners[0], limit=200)["entries"]) == 50
    assert len(_call(monkeypatch, names, owners[0], limit=5)["entries"]) == 5


def test_unnamed_hidden(monkeypatch):
    owners, names = _named([1000, 500, 60])
    del names[owners[1]]
    res = _call(monkeypatch, names, owners[2])
    assert [e["username"] for e in res["entries"]] == [names[owners[0]], names[owners[2]]]
    assert res["me"]["rank"] == 2


def test_me(monkeypatch):
    owners, names = _named([1000, 500, 60])
    res = _call(monkeypatch, names, owners[1])
    assert res["me"]["rank"] == 2 and res["me"]["username"] == names[owners[1]]
    res = _call(monkeypatch, names, owners[2], limit=2)
    assert len(res["entries"]) == 2
    assert res["me"]["rank"] == 3
    fresh = _owner()
    res = _call(monkeypatch, names, fresh)
    assert res["me"] == {"rank": None, "level": 1, "username": None}


def test_equipped_shown(monkeypatch):
    owners, names = _named([1000])
    item = progression.catalog()["items"][0]
    with progression.connect() as conn:
        conn.execute(
            "INSERT INTO equipped (owner, slot, item_id) VALUES (?, ?, ?)",
            (owners[0], progression.SLOTS[0], item["id"]),
        )
    res = _call(monkeypatch, names, owners[0])
    assert res["entries"][0]["equipped"][progression.SLOTS[0]] == item["id"]


def test_empty_when_no_handles(monkeypatch):
    o = _seed(100)
    res = _call(monkeypatch, {}, o)
    assert res["entries"] == []
    assert res["me"]["rank"] is None


def test_requires_device(monkeypatch):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.leaderboard(limit=5, authorization=AUTH, x_shadow_device=""))
    assert exc.value.status_code in (400, 401)
