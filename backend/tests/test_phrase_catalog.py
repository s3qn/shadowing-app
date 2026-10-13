"""Tests for the phrase catalogue and the phrase-island routes. No models or
network: voices.speak and generate.translate_lines are monkeypatched."""

import asyncio
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

import main
import phrase_catalog
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "dddddddd-0000-4000-8000-000000000004"
JA_VOICE = 3
ES_VOICE = 10011


@pytest.fixture(autouse=True)
def _init_db():
    # A fresh device per test: a repeat pick on one device returns the old island.
    global DEV
    DEV = f"dddddddd-0000-4000-8000-{uuid.uuid4().hex[:12]}"
    store.init()


async def _fake_speak(text, speaker, speed=1.0):
    return b"RIFF", [], 1.0, ""


@pytest.fixture
def fakes(monkeypatch):
    monkeypatch.setattr(main.voices, "speak", _fake_speak)
    calls = []

    def fake_translate(texts, language, native):
        calls.append((list(texts), language, native))
        return [f"he{i}" for i in range(len(texts))]

    monkeypatch.setattr(main.generate, "translate_lines", fake_translate)

    monkeypatch.setattr(main.segment, "align", lambda *a, **k: [])
    monkeypatch.setattr(main.latin, "align", lambda *a, **k: [])
    monkeypatch.setattr(main.transcribe, "transcribe", lambda *a, **k: {"ok": True, "words": []})
    return calls


def _post(topic="greetings", speaker=JA_VOICE, language="ja", native="en"):
    background = BackgroundTasks()
    out = asyncio.run(main.import_phrases(
        background, topic=topic, speaker=speaker, language=language, native=native,
        authorization=AUTH, x_shadow_device=DEV,
    ))
    for task in background.tasks:
        asyncio.run(task.func(*task.args, **task.kwargs))
    return out


@pytest.mark.parametrize("lang", ["ja", "es", "en"])
def test_catalogue_complete(lang):
    cat = phrase_catalog.catalog(lang)
    assert len(cat["topics"]) == 8
    for topic in cat["topics"]:
        entries = phrase_catalog.phrases(lang, topic["id"])
        assert topic["count"] == len(entries)
        assert all(e["text"].strip() for e in entries)
        if lang != "en":
            assert all(e.get("en", "").strip() for e in entries)


def test_unknown_language_and_he_titles():
    with pytest.raises(KeyError):
        phrase_catalog.catalog("xx")
    assert phrase_catalog.catalog("ja", "he")["topics"][0]["title"] == "ברכות"
    assert phrase_catalog.catalog("ja", "en")["topics"][0]["title"] == "Greetings"


def test_route_rejects_bad_input(fakes):
    for kwargs, code in [
        ({"language": "xx"}, 400),
        ({"language": "ja", "native": "ja"}, 400),
        ({"speaker": ES_VOICE}, 400),
        ({"topic": "nope"}, 404),
    ]:
        with pytest.raises(HTTPException) as err:
            _post(**kwargs)
        assert err.value.status_code == code


def test_good_post_builds_ready_island(fakes):
    out = _post()
    island = store.get_island(out["id"])
    assert island["source"] == "phrases"
    assert island["status"] == "ready"
    assert len(island["lines"]) == len(phrase_catalog.phrases("ja", "greetings"))
    assert island["lines"][0]["kana"]
    assert island["lines"][0]["en"]
    assert fakes == []
    assert store.count_builds_today(DEV, "create") == 1


def test_native_he_translates_and_failure_stays_ready(fakes, monkeypatch):
    out = _post(topic="greetings", native="he")
    assert fakes and fakes[0][2] == "he"
    assert store.get_island(out["id"])["lines"][0]["en"] == "he0"

    def boom(*a, **k):
        raise RuntimeError("claude down")

    monkeypatch.setattr(main.generate, "translate_lines", boom)
    out2 = _post(topic=phrase_catalog.catalog("ja")["topics"][1]["id"], native="he")
    island = store.get_island(out2["id"])
    assert island["status"] == "ready"
    assert island["lines"][0]["en"] == ""


def test_repeat_pick_returns_same_island_and_regenerate_refused(fakes):
    first = _post(topic="greetings")
    again = asyncio.run(main.import_phrases(
        BackgroundTasks(), topic="greetings", speaker=JA_VOICE, language="ja", native="en",
        authorization=AUTH, x_shadow_device=DEV,
    ))
    assert again["id"] == first["id"]
    with pytest.raises(HTTPException) as err:
        asyncio.run(main.regenerate(
            first["id"], BackgroundTasks(), complexity="complex", count=8,
            authorization=AUTH, x_shadow_device=DEV,
        ))
    assert err.value.status_code == 409
