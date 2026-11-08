"""tts_cache through the render door: one provider call per (text, voice),
whitespace-normalised keys, and a hit never touches the budget."""

import asyncio

import pytest

import tts_budget
import tts_cache
import tts_render
import tts_fakes


@pytest.fixture
def local(monkeypatch):
    return tts_fakes.local_default(monkeypatch)


def test_second_render_of_the_same_text_is_a_cache_hit(local):
    a = asyncio.run(tts_render.render("Bonjour", 10021))
    b = asyncio.run(tts_render.render("Bonjour", 10021))
    assert len(local.calls) == 1
    assert a.wav == b.wav and b.voice == 10021
    assert tts_cache.path_for(10021, "Bonjour").exists()


def test_another_voice_renders_again(local):
    asyncio.run(tts_render.render("Bonjour", 10021))
    asyncio.run(tts_render.render("Bonjour", 10011))
    assert [c[1] for c in local.calls] == [10021, 10011]


def test_trailing_whitespace_and_nfc_share_one_key(local):
    asyncio.run(tts_render.render("Bonjour  tout le monde", 10021))
    asyncio.run(tts_render.render("  Bonjour tout le monde \n", 10021))
    assert len(local.calls) == 1
    assert tts_cache.norm("é") == "é"


def test_a_hit_skips_the_budget(monkeypatch):
    hosted = tts_fakes.hosted(monkeypatch)
    import store

    store.init()
    asyncio.run(tts_render.render("Bonjour", 22001))
    assert tts_budget.spent("fakehosted") == (7, 1)

    def boom(*a, **k):
        raise AssertionError("budget consulted on a cache hit")

    monkeypatch.setattr(tts_budget, "check", boom)
    monkeypatch.setattr(tts_budget, "take_user_slot", boom)
    out = asyncio.run(tts_render.render("Bonjour", 22001, "device-1"))
    assert out.voice == 22001 and out.fallback == ""
    assert len(hosted.calls) == 1
    assert tts_budget.spent("fakehosted") == (7, 1)


def test_speed_variant_comes_from_the_cached_render(local, monkeypatch):
    stretched = []
    monkeypatch.setattr(tts_render.kokoro_tts, "_stretch_wav",
                        lambda wav, speed: stretched.append(speed) or tts_fakes.wav_bytes(1.25))
    asyncio.run(tts_render.render("Bonjour", 10021))
    out = asyncio.run(tts_render.render("Bonjour", 10021, speed=0.8))
    assert stretched == [0.8]
    assert out.duration == 1.25
    assert [c[2] for c in local.calls] == [1.0]
