"""Beta flag store, the admin routes (called directly) and the DeviceGuard
beta gate (through TestClient)."""

import uuid

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import accounts
import beta
import catch
import main
import store

from test_accounts import _token, key  # noqa: F401  (key is a fixture)

AUTH = "Bearer t0k"
ADMIN = "00000000-0000-4000-8000-0000000000ad"
NOT_BETA = {"detail": {"code": "not_beta"}}

client = TestClient(main.app)


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setattr(main, "SHADOW_TOKEN", "t0k")
    monkeypatch.setattr(main, "ADMIN_USERS", frozenset({ADMIN}))
    monkeypatch.setattr(main, "OWNER_DEVICE", "")
    monkeypatch.setattr(main, "OWNER_ALIASES", frozenset())
    beta.init()
    store.init()
    catch.init()
    # beta.db lives for the whole session: an admin row left by one test must
    # not decide the next one.
    beta.delete_owner(ADMIN)


def _hdr(device: str) -> dict:
    return {"Authorization": AUTH, "X-Shadow-Device": device}


def _dev() -> str:
    return uuid.uuid4().hex[:12]


def _run(coro):
    import asyncio

    return asyncio.run(coro)


def _get(device):
    return _run(main.beta_get(AUTH, device))


def test_store_default_off_set_unset_delete():
    o = _dev()
    assert beta.is_enabled(o) is False
    beta.set_flag(o, True, ADMIN)
    assert beta.is_enabled(o) is True
    assert beta.list_flags()[o] is True
    beta.set_flag(o, False, ADMIN)
    assert beta.is_enabled(o) is False
    beta.delete_owner(o)
    assert o not in beta.list_flags()


def test_separate_db_file():
    assert beta.DB_PATH.name == "beta.db"
    assert beta.DB_PATH != store.DB_PATH
    with store.connect() as conn:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    assert "beta_flags" not in names


def _state(admin: bool, on: bool) -> dict:
    return {"admin": admin, "beta": on, "youtube": on, "podcast": on, "import": on}


def test_store_flag_is_none_without_a_row():
    o = _dev()
    assert beta.flag(o) is None
    beta.set_flag(o, False, ADMIN)
    assert beta.flag(o) is False
    beta.set_flag(o, True, ADMIN)
    assert beta.flag(o) is True
    beta.delete_owner(o)
    assert beta.flag(o) is None


def test_beta_get_states():
    d = _dev()
    assert _get(d) == _state(admin=False, on=False)
    beta.set_flag(d, True, ADMIN)
    assert _get(d) == _state(admin=False, on=True)
    # An admin with no row defaults on.
    assert _get(ADMIN) == _state(admin=True, on=True)


def test_admin_who_flips_himself_off_is_off():
    beta.set_flag(ADMIN, False, ADMIN)
    assert _get(ADMIN) == _state(admin=True, on=False)
    assert main._beta_on(ADMIN) is False
    beta.delete_owner(ADMIN)
    assert main._beta_on(ADMIN) is True


def test_people_row_for_fresh_admin_is_enabled():
    people = _run(main.admin_beta_list(AUTH, ADMIN))["people"]
    me = people[0]
    assert me["me"] is True and me["owner"] == ADMIN and me["enabled"] is True
    beta.set_flag(ADMIN, False, ADMIN)
    people = _run(main.admin_beta_list(AUTH, ADMIN))["people"]
    assert people[0]["enabled"] is False


def test_owner_device_is_admin(monkeypatch):
    d = _dev()
    monkeypatch.setattr(main, "OWNER_DEVICE", d)
    assert _get(d)["admin"] is True


def test_admin_routes_403_for_non_admin_and_flagged():
    d = _dev()
    beta.set_flag(d, True, ADMIN)
    for dev in (d, _dev()):
        with pytest.raises(HTTPException) as e:
            _run(main.admin_beta_list(AUTH, dev))
        assert e.value.status_code == 403 and e.value.detail == {"code": "not_admin"}
        with pytest.raises(HTTPException) as e:
            _run(main.admin_beta_set(main.BetaBody(owner=d, enabled=True), AUTH, dev))
        assert e.value.status_code == 403


def test_admin_set_then_target_sees_it_and_list():
    d = _dev()
    _run(main.admin_beta_set(main.BetaBody(owner=d, enabled=True), AUTH, ADMIN))
    assert _get(d)["podcast"] is True
    people = _run(main.admin_beta_list(AUTH, ADMIN))["people"]
    assert people[0]["me"] is True and people[0]["owner"] == ADMIN
    row = next(p for p in people if p["owner"] == d)
    assert row["enabled"] is True and row["kind"] == "device" and row["handle"] is None
    _run(main.admin_beta_set(main.BetaBody(owner=d, enabled=False), AUTH, ADMIN))
    assert _get(d)["podcast"] is False


def test_bad_owner_400():
    with pytest.raises(HTTPException) as e:
        _run(main.admin_beta_set(main.BetaBody(owner="nope!", enabled=True), AUTH, ADMIN))
    assert e.value.status_code == 400


def test_admin_users_parsing(monkeypatch):
    monkeypatch.setenv("SHADOW_ADMIN_USERS", f" {ADMIN} , ,x ")
    parsed = main._parse_admin_users(main.os.getenv("SHADOW_ADMIN_USERS"))
    assert parsed == {ADMIN, "x"}
    assert main._parse_admin_users(None) == frozenset()
    assert main._parse_admin_users(" , ") == frozenset()
    monkeypatch.setattr(main, "ADMIN_USERS", parsed)
    assert main._is_admin(ADMIN) and not main._is_admin("y")
    assert not main._is_admin("")


# --- DeviceGuard beta gate ---

# One row per family in main.BETA_PATHS, and the core routes next to them that
# must stay open. A route added to the backend lands in one of the two lists.
GATED = [
    "/shadow/islands/import",
    "/shadow/podcasts",
    "/shadow/podcasts/search",
    "/shadow/podcasts/import",
    "/shadow/youtube/info",
    "/shadow/youtube/captions",
    "/shadow/videos",
    "/shadow/islands/abc/video",
    "/shadow/islands/abc/video-audio",
    "/shadow/islands/abc/captions-timing",
    "/shadow/islands/abc/episode",
    "/shadow/islands/abc/repair",
    "/shadow/islands/abc/ai-picks",
    "/shadow/catch/words",
    "/shadow/catch/islands/abc/words",
    "/shadow/catch/review",
    "/shadow/progress",
    "/shadow/leaderboard",
    "/shadow/leaderboard/weekly",
    "/shadow/cosmetics/catalog",
    "/shadow/cosmetics/equip",
    "/shadow/profile/sean",
    "/shadow/streak/freeze/buy",
    "/shadow/review/cards",
    "/shadow/review/cards/7/grade",
]
CORE = [
    "/shadow/islands",
    "/shadow/islands/abc",
    "/shadow/islands/abc/title",
    "/shadow/islands/abc/lines/0/audio",
    "/shadow/islands/abc/lines/0/take",
    "/shadow/islands/abc/lines/0/take/clean",
    "/shadow/islands/abc/lines/0/known",
    "/shadow/islands/abc/regenerate",
    "/shadow/islands/abc/revoice",
    "/shadow/islands/abc/export",
    "/shadow/islands/abc/glosses",
    "/shadow/word-audio",
    "/shadow/gloss",
    "/shadow/explain-word",
    "/shadow/explain-chat",
    "/shadow/phrases/catalog",
    "/shadow/phrases/import",
    "/shadow/grammar/levels",
    "/shadow/starter",
    "/shadow/starter/finish",
    "/shadow/review/due",
    "/shadow/review/session/start",
    "/shadow/review/session-finished",
    "/shadow/energy",
    "/shadow/username",
    "/shadow/username/check",
    "/shadow/account",
    "/shadow/speakers",
    "/shadow/voices/3/preview",
    "/shadow/health",
    "/shadow/privacy",
    "/shadow/dev/review",
    "/shadow/llm/spend",
    "/shadow/beta",
    "/shadow/admin/beta",
    "/shadow/schedule/due-today",
    "/shadow/suggestions",
    "/shadow/feedback",
]


def test_beta_paths_by_family():
    d = _dev()
    for path in GATED:
        assert _run(main._beta_denied(path, d)) is True, path
    for path in CORE:
        assert _run(main._beta_denied(path, d)) is False, path
    beta.set_flag(d, True, ADMIN)
    for path in GATED:
        assert _run(main._beta_denied(path, d)) is False, path


def test_gate_403_for_fresh_device_until_flagged():
    d = _dev()
    for path in ("/shadow/leaderboard", "/shadow/catch/words?language=ja"):
        r = client.get(path, headers=_hdr(d))
        assert r.status_code == 403 and r.json() == NOT_BETA, path
    beta.set_flag(d, True, ADMIN)
    for path in ("/shadow/leaderboard", "/shadow/catch/words?language=ja"):
        assert client.get(path, headers=_hdr(d)).status_code != 403, path


def test_gate_owner_device_on_by_default_then_off(monkeypatch):
    d = _dev()
    monkeypatch.setattr(main, "OWNER_DEVICE", d)
    assert client.get("/shadow/leaderboard", headers=_hdr(d)).status_code != 403
    beta.set_flag(d, False, ADMIN)
    r = client.get("/shadow/leaderboard", headers=_hdr(d))
    assert r.status_code == 403 and r.json() == NOT_BETA


def test_gate_leaves_core_routes_open():
    d = _dev()
    assert client.get("/shadow/islands", headers=_hdr(d)).status_code == 200
    assert client.get("/shadow/beta", headers=_hdr(d)).json() == _state(admin=False, on=False)
    assert client.get("/shadow/health").status_code == 200


def test_gate_user_principal_with_flag(key, monkeypatch):
    monkeypatch.setattr(main, "REQUIRE_SIGNIN", True)
    sub = str(uuid.uuid4())
    hdr = {"Authorization": AUTH, "X-Shadow-User": _token(key, sub=sub)}
    r = client.get("/shadow/leaderboard", headers=hdr)
    assert r.status_code == 403 and r.json() == NOT_BETA
    beta.set_flag(accounts.principal(sub), True, ADMIN)
    assert client.get("/shadow/leaderboard", headers=hdr).status_code != 403
    assert client.get("/shadow/beta", headers=hdr).json() == _state(admin=False, on=True)


def test_gate_needs_the_shared_token_so_a_probe_gets_401():
    d = _dev()
    for auth in (None, "Bearer wrong"):
        hdr = {"X-Shadow-Device": d} | ({"Authorization": auth} if auth else {})
        for path in ("/shadow/leaderboard", "/shadow/islands/abc/episode"):
            assert client.get(path, headers=hdr).status_code == 401, (auth, path)
    # The media query token counts like the header: a non-beta device stays out.
    r = client.get(f"/shadow/islands/abc/episode?token=t0k&device={d}")
    assert r.status_code == 403 and r.json() == NOT_BETA
    assert client.get(f"/shadow/islands/abc/episode?token=nope&device={d}").status_code == 401
