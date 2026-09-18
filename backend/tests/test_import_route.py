"""Tests for the import pipeline in main.py: _build_import, _build_from_cues,
the source-aware guards on regenerate/revoice and _resolve_line_audio, and
startup healing of an interrupted import.

No ffmpeg, whisper or network: main._probe_streams, main._extract_audio,
main._probe_duration, main._slice and transcribe.transcribe are all
monkeypatched. A tiny real wav (written with the stdlib `wave` module) stands
in for whatever ffmpeg would have produced, so store.get_island's duration
and offset math has something real to read.
"""

import asyncio
import io
import wave
from pathlib import Path

import pytest
from fastapi import HTTPException

import main
import store


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


def _write_wav(path: Path, seconds: float = 1.0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    n_frames = int(main.SLICE_RATE * seconds)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(main.SLICE_RATE)
        w.writeframes(b"\x00\x00" * n_frames)


@pytest.fixture
def fake_pipeline(monkeypatch, tmp_path):
    """Every ffmpeg/ffprobe touchpoint _build_import uses, faked to behave
    like a 4-second clip with one Japanese audio stream."""
    monkeypatch.setattr(main, "_probe_streams", lambda path: {
        "streams": [{"index": 0, "codec_type": "audio", "tags": {"language": "jpn"}}]
    })
    monkeypatch.setattr(main, "_probe_duration", lambda path: 4.0)

    def fake_extract(src, dst, stream, start_s=0.0, max_s=None):
        _write_wav(dst, 4.0)
        return True

    monkeypatch.setattr(main, "_extract_audio", fake_extract)

    def fake_slice(src, dst, start, end):
        _write_wav(dst, max(end - start, 0.05))
        return True

    monkeypatch.setattr(main, "_slice", fake_slice)
    monkeypatch.setattr(main.generate, "translate_lines", lambda *a, **k: [])
    return tmp_path


def _fake_transcribe_result(words):
    segments = []
    if words:
        segments = [{
            "start": words[0]["start"], "end": words[-1]["end"],
            "text": "".join(w["text"] for w in words), "words": words,
        }]
    return {"ok": True, "text": "".join(w["text"] for w in words), "language": "ja",
            "segments": segments, "words": words}


def test_build_import_with_srt_produces_lines_with_offset_and_kana(fake_pipeline, monkeypatch):
    island_id = store.create_island("simple", 3, source="import", source_name="clip.mp3")
    srt = (
        "1\n00:00:00,500 --> 00:00:02,000\nこんにちは\n\n"
        "2\n00:00:02,500 --> 00:00:03,800\nさようなら\n"
    )
    words = [
        {"text": "こんにちは", "start": 0.5, "end": 1.9},
        {"text": "さようなら", "start": 2.5, "end": 3.7},
    ]
    monkeypatch.setattr(main.transcribe, "transcribe", lambda *a, **k: _fake_transcribe_result(words))

    asyncio.run(main._build_import(island_id, fake_pipeline / "media.mp4", srt, "Clip", 0.0))

    island = store.get_island(island_id)
    assert island["status"] == "ready"
    assert island["source"] == "import"
    assert len(island["lines"]) == 2
    assert island["lines"][0]["ja"] == "こんにちは"
    assert island["lines"][0]["kana"] == segment_reading("こんにちは")
    assert island["lines"][0]["offset"] >= 0
    assert island["lines"][1]["offset"] > island["lines"][0]["offset"]


def segment_reading(text: str) -> str:
    import segment
    return segment.reading(text)


def test_build_import_without_srt_uses_whisper_segments(fake_pipeline, monkeypatch):
    island_id = store.create_island("simple", 3, source="import", source_name="clip.mp3")
    words = [
        {"text": "おはよう", "start": 0.2, "end": 1.0},
        {"text": "ございます", "start": 1.0, "end": 2.0},
    ]
    monkeypatch.setattr(main.transcribe, "transcribe", lambda *a, **k: _fake_transcribe_result(words))

    asyncio.run(main._build_import(island_id, fake_pipeline / "media.mp4", None, "Clip", 0.0))

    island = store.get_island(island_id)
    assert island["status"] == "ready"
    assert len(island["lines"]) >= 1
    assert island["lines"][0]["ja"] == "おはようございます"


def test_build_import_fails_the_island_when_whisper_is_not_ok(fake_pipeline, monkeypatch):
    island_id = store.create_island("simple", 3, source="import", source_name="clip.mp3")
    monkeypatch.setattr(
        main.transcribe, "transcribe",
        lambda *a, **k: {"ok": False, "text": "", "language": "", "segments": [], "words": []},
    )

    asyncio.run(main._build_import(island_id, fake_pipeline / "media.mp4", None, "Clip", 0.0))

    island = store.get_island(island_id)
    assert island["status"] == "failed"


def test_build_import_title_gets_a_range_suffix_when_trimmed(fake_pipeline, monkeypatch):
    island_id = store.create_island("simple", 3, source="import", source_name="clip.mp3")
    words = [{"text": "こんにちは", "start": 0.1, "end": 1.0}]
    monkeypatch.setattr(main.transcribe, "transcribe", lambda *a, **k: _fake_transcribe_result(words))
    # A 2-minute source, so a 1-minute start lies inside it; the extracted wav stays 4s.
    monkeypatch.setattr(main, "_probe_duration", lambda path: 120.0 if path.suffix == ".mp4" else 4.0)

    asyncio.run(main._build_import(island_id, fake_pipeline / "media.mp4", None, "Clip", 60.0))

    island = store.get_island(island_id)
    assert island["status"] == "ready"
    assert "min" in island["title"]
    assert island["title"] != "Clip"


def test_build_import_fails_clearly_when_the_start_is_past_the_end(fake_pipeline, monkeypatch):
    island_id = store.create_island("simple", 3, source="import", source_name="clip.mp3")
    monkeypatch.setattr(main.transcribe, "transcribe", lambda *a, **k: _fake_transcribe_result([]))

    asyncio.run(main._build_import(island_id, fake_pipeline / "media.mp4", None, "Clip", 600.0))

    island = store.get_island(island_id)
    assert island["status"] == "failed"
    assert "past the end" in island["error"]


def _cues(n):
    return [{"start": i * 1.0, "end": i * 1.0 + 0.9, "text": f"行{i}", "words": []} for i in range(n)]


def test_build_from_cues_translates_in_batches_by_count(fake_pipeline, monkeypatch):
    island_id = store.create_island("simple", 3, source="import", source_name="clip.mp3")
    n = generate_batch() * 2 + 5
    sizes = []

    def fake_translate(batch, *a, **k):
        sizes.append(len(batch))
        return [f"en {text}" for text in batch]

    monkeypatch.setattr(main.generate, "translate_lines", fake_translate)

    asyncio.run(main._build_from_cues(island_id, fake_pipeline / "source.wav", _cues(n), "Clip", n + 1.0))

    assert sizes == [generate_batch(), generate_batch(), 5]
    island = store.get_island(island_id)
    assert island["status"] == "ready"
    assert island["lines"][0]["en"] == "en 行0"
    assert island["lines"][n - 1]["en"] == f"en 行{n - 1}"


def generate_batch() -> int:
    return main.generate.TRANSLATE_BATCH


def test_build_import_stays_ready_when_translation_raises(fake_pipeline, monkeypatch):
    island_id = store.create_island("simple", 3, source="import", source_name="clip.mp3")
    words = [{"text": "こんにちは", "start": 0.1, "end": 1.0}]
    monkeypatch.setattr(main.transcribe, "transcribe", lambda *a, **k: _fake_transcribe_result(words))

    def broken_translate(*a, **k):
        raise RuntimeError("translation broke")

    monkeypatch.setattr(main.generate, "translate_lines", broken_translate)

    asyncio.run(main._build_import(island_id, fake_pipeline / "media.mp4", None, "Clip", 0.0))

    island = store.get_island(island_id)
    assert island["status"] == "ready"


def test_startup_marks_an_interrupted_import_failed_not_ready():
    island_id = store.create_island("simple", 3, source="import", source_name="clip.mp3")
    store.set_stage(island_id, "slicing")
    store.add_line(island_id, 0, {"ja": "a"}, 1.0, [])

    main._startup()

    island = store.get_island(island_id)
    assert island["status"] == "failed"
    assert "import" in island["error"].lower()


def test_startup_keeps_a_voice_island_ready_with_its_lines():
    island_id = store.create_island("simple", 3)
    store.set_stage(island_id, "speaking")
    store.add_line(island_id, 0, {"ja": "a"}, 1.0, [])

    main._startup()

    island = store.get_island(island_id)
    assert island["status"] == "ready"


def test_regenerate_refuses_an_imported_island():
    island_id = store.create_island(
        "simple", 3, source="import", source_name="clip.mp3", device="aaaaaaaa-0000-4000-8000-00000000000a",
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.regenerate(
            island_id, background=None, complexity="complex", count=8,
            authorization=f"Bearer {main.SHADOW_TOKEN}", x_shadow_device="aaaaaaaa-0000-4000-8000-00000000000a",
        ))

    assert exc_info.value.status_code == 409


def test_revoice_refuses_an_imported_island():
    island_id = store.create_island(
        "simple", 3, source="import", source_name="clip.mp3", device="aaaaaaaa-0000-4000-8000-00000000000a",
    )
    store.add_line(island_id, 0, {"ja": "a"}, 1.0, [])
    store.set_ready(island_id, "Clip")

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.revoice(
            island_id, background=None, speaker=3, authorization=f"Bearer {main.SHADOW_TOKEN}",
            x_shadow_device="aaaaaaaa-0000-4000-8000-00000000000a",
        ))

    assert exc_info.value.status_code == 409


def test_resolve_line_audio_stretches_an_imported_line_instead_of_synthesizing(monkeypatch):
    island_id = store.create_island("simple", 3, source="import", source_name="clip.mp3")
    store.add_line(island_id, 0, {"ja": "a"}, 1.0, [])
    store.set_ready(island_id, "Clip")
    base = store.line_audio_path(island_id, 0)
    _write_wav(base, 1.0)

    calls = []

    def fake_stretch(src, dst, speed):
        calls.append((src, dst, speed))
        _write_wav(dst, 1.0 / speed)
        return True

    monkeypatch.setattr(main, "_stretch", fake_stretch)
    speak_called = []
    monkeypatch.setattr(
        main.voicevox, "speak",
        lambda *a, **k: speak_called.append(1),
    )

    island = store.get_island(island_id)
    path = asyncio.run(main._resolve_line_audio(island, 0, 0.7))

    assert path.exists()
    assert len(calls) == 1
    assert not speak_called
