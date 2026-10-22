"""Caption parsing and the POST /shadow/youtube/captions route. No network."""

import asyncio
import json
import uuid
from pathlib import Path

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
    # youtube-asr-context-repair: the build hands the island to the repair
    # pass; these tests cover the build, test_repair.py covers the pass.
    monkeypatch.setattr(main.repair, "job", lambda *a, **k: None)


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
    assert cues == [{"start": 1.0, "end": 2.0, "text": "a", "words": [], "pieces": []}]


def test_build_from_captions_makes_a_ready_island_without_audio(monkeypatch):
    monkeypatch.setattr(main.generate, "translate_lines", lambda b, *a, **k: ["en " + t for t in b])
    iid = store.create_island("simple", 3, source="youtube", source_name=VID, device=DEV)
    store.add_video(iid, VID, 0.0, "Clip", "")
    cues = [
        {"start": 1.5, "end": 3.0, "text": "こんにちは"},
        {"start": 4.0, "end": 6.5, "text": "さようなら"},
    ]
    asyncio.run(main._build_from_captions(iid, cues, "Clip"))
    island = store.get_island(iid)
    assert island["status"] == "ready"
    assert [l["idx"] if "idx" in l else i for i, l in enumerate(island["lines"])] == [0, 1]
    assert island["lines"][0]["offset"] == 1.5 and island["lines"][1]["offset"] == 4.0
    assert island["lines"][0]["en"] == "en こんにちは"
    assert not store.line_audio_path(iid, 0).exists()
    assert store.get_video(iid)["duration"] == 6.5


def test_route_asr_only_when_an_event_has_tOffsetMs():
    asr_ev = {"tStartMs": 0, "dDurationMs": 2000, "segs": [{"utf8": "こん", "tOffsetMs": 0}, {"utf8": "にちは", "tOffsetMs": 900}]}
    _, bg = _post(_good(events=[asr_ev]))
    assert bg.tasks[0].args[-1] is True
    _, bg = _post(_good())
    assert bg.tasks[0].args[-1] is False


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


# --- yt-precise: the ASR track next to the manual one --------------------------

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "yt_pair_synthetic.json").read_text())
BLOCK_TEXT = max((t["text"] for t in FIXTURE["truth"]), key=len)  # the 15 s caption of 4 sentences


def _captions_json(island_id):
    return json.loads((store.AUDIO_DIR / island_id / "captions.json").read_text())


def test_route_passes_asr_tokens_and_keeps_both_tracks():
    out, bg = _post(_good(events=FIXTURE["events"], asr_events=FIXTURE["asr_events"]))
    task = bg.tasks[0]
    assert task.args[-1] is False
    tokens = task.kwargs["asr_tokens"]
    assert tokens == youtube.asr_tokens(FIXTURE["asr_events"])
    saved = _captions_json(out["id"])
    assert saved["video_id"] == VID and saved["events"] == FIXTURE["events"]
    assert saved["asr_events"] == FIXTURE["asr_events"]


def test_route_without_asr_events_behaves_as_today():
    out, bg = _post(_good())
    assert bg.tasks[0].kwargs["asr_tokens"] == []
    assert _captions_json(out["id"])["asr_events"] == []


@pytest.mark.parametrize("bad", [
    "x",
    [{"tStartMs": 0, "dDurationMs": 1000, "segs": [{"utf8": "x", "tOffsetMs": "9"}]}],
    [{"tStartMs": 0, "dDurationMs": 1, "segs": [{"utf8": "x"}]}] * (youtube.ASR_MAX_EVENTS + 1),
])
def test_route_bad_asr_events_are_ignored_and_the_manual_track_imports(bad):
    out, bg = _post(_good(asr_events=bad))
    assert out["status"] == "pending" and bg.tasks[0].kwargs["asr_tokens"] == []
    assert _captions_json(out["id"])["asr_events"] == []
    assert store.count_builds_today(DEV, "create") == 1


def test_route_oversized_asr_events_are_ignored(monkeypatch):
    monkeypatch.setattr(youtube, "ASR_MAX_BYTES", len(json.dumps(FIXTURE["asr_events"])) // 2)
    out, bg = _post(_good(events=FIXTURE["events"], asr_events=FIXTURE["asr_events"]))
    assert out["status"] == "pending" and bg.tasks[0].kwargs["asr_tokens"] == []
    assert _captions_json(out["id"])["asr_events"] == []


def test_body_limit_fits_both_tracks_at_their_caps():
    # a full ASR track and a manual track at their own budget fit in one body
    assert youtube.CAPTIONS_MAX_BODY >= youtube.ASR_MAX_BYTES + youtube.CAPTIONS_MANUAL_BYTES


def _build(monkeypatch, tokens):
    monkeypatch.setattr(main.generate, "translate_lines", lambda b, *a, **k: ["" for _ in b])
    iid = store.create_island("simple", 3, source="youtube", source_name=VID, device=DEV)
    store.add_video(iid, VID, 0.0, "Clip", "")
    lines = youtube.json3_to_lines(FIXTURE["events"])
    asyncio.run(main._build_from_captions(iid, lines, "Clip", asr_tokens=tokens))
    island = store.get_island(iid)
    assert island["status"] == "ready"
    return iid, island["lines"]


def test_build_with_asr_tokens_follows_the_voice(monkeypatch):
    iid, lines = _build(monkeypatch, youtube.asr_tokens(FIXTURE["asr_events"]))
    block = [ln for ln in lines if ln["ja"] in BLOCK_TEXT]
    # The 15 s block is cut on the ASR pieces: its last child sits after the
    # 9 s pause, and the child before the pause does not run through it.
    assert len(block) >= 3
    assert block[-1]["offset"] - block[0]["offset"] >= 9.0
    assert block[-2]["offset"] + block[-2]["duration"] < block[-1]["offset"] - 5.0
    assert block[-1]["ja"].startswith("よろしく")
    for truth in FIXTURE["truth"]:
        first = truth["text"].split(" ")[0]
        ln = next(l for l in lines if l["ja"].startswith(first))
        assert abs(ln["offset"] - truth["start"]) <= 0.3, (ln["ja"], ln["offset"], truth["start"])
    video = store.get_video(iid)
    assert (video["align_status"], video["align_error"]) == ("done", "asr")


def test_build_without_tokens_is_the_mora_clock_and_asr_none(monkeypatch):
    iid, lines = _build(monkeypatch, [])
    block = [ln for ln in lines if ln["ja"] in BLOCK_TEXT]
    assert len(block) == 2 and block[-1]["offset"] - block[0]["offset"] < 4.0
    video = store.get_video(iid)
    assert (video["align_status"], video["align_error"]) == ("done", "asr_none")


# yt-lump: the first 42 s of the ASR track of XDgLZUBxPc0. The event at
# 25.119 s packs the speech up to 39.44 s into one seg with a 3 s duration.
LUMP_EVENTS = [
    (80, 7160, [(0, 'おはよう'), (200, 'ござい'), (360, 'ます'), (560, '。'), (2040, 'え'), (2240, '、'), (2720, '今日'), (2960, 'も'), (3400, '朝'), (3879, '6'), (4080, '時'), (4239, '半')]),
    (4520, 5999, [(0, 'ぐらい'), (160, 'に'), (279, '目覚め'), (640, 'て'), (1160, 'ちょっと'), (1560, 'この'), (1799, '後'), (2200, '準備'), (2520, 'だけ')]),
    (7240, 5399, [(0, 'し'), (119, 'て'), (559, '、'), (760, 'え'), (840, '、'), (920, '生'), (1160, '放送'), (2319, 'やる'), (2520, 'ところ'), (2760, 'から'), (2880, '1'), (3040, '日'), (3200, 'を')]),
    (10519, 4441, [(0, 'スタート'), (240, 'さ'), (321, 'せよう'), (561, 'か'), (641, 'な'), (761, 'と'), (881, '思い'), (1040, 'ます'), (1160, '。'), (1881, 'で'), (2000, '、')]),
    (12639, 3801, [(0, 'いつ'), (201, 'も'), (281, 'ね'), (361, '、'), (481, '神楽'), (761, 'が'), (960, '朝ご飯'), (1681, 'を'), (1761, 'こう'), (1880, 'やっ'), (1960, 'て'), (2080, '作っ')]),
    (14960, 3200, [(0, 'て'), (40, 'くれ'), (240, 'て'), (320, '、'), (559, 'その'), (719, 'まま'), (1000, 'スーパー'), (1159, 'に'), (1280, '行く')]),
    (16440, 2999, [(0, 'タイミング'), (360, 'も'), (480, 'あれ'), (640, 'ば'), (839, '作ら'), (1080, 'ず'), (1160, 'に'), (1240, 'その'), (1400, 'まま')]),
    (18160, 3320, [(0, 'ゆっくり'), (279, '寝'), (360, 'て'), (440, 'もらう'), (680, 'パターン'), (879, 'も'), (1000, 'ある'), (1119, 'ん'), (1199, 'です')]),
    (19439, 4680, [(0, 'けど'), (81, '、'), (281, 'そこ'), (441, 'は'), (561, 'なん'), (641, 'か'), (721, '臨気'), (1041, '応援'), (1281, 'に'), (1441, '元気'), (1680, 'な'), (1801, '時'), (1920, 'は')]),
    (21480, 3639, [(0, '普通'), (160, 'に'), (360, 'ご飯'), (680, '作っ'), (879, 'て'), (959, 'くれる'), (1160, 'し'), (1440, 'みたい'), (1680, 'な'), (1799, '感じ'), (2080, '。')]),
    (24119, 4000, [(0, 'そろそろ'), (400, 'か'), (521, '。'), (841, '7')]),
    (25119, 3000, [(0, '時なったらね、俺は生放送をやって、今日はまさんは多分地下でパーソナルやって、で、イみが生放送を守るみたいな感じですね。だいぶね、システムがされてるというか、半年前ぐらいから始めたこの朝の生放送がもう定着して、絶対に朝は')]),
    (39440, 3135, [(0, '6'), (200, '時半とか'), (1040, '6'), (1160, '時'), (1240, '45')]),
]
LUMP_TEXT = LUMP_EVENTS[11][2][0][1]


def _lump_events():
    out = []
    for start, dur, segs in LUMP_EVENTS:
        out.append({"tStartMs": start, "dDurationMs": dur,
                    "segs": [{"utf8": t, **({"tOffsetMs": o} if o else {})} for o, t in segs]})
    return out


def test_stretch_lumps_moves_a_lump_end_to_the_next_line():
    lines = youtube.stretch_lumps(youtube.json3_to_lines(_lump_events()))
    lump = next(ln for ln in lines if ln["text"] == LUMP_TEXT)
    assert lump["end"] == 39.44
    # Lines with pieces, and a lump that fits, keep their times.
    assert lines[0]["end"] == 4.52
    fits = youtube.stretch_lumps([{"start": 1.0, "end": 3.0, "text": "こんにちは"},
                                  {"start": 9.0, "end": 10.0, "text": "はい"}])
    assert fits[0]["end"] == 3.0


def test_build_spreads_an_asr_lump_over_its_voice(monkeypatch):
    monkeypatch.setattr(main.generate, "translate_lines", lambda b, *a, **k: [""] * len(b))
    iid = store.create_island("simple", 3, source="youtube", source_name=VID, device=DEV)
    store.add_video(iid, VID, 0.0, "Clip", "")
    asyncio.run(main._build_from_captions(iid, youtube.json3_to_lines(_lump_events()), "Clip"))
    lines = store.get_island(iid)["lines"]
    lump = [ln for ln in lines if ln["ja"] in LUMP_TEXT and ln["offset"] >= 25.0 and not ln["ja"].startswith("6")]
    assert len(lump) >= 3
    # Its speech runs to 39.44 s, not 28.1 s: the last child starts well past
    # the 3 s the event claimed, and no child is crammed under a second.
    assert lump[-1]["offset"] >= 33.0
    assert lump[-1]["offset"] + lump[-1]["duration"] <= 39.44 + 1e-6
    assert all(ln["duration"] >= 1.0 for ln in lump)
    nxt = next(ln for ln in lines if ln["ja"].startswith("6時半"))
    assert abs(nxt["offset"] - 39.44) < 0.01
