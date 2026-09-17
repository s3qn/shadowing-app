"""Tests for the /shadow/suggestions route in suggest.py: the row it writes
and the Discord relay it schedules as a background task. Calls the route
function directly (asyncio.run, no TestClient, no network), same reasoning
as test_explain_chat_route.py.
"""

import asyncio
import sqlite3

import pytest
from fastapi import BackgroundTasks, HTTPException

import main
import store
import suggest

AUTH = f"Bearer {main.SHADOW_TOKEN}"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


def _rows():
    conn = sqlite3.connect(store.DB_PATH)
    try:
        conn.execute(suggest.SCHEMA)
        return conn.execute("SELECT text FROM suggestions").fetchall()
    finally:
        conn.close()


async def _call_and_run_background(text: str, authorization: str | None):
    background = BackgroundTasks()
    result = await suggest.suggest_feature(
        suggest.SuggestBody(text=text), background, authorization=authorization
    )
    await background()
    return result


def test_valid_text_with_no_webhook_inserts_a_row_and_never_calls_urlopen(monkeypatch):
    monkeypatch.delenv("SHADOW_DISCORD_WEBHOOK", raising=False)

    def _boom(*a, **k):
        raise AssertionError("urlopen should not be called when no webhook is set")

    monkeypatch.setattr(suggest.urllib.request, "urlopen", _boom)

    result = asyncio.run(_call_and_run_background("a test idea", AUTH))

    assert result == {"ok": True}
    assert [row[0] for row in _rows()] == ["a test idea"]


def test_valid_text_with_webhook_posts_to_the_configured_url(monkeypatch):
    monkeypatch.setenv("SHADOW_DISCORD_WEBHOOK", "https://discord.example/webhook")
    seen = {}

    def _record(req, timeout=5):
        seen["url"] = req.full_url

    monkeypatch.setattr(suggest.urllib.request, "urlopen", _record)

    asyncio.run(_call_and_run_background("relay this idea", AUTH))

    assert seen["url"] == "https://discord.example/webhook"


def test_a_webhook_that_raises_does_not_raise_out_of_the_route(monkeypatch):
    monkeypatch.setenv("SHADOW_DISCORD_WEBHOOK", "https://discord.example/webhook")

    def _fail(*a, **k):
        raise OSError("unreachable")

    monkeypatch.setattr(suggest.urllib.request, "urlopen", _fail)

    result = asyncio.run(_call_and_run_background("resilient idea", AUTH))

    assert result == {"ok": True}


def test_empty_text_raises_400():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(_call_and_run_background("   ", AUTH))

    assert exc_info.value.status_code == 400


def test_missing_bearer_token_raises_401():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(_call_and_run_background("an idea", None))

    assert exc_info.value.status_code == 401


def test_bad_bearer_token_raises_401():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(_call_and_run_background("an idea", "Bearer nope"))

    assert exc_info.value.status_code == 401
