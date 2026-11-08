"""tts_render: a hosted voice that is over budget, failing or disabled
renders with the language's free voice and says so; a failing local default
raises."""

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


def test_over_monthly_budget_falls_back(monkeypatch):
    hosted = tts_fakes.hosted(monkeypatch)
    local = tts_fakes.local_default(monkeypatch)
    monkeypatch.setenv("SHADOW_TTS_MONTHLY_CHARS_FAKEHOSTED", "3")
    out = asyncio.run(tts_render.render("Bonjour", 22001, "dev-1"))
    assert (out.voice, out.fallback) == (10021, "budget")
    assert hosted.calls == [] and len(local.calls) == 1
    assert tts_budget.spent("fakehosted") == (0, 0)


def test_over_user_cap_falls_back_but_previews_do_not_count(monkeypatch):
    hosted = tts_fakes.hosted(monkeypatch)
    tts_fakes.local_default(monkeypatch)
    monkeypatch.setitem(dependencies.DAILY_CAPS, "hosted_tts", 1)
    first = asyncio.run(tts_render.render("Un", 22001, "dev-1"))
    second = asyncio.run(tts_render.render("Deux", 22001, "dev-1"))
    preview = asyncio.run(tts_render.render("Trois", 22001))
    assert (first.voice, first.fallback) == (22001, "")
    assert (second.voice, second.fallback) == (10021, "budget")
    assert (preview.voice, preview.fallback) == (22001, "")
    assert [c[0] for c in hosted.calls] == ["Un", "Trois"]


def test_provider_error_falls_back_and_records_nothing(monkeypatch):
    tts_fakes.hosted(monkeypatch, fail=True)
    tts_fakes.local_default(monkeypatch)
    out = asyncio.run(tts_render.render("Bonjour", 22001, "dev-1"))
    assert (out.voice, out.fallback) == (10021, "error")
    assert tts_budget.spent("fakehosted") == (0, 0)


def test_slow_provider_falls_back(monkeypatch):
    hosted = tts_fakes.hosted(monkeypatch)
    tts_fakes.local_default(monkeypatch)
    monkeypatch.setattr(tts_render, "HOSTED_TIMEOUT_S", 0.01)

    async def slow(text, voice, speed=1.0):
        await asyncio.sleep(0.2)
        raise AssertionError("not reached")

    hosted.render = slow
    out = asyncio.run(tts_render.render("Bonjour", 22001))
    assert (out.voice, out.fallback) == (10021, "error")


def test_disabled_provider_falls_back(monkeypatch):
    tts_fakes.hosted(monkeypatch, on=False)
    tts_fakes.local_default(monkeypatch)
    out = asyncio.run(tts_render.render("Bonjour", 22001))
    assert (out.voice, out.fallback) == (10021, "disabled")


def test_success_records_spend_and_keeps_the_voice(monkeypatch):
    tts_fakes.hosted(monkeypatch)
    out = asyncio.run(tts_render.render("Bonjour", 22001, "dev-1"))
    assert (out.voice, out.fallback) == (22001, "")
    assert tts_budget.spent("fakehosted") == (7, 1)


def test_a_failing_local_default_raises(monkeypatch):
    tts_fakes.hosted(monkeypatch, fail=True)
    tts_fakes.local_default(monkeypatch, fail=True)
    with pytest.raises(RuntimeError, match="kokoro is down"):
        asyncio.run(tts_render.render("Bonjour", 22001))


def test_unknown_voice_raises():
    with pytest.raises(ValueError):
        asyncio.run(tts_render.render("Bonjour", 99999))


def _slow(hosted):
    orig = hosted.render

    async def slow(text, voice, speed=1.0):
        await asyncio.sleep(0.05)
        return await orig(text, voice, speed)

    hosted.render = slow


def test_concurrent_renders_respect_the_monthly_cap(monkeypatch):
    hosted = tts_fakes.hosted(monkeypatch)
    tts_fakes.local_default(monkeypatch)
    _slow(hosted)
    monkeypatch.setenv("SHADOW_TTS_MONTHLY_CHARS_FAKEHOSTED", "10")

    async def run():
        return await asyncio.gather(*(tts_render.render(f"Mot {i}", 22001) for i in range(5)))

    outs = asyncio.run(run())
    assert len(hosted.calls) == 2  # "Mot 0" is 5 chars, so two fit in 10
    assert sorted(o.fallback for o in outs) == ["", "", "budget", "budget", "budget"]
    assert tts_budget.spent("fakehosted") == (10, 2)


def test_identical_concurrent_renders_share_one_call(monkeypatch):
    hosted = tts_fakes.hosted(monkeypatch)
    _slow(hosted)

    async def run():
        return await asyncio.gather(*(tts_render.render("Bonjour", 22001) for _ in range(5)))

    outs = asyncio.run(run())
    assert len(hosted.calls) == 1
    assert all(o.voice == 22001 and o.fallback == "" for o in outs)
    assert tts_budget.spent("fakehosted") == (7, 1)


def test_failed_hosted_call_refunds_its_reservation(monkeypatch):
    tts_fakes.hosted(monkeypatch, fail=True)
    tts_fakes.local_default(monkeypatch)
    asyncio.run(tts_render.render("Bonjour", 22001))
    assert tts_budget.spent("fakehosted") == (0, 0)


def test_ai_jobs_kill_switch_falls_back(monkeypatch):
    hosted = tts_fakes.hosted(monkeypatch)
    tts_fakes.local_default(monkeypatch)
    monkeypatch.setenv("SHADOW_KILL", "ai")
    out = asyncio.run(tts_render.render("Bonjour", 22001))
    assert (out.voice, out.fallback) == (10021, "ai_paused")
    assert hosted.calls == []
