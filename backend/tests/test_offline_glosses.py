"""The offline-islands glosses route: one request returns every unique word's
meanings. glossary.gloss is monkeypatched, so no dictionary is needed."""

import asyncio

import pytest
from fastapi import HTTPException

import main
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "dddddddd-0000-4000-8000-000000000004"
OTHER = "dddddddd-0000-4000-8000-000000000005"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


def _island(language: str, lines: list[list[str]]) -> str:
    iid = store.create_island("simple", 3, language=language, device=DEV)
    for idx, texts in enumerate(lines):
        store.add_line(iid, idx, {"ja": "x"}, 1.0, [],
                       words=[{"text": t, "start": 0, "end": 1} for t in texts])
    store.set_ready(iid, "Title")
    return iid


def test_unique_stripped_words_are_glossed_once(monkeypatch):
    calls: list[str] = []

    def fake(word):
        calls.append(word)
        return {"base": word}

    monkeypatch.setattr(main.glossary, "gloss", fake)
    iid = _island("ja", [["猫", "は、"], ["猫", "です。"]])
    out = asyncio.run(main.island_glosses(iid, authorization=AUTH, x_shadow_device=DEV))
    assert out == {"猫": {"base": "猫"}, "は": {"base": "は"}, "です": {"base": "です"}}
    assert sorted(calls) == sorted(set(calls))


def test_non_japanese_island_returns_empty(monkeypatch):
    monkeypatch.setattr(main.glossary, "gloss", lambda w: pytest.fail("called"))
    iid = _island("es", [["hola"]])
    out = asyncio.run(main.island_glosses(iid, authorization=AUTH, x_shadow_device=DEV))
    assert out == {}


def test_another_device_gets_404():
    iid = _island("ja", [["猫"]])
    with pytest.raises(HTTPException) as exc:
        asyncio.run(main.island_glosses(iid, authorization=AUTH, x_shadow_device=OTHER))
    assert exc.value.status_code == 404
