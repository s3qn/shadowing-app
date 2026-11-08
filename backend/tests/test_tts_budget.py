"""tts_budget: the monthly caps per provider in the throwaway sqlite, the
per-user daily slot, and the dev switch modes."""

import asyncio

import pytest

import dependencies
import store
import tts_budget
import tts_render
import tts_fakes


@pytest.fixture(autouse=True)
def db():
    store.init()
    with store.connect() as conn:
        conn.execute("DELETE FROM tts_spend")
    tts_budget._warned.clear()


def test_record_upserts_and_check_stops_at_the_cap(monkeypatch):
    monkeypatch.setenv("SHADOW_TTS_MONTHLY_CHARS_FAKEHOSTED", "100")
    assert tts_budget.check("fakehosted", 60) == ""
    tts_budget.record("fakehosted", 60)
    tts_budget.record("fakehosted", 30)
    assert tts_budget.spent("fakehosted") == (90, 2)
    assert tts_budget.check("fakehosted", 10) == ""
    assert tts_budget.check("fakehosted", 11) == "budget"


def test_request_cap_counts_requests(monkeypatch):
    monkeypatch.setenv("SHADOW_TTS_MONTHLY_REQUESTS_FAKEHOSTED", "2")
    tts_budget.record("fakehosted", 5)
    assert tts_budget.check("fakehosted", 5) == ""
    tts_budget.record("fakehosted", 5)
    assert tts_budget.check("fakehosted", 5) == "budget"


def test_month_rollover_starts_a_fresh_row(monkeypatch):
    monkeypatch.setenv("SHADOW_TTS_MONTHLY_CHARS_FAKEHOSTED", "10")
    monkeypatch.setattr(tts_budget, "_month", lambda: "2001-01")
    tts_budget.record("fakehosted", 10)
    assert tts_budget.check("fakehosted", 1) == "budget"
    monkeypatch.setattr(tts_budget, "_month", lambda: "2001-02")
    assert tts_budget.check("fakehosted", 1) == ""
    assert tts_budget.spent("fakehosted", "2001-01") == (10, 1)


def test_no_cap_means_unlimited(monkeypatch):
    monkeypatch.setenv("SHADOW_TTS_MONTHLY_CHARS_FAKEHOSTED", "0")
    tts_budget.record("fakehosted", 10 ** 6)
    assert tts_budget.check("fakehosted", 10 ** 6) == ""


def test_warns_once_at_eighty_percent(monkeypatch):
    monkeypatch.setenv("SHADOW_TTS_MONTHLY_CHARS_FAKEHOSTED", "100")
    relayed = []
    monkeypatch.setattr(tts_budget.suggest, "_relay_to_discord",
                        lambda text, prefix="": relayed.append(text))
    tts_budget.record("fakehosted", 70)
    assert relayed == []
    tts_budget.record("fakehosted", 15)
    tts_budget.record("fakehosted", 5)
    import time

    time.sleep(0.05)
    assert len(relayed) == 1 and "fakehosted" in relayed[0]


def test_user_slot_honours_the_daily_cap_and_exempts_the_owner(monkeypatch):
    monkeypatch.setitem(dependencies.DAILY_CAPS, "hosted_tts", 2)
    assert tts_budget.take_user_slot("dev-a") is True
    assert tts_budget.take_user_slot("dev-a") is True
    assert tts_budget.take_user_slot("dev-a") is False
    assert tts_budget.take_user_slot("dev-b") is True
    monkeypatch.setattr(dependencies, "OWNER_DEVICE", "sean")
    for _ in range(5):
        assert tts_budget.take_user_slot("sean") is True


def test_dev_force_modes(monkeypatch):
    hosted = tts_fakes.hosted(monkeypatch)
    local = tts_fakes.local_default(monkeypatch)
    monkeypatch.setattr(tts_budget, "DEV_FORCE", "budget_out")
    assert tts_budget.check("fakehosted", 1) == "budget"
    out = asyncio.run(tts_render.render("a", 22001))
    assert (out.voice, out.fallback) == (10021, "budget")
    monkeypatch.setattr(tts_budget, "DEV_FORCE", "provider_down")
    out = asyncio.run(tts_render.render("b", 22001))
    assert (out.voice, out.fallback) == (10021, "error")
    monkeypatch.setattr(tts_budget, "DEV_FORCE", "hosted_off")
    out = asyncio.run(tts_render.render("c", 22001))
    assert (out.voice, out.fallback) == (10021, "disabled")
    assert hosted.calls == []
    assert [c[0] for c in local.calls] == ["a", "b", "c"]
    assert tts_budget.spent("fakehosted") == (0, 0)
