"""Tests for user_profile.py and the cat-username routes (direct calls)."""

import asyncio
import threading

import pytest
from fastapi import HTTPException

import main
import user_profile as up

A = "user_aaaaaaaa-1111"
B = "user_bbbbbbbb-2222"
TOK = None


@pytest.fixture(autouse=True)
def clean():
    with up.connect() as c:
        c.execute("DELETE FROM profiles")
    yield


@pytest.mark.parametrize(
    "name,ok",
    [("ab", False), ("a" * 21, False), ("a" * 20, True), ("abc", True),
     ("Cat_One", True), ("a-b", False), ("a b", False), ("café", False),
     ("admin", False), ("Admin", False), ("  cat1  ", True)],
)
def test_validation(name, ok):
    assert (up.normalize(name) is not None) is ok


def test_case_insensitive_unique():
    assert up.set_username(A, "Cat_One") == "cat_one"
    with pytest.raises(up.UsernameTaken):
        up.set_username(B, "cat_one")


def test_resave_and_rename():
    up.set_username(A, "cat_one")
    assert up.set_username(A, "CAT_ONE") == "cat_one"
    assert up.set_username(A, "cat_two") == "cat_two"
    assert up.get_username(A) == "cat_two"
    up.set_username(B, "cat_one")


def test_race_exactly_one_wins():
    results = []

    def go(owner):
        try:
            up.set_username(owner, "racer")
            results.append("ok")
        except up.UsernameTaken:
            results.append("taken")

    ts = [threading.Thread(target=go, args=(o,)) for o in (A, B)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(results) == ["ok", "taken"]


def test_usernames_batch_and_delete():
    up.set_username(A, "cat_one")
    assert up.usernames([A, B]) == {A: "cat_one"}
    up.delete_owner(A)
    assert up.usernames([A]) == {}
    up.set_username(B, "cat_one")


def test_check_own_handle_available():
    up.set_username(A, "cat_one")
    assert up.check(A, "cat_one")["available"] is True
    assert up.check(B, "CAT_ONE") == {"valid": True, "available": False, "reason": "taken"}
    assert up.check(B, "x")["reason"] == "invalid"


def test_routes_reject_bare_device(monkeypatch):
    monkeypatch.setattr(main, "require_token", lambda a: None)
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.username_get(authorization=None, x_shadow_device="abcdef123456"))
    assert e.value.status_code == 401


def test_route_codes(monkeypatch):
    monkeypatch.setattr(main, "require_token", lambda a: None)
    run = lambda coro: asyncio.run(coro)
    assert run(main.username_set(username="Cat_One", authorization=None, x_shadow_device=A)) == {"username": "cat_one"}
    with pytest.raises(HTTPException) as e:
        run(main.username_set(username="cat_one", authorization=None, x_shadow_device=B))
    assert e.value.status_code == 409 and e.value.detail == {"code": "username_taken"}
    with pytest.raises(HTTPException) as e:
        run(main.username_set(username="no", authorization=None, x_shadow_device=B))
    assert e.value.status_code == 400
    assert run(main.username_get(authorization=None, x_shadow_device=A)) == {"username": "cat_one"}
