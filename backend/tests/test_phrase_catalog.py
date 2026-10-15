"""Tests for the phrase catalogue and the phrase-island routes. No models or
network: voices.speak and generate.translate_lines are monkeypatched."""

import asyncio
import json
import re
import uuid
from pathlib import Path

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


DATA = Path(phrase_catalog.__file__).parent / "phrase_data"
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def test_split_data_is_valid():
    topics = json.loads((DATA / "topics.json").read_text())
    cats = json.loads((DATA / "categories.json").read_text())
    cat_ids = [c["id"] for c in cats]
    assert len(set(cat_ids)) == len(cat_ids)
    for c in cats:
        assert c["title"] and c["titleHe"] and isinstance(c["order"], int)
    ids = [t["id"] for t in topics]
    assert len(set(ids)) == len(ids)
    for t in topics:
        assert KEBAB.match(t["id"])
        assert t["category"] in cat_ids
        assert t["title"] and t["titleHe"]
        assert isinstance(t["keywords"], list) and isinstance(t["keywordsHe"], list)
        for lang in ("ja", "es", "en"):
            entries = json.loads((DATA / lang / f"{t['id']}.json").read_text())
            texts = [e["text"] for e in entries]
            assert all(x.strip() for x in texts)
            assert len(set(texts)) == len(texts)
    for lang in ("ja", "es", "en"):
        stems = {f.stem for f in (DATA / lang).glob("*.json")}
        assert stems == set(ids)


def test_catalog_has_category_fields():
    cat = phrase_catalog.catalog("ja")
    assert all(t["category"] for t in cat["topics"])
    assert {c["id"] for c in cat["categories"]} >= {t["category"] for t in cat["topics"]}


def ids(result):
    return [t["id"] for t in result["topics"]]


def test_search_empty_query_returns_all():
    out = phrase_catalog.search("ja", "en", "", "")
    assert ids(out) == [t["id"] for t in phrase_catalog.catalog("ja")["topics"]]
    assert all(t["matchedPhrase"] is None for t in out["topics"])


def test_search_by_query_and_ranking():
    out = phrase_catalog.search("es", "en", "shop")
    assert ids(out)[0] == "shopping"
    # keyword hit ("buy") works without a title match
    assert "shopping" in ids(phrase_catalog.search("es", "en", "  BUY "))
    # Hebrew title matches under any ui language
    assert ids(phrase_catalog.search("ja", "en", "קניות")) == ["shopping"]


def test_search_phrase_text_sets_matched_phrase():
    out = phrase_catalog.search("ja", "en", "おはよう")
    top = out["topics"][0]
    assert top["id"] == "greetings"
    assert top["matchedPhrase"] == "おはようございます。"


def test_search_by_category_and_no_match():
    out = phrase_catalog.search("ja", "en", "", "food")
    assert ids(out) == ["eating-out"]
    assert phrase_catalog.search("ja", "en", "", "nope")["topics"] == []
    assert phrase_catalog.search("ja", "en", "zzzqqq")["topics"] == []
    assert ids(phrase_catalog.search("ja", "en", "shop", "food")) == []


def test_search_ui_language_titles():
    he = phrase_catalog.search("ja", "he", "", "social")
    assert he["topics"][0]["title"] == "ברכות"
    assert {c["id"]: c["title"] for c in he["categories"]}["social"] == "חברה"


def test_search_route():
    out = main.phrases_search(language="es", ui="en", q="shopping", category="", authorization=AUTH)
    assert ids(out)[0] == "shopping"
    with pytest.raises(HTTPException) as err:
        main.phrases_search(language="xx", authorization=AUTH)
    assert err.value.status_code == 404
    with pytest.raises(HTTPException) as err:
        main.phrases_search(language="ja", authorization="Bearer wrong")
    assert err.value.status_code in (401, 403)


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
