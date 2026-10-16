"""Tests for the security fixes: sign-in switch, per-owner caps, generic
error bodies, response headers, non-ASCII tokens and suggestion limits."""

import asyncio
import sqlite3
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from fastapi.testclient import TestClient

import main
import podcast
import store
import suggest
import voicevox

from test_accounts import _token, key  # noqa: F401  (key is a fixture)

client = TestClient(main.app)
AUTH = {"Authorization": f"Bearer {main.SHADOW_TOKEN}"}
DEV = "0123456789abcdef0123456789abcdef"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


# --- F5: non-ASCII bearer ---
def test_non_ascii_bearer_is_401_not_500():
    r = client.get(
        "/shadow/speakers",
        headers=[(b"authorization", "Bearer é".encode("utf-8")),
                 (b"x-shadow-device", DEV.encode())],
    )
    assert r.status_code == 401


def test_non_ascii_bearer_on_schedule_routes_is_401_not_500():
    hdrs = [(b"authorization", "Bearer é".encode("utf-8")),
            (b"x-shadow-device", DEV.encode())]
    assert client.get("/shadow/schedule/due-today", headers=hdrs).status_code == 401
    assert client.post("/shadow/schedule/practice", headers=hdrs,
                       data={"island_id": "x", "seconds": "5"}).status_code == 401


# --- F3: voice errors ---
def test_voice_preview_hides_the_voice_error(monkeypatch, tmp_path):
    async def boom(*a, **k):
        raise voicevox.VoicevoxError("http://127.0.0.1:50021 down")

    monkeypatch.setattr(main.voices, "speak", boom)
    monkeypatch.setattr(main, "PREVIEW_DIR", tmp_path)
    r = client.get("/shadow/voices/3/preview", headers={**AUTH, "X-Shadow-Device": DEV})
    assert r.status_code == 502
    assert r.json() == {"detail": {"code": "voice_unreachable"}}
    assert "127.0.0.1" not in r.text


# --- F6: ssrf text ---
def test_check_url_error_does_not_echo_the_address():
    with pytest.raises(ValueError) as err:
        asyncio.run(podcast.check_url("http://127.0.0.1/"))
    assert "127.0.0.1" not in str(err.value)


def test_podcast_search_error_returns_the_generic_text(monkeypatch):
    async def boom(*a, **k):
        raise podcast.PodcastError("all connection attempts failed for 10.0.0.5")

    monkeypatch.setattr(main.podcast_catalog, "search", boom)
    r = client.get("/shadow/podcasts/search", params={"q": "x", "language": "ja"},
                   headers={**AUTH, "X-Shadow-Device": DEV})
    assert r.status_code == 400
    assert r.json()["detail"] == "that feed could not be fetched"
    assert "10.0.0.5" not in r.text


def test_podcast_episodes_returns_the_generic_text():
    r = client.get("/shadow/podcasts/episodes", params={"url": "http://127.0.0.1/x"},
                   headers={**AUTH, "X-Shadow-Device": DEV})
    assert r.status_code == 400
    assert r.json()["detail"] == "that url could not be used"


# --- F7: suggestions ---
def _texts():
    conn = sqlite3.connect(store.DB_PATH)
    try:
        conn.execute(suggest.SCHEMA)
        return [r[0] for r in conn.execute("SELECT text FROM suggestions")]
    finally:
        conn.close()


def _suggest(text):
    return asyncio.run(suggest.suggest_feature(
        suggest.SuggestBody(text=text), BackgroundTasks(), authorization=AUTH["Authorization"],
    ))


def test_suggestion_over_the_cap_is_400():
    with pytest.raises(HTTPException) as err:
        _suggest("x" * 2001)
    assert err.value.status_code == 400
    assert err.value.detail == {"code": "too_long", "limit": 2000}


def test_suggestion_at_sign_is_neutralised():
    _suggest("@everyone hi")
    texts = _texts()
    conn = sqlite3.connect(store.DB_PATH)
    conn.execute("DELETE FROM suggestions")  # other tests count rows
    conn.commit()
    conn.close()
    assert texts == ["(at)everyone hi"]


# --- F1: sign-in required ---
def test_sign_in_is_required_by_default_and_env_can_turn_it_off():
    assert main._signin_required(None) is True
    assert main._signin_required("1") is True
    assert main._signin_required("0") is False
    assert main._signin_required("off") is False


def test_device_only_request_is_401_when_required(monkeypatch):
    monkeypatch.setattr(main, "REQUIRE_SIGNIN", True)
    assert client.get("/shadow/health").status_code == 200
    assert client.get("/shadow/privacy").status_code == 200
    r = client.get("/shadow/islands", headers={**AUTH, "X-Shadow-Device": DEV})
    assert r.status_code == 401
    assert r.json() == {"detail": "sign-in required"}
    assert client.get("/shadow/islands", params={"device": DEV}, headers=AUTH).status_code == 401


def test_device_only_request_passes_when_switch_is_off():
    r = client.get("/shadow/islands", headers={**AUTH, "X-Shadow-Device": DEV})
    assert r.status_code == 200


def test_valid_jwt_passes_and_bad_jwt_is_401(monkeypatch, key):  # noqa: F811
    monkeypatch.setattr(main, "REQUIRE_SIGNIN", True)
    ok = client.get("/shadow/islands", headers={**AUTH, "X-Shadow-User": _token(key)})
    assert ok.status_code == 200
    bad = client.get("/shadow/islands", headers={**AUTH, "X-Shadow-User": "garbage"})
    assert bad.status_code == 401


# --- F2: per-owner caps ---
def test_use_slot_caps_then_429(monkeypatch):
    dev = uuid.uuid4().hex
    monkeypatch.setitem(main.DAILY_CAPS, "explain", 2)
    main._take_use_slot(dev, "explain")
    main._take_use_slot(dev, "explain")
    with pytest.raises(HTTPException) as err:
        main._take_use_slot(dev, "explain")
    assert err.value.status_code == 429
    assert err.value.detail == {"code": "daily_limit", "limit": 2, "kind": "explain"}


def test_use_slot_owner_is_exempt(monkeypatch):
    owner = uuid.uuid4().hex
    monkeypatch.setattr(main, "OWNER_DEVICE", owner)
    monkeypatch.setitem(main.DAILY_CAPS, "take", 0)
    main._take_use_slot(owner, "take")


def test_cached_word_audio_does_not_use_a_slot(monkeypatch, tmp_path):
    dev = uuid.uuid4().hex
    calls = {"n": 0}

    async def speak(*a, **k):
        calls["n"] += 1
        return b"RIFF", [], 1.0, None

    monkeypatch.setattr(main.voices, "speak", speak)

    async def speak_timed(*a, **k):
        return (*(await speak()), [])

    monkeypatch.setattr(main.voices, "speak_timed", speak_timed)
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setitem(main.DAILY_CAPS, "word_audio", 1)
    h = {**AUTH, "X-Shadow-Device": dev}
    assert client.get("/shadow/word-audio", params={"text": "猫"}, headers=h).status_code == 200
    assert client.get("/shadow/word-audio", params={"text": "猫"}, headers=h).status_code == 200
    assert calls["n"] == 1
    assert client.get("/shadow/word-audio", params={"text": "犬"}, headers=h).status_code == 429


# --- F4: headers ---
def test_security_headers():
    r = client.get("/shadow/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert "content-security-policy" not in r.headers
    page = client.get("/shadow/privacy")
    assert "default-src 'none'" in page.headers["content-security-policy"]


def test_security_headers_on_a_guard_401():
    r = client.get("/shadow/islands")
    assert r.status_code == 401
    assert r.headers["x-content-type-options"] == "nosniff"
