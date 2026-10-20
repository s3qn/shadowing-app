"""bl52-energy: the daily meter, the grant balance, the global stop, the
warning relay, the two routes, and the proof that with SHADOW_ENERGY off
nothing changes. Runs on the throwaway data dir conftest.py points at."""

import asyncio
import threading
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import energy
import main
import store
import suggest
import user_profile

AUTH = f"Bearer {main.SHADOW_TOKEN}"
OWNER = "00000000-0000-4000-8000-00000000000f"


@pytest.fixture(autouse=True)
def _init_db(monkeypatch, tmp_path):
    # A fresh data dir per test: the global stop sums every device's rows.
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "islands.db")
    store.init()
    user_profile.init()


@pytest.fixture
def on(monkeypatch):
    monkeypatch.setattr(energy, "ON", True)
    monkeypatch.setattr(energy, "DAILY_UNITS", 7)
    monkeypatch.setattr(energy, "GLOBAL_DAILY_UNITS", 1000)
    monkeypatch.setattr(main, "OWNER_DEVICE", OWNER)
    monkeypatch.setattr(main, "OWNER_ALIASES", frozenset())


def _dev() -> str:
    return f"user_{uuid.uuid4().hex}"


def _name() -> str:
    """A fresh handle per test: profiles.db is shared for the whole run."""
    return f"cat_{uuid.uuid4().hex[:8]}"


def _rows(table: str, device: str) -> list[dict]:
    col = "target_device" if table == "energy_grants" else "device"
    with store.connect() as conn:
        return [dict(r) for r in conn.execute(
            f"SELECT * FROM {table} WHERE {col}=? ORDER BY id", (device,))]


def _counts() -> dict[str, int]:
    with store.connect() as conn:
        names = [r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        return {n: conn.execute(f"SELECT COUNT(*) AS n FROM {n}").fetchone()["n"] for n in names}


def _get(dev, username=""):
    return asyncio.run(main.energy_get(
        username=username, authorization=AUTH, x_shadow_device=dev))


def _grant(dev, username, amount, note=""):
    return asyncio.run(main.energy_grant(
        username=username, amount=amount, note=note, authorization=AUTH, x_shadow_device=dev))


def _progress(dev):
    return asyncio.run(main.get_progress(authorization=AUTH, x_shadow_device=dev))


# --- charging ---

def test_a_charge_spends_daily_first_then_the_grant_with_an_exact_split(on):
    dev = _dev()
    energy.grant(OWNER, dev, "cat", 10)
    energy.charge(dev, "create", False)  # 5 of 7 daily
    energy.charge(dev, "create", False)  # 2 daily + 3 grant
    rows = _rows("energy_ledger", dev)
    assert [(r["kind"], r["units"], r["from_grant"]) for r in rows] == [
        ("create", 5, 0), ("create", 5, 3),
    ]
    st = energy.status(dev, False)
    assert (st["daily_left"], st["granted_left"]) == (0, 7)
    energy.charge(dev, "explain", False)  # all from the grant
    assert _rows("energy_ledger", dev)[-1]["from_grant"] == 2
    assert energy.status(dev, False)["granted_left"] == 5


def test_a_charge_past_both_balances_is_429_and_writes_nothing(on):
    dev = _dev()
    energy.charge(dev, "create", False)
    before = _counts()
    with pytest.raises(HTTPException) as exc_info:
        energy.charge(dev, "create", False)  # needs 5, 2 daily left, no grant
    assert exc_info.value.status_code == 429
    assert exc_info.value.detail["code"] == "no_energy"
    assert exc_info.value.detail["need"] == 5
    assert exc_info.value.detail["refill_at"] == energy.refill_at()
    assert _counts() == before
    # The cheaper call still fits in what is left.
    energy.charge(dev, "phrases", False)
    assert energy.status(dev, False)["daily_left"] == 1


def test_a_cap_429_from_the_slot_helper_writes_no_ledger_row(on, monkeypatch):
    monkeypatch.setattr(main, "DAILY_CREATES", 1)
    dev = _dev()
    main._take_build_slot(dev, "create", "phrases")
    assert len(_rows("energy_ledger", dev)) == 1
    assert store.count_builds_today(dev, "create") == 1
    with pytest.raises(HTTPException) as exc_info:
        main._take_build_slot(dev, "create", "phrases")
    assert exc_info.value.detail["code"] == "daily_limit"
    assert len(_rows("energy_ledger", dev)) == 1


def test_a_refused_charge_never_burns_a_build_slot(on):
    dev = _dev()
    energy.charge(dev, "create", False)
    energy.charge(dev, "phrases", False)  # 1 of 7 left
    with pytest.raises(HTTPException) as exc_info:
        main._take_build_slot(dev, "create", "import")  # 10 > 1
    assert exc_info.value.detail["code"] == "no_energy"
    assert store.count_builds_today(dev, "create") == 0
    with pytest.raises(HTTPException) as exc_info:
        main._take_use_slot(dev, "explain", "explain")
    assert exc_info.value.detail["code"] == "no_energy"
    assert store.count_builds_today(dev, "explain") == 0


def test_the_global_stop_is_429_global_limit_for_the_next_device(on, monkeypatch):
    monkeypatch.setattr(energy, "GLOBAL_DAILY_UNITS", 6)
    first, second = _dev(), _dev()
    energy.charge(first, "create", False)  # global 5 of 6
    with pytest.raises(HTTPException) as exc_info:
        energy.charge(second, "explain", False)  # 5 + 2 > 6
    assert exc_info.value.status_code == 429
    assert exc_info.value.detail == {"code": "global_limit", "refill_at": energy.refill_at()}
    assert _rows("energy_ledger", second) == []
    assert energy.status(second, False)["daily_left"] == 7
    # The first device still has daily units; what fits the budget still goes.
    assert energy.status(first, False)["daily_left"] == 2
    energy.charge(first, "phrases", False)  # 5 + 1 = 6 fits
    with pytest.raises(HTTPException) as exc_info:
        energy.charge(first, "phrases", False)
    assert exc_info.value.detail["code"] == "global_limit"


def test_the_global_stop_lets_a_charge_that_exactly_fills_the_budget(on, monkeypatch):
    monkeypatch.setattr(energy, "GLOBAL_DAILY_UNITS", 6)
    dev = _dev()
    energy.charge(dev, "create", False)
    energy.charge(dev, "phrases", False)  # 6 of 6
    assert store.energy_global_today() == 6


def test_the_warning_relays_once_when_the_budget_crosses_the_line(on, monkeypatch):
    monkeypatch.setattr(energy, "GLOBAL_DAILY_UNITS", 10)  # line at 8
    sent, got = [], threading.Event()

    def fake_relay(text, prefix="Feature suggestion: "):
        sent.append((text, prefix))
        got.set()
    monkeypatch.setattr(suggest, "_relay_to_discord", fake_relay)

    a, b = _dev(), _dev()
    energy.charge(a, "create", False)  # 5, under the line
    assert sent == []
    energy.charge(b, "create", False)  # 10, crosses 8
    assert got.wait(2)
    energy._warn_thread.join(2)
    assert sent == [("Energy: 80% of today's global budget used (10 of 10 ⚡)", "")]
    # Nothing else fits today, so the budget stays past the line; the next
    # charge tomorrow starts below it again. A later charge on a bigger
    # budget does not repeat the line either.
    monkeypatch.setattr(energy, "GLOBAL_DAILY_UNITS", 20)  # line at 16; 10 -> 15 stays under
    energy.charge(_dev(), "create", False)
    energy._warn_thread.join(2)
    assert len(sent) == 1


def test_the_relay_keeps_its_suggestion_prefix_by_default(monkeypatch):
    posted = []

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False
    monkeypatch.setenv("SHADOW_DISCORD_WEBHOOK", "https://example.invalid/hook")
    monkeypatch.setattr(suggest.urllib.request, "urlopen",
                        lambda req, timeout=5: posted.append(req.data) or Resp())
    suggest._relay_to_discord("hello")
    suggest._relay_to_discord("Energy: x", prefix="")
    assert b"Feature suggestion: hello" in posted[0]
    assert b"\"content\": \"Energy: x\"" in posted[1]


# --- status ---

def test_the_owner_is_full_and_never_charged(on):
    for _ in range(5):
        energy.charge(OWNER, "import", True)
        main._take_build_slot(OWNER, "create", "import")
    st = energy.status(OWNER, True)
    assert (st["daily_left"], st["daily_max"], st["granted_left"], st["owner"]) == (7, 7, 0, True)
    assert _rows("energy_ledger", OWNER) == []


def test_a_row_dated_yesterday_does_not_count_and_refill_is_next_midnight(on):
    dev = _dev()
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(timespec="seconds")
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO energy_ledger (device, kind, units, from_grant, created_at)"
            " VALUES (?, 'create', 5, 0, ?)", (dev, yesterday))
    st = energy.status(dev, False)
    assert st["daily_left"] == 7
    assert st["prices"] == energy.PRICES and st["last_grant"] is None
    now = datetime.now(timezone.utc)
    at = datetime.fromisoformat(st["refill_at"])
    assert at.tzinfo is not None and (at.hour, at.minute, at.second) == (0, 0, 0)
    assert now < at <= now + timedelta(days=1)


def test_status_carries_the_last_grant(on):
    dev = _dev()
    energy.grant(OWNER, dev, "cat", 30, "first")
    gid = store.energy_add_grant(dev, "cat", 60, "second", OWNER)
    last = energy.status(dev, False)["last_grant"]
    assert last["id"] == gid and last["amount"] == 60
    assert last["at"][:10] == datetime.now(timezone.utc).isoformat()[:10]
    assert energy.status(dev, False)["granted_left"] == 90


# --- routes ---

def test_grant_by_a_non_owner_is_403_unknown_handle_404_bad_amount_400(on):
    dev, name = _dev(), _name()
    user_profile.set_username(dev, name)
    with pytest.raises(HTTPException) as exc_info:
        _grant(_dev(), name, 30)
    assert (exc_info.value.status_code, exc_info.value.detail) == (403, {"code": "not_owner"})
    with pytest.raises(HTTPException) as exc_info:
        _get(_dev(), name)
    assert exc_info.value.status_code == 403
    with pytest.raises(HTTPException) as exc_info:
        _grant(OWNER, _name(), 30)
    assert (exc_info.value.status_code, exc_info.value.detail) == (404, {"code": "profile_not_found"})
    for bad in (0, 1001, -5):
        with pytest.raises(HTTPException) as exc_info:
            _grant(OWNER, name, bad)
        assert (exc_info.value.status_code, exc_info.value.detail) == (400, {"code": "bad_amount"})
    assert _rows("energy_grants", dev) == []


def test_the_owner_grants_by_handle_and_reads_the_target(on):
    dev, name = _dev(), _name()
    user_profile.set_username(dev, name.upper())
    energy.charge(dev, "create", False)
    out = _grant(OWNER, name, 60, "welcome")
    assert (out["daily_left"], out["granted_left"], out["owner"]) == (2, 60, False)
    row = _rows("energy_grants", dev)[0]
    assert (row["target_username"], row["amount"], row["note"], row["granted_by"]) == (
        name, 60, "welcome", OWNER)
    assert _get(OWNER, name.upper())["granted_left"] == 60
    assert _get(dev)["granted_left"] == 60
    assert _get(OWNER)["daily_left"] == 7 and _get(OWNER)["owner"] is True


def test_get_progress_carries_energy_only_when_on(on, monkeypatch):
    dev = _dev()
    assert _progress(dev)["energy"]["daily_left"] == 7
    monkeypatch.setattr(energy, "ON", False)
    assert "energy" not in _progress(dev)


def test_delete_owner_rows_drops_grants_and_anonymises_the_ledger(on):
    """The ledger rows stay, without the device, so today's global total
    (and so the stop and the 80% line) does not drop on a delete."""
    dev, other = _dev(), _dev()
    energy.grant(OWNER, dev, "cat", 10)
    energy.charge(dev, "create", False)
    energy.grant(OWNER, other, "dog", 10)
    store.delete_owner_rows(dev)
    assert _rows("energy_ledger", dev) == [] and _rows("energy_grants", dev) == []
    assert len(_rows("energy_grants", other)) == 1
    assert [r["units"] for r in _rows("energy_ledger", store.ENERGY_DELETED_DEVICE)] == [5]
    assert store.energy_global_today() == 5


def test_grant_note_is_stripped_and_capped(on):
    dev, name = _dev(), _name()
    user_profile.set_username(dev, name)
    _grant(OWNER, name, 5, "  " + "n" * 300 + "  ")
    assert _rows("energy_grants", dev)[0]["note"] == "n" * 200


# --- refunds and races ---

def test_a_refund_nets_out_the_daily_grant_and_global_totals(on):
    dev = _dev()
    energy.grant(OWNER, dev, "cat", 10)
    energy.charge(dev, "create", False)  # 5 of 7 daily
    energy.charge(dev, "create", False)  # 2 daily + 3 grant
    energy.refund(dev, "create", False)
    rows = _rows("energy_ledger", dev)
    assert [(r["kind"], r["units"], r["from_grant"]) for r in rows][-1] == ("create", -5, -3)
    st = energy.status(dev, False)
    assert (st["daily_left"], st["granted_left"]) == (2, 10)
    assert store.energy_global_today() == 5


def test_refund_is_a_no_op_for_the_owner_flag_off_or_with_no_charge(on, monkeypatch):
    dev = _dev()
    energy.refund(dev, "explain", False)  # nothing charged yet
    energy.refund(OWNER, "explain", True)
    monkeypatch.setattr(energy, "ON", False)
    energy.refund(dev, "explain", False)
    assert _rows("energy_ledger", dev) == [] and _rows("energy_ledger", OWNER) == []


def test_two_threads_cannot_both_spend_the_last_unit(on, monkeypatch):
    monkeypatch.setattr(energy, "DAILY_UNITS", 1)
    dev = _dev()
    gate = threading.Barrier(2)
    results: list[str] = []

    def spend():
        gate.wait()
        try:
            energy.charge(dev, "word", False)
            results.append("ok")
        except HTTPException as exc:
            results.append(exc.detail["code"])
    threads = [threading.Thread(target=spend) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert sorted(results) == ["no_energy", "ok"]
    assert [r["units"] for r in _rows("energy_ledger", dev)] == [1]


def _explain_word(dev, word="猫"):
    return asyncio.run(main.explain_word(
        word=word, sentence_ja=f"{word}がいる。", authorization=AUTH, x_shadow_device=dev))


def _explain_chat(dev, question="why?"):
    body = main.ExplainChatBody(sentence_ja="猫がいる。", question=question)
    return asyncio.run(main.explain_chat(body, authorization=AUTH, x_shadow_device=dev))


def test_a_failed_explain_word_leaves_the_balance_unchanged(on, monkeypatch):
    dev = _dev()
    monkeypatch.setattr(main.explain, "word_context", lambda *a, **k: "")
    for _ in range(3):
        assert _explain_word(dev) == {"context": ""}
    assert energy.status(dev, False)["daily_left"] == 7
    assert store.count_builds_today(dev, "explain_word") == 0
    assert store.energy_global_today() == 0


def test_a_good_explain_word_charges_once(on, monkeypatch):
    dev = _dev()
    monkeypatch.setattr(main.explain, "word_context", lambda *a, **k: "subject")
    assert _explain_word(dev) == {"context": "subject"}
    assert _explain_word(dev) == {"context": "subject"}  # cache hit, free
    assert [r["units"] for r in _rows("energy_ledger", dev)] == [energy.PRICES["word"]]
    assert store.count_builds_today(dev, "explain_word") == 1


def test_a_failed_explain_chat_leaves_the_balance_unchanged(on, monkeypatch):
    dev = _dev()
    monkeypatch.setattr(main.explain, "chat_answer", lambda *a, **k: "")
    for _ in range(3):
        assert _explain_chat(dev) == {}
    assert energy.status(dev, False)["daily_left"] == 7
    assert store.count_builds_today(dev, "explain") == 0
    assert store.energy_global_today() == 0


def test_a_good_explain_chat_charges_once(on, monkeypatch):
    dev = _dev()
    monkeypatch.setattr(main.explain, "chat_answer", lambda *a, **k: '{"summary": "a cat"}')
    assert _explain_chat(dev) == {"summary": "a cat"}
    assert _explain_chat(dev) == {"summary": "a cat"}  # cache hit, free
    assert [r["units"] for r in _rows("energy_ledger", dev)] == [energy.PRICES["explain"]]
    assert store.count_builds_today(dev, "explain") == 1


def test_the_warning_fires_once_a_day_even_after_a_refund_dips_under(on, monkeypatch):
    monkeypatch.setattr(energy, "GLOBAL_DAILY_UNITS", 10)  # line at 8
    sent = []
    monkeypatch.setattr(energy, "_relay_warning", sent.append)
    a, b = _dev(), _dev()
    energy.charge(a, "create", False)
    energy.charge(b, "create", False)  # 10, crosses 8
    energy._warn_thread.join(2)
    assert len(sent) == 1
    energy.refund(b, "create", False)  # back to 5
    energy._warn_thread = None
    energy.charge(_dev(), "create", False)  # 10 again
    assert energy._warn_thread is None and len(sent) == 1


# --- flag off: nothing changes ---

def test_flag_off_charge_writes_nothing_and_the_route_says_off(monkeypatch):
    assert energy.ON is False
    dev = _dev()
    energy.charge(dev, "import", False)
    for _ in range(3):
        energy.charge(dev, "create", False)  # would be no_energy with the flag on
    assert _rows("energy_ledger", dev) == []
    assert _get(dev) == {"on": False}
    monkeypatch.setattr(main, "OWNER_DEVICE", OWNER)
    name = _name()
    user_profile.set_username(dev, name)
    assert _get(OWNER, name) == {"on": False}
    assert _grant(OWNER, name, 30) == {"on": False}
    assert _rows("energy_grants", dev) == []
    with pytest.raises(HTTPException) as exc_info:
        _grant(_dev(), name, 30)
    assert exc_info.value.status_code == 403


def test_flag_off_the_slot_helpers_and_progress_behave_as_before(monkeypatch):
    """With the flag off a charged slot call is byte-identical to an
    uncharged one: the same builds row, no other table touched, the same
    429 at the cap, and progress has no energy key."""
    assert energy.ON is False
    monkeypatch.setattr(main, "DAILY_CREATES", 1)
    dev = _dev()
    before = _counts()
    main._take_build_slot(dev, "create", "import")
    main._take_use_slot(dev, "explain", "explain")
    after = _counts()
    assert after == {**before, "builds": before["builds"] + 2}
    assert [r["kind"] for r in _rows("builds", dev)] == ["create", "explain"]
    with pytest.raises(HTTPException) as exc_info:
        main._take_build_slot(dev, "create", "import")
    assert exc_info.value.detail == {"code": "daily_limit", "limit": 1, "kind": "create"}
    assert _counts() == after
    snap = _progress(dev)
    assert "energy" not in snap
    assert set(snap) == set(_progress(_dev()))
