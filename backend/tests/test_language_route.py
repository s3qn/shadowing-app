"""Tests for the es/en/native plumbing in main.py and store.py: the
create_island language/voice guard, _build_island's non-ja path through
latin.align, regenerate carrying learning/native forward, and the native
column migration and read path.

No VOICEVOX, whisper, Kokoro or claude CLI: transcribe.transcribe,
generate.generate_lines and voices.speak are all monkeypatched.
"""

import asyncio
import sqlite3
from pathlib import Path

import pytest
from fastapi import BackgroundTasks, HTTPException

import main
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
# device-scope: every island route needs a device id.
DEV = "cccccccc-0000-4000-8000-000000000003"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


class _FakeUpload:
    def __init__(self, data: bytes = b"fake audio"):
        self._data = data
        self.filename = "rec.wav"

    async def read(self) -> bytes:
        return self._data


# ---------------------------------------------------------------------------
# create_island: the voice must speak the chosen language
# ---------------------------------------------------------------------------

def test_create_island_rejects_a_kokoro_voice_for_japanese():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.create_island(
            background=BackgroundTasks(), audio=_FakeUpload(), complexity="simple",
            register="polite", language="ja", native="en", speaker=10001, count=8,
            authorization=AUTH, x_shadow_device=DEV,
        ))
    assert exc.value.status_code == 400


def test_create_island_rejects_a_voicevox_voice_for_spanish():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.create_island(
            background=BackgroundTasks(), audio=_FakeUpload(), complexity="simple",
            register="polite", language="es", native="en", speaker=3, count=8,
            authorization=AUTH, x_shadow_device=DEV,
        ))
    assert exc.value.status_code == 400


# ---------------------------------------------------------------------------
# _build_island for es/he: latin.align words, empty timeline, native kept
# ---------------------------------------------------------------------------

def _fake_transcribe(audio_path, language=None, word_timestamps=False, vad=False):
    if word_timestamps:
        return {
            "ok": True, "text": "", "language": "", "segments": [],
            "words": [
                {"text": "Hola", "start": 0.0, "end": 0.4},
                {"text": "mundo", "start": 0.4, "end": 0.8},
            ],
        }
    return {"ok": True, "text": "un audio en espanol", "language": "es", "segments": [], "words": []}


async def _fake_speak(text, speaker, speed=1.0):
    return b"RIFF....WAVEfmt ", [], 0.8, ""


def test_build_island_for_es_and_he_stores_latin_aligned_words(monkeypatch, tmp_path):
    monkeypatch.setattr(main.transcribe, "transcribe", _fake_transcribe)
    monkeypatch.setattr(
        main.generate, "generate_lines",
        lambda *a, **k: {
            "title": "Titulo",
            "lines": [{"ja": "Hola mundo", "kana": "", "romaji": "", "en": "Hello world"}],
        },
    )
    monkeypatch.setattr(main.voices, "speak", _fake_speak)

    island_id = store.create_island("simple", 10011, register="polite", language="es", native="he")
    wav = tmp_path / "source.wav"

    asyncio.run(main._build_island(
        island_id, wav, "simple", 10011, 8, "polite", learning="es", native="he",
    ))

    island = store.get_island(island_id)
    assert island["status"] == "ready"
    assert island["native"] == "he"
    line = island["lines"][0]
    assert line["timeline"] == []
    assert [w["text"] for w in line["words"]] == ["Hola", "mundo"]
    assert line["words"][0]["start"] == 0.0
    assert line["words"][-1]["end"] == 0.8


def test_build_island_marks_failed_when_generation_returns_no_lines(monkeypatch, tmp_path):
    monkeypatch.setattr(main.transcribe, "transcribe", _fake_transcribe)
    monkeypatch.setattr(main.generate, "generate_lines", lambda *a, **k: {"title": "", "lines": []})

    island_id = store.create_island("simple", 10011, register="polite", language="es", native="he")
    wav = tmp_path / "source.wav"

    asyncio.run(main._build_island(
        island_id, wav, "simple", 10011, 8, "polite", learning="es", native="he",
    ))

    island = store.get_island(island_id)
    assert island["status"] == "failed"
    assert island["error"] == "No lines could be generated."
    assert island["error_code"] == "no_lines"


# ---------------------------------------------------------------------------
# regenerate carries learning/native forward
# ---------------------------------------------------------------------------

def test_regenerate_passes_learning_and_native(monkeypatch, tmp_path):
    island_id = store.create_island("simple", 10011, register="polite", language="es", native="he", device=DEV)
    wav = store.AUDIO_DIR / island_id / "source.wav"
    wav.write_bytes(b"fake wav")

    captured = {}

    async def fake_build_island(island_id, wav_path, complexity, speaker, count, register,
                                 learning, native):
        captured["learning"] = learning
        captured["native"] = native

    monkeypatch.setattr(main, "_build_island", fake_build_island)

    background = BackgroundTasks()
    asyncio.run(main.regenerate(
        island_id, background, complexity="complex", count=8, authorization=AUTH, x_shadow_device=DEV,
    ))
    assert len(background.tasks) == 1
    asyncio.run(background.tasks[0]())

    assert captured["learning"] == "es"
    assert captured["native"] == "he"


# ---------------------------------------------------------------------------
# store: native column migration and read path
# ---------------------------------------------------------------------------

def test_store_init_migrates_islands_missing_native_column(tmp_path, monkeypatch):
    db_path = tmp_path / "old.db"
    raw = sqlite3.connect(db_path)
    raw.execute(
        "CREATE TABLE islands ("
        " id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',"
        " status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '',"
        " error TEXT NOT NULL DEFAULT '', complexity TEXT NOT NULL DEFAULT 'simple',"
        " register TEXT NOT NULL DEFAULT 'polite', language TEXT NOT NULL DEFAULT 'ja',"
        " source TEXT NOT NULL DEFAULT 'voice', source_name TEXT NOT NULL DEFAULT '',"
        " speaker INTEGER NOT NULL DEFAULT 3,"
        " transcript TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)"
    )
    raw.execute(
        "CREATE TABLE lines ("
        " island_id TEXT NOT NULL, idx INTEGER NOT NULL, ja TEXT NOT NULL,"
        " kana TEXT NOT NULL DEFAULT '', romaji TEXT NOT NULL DEFAULT '',"
        " en TEXT NOT NULL DEFAULT '', duration REAL NOT NULL DEFAULT 0,"
        " timeline TEXT NOT NULL DEFAULT '[]', words TEXT NOT NULL DEFAULT '[]',"
        " offset REAL NOT NULL DEFAULT 0,"
        " PRIMARY KEY (island_id, idx))"
    )
    raw.execute(
        "INSERT INTO islands (id, status, created_at) VALUES ('old-island', 'ready', 'now')"
    )
    raw.commit()
    raw.close()

    monkeypatch.setattr(store, "DB_PATH", db_path)
    if hasattr(store._local, "conn"):
        del store._local.conn

    try:
        store.init()
        store.init()  # a second run (a real restart) must not raise on the column

        island = store.get_island("old-island")
        assert island["native"] == "en"
    finally:
        if hasattr(store._local, "conn"):
            del store._local.conn


def test_list_islands_returns_native():
    store.create_island("simple", 10011, register="polite", language="es", native="he")
    rows = store.list_islands()
    assert any(r["native"] == "he" for r in rows)


# ---------------------------------------------------------------------------
# revoice: the new voice must speak the island's language
# ---------------------------------------------------------------------------

def _ready_island(language: str, speaker: int) -> str:
    island_id = store.create_island("simple", speaker, register="polite", language=language, device=DEV)
    store.add_line(island_id, 0, {"ja": "Hola", "kana": "", "romaji": "", "en": "Hello"}, 0.5, [])
    store.set_ready(island_id, "Hola")
    return island_id


def test_revoice_rejects_a_voicevox_voice_for_a_spanish_island():
    island_id = _ready_island("es", 10011)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.revoice(island_id, BackgroundTasks(), speaker=3, authorization=AUTH, x_shadow_device=DEV))
    assert exc.value.status_code == 400
    assert store.get_island(island_id)["speaker"] == 10011


def test_revoice_rejects_a_kokoro_voice_for_a_japanese_island():
    island_id = _ready_island("ja", 3)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.revoice(island_id, BackgroundTasks(), speaker=10001, authorization=AUTH, x_shadow_device=DEV))
    assert exc.value.status_code == 400
    assert store.get_island(island_id)["speaker"] == 3


def test_revoice_accepts_another_voice_in_the_same_language():
    island_id = _ready_island("es", 10011)
    background = BackgroundTasks()
    result = asyncio.run(main.revoice(island_id, background, speaker=10012, authorization=AUTH, x_shadow_device=DEV))
    assert result["speaker"] == 10012
    assert len(background.tasks) == 1


# ---------------------------------------------------------------------------
# learning and native must differ
# ---------------------------------------------------------------------------

def test_create_island_rejects_learning_english_with_native_english():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.create_island(
            background=BackgroundTasks(), audio=_FakeUpload(), complexity="simple",
            register="polite", language="en", native="en", speaker=10001, count=8,
            authorization=AUTH, x_shadow_device=DEV,
        ))
    assert exc.value.status_code == 400


def test_import_rejects_learning_english_with_native_english():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.create_import_island(
            background=BackgroundTasks(), audio=_FakeUpload(), subtitles=None, title="",
            speaker=10001, language="en", native="en", start_min=0, authorization=AUTH, x_shadow_device=DEV,
        ))
    assert exc.value.status_code == 400


def test_podcast_import_rejects_learning_english_with_native_english():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.import_podcast_episode(
            background=BackgroundTasks(), audio_url="https://example.com/a.mp3", title="",
            start_min=0, speaker=10001, language="en", native="en", authorization=AUTH, x_shadow_device=DEV,
        ))
    assert exc.value.status_code == 400


def test_import_rejects_a_voicevox_voice_for_spanish():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.create_import_island(
            background=BackgroundTasks(), audio=_FakeUpload(), subtitles=None, title="",
            speaker=3, language="es", native="en", start_min=0, authorization=AUTH, x_shadow_device=DEV,
        ))
    assert exc.value.status_code == 400
    assert "voice" in exc.value.detail


def test_podcast_import_rejects_a_kokoro_voice_for_japanese():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.import_podcast_episode(
            background=BackgroundTasks(), audio_url="https://example.com/a.mp3", title="",
            start_min=0, speaker=10001, language="ja", native="en", authorization=AUTH, x_shadow_device=DEV,
        ))
    assert exc.value.status_code == 400
    assert "voice" in exc.value.detail


# ---------------------------------------------------------------------------
# Kokoro warm-up at startup
# ---------------------------------------------------------------------------

def test_kokoro_warm_up_follows_the_env_flag(monkeypatch):
    monkeypatch.setenv("SHADOW_KOKORO_WARMUP", "1")
    assert main._kokoro_warm_up_wanted() is True
    monkeypatch.setenv("SHADOW_KOKORO_WARMUP", "0")
    assert main._kokoro_warm_up_wanted() is False


def test_kokoro_warm_up_unset_depends_on_a_non_japanese_island(monkeypatch):
    monkeypatch.delenv("SHADOW_KOKORO_WARMUP", raising=False)
    monkeypatch.setattr(main.store, "list_islands", lambda: [{"language": "ja"}])
    assert main._kokoro_warm_up_wanted() is False
    monkeypatch.setattr(main.store, "list_islands", lambda: [{"language": "ja"}, {"language": "es"}])
    assert main._kokoro_warm_up_wanted() is True


# ---------------------------------------------------------------------------
# explain caches: an English answer keeps its old key
# ---------------------------------------------------------------------------

def test_explain_word_english_answer_hits_the_key_from_before_languages(monkeypatch):
    store.set_word_context("languages-word", "languages-route-sentence。", "cached gloss")
    monkeypatch.setattr(main.explain, "word_context", lambda *a, **k: "fresh gloss")

    en = asyncio.run(main.explain_word(
        word="languages-word", sentence_ja="languages-route-sentence。", authorization=AUTH,
    ))
    he = asyncio.run(main.explain_word(
        word="languages-word", sentence_ja="languages-route-sentence。", native="he", authorization=AUTH,
    ))
    assert en == {"context": "cached gloss"}
    assert he == {"context": "fresh gloss"}
    assert store.get_word_context("languages-word", "he:languages-route-sentence。") == "fresh gloss"
