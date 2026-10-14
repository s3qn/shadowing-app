"""Caption parsing and the POST /shadow/youtube/captions route. No network."""

import asyncio
import json
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

import main
import store
import youtube

AUTH = f"Bearer {main.SHADOW_TOKEN}"
VID = "dQw4w9WgXcQ"


DEV = ""


@pytest.fixture(autouse=True)
def _init_db(monkeypatch):
    global DEV
    DEV = str(uuid.uuid4())
    store.init()
    monkeypatch.setattr(main, "DAILY_CREATES", 1000)


def ev(start_ms, dur_ms, *texts):
    return {"tStartMs": start_ms, "dDurationMs": dur_ms, "segs": [{"utf8": t} for t in texts]}


def test_join_segs_and_newlines():
    out = youtube.json3_to_lines([ev(1000, 2000, "こんに", "ちは\n", "世界")])
    assert out == [{"start": 1.0, "end": 3.0, "text": "こんにちは 世界"}]


def test_drops_empty_whitespace_markers_and_segless():
    events = [
        {"tStartMs": 0, "dDurationMs": 500},
        ev(0, 1000, " \n "), ev(1000, 1000, "[Music]"), ev(2000, 1000, "♪ la"),
        ev(3000, 1000, "ok"),
    ]
    assert [l["text"] for l in youtube.json3_to_lines(events)] == ["ok"]


def test_overlap_is_clipped_and_monotonic():
    out = youtube.json3_to_lines([ev(0, 4000, "a"), ev(2000, 4000, "b"), ev(5000, 3000, "c")])
    assert [(l["start"], l["end"]) for l in out] == [(0.0, 2.0), (2.0, 5.0), (5.0, 8.0)]
    for a, b in zip(out, out[1:]):
        assert a["end"] <= b["start"]


def test_tiny_line_merges_into_short_previous():
    out = youtube.json3_to_lines([ev(0, 2000, "abc"), ev(2000, 100, "d")])
    assert len(out) == 1 and out[0]["text"] == "abc d"


def test_tiny_line_after_long_previous_gets_minimum():
    out = youtube.json3_to_lines([ev(0, 5000, "abc"), ev(5000, 100, "d")])
    assert len(out) == 2
    assert out[1]["end"] - out[1]["start"] == pytest.approx(0.6)


@pytest.mark.parametrize("bad", [
    float("nan"), float("inf"), -5, 4 * 3600 * 1000 + 1, "1", True, None,
])
def test_bad_timestamps_rejected(bad):
    with pytest.raises(youtube.CaptionsInvalid):
        youtube.json3_to_lines([{"tStartMs": bad, "dDurationMs": 1000, "segs": [{"utf8": "x"}]}])


def test_wrong_shapes_rejected():
    for bad in ("x", {"a": 1}, [1], [{"segs": "x"}], [{"segs": [1]}], [{"segs": [{"utf8": 3}]}]):
        with pytest.raises(youtube.CaptionsInvalid):
            youtube.json3_to_lines(bad)


def test_long_text_cut_and_line_cap():
    out = youtube.json3_to_lines([ev(0, 1000, "あ" * 500)])
    assert len(out[0]["text"]) == youtube.CAPTION_MAX_CHARS
    many = [ev(i * 1000, 900, f"l{i}") for i in range(1500)]
    assert len(youtube.json3_to_lines(many)) == youtube.CAPTIONS_MAX_LINES
    with pytest.raises(youtube.CaptionsInvalid):
        youtube.json3_to_lines([ev(0, 1, "x")] * (youtube.CAPTIONS_MAX_EVENTS + 1))


def test_cues_from_lines():
    cues = youtube.cues_from_lines([{"start": 1.0, "end": 2.0, "text": "a"}])
    assert cues == [{"start": 1.0, "end": 2.0, "text": "a", "words": []}]


def test_build_from_captions_makes_a_ready_island_without_audio(monkeypatch):
    monkeypatch.setattr(main.generate, "translate_lines", lambda b, *a, **k: ["en " + t for t in b])
    iid = store.create_island("simple", 3, source="youtube", source_name=VID, device=DEV)
    store.add_video(iid, VID, 0.0, "Clip", "")
    cues = [
        {"start": 1.5, "end": 3.0, "text": "こんにちは", "words": []},
        {"start": 4.0, "end": 6.5, "text": "さようなら", "words": []},
    ]
    asyncio.run(main._build_from_captions(iid, cues, "Clip"))
    island = store.get_island(iid)
    assert island["status"] == "ready"
    assert [l["idx"] if "idx" in l else i for i, l in enumerate(island["lines"])] == [0, 1]
    assert island["lines"][0]["offset"] == 1.5 and island["lines"][1]["offset"] == 4.0
    assert island["lines"][0]["en"] == "en こんにちは"
    assert not store.line_audio_path(iid, 0).exists()
    assert store.get_video(iid)["duration"] == 6.5


def _post(body, device=None, raw=None):
    device = device or DEV
    data = raw if raw is not None else json.dumps(body).encode()

    class Req:
        headers = {"content-length": str(len(data))}

        async def stream(self):
            yield data

    bg = BackgroundTasks()
    out = asyncio.run(main.import_youtube_captions(
        Req(), bg, authorization=AUTH, x_shadow_device=device))
    return out, bg


def _good(**over):
    body = {"url": f"https://youtu.be/{VID}", "title": "Clip", "speaker": 3,
            "language": "ja", "native": "en", "events": [ev(0, 2000, "こんにちは")]}
    body.update(over)
    return body


def _status(body=None, raw=None):
    with pytest.raises(HTTPException) as exc:
        _post(body, raw=raw)
    return exc.value


def test_route_good_body_is_pending_and_takes_one_slot():
    out, bg = _post(_good())
    assert out["status"] == "pending" and len(bg.tasks) == 1
    assert store.count_builds_today(DEV, "create") == 1
    assert store.get_video(out["id"])["video_id"] == VID


def test_route_413_on_big_body():
    e = _status(raw=b"x" * (youtube.CAPTIONS_MAX_BODY + 1))
    assert e.status_code == 413


@pytest.mark.parametrize("raw", [b"not json", b"[1]", json.dumps(_good(events="x")).encode(),
                                 json.dumps(_good(speaker="3")).encode()])
def test_route_400_captions_invalid_and_no_slot(raw):
    e = _status(raw=raw)
    assert e.status_code == 400 and e.detail == {"code": "captions_invalid"}
    assert store.count_builds_today(DEV, "create") == 0


def test_route_400_no_captions_and_no_slot():
    e = _status(_good(events=[ev(0, 1000, "[Music]")]))
    assert e.status_code == 400 and e.detail == {"code": "no_captions"}
    assert store.count_builds_today(DEV, "create") == 0


def test_route_language_and_speaker_mismatch():
    assert _status(_good(language="en")).status_code == 400
    assert _status(_good(language="es", native="en")).status_code == 400
    assert store.count_builds_today(DEV, "create") == 0
