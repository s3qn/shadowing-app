"""Tests for the /shadow/explain-chat route in main.py: specifically the
sqlite cache lookup for a thread's opening turn. Calls the route function
directly (it is a plain async def) rather than through TestClient, same
reasoning as test_register_route.py: no server, no network needed.
"""

import asyncio

import pytest

import main
import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


AUTH = f"Bearer {main.SHADOW_TOKEN}"


def test_explain_chat_corrupt_cache_row_is_treated_as_a_miss(monkeypatch):
    # A row that predates a field rename, or a partial write, leaves JSON
    # sqlite cannot parse. That used to bubble up as a 500 instead of just
    # falling through to a fresh answer.
    store.set_explain_answer("公園を歩きます。", ["歩きます"], "explain this test route", "{not valid json")

    monkeypatch.setattr(
        main.explain, "chat_answer", lambda *a, **k: '{"summary": "fresh answer"}'
    )

    body = main.ExplainChatBody(
        sentence_ja="公園を歩きます。", sentence_en="I walk in the park.",
        marked=["歩きます"], question="explain this test route", history=[],
    )

    result = asyncio.run(main.explain_chat(body, authorization=AUTH))

    assert result == {"summary": "fresh answer"}


def test_explain_chat_corrupt_cache_row_is_overwritten_with_the_fresh_answer(monkeypatch):
    store.set_explain_answer("公園を歩きます。", ["歩きます"], "explain this test route", "{not valid json")

    monkeypatch.setattr(
        main.explain, "chat_answer", lambda *a, **k: '{"summary": "fresh answer"}'
    )

    body = main.ExplainChatBody(
        sentence_ja="公園を歩きます。", sentence_en="I walk in the park.",
        marked=["歩きます"], question="explain this test route", history=[],
    )
    asyncio.run(main.explain_chat(body, authorization=AUTH))

    assert store.get_explain_answer("公園を歩きます。", ["歩きます"], "explain this test route") == (
        '{"summary": "fresh answer"}'
    )
