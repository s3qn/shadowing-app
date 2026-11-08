"""build._synthesize_lines: timing follows what the voice gives back
(mora, pieces, phonemes, else whisper) and a hosted fallback re-stamps the
island's speaker."""

import asyncio

import pytest

import main
import store
import tts_fakes
import tts_registry
from services import build
from tts_registry import Render

LINE = {"ja": "Hola mundo", "kana": "", "romaji": "", "en": "Hello world"}
TIMINGS = [
    {"phoneme": "o", "start": 0.1, "end": 0.4},
    {"phoneme": " ", "start": 0.4, "end": 0.5},
    {"phoneme": "u", "start": 0.5, "end": 0.9},
]
PIECES = [{"text": "Hola", "start": 0.1, "end": 0.5}, {"text": "mundo", "start": 0.5, "end": 0.9}]


@pytest.fixture
def island(monkeypatch):
    store.init()
    calls = {"whisper": 0, "latin": 0, "latin_pieces": [], "latin_codes": []}

    def fake_transcribe(*a, **k):
        calls["whisper"] += 1
        return {"ok": True, "words": []}

    def fake_align(text, pieces, duration, code="en"):
        calls["latin"] += 1
        calls["latin_codes"].append(code)
        calls["latin_pieces"].append(pieces)
        return [{"text": "whisper", "start": 0.0, "end": duration, "pos": "other", "ruby": []}]

    monkeypatch.setattr(main.transcribe, "transcribe", fake_transcribe)
    monkeypatch.setattr(main.latin, "align", fake_align)
    return calls


def _run(language, speaker, monkeypatch, render: Render, requested=None):
    async def fake_render(text, spk, device="", speed=1.0):
        assert spk == speaker
        return render

    monkeypatch.setattr(build.voices, "render", fake_render)
    island_id = store.create_island("simple", requested or speaker, register="polite", language=language)
    (store.AUDIO_DIR / island_id).mkdir(parents=True, exist_ok=True)
    done = asyncio.run(build._synthesize_lines(island_id, [LINE], requested or speaker, language))
    assert done == 1
    return store.get_island(island_id)


def test_phoneme_timings_skip_whisper(island, monkeypatch):
    out = _run("es", 10011, monkeypatch, Render(b"RIFF", 1.0, phonemes=TIMINGS, voice=10011))
    assert island["whisper"] == 0 and island["latin"] == 0
    assert [(w["text"], w["start"], w["end"]) for w in out["lines"][0]["words"]] == [
        ("Hola", 0.1, 0.5), ("mundo", 0.5, 0.9),
    ]


def test_no_timings_falls_back_to_whisper(island, monkeypatch):
    out = _run("es", 10011, monkeypatch, Render(b"RIFF", 1.0, voice=10011))
    assert island["whisper"] == 1 and island["latin"] == 1
    assert island["latin_codes"] == ["es"]
    assert out["lines"][0]["words"][0]["text"] == "whisper"


def test_ja_line_is_unchanged(island, monkeypatch):
    monkeypatch.setattr(main.segment, "align", lambda text, tl: [{"text": "ja-word"}])
    out = _run("ja", 3, monkeypatch, Render(b"RIFF", 1.0, voice=3))
    assert island["whisper"] == 0 and island["latin"] == 0
    assert out["lines"][0]["words"] == [{"text": "ja-word"}]


def test_pieces_go_to_latin_align_not_whisper(island, monkeypatch):
    tts_fakes.hosted(monkeypatch)
    out = _run("fr", 22001, monkeypatch, Render(b"RIFF", 1.0, pieces=PIECES, voice=22001))
    assert island["whisper"] == 0 and island["latin"] == 1
    assert island["latin_pieces"] == [PIECES]
    assert out["speaker"] == 22001


def test_fallback_sets_the_island_speaker(island, monkeypatch):
    tts_fakes.hosted(monkeypatch)
    out = _run("fr", 22001, monkeypatch, Render(b"RIFF", 1.0, voice=10021, fallback="budget"))
    assert out["speaker"] == 10021
    assert island["whisper"] == 1


def test_unregistered_voice_builds_in_the_free_voice(island, monkeypatch):
    """A saved hosted id whose provider is gone (its key removed)."""
    out = _run("fr", 10021, monkeypatch, Render(b"RIFF", 1.0, voice=10021), requested=29999)
    assert out["speaker"] == 10021


def test_hosted_japanese_uses_whisper_words_and_the_ja_aligner(island, monkeypatch):
    tts_fakes.hosted(monkeypatch)
    seen = {}

    def fake_pieces(text, pieces, duration, speech_end=None):
        seen["pieces"] = pieces
        return [{"text": "ja-pieces"}]

    monkeypatch.setattr(main.transcribe, "transcribe",
                        lambda *a, **k: {"ok": True, "words": [{"text": "x", "start": 0.0, "end": 0.5}]})
    monkeypatch.setattr(main.segment, "align_pieces", fake_pieces)
    monkeypatch.setattr(main.segment, "reading", lambda text: "かな")
    monkeypatch.setattr(tts_registry, "voice", lambda v: tts_registry.Voice(
        22001, "fakehosted", "ja", "Sarah", "female", "s", timing="none", hosted=True))
    out = _run("ja", 22001, monkeypatch, Render(b"RIFF", 1.0, voice=22001))
    assert island["latin"] == 0
    assert seen["pieces"] and out["lines"][0]["words"] == [{"text": "ja-pieces"}]
    assert out["lines"][0]["kana"] == "かな"


def test_provider_error_sends_the_rest_to_the_free_voice(island, monkeypatch):
    calls = []

    async def fake_render(text, spk, device="", speed=1.0):
        calls.append(spk)
        if spk == 22001:
            return Render(b"RIFF", 1.0, voice=10011, fallback="error")
        return Render(b"RIFF", 1.0, voice=spk)

    tts_fakes.hosted(monkeypatch)
    monkeypatch.setattr(build.voices, "render", fake_render)
    island_id = store.create_island("simple", 22001, register="polite", language="es")
    (store.AUDIO_DIR / island_id).mkdir(parents=True, exist_ok=True)
    asyncio.run(build._synthesize_lines(island_id, [LINE, LINE, LINE], 22001, "es"))
    assert calls == [22001, 10011, 10011]
    assert store.get_island(island_id)["speaker"] == 10011


def test_mixed_build_keeps_the_requested_voice(island, monkeypatch):
    n = {"i": 0}

    async def fake_render(text, spk, device="", speed=1.0):
        n["i"] += 1
        if n["i"] == 2:
            return Render(b"RIFF", 1.0, voice=10011, fallback="budget")
        return Render(b"RIFF", 1.0, voice=spk)

    tts_fakes.hosted(monkeypatch)
    monkeypatch.setattr(build.voices, "render", fake_render)
    island_id = store.create_island("simple", 22001, register="polite", language="es")
    (store.AUDIO_DIR / island_id).mkdir(parents=True, exist_ok=True)
    asyncio.run(build._synthesize_lines(island_id, [LINE, LINE, LINE], 22001, "es"))
    assert store.get_island(island_id)["speaker"] == 22001
