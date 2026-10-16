"""main._synthesize_lines: phoneme timings first, whisper only as fallback."""

import asyncio

import pytest

import main
import store

LINE = {"ja": "Hola mundo", "kana": "", "romaji": "", "en": "Hello world"}
TIMINGS = [
    {"phoneme": "o", "start": 0.1, "end": 0.4},
    {"phoneme": " ", "start": 0.4, "end": 0.5},
    {"phoneme": "u", "start": 0.5, "end": 0.9},
]


@pytest.fixture
def island(monkeypatch):
    store.init()
    calls = {"whisper": 0, "latin": 0}

    def fake_transcribe(*a, **k):
        calls["whisper"] += 1
        return {"ok": True, "words": []}

    def fake_align(text, pieces, duration):
        calls["latin"] += 1
        return [{"text": "whisper", "start": 0.0, "end": duration, "pos": "other", "ruby": []}]

    monkeypatch.setattr(main.transcribe, "transcribe", fake_transcribe)
    monkeypatch.setattr(main.latin, "align", fake_align)
    return calls


def _run(language, speaker, timings, monkeypatch, timeline=None):
    async def fake_timed(text, spk):
        return b"RIFF", timeline or [], 1.0, "", timings

    monkeypatch.setattr(main.voices, "speak_timed", fake_timed)
    island_id = store.create_island("simple", speaker, register="polite", language=language)
    (store.AUDIO_DIR / island_id).mkdir(parents=True, exist_ok=True)
    done = asyncio.run(main._synthesize_lines(island_id, [LINE], speaker, language))
    assert done == 1
    return store.get_island(island_id)["lines"][0]


def test_phoneme_timings_skip_whisper(island, monkeypatch):
    line = _run("es", 10011, TIMINGS, monkeypatch)
    assert island == {"whisper": 0, "latin": 0}
    assert [(w["text"], w["start"], w["end"]) for w in line["words"]] == [
        ("Hola", 0.1, 0.5), ("mundo", 0.5, 0.9),
    ]


def test_no_timings_falls_back_to_whisper(island, monkeypatch):
    line = _run("es", 10011, [], monkeypatch)
    assert island == {"whisper": 1, "latin": 1}
    assert line["words"][0]["text"] == "whisper"


def test_ja_line_is_unchanged(island, monkeypatch):
    monkeypatch.setattr(main.segment, "align", lambda text, tl: [{"text": "ja-word"}])
    line = _run("ja", 3, [], monkeypatch)
    assert island == {"whisper": 0, "latin": 0}
    assert line["words"] == [{"text": "ja-word"}]
