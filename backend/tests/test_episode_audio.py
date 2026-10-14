"""Tests for the whole-episode m4a route and export.encode_file_m4a."""

import asyncio

import pytest
from fastapi import HTTPException

import export
import main
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "eeeeeeee-0000-4000-8000-0000000000a1"
OTHER = "eeeeeeee-0000-4000-8000-0000000000a2"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


@pytest.fixture
def encoder(monkeypatch):
    calls = []

    def fake(src, dst, title, **kw):
        calls.append((src, dst))
        dst.write_bytes(b"m4a")

    monkeypatch.setattr(export, "encode_file_m4a", fake)
    return calls


def _island(source, with_wav=True):
    island_id = store.create_island("simple", 3, source=source, device=DEV)
    store.add_line(island_id, 0, {"ja": "a"}, 1.0, [])
    store.set_ready(island_id, "Title")
    if with_wav:
        wav = store.AUDIO_DIR / island_id / "source.wav"
        wav.parent.mkdir(parents=True, exist_ok=True)
        wav.write_bytes(b"wav")
    return island_id


def _get(island_id, device=DEV):
    return asyncio.run(main.episode_audio(
        island_id, token="", device="", authorization=AUTH, x_shadow_device=device,
    ))


def test_voice_island_is_409(encoder):
    with pytest.raises(HTTPException) as e:
        _get(_island("voice"))
    assert e.value.status_code == 409


def test_podcast_without_source_wav_is_409(encoder):
    with pytest.raises(HTTPException) as e:
        _get(_island("podcast", with_wav=False))
    assert e.value.status_code == 409
    assert e.value.detail == {"code": "no_episode"}


def test_podcast_returns_cached_file_and_encodes_once(encoder):
    island_id = _island("podcast")
    first = _get(island_id)
    assert first.path == store.AUDIO_DIR / island_id / "episode.m4a"
    _get(island_id)
    assert len(encoder) == 1


def test_other_device_is_404(encoder):
    with pytest.raises(HTTPException) as e:
        _get(_island("podcast"), device=OTHER)
    assert e.value.status_code == 404


def test_encode_m4a_delegates_to_encode_file(monkeypatch, tmp_path):
    seen = {}

    def fake(src, dst, title, **kw):
        seen["wav"] = src.read_bytes()
        dst.write_bytes(b"m4a")

    monkeypatch.setattr(export, "encode_file_m4a", fake)
    dst = tmp_path / "x.m4a"
    export.encode_m4a(b"RIFF", dst, "T")
    assert seen["wav"] == b"RIFF" and dst.read_bytes() == b"m4a"
    assert list(tmp_path.iterdir()) == [dst]
