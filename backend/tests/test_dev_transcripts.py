"""Dev transcript review routes, called directly (no TestClient)."""

import json

import pytest
from fastapi import HTTPException

import dev_transcripts as dt

AUTH = "Bearer t0k"
VID = "abcDEF12345"


def _cand(gold, key, video=VID, lines=True, words=True):
    d = gold / "_cache" / key
    d.mkdir(parents=True, exist_ok=True)
    ln = {"start": 0.0, "end": 1.0, "text": "こんにちは"}
    if words == "whole":
        ln["words"] = [{"start": 0.0, "end": 1.0, "text": "こんにちは"}]
    elif words:
        ln["words"] = [{"start": 0.0, "end": 0.4, "text": "こんに"}, {"start": 0.4, "end": 1.0, "text": "ちは"}]
    body = {"lines": [ln]} if lines else {"note": "no lines"}
    (d / f"{video}.json").write_text(json.dumps(body), encoding="utf-8")


@pytest.fixture(autouse=True)
def env(monkeypatch, tmp_path):
    gold = tmp_path / "gold"
    state = tmp_path / "state"
    vdir = gold / "chan" / VID
    vdir.mkdir(parents=True)
    (vdir / f"{VID}.info.json").write_text(json.dumps({"title": "T", "channel": "C"}))
    (vdir / f"{VID}.mp4").write_bytes(b"x")
    (gold / "_cache" / "_audio").mkdir(parents=True)
    (gold / "_cache" / "_audio" / f"{VID}.wav").write_bytes(b"x")
    _cand(gold, "whisper-medium/v1")
    _cand(gold, "fusion/rover", words=False)
    _cand(gold, "current/main", words="whole")
    _cand(gold, "broken/v1", lines=False)
    monkeypatch.setenv("SHADOW_TOKEN", "t0k")
    monkeypatch.setenv("SHADOW_GOLD_DIR", str(gold))
    monkeypatch.setenv("SHADOW_REVIEW_FILE", str(state / "current.json"))
    monkeypatch.setenv("SHADOW_ENV", "dev")
    return state


def _rows(state):
    f = state / "transcript-tags.jsonl"
    return [json.loads(x) for x in f.read_text().splitlines()] if f.exists() else []


def _tag(session="s1", label="A", tag="wrong_word", video=VID):
    return dt.post_tag(
        dt.TagBody(session=session, video=video, label=label, tag=tag, playerTime=1.5, lineIndex=0, lineText="x"),
        AUTH,
    )


def test_list_finds_video_and_nested_candidates_and_skips_bad():
    out = dt.list_transcripts(AUTH)
    assert [v["id"] for v in out["videos"]] == [VID]
    v = out["videos"][0]
    assert (v["title"], v["channel"], v["n_candidates"]) == ("T", "C", 3)
    assert sorted(v["has_words"]) == [False, False, True]


def test_media_never_listed():
    blob = json.dumps(dt.list_transcripts(AUTH)) + json.dumps(dt.get_transcript(VID, "s1", AUTH))
    assert ".mp4" not in blob and ".wav" not in blob


def test_labels_stable_per_session_and_differ_across_sessions():
    first = dt.get_transcript(VID, "s1", AUTH)
    again = dt.get_transcript(VID, "s1", AUTH)
    assert first == again
    assert [c["label"] for c in first["candidates"]] == ["A", "B", "C"]
    maps = {dt._label_map(f"sess{i}", VID, ["a", "b", "c"])["A"] for i in range(30)}
    assert len(maps) > 1


def test_response_has_no_candidate_key():
    blob = json.dumps(dt.get_transcript(VID, "s1", AUTH))
    for key in ("whisper-medium", "rover", "current", "fusion"):
        assert key not in blob


def test_tag_appends_resolved_candidate(env):
    _tag(label="B")
    row = _rows(env)[0]
    expect = dt._label_map("s1", VID, list(dt._candidates(VID)))["B"]
    assert row["candidate"] == expect
    assert row["tag"] == "wrong_word"
    assert {"ts", "video", "label", "playerTime", "lineIndex", "lineText"} <= set(row)


def test_bad_tag_rejected():
    with pytest.raises(ValueError):
        dt.TagBody(session="s", video=VID, label="A", tag="nope", playerTime=0, lineIndex=0)


def test_bad_video_ids_and_label():
    for bad in ("../etc", "a/b", "short"):
        with pytest.raises(HTTPException) as e:
            dt.get_transcript(bad, "s1", AUTH)
        assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        dt.get_transcript("zzzzzzzzzzz", "s1", AUTH)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        _tag(label="Z")
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        _tag(video="../../etc/passwd")
    assert e.value.status_code == 400


def test_undo_removes_only_last_of_session(env):
    _tag(tag="correct")
    _tag(session="other", tag="too_fast")
    _tag(tag="bad_split")
    assert dt.post_undo(dt.UndoBody(session="s1"), AUTH)["removed"] is True
    assert [r["tag"] for r in _rows(env)] == ["correct", "too_fast"]
    assert dt.post_undo(dt.UndoBody(session="nobody"), AUTH)["removed"] is False


def test_score_range(env):
    dt.post_score(dt.ScoreBody(session="s1", video=VID, label="A", score=4), AUTH)
    assert _rows(env)[0]["tag"] == "score:4"
    for bad in (0, 6):
        with pytest.raises(ValueError):
            dt.ScoreBody(session="s1", video=VID, label="A", score=bad)


def test_auth():
    with pytest.raises(HTTPException) as e:
        dt.list_transcripts(None)
    assert e.value.status_code == 401
    with pytest.raises(HTTPException) as e:
        dt.list_transcripts("Bearer nope")
    assert e.value.status_code == 401


def test_disabled_in_prod(monkeypatch):
    monkeypatch.setenv("SHADOW_ENV", "prod")
    assert dt.enabled() is False


def test_whole_line_single_word_is_not_word_timing():
    cands = {c["label"]: c["has_words"] for c in dt.get_transcript(VID, "s1", AUTH)["candidates"]}
    assert sorted(cands.values()) == [False, False, True]


def test_route_unmounted_in_prod():
    """Under SHADOW_ENV=prod the router is not on the app (the auth middleware answers 401 first)."""
    import os
    import subprocess
    import sys

    code = (
        "import main\n"
        "paths = [getattr(r, 'path', '') for r in main.app.routes]\n"
        "print('MOUNTED', any(p.startswith('/shadow/dev/transcripts') for p in paths))\n"
    )
    env = {**os.environ, "SHADOW_ENV": "prod", "SHADOW_TOKEN": "t0k"}
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=120)
    assert "MOUNTED False" in out.stdout, out.stdout + out.stderr
    env["SHADOW_ENV"] = "dev"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=120)
    assert "MOUNTED True" in out.stdout, out.stdout + out.stderr
