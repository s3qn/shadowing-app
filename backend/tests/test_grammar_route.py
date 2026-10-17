"""Grammar island routes and the mic match. No models or network."""

import asyncio
import io
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile

import grammar
import main
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
JA_VOICE = 3
ES_VOICE = 10011
POINT = {"id": "ながら", "pattern": "AながらB", "reading": "ながら", "level": "N4",
         "level_guess": 0, "connection": "", "meaning_short": "while doing", "source": "nk"}


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


@pytest.fixture
def fakes(monkeypatch):
    seen = {"expand": 0, "point": None}

    async def speak_timed(text, speaker):
        return b"RIFF", [], 1.0, "", []

    def gen(point, seed, register="polite", native="en"):
        seen["point"] = point
        return {"title": "x", "lines": [
            {"ja": "歩きながら話す。", "kana": "", "romaji": "", "en": "a", "span": "ながら"},
            {"ja": "走る。", "kana": "", "romaji": "", "en": "b", "span": ""},
        ]}

    def to_wav(src, dst):
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(b"RIFF")
        return True

    def expand(*a):
        seen["expand"] += 1
        return ["x"]

    monkeypatch.setattr(main.grammar, "get", lambda pid: POINT if pid == "ながら" else None)
    monkeypatch.setattr(main.grammar, "list_points", lambda level: [POINT] if level == "N4" else [])
    monkeypatch.setattr(main.grammar, "levels", lambda: [{"level": "N4", "count": 1}])
    monkeypatch.setattr(main.grammar, "match",
                        lambda t: POINT if t == "ながら" else None)
    monkeypatch.setattr(main.corpus, "search", lambda *a, **k: [])
    monkeypatch.setattr(main.generate, "generate_grammar", gen)
    monkeypatch.setattr(main.generate, "expand_topic", expand)
    monkeypatch.setattr(main.generate, "generate_lines",
                        lambda *a, **k: {"title": "T", "lines": [{"ja": "走る。", "en": "r"}]})
    monkeypatch.setattr(main.voices, "speak_timed", speak_timed)
    monkeypatch.setattr(main.segment, "align", lambda *a, **k: [])
    monkeypatch.setattr(main, "_to_wav", to_wav)
    return seen


def _device():
    return f"dddddddd-0000-4000-8000-{uuid.uuid4().hex[:12]}"


def _run(background):
    async def run():
        for task in background.tasks:
            await task.func(*task.args, **task.kwargs)

    asyncio.run(run())


def _import(dev, point="ながら", speaker=JA_VOICE):
    background = BackgroundTasks()
    out = asyncio.run(main.import_grammar(
        background, point=point, speaker=speaker, register="polite", native="en",
        authorization=AUTH, x_shadow_device=dev))
    _run(background)
    return out


def test_levels_and_points_mark_added(fakes):
    dev = _device()
    assert main.grammar_levels(AUTH, dev) == {"levels": [{"level": "N4", "count": 1}]}
    assert main.grammar_points("N4", "", AUTH, dev)["points"][0]["added"] is False
    _import(dev)
    assert main.grammar_points("N4", "", AUTH, dev)["points"][0]["added"] is True
    assert main.grammar_points("N4", "", AUTH, _device())["points"][0]["added"] is False


def test_points_by_id_reads_one_point(fakes):
    dev = _device()
    out = main.grammar_points("", "", AUTH, dev, point="ながら")["points"]
    assert [p["id"] for p in out] == ["ながら"]
    assert out[0]["level"] == "N4"
    assert main.grammar_points("", "", AUTH, dev, point="nope")["points"] == []


def test_import_builds_grammar_island_and_repeat_returns_same(fakes):
    dev = _device()
    out = _import(dev)
    island = store.get_island(out["id"])
    assert island["status"] == "ready"
    assert (island["source"], island["source_name"]) == ("grammar", "ながら")
    assert island["title"] == "AながらB · while doing"
    assert [ln["span"] for ln in island["lines"]] == ["ながら", ""]
    assert _import(dev)["id"] == out["id"]
    assert store.count_builds_today(dev, "create") == 1


def test_import_rejects_es_voice_and_unknown_point(fakes):
    with pytest.raises(HTTPException) as err:
        _import(_device(), speaker=ES_VOICE)
    assert err.value.status_code == 400
    with pytest.raises(HTTPException) as err:
        _import(_device(), point="nope")
    assert err.value.status_code == 404


def _mic(monkeypatch, text, dev):
    monkeypatch.setattr(main.transcribe, "transcribe",
                        lambda *a, **k: {"text": text, "language": "ja"})
    background = BackgroundTasks()
    out = asyncio.run(main.create_island(
        background, audio=UploadFile(file=io.BytesIO(b"x"), filename="r.m4a"),
        complexity="simple", register="polite", language="ja", speaker=JA_VOICE,
        native="en", count=8, topic=1, authorization=AUTH, x_shadow_device=dev))
    _run(background)
    return store.get_island(out["id"])


def test_mic_match_switches_to_grammar(fakes, monkeypatch):
    island = _mic(monkeypatch, "ながら", _device())
    assert (island["source"], island["source_name"]) == ("grammar", "ながら")
    assert fakes["expand"] == 0
    assert island["lines"][0]["span"] == "ながら"


def test_mic_no_match_keeps_topic_path(fakes, monkeypatch):
    island = _mic(monkeypatch, "phrases for the gym", _device())
    assert island["source"] == "phrases"
    assert fakes["expand"] == 1
