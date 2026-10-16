"""Voice topic islands: POST /shadow/islands with topic=1. No models or
network: whisper, the CLI, the corpus and the voices are monkeypatched."""

import asyncio
import io
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile

import main
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
JA_VOICE = 3
ES_VOICE = 10011
ROWS = [
    {"id": 111, "text": "ジムに行きます。", "en": "I go to the gym.", "username": "a"},
    {"id": 222, "text": "運動は好きです。", "en": "I like exercise.", "username": "b"},
]


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


@pytest.fixture
def pipeline(monkeypatch):
    seen = {"expand": 0, "seed": "unset", "search": None}

    async def speak(text, speaker, speed=1.0):
        return b"RIFF", [], 1.0, ""

    async def speak_timed(text, speaker):
        return b"RIFF", [], 1.0, "", []

    def to_wav(src, dst):
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(b"RIFF")
        return True

    def expand(text, learning):
        seen["expand"] += 1
        return ["gym", "workout"]

    def search(language, keywords, complexity, limit=40):
        seen["search"] = (language, keywords)
        return [] if language == "en" else list(ROWS)

    def generate_lines(text, complexity, count, language, register, learning="ja",
                       native="en", seed=None):
        seen["seed"] = seed
        tid = [r["id"] for r in seed or []]
        return {"title": "Gym", "lines": [
            {"ja": "ジムに行きます。", "kana": "", "romaji": "", "en": "gym",
             **({"tatoeba_id": tid[0]} if tid else {})},
            {"ja": "走ります。", "kana": "", "romaji": "", "en": "run",
             **({"tatoeba_id": None} if tid else {})},
        ]}

    monkeypatch.setattr(main, "_to_wav", to_wav)
    monkeypatch.setattr(main.transcribe, "transcribe",
                        lambda *a, **k: {"text": "phrases for the gym", "language": "en"})
    monkeypatch.setattr(main.generate, "expand_topic", expand)
    monkeypatch.setattr(main.corpus, "search", search)
    monkeypatch.setattr(main.generate, "generate_lines", generate_lines)
    monkeypatch.setattr(main.generate, "translate_lines", lambda *a, **k: [])
    monkeypatch.setattr(main.voices, "speak", speak)
    monkeypatch.setattr(main.voices, "speak_timed", speak_timed)
    monkeypatch.setattr(main.segment, "align", lambda *a, **k: [])
    monkeypatch.setattr(main.latin, "align", lambda *a, **k: [])
    return seen


def _post(device, topic=1, language="ja", speaker=JA_VOICE, native="en"):
    background = BackgroundTasks()
    out = asyncio.run(main.create_island(
        background, audio=UploadFile(file=io.BytesIO(b"x"), filename="r.m4a"),
        complexity="simple", register="polite", language=language, speaker=speaker,
        native=native, count=10, topic=topic,
        authorization=AUTH, x_shadow_device=device,
    ))

    async def run():
        for task in background.tasks:
            await task.func(*task.args, **task.kwargs)

    asyncio.run(run())
    return out


def _device():
    return f"dddddddd-0000-4000-8000-{uuid.uuid4().hex[:12]}"


def test_topic_island_is_a_phrases_island_with_tatoeba_ids(pipeline):
    dev = _device()
    out = _post(dev)
    island = store.get_island(out["id"])
    assert island["status"] == "ready"
    assert island["source"] == "phrases"
    assert island["source_name"] == "voice-topic"
    assert pipeline["seed"] == ROWS
    assert pipeline["search"] == ("ja", ["gym", "workout"])
    assert [ln["tatoeba_id"] for ln in island["lines"]] == [111, None]
    assert store.count_builds_today(dev, "create") == 1
    with pytest.raises(HTTPException) as err:
        asyncio.run(main.regenerate(
            out["id"], BackgroundTasks(), complexity="complex", count=8,
            authorization=AUTH, x_shadow_device=dev,
        ))
    assert err.value.status_code == 409


def test_plain_recording_is_unchanged(pipeline):
    out = _post(_device(), topic=0)
    island = store.get_island(out["id"])
    assert island["source"] == "voice"
    assert pipeline["expand"] == 0
    assert pipeline["seed"] is None
    assert island["lines"][0]["tatoeba_id"] is None


def test_english_learning_gets_empty_seed(pipeline):
    out = _post(_device(), language="en", speaker=main.voices.default_speaker("en"),
                native="he")
    assert pipeline["seed"] == []
    assert store.get_island(out["id"])["source_name"] == "voice-topic"
