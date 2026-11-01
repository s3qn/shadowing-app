"""ai-guardrails: daily AI-build budgets, kill switches, signup switch, order."""

import asyncio
import json
import os
import uuid

import pytest
from fastapi import HTTPException

import energy
import guardrails
import main
import starter
import store

OWNER = "00000000-0000-4000-8000-00000000000f"


@pytest.fixture(autouse=True)
def _setup(monkeypatch, tmp_path):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "islands.db")
    store.init()
    monkeypatch.setenv("SHADOW_ADMIN_FILE", str(tmp_path / "admin.json"))
    monkeypatch.delenv("SHADOW_KILL", raising=False)
    guardrails._cache.update(path=None, mtime=None, values={})
    monkeypatch.setattr(main, "OWNER_DEVICE", OWNER)
    monkeypatch.setattr(main, "OWNER_ALIASES", frozenset())
    monkeypatch.setattr(main, "DAILY_CREATES", 50)
    monkeypatch.setattr(main, "DAILY_REWORKS", 50)
    monkeypatch.setattr(energy, "ON", True)
    monkeypatch.setattr(energy, "DAILY_UNITS", 1000)
    monkeypatch.setattr(energy, "GLOBAL_DAILY_UNITS", 100000)
    monkeypatch.setattr(guardrails, "USER_AI_BUILDS", 5)
    monkeypatch.setattr(guardrails, "GLOBAL_AI_BUILDS", 100)


def _dev() -> str:
    return f"user_{uuid.uuid4().hex}"


def _code(fn, *args):
    with pytest.raises(HTTPException) as e:
        fn(*args)
    return e.value.status_code, e.value.detail["code"]


def _write(tmp_path, data, bump=0):
    p = tmp_path / "admin.json"
    p.write_text(data if isinstance(data, str) else json.dumps(data))
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + bump))


def test_user_budget_blocks_the_sixth_build():
    d = _dev()
    for i in range(5):
        main._take_build_slot(d, "create" if i % 2 else "rework", "revoice")
    assert _code(main._take_build_slot, d, "create", "revoice") == (429, "daily_budget")


def test_global_budget_across_devices(monkeypatch):
    monkeypatch.setattr(guardrails, "GLOBAL_AI_BUILDS", 3)
    a, b = _dev(), _dev()
    main._take_build_slot(a, "create", "revoice")
    main._take_build_slot(a, "create", "revoice")
    main._take_build_slot(b, "create", "revoice")
    assert _code(main._take_build_slot, _dev(), "create", "revoice") == (429, "global_budget")


def test_day_rollover_restores_the_budget(monkeypatch):
    d = _dev()
    monkeypatch.setattr(store, "_now", lambda: "2030-01-01T10:00:00+00:00")
    for _ in range(5):
        main._take_build_slot(d, "create", "revoice")
    assert _code(main._take_build_slot, d, "create", "revoice")[1] == "daily_budget"
    monkeypatch.setattr(store, "_now", lambda: "2030-01-02T00:00:01+00:00")
    main._take_build_slot(d, "create", "revoice")


def test_owner_is_exempt():
    for _ in range(8):
        main._take_build_slot(OWNER, "create", "import")
    assert store.count_builds_today_kinds(OWNER, ("create",)) == 0


def test_phrases_cache_hit_burns_nothing(monkeypatch):
    monkeypatch.setattr(starter, "has_cached", lambda *a: True)
    monkeypatch.setattr(starter, "has_template", lambda *a: False)
    monkeypatch.setattr(starter, "seed_cached", lambda *a: "isl")
    monkeypatch.setattr(main.voices, "language_for", lambda s: "ja", raising=False)
    d = _dev()
    for _ in range(8):
        try:
            asyncio.run(main.import_phrases(
                background=main.BackgroundTasks(), topic="greetings", speaker=3,
                language="ja", native="en", authorization="Bearer test-token",
                x_shadow_device=d))
        except HTTPException as e:
            assert e.status_code != 429, "a cache hit must never hit a budget"
    assert store.count_builds_all_today(("create", "rework")) == 0
    assert energy.status(d, False)["daily_left"] == 1000


@pytest.mark.parametrize("key,charge,code", [
    ("ai_jobs", "revoice", "ai_paused"),
    ("imports", "import", "imports_paused"),
])
def test_switch_codes_and_live_flip(tmp_path, key, charge, code):
    d = _dev()
    _write(tmp_path, {key: False})
    assert _code(main._take_build_slot, d, "create", charge) == (503, code)
    _write(tmp_path, {}, bump=10)
    main._take_build_slot(d, "create", charge)


def test_imports_off_leaves_other_builds(tmp_path):
    _write(tmp_path, {"imports": False})
    main._take_build_slot(_dev(), "create", "phrases")


def test_ai_jobs_blocks_use_routes(tmp_path):
    _write(tmp_path, {"ai_jobs": False})
    assert _code(main._take_use_slot, _dev(), "explain", "explain") == (503, "ai_paused")
    main._take_use_slot(_dev(), "take")


def test_env_kill(monkeypatch):
    monkeypatch.setenv("SHADOW_KILL", "ai")
    assert _code(main._take_build_slot, _dev(), "create", "create") == (503, "ai_paused")


def test_malformed_file_keeps_last_value(tmp_path):
    _write(tmp_path, {"ai_jobs": False})
    assert guardrails.load_switches() == {"ai_jobs": False}
    _write(tmp_path, "{nope", bump=10)
    assert guardrails.load_switches() == {"ai_jobs": False}
    assert _code(main._take_build_slot, _dev(), "create", "create")[1] == "ai_paused"


def test_check_order(monkeypatch, tmp_path):
    d = _dev()
    monkeypatch.setattr(main, "DAILY_CREATES", 1)
    monkeypatch.setattr(guardrails, "USER_AI_BUILDS", 1)
    monkeypatch.setattr(energy, "DAILY_UNITS", 0)
    # cap beats budget beats energy
    main.energy.ON = False
    main._take_build_slot(d, "create", "create")
    main.energy.ON = True
    assert _code(main._take_build_slot, d, "create", "create")[1] == "daily_limit"
    monkeypatch.setattr(main, "DAILY_CREATES", 9)
    assert _code(main._take_build_slot, d, "create", "create")[1] == "daily_budget"
    monkeypatch.setattr(guardrails, "USER_AI_BUILDS", 9)
    assert _code(main._take_build_slot, d, "create", "create")[1] == "no_energy"
    # switch beats all
    _write(tmp_path, {"ai_jobs": False})
    assert _code(main._take_build_slot, d, "create", "create")[1] == "ai_paused"


def test_signup_switch(tmp_path):
    known = _dev()
    store.log_build(known, "create")
    _write(tmp_path, {"signups": False})
    guardrails.check_signup(known, main._principal_known(known))
    unknown = _dev()
    assert _code(guardrails.check_signup, unknown, main._principal_known(unknown)) == (403, "signups_paused")
    _write(tmp_path, {}, bump=10)
    assert main._principal_known(unknown) is True


def test_catch_slot_charges_and_blocks(tmp_path):
    d = _dev()
    guardrails.take_ai_call(d, "catch_meaning", "word")
    assert energy.status(d, False)["daily_left"] == 999
    _write(tmp_path, {"ai_jobs": False})
    assert _code(guardrails.take_ai_call, d, "catch_meaning", "word")[1] == "ai_paused"


def test_energy_route_has_builds():
    d = _dev()
    main._take_build_slot(d, "create", "create")
    snap = asyncio.run(main.energy_get(
        username="", authorization="Bearer test-token", x_shadow_device=d))
    assert snap["on"] is True and snap["builds_left"] == 4 and snap["builds_max"] == 5
    assert snap["daily_max"] == 1000 and "refill_at" in snap


@pytest.mark.parametrize("value", [False, 0, "false", "off", "no", "0", " OFF "])
def test_off_values_in_the_admin_file(tmp_path, value):
    _write(tmp_path, {"ai_jobs": value})
    assert _code(main._take_build_slot, _dev(), "create", "create") == (503, "ai_paused")


@pytest.mark.parametrize("value", [True, 1, "true", "on", "yes", None])
def test_on_values_in_the_admin_file(tmp_path, value):
    _write(tmp_path, {"ai_jobs": value})
    main._take_build_slot(_dev(), "create", "create")


# ---- a failed build gives its slot and energy back ----

def _run_build(device, kind, charge, job):
    main._take_build_slot(device, kind, charge)
    iid = store.create_island("simple", 3, device=device)
    asyncio.run(main._refunding(job, iid, device, kind, charge)(iid))
    return iid


@pytest.mark.parametrize("kind,charge", [
    ("create", "create"), ("create", "import"), ("rework", "regenerate"),
    ("create", "phrases"),
])
def test_a_failed_build_refunds_energy_and_the_budget(kind, charge):
    d = _dev()

    async def fails(iid):
        store.set_failed(iid, "No lines could be generated.", "no_lines")

    _run_build(d, kind, charge, fails)
    assert energy.status(d, False)["daily_left"] == 1000
    assert store.count_builds_today_kinds(d, guardrails.BUILD_KINDS) == 0


def test_a_crashing_build_is_refunded_too():
    d = _dev()

    async def crashes(iid):
        store.set_failed(iid, "boom")
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        _run_build(d, "create", "create", crashes)
    assert store.count_builds_today_kinds(d, guardrails.BUILD_KINDS) == 0
    assert energy.status(d, False)["daily_left"] == 1000


def test_a_build_with_lines_keeps_its_charge():
    d = _dev()

    async def ready(iid):
        store.add_line(iid, 0, {"ja": "猫", "kana": "ねこ", "romaji": "", "en": "cat"}, 1.0, [], [])
        store.set_ready(iid, "t")

    _run_build(d, "create", "create", ready)
    assert store.count_builds_today_kinds(d, guardrails.BUILD_KINDS) == 1
    assert energy.status(d, False)["daily_left"] < 1000


def test_the_owner_build_refund_touches_nothing():
    other = _dev()
    main._take_build_slot(other, "create", "create")

    async def fails(iid):
        store.set_failed(iid, "x")

    _run_build(OWNER, "create", "create", fails)
    assert store.count_builds_today_kinds(other, guardrails.BUILD_KINDS) == 1
