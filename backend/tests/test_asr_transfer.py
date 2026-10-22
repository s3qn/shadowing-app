"""yt-precise: ASR tokens from json3, the transfer of their onsets onto manual
caption lines, the captions-timing route and the retime job, restore."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import asr_transfer
import caption_timing
import main
import segment
import store
import youtube

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "yt_pair_synthetic.json").read_text())
DEV = "dddddddd-0000-4000-8000-0000000000b1"
HEAD = {"Authorization": "Bearer test-token", "X-Shadow-Device": DEV}

client = TestClient(main.app)


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


# --- youtube.asr_tokens ---------------------------------------------------------

def test_asr_tokens_onsets_missing_offset_is_zero_and_end_rule():
    events = [
        {"tStartMs": 1000, "dDurationMs": 3000, "segs": [
            {"utf8": "今日"}, {"utf8": "は", "tOffsetMs": 400}, {"utf8": " "}, {"utf8": "晴れ", "tOffsetMs": 2500}]},
        {"tStartMs": 5000, "dDurationMs": 2000, "segs": [{"utf8": "です"}]},
        {"tStartMs": 9000, "dDurationMs": 1000, "segs": [{"utf8": "\n"}]},
        {"tStartMs": 10000, "dDurationMs": 4000, "segs": [{"utf8": "[Music]"}, {"utf8": "ね", "tOffsetMs": 100}]},
    ]
    toks = youtube.asr_tokens(events)
    assert [t["text"] for t in toks] == ["今日", "は", "晴れ", "です", "ね"]
    assert [t["start"] for t in toks] == [1.0, 1.4, 3.5, 5.0, 10.1]
    # next onset, then the 1.5 s cap, then the event's own end, the last with its event
    assert [t["end"] for t in toks] == [1.4, pytest.approx(2.9), 4.0, pytest.approx(6.5), 14.0]


def test_asr_tokens_sorted_and_empty():
    events = [{"tStartMs": 3000, "dDurationMs": 1000, "segs": [{"utf8": "b"}]},
              {"tStartMs": 1000, "dDurationMs": 1000, "segs": [{"utf8": "a"}]}]
    assert [t["text"] for t in youtube.asr_tokens(events)] == ["a", "b"]
    assert youtube.asr_tokens([]) == []


@pytest.mark.parametrize("bad", [
    "x", [1], [{"segs": "x"}], [{"segs": [1]}], [{"segs": [{"utf8": 3}]}],
    [{"tStartMs": 0, "dDurationMs": 1, "segs": [{"utf8": "x", "tOffsetMs": "9"}]}],
    [{"tStartMs": 0, "dDurationMs": 1, "segs": [{"utf8": "x", "tOffsetMs": float("nan")}]}],
    [{"tStartMs": -1, "dDurationMs": 1, "segs": [{"utf8": "x"}]}],
    [{"tStartMs": 0, "dDurationMs": 1, "segs": [{"utf8": "x"}]}] * (youtube.ASR_MAX_EVENTS + 1),
    [{"tStartMs": 0, "dDurationMs": 1, "segs": [{"utf8": "x"}] * (youtube.ASR_MAX_SEGS_PER_EVENT + 1)}],
    [{"tStartMs": 0, "dDurationMs": 1, "segs": [{"utf8": "x"}] * youtube.ASR_MAX_SEGS_PER_EVENT}]
    * (youtube.ASR_MAX_TOKENS // youtube.ASR_MAX_SEGS_PER_EVENT + 1),
])
def test_asr_tokens_rejects_bad_shapes(bad):
    with pytest.raises(youtube.CaptionsInvalid):
        youtube.asr_tokens(bad)


# --- asr_transfer.attach --------------------------------------------------------

def _fixture_lines():
    return youtube.json3_to_lines(FIXTURE["events"])


def _fixture_tokens():
    return youtube.asr_tokens(FIXTURE["asr_events"])


def _rate(lines):
    return segment.mora_rate([(ln["text"], ln["end"] - ln["start"]) for ln in lines])


def toks(spec):
    """[(start, text), ...] to tokens, each ending at the next start."""
    out = []
    for i, (start, text) in enumerate(spec):
        end = spec[i + 1][0] if i + 1 < len(spec) else start + 0.5
        out.append({"text": text, "start": float(start), "end": float(end)})
    return out


def test_attach_fixture_lands_every_line_on_the_voice():
    lines = _fixture_lines()
    rate = _rate(lines)
    new, report = asr_transfer.attach(lines, _fixture_tokens(), rate)
    assert len(new) == len(lines) == 12
    for ln, truth in zip(new, FIXTURE["truth"]):
        assert abs(ln["start"] - truth["start"]) <= 0.3, (ln["text"], ln["start"], truth["start"])
    for a, b in zip(new, new[1:]):
        assert a["end"] <= b["start"] + 1e-9
    # うん。 has two moras: never anchored, keeps its caption time
    un = next(ln for ln in new if ln["text"].startswith("うん"))
    assert "pieces" not in un and un["asr_ratio"] == 0.0
    assert report["lines"] == 12 and report["anchored"] == 11
    assert 0.5 <= report["median_ratio"] <= 1.0
    assert report["median_shift_s"] <= 0.3 and report["max_shift_s"] <= 1.0
    # the caller's lines are untouched
    assert "pieces" not in lines[1] and "asr_ratio" not in lines[1]


def test_attach_block_splits_on_the_voice_not_the_even_clock():
    lines = _fixture_lines()
    rate = _rate(lines)
    block = next(ln for ln in lines if ln["end"] - ln["start"] >= 14.0)
    before = [ln for ln in youtube.split_lines(lines, rate=rate) if block["start"] <= ln["start"] < block["end"]]
    assert before[-1]["start"] - block["start"] < 4.0  # today: the mora clock cuts inside the speech
    new, _ = asr_transfer.attach(lines, _fixture_tokens(), rate)
    after = asr_transfer.trim_tails(youtube.split_lines(new, rate=rate))
    children = [ln for ln in after if block["start"] - 0.5 <= ln["start"] < block["end"] + 0.5]
    assert children[-1]["text"].startswith("よろしく")
    assert children[-1]["start"] - block["start"] >= 9.0
    assert abs(children[-1]["start"] - 29.2) <= 0.3
    # the child before the pause does not keep its last word lit through it
    assert children[-2]["end"] < children[-1]["start"] - 5.0
    assert all(ln.get("pieces") for ln in children)


def test_unmatched_line_keeps_caption_times_clamped_between_neighbours():
    lines = [{"start": 0.0, "end": 2.0, "text": "おはようございます。"},
             {"start": 2.0, "end": 2.5, "text": "うん。"},
             {"start": 2.5, "end": 4.0, "text": "さようなら。"}]
    tokens = toks([(0.1, "おはよう"), (0.6, "ござい"), (1.0, "ます"), (1.9, "さよう"), (2.4, "なら")])
    new, report = asr_transfer.attach(lines, tokens, 6.0)
    assert "pieces" in new[0] and "pieces" in new[2] and "pieces" not in new[1]
    assert new[1]["start"] >= new[0]["end"]
    assert new[1]["end"] - new[1]["start"] >= youtube.MIN_LINE_S
    assert new[2]["start"] >= new[1]["end"]
    assert report["anchored"] == 2


def test_stretched_match_is_rejected():
    line = {"start": 10.0, "end": 13.0, "text": "今日は東京の天気を見ていきましょう。"}
    spread = toks([(5.0 + 2.5 * i, t) for i, t in enumerate(["今日は", "東京の", "天気を", "見て", "いき", "ましょう"])])
    new, report = asr_transfer.attach([line], spread, 6.0)
    assert "pieces" not in new[0] and report["anchored"] == 0
    assert (new[0]["start"], new[0]["end"]) == (10.0, 13.0)
    tight = toks([(10.2 + 0.4 * i, t) for i, t in enumerate(["今日は", "東京の", "天気を", "見て", "いき", "ましょう"])])
    new, report = asr_transfer.attach([line], tight, 6.0)
    assert "pieces" in new[0] and abs(new[0]["start"] - 10.1) < 0.15


def test_monotonic_guard_rejects_a_match_before_the_previous_line():
    lines = [{"start": 4.0, "end": 7.0, "text": "今日は東京の天気を見ていきましょう。"},
             {"start": 8.0, "end": 11.0, "text": "午後からは雲が広がる見込みです。"}]
    tokens = toks([(5.0, "午後"), (5.4, "からは"), (5.8, "雲が"), (6.2, "広がる"), (6.6, "見込み"), (7.0, "です"),
                   (10.0, "今日は"), (10.4, "東京の"), (10.8, "天気を"), (11.2, "見て"), (11.6, "いき"), (12.0, "ましょう")])
    new, report = asr_transfer.attach(lines, tokens, 6.0)
    assert "pieces" in new[0] and abs(new[0]["start"] - 9.9) < 0.15
    assert "pieces" not in new[1] and new[1]["start"] >= new[0]["end"]
    assert report["anchored"] == 1


FALSE_ANCHOR_LINES = [
    {"start": 10.0, "end": 11.0, "text": "そうですね。"},  # the ASR missed this one
    {"start": 11.0, "end": 13.0, "text": "今日は東京の天気を見ていきましょう。"},
    {"start": 13.0, "end": 15.0, "text": "午後からは雲が広がる見込みです。"},
    {"start": 15.0, "end": 17.0, "text": "傘を持って出かけてください。"},
    {"start": 17.0, "end": 19.0, "text": "明日は晴れるでしょう。"},
    {"start": 22.0, "end": 23.0, "text": "そうですね。"},  # the repeat, 12 s later
]
FALSE_ANCHOR_TOKENS = toks([
    (11.1, "今日は"), (11.4, "東京の"), (11.8, "天気を"), (12.1, "見て"), (12.4, "いき"), (12.7, "ましょう"),
    (13.1, "午後"), (13.4, "からは"), (13.7, "雲が"), (14.0, "広がる"), (14.4, "見込み"), (14.8, "です"),
    (15.1, "傘を"), (15.4, "持って"), (15.8, "出かけて"), (16.3, "ください"),
    (17.1, "明日は"), (17.5, "晴れる"), (17.9, "でしょう"),
    (22.1, "そう"), (22.4, "ですね"),
])


def test_a_false_late_anchor_does_not_squeeze_the_lines_after_it():
    new, report = asr_transfer.attach(FALSE_ANCHOR_LINES, FALSE_ANCHOR_TOKENS, 6.0)
    for ln, truth in zip(new[1:5], [11.1, 13.1, 15.1, 17.1]):
        assert "pieces" in ln and abs(ln["start"] - (truth - asr_transfer.PAD_S)) <= 0.3, (ln["text"], ln["start"])
        assert ln["end"] - ln["start"] >= 0.8
    # the first そうですね。 is not dragged to the repeat; the repeat is
    assert "pieces" not in new[0] and (new[0]["start"], new[0]["end"]) == (10.0, 11.0)
    assert "pieces" in new[5] and abs(new[5]["start"] - 22.0) <= 0.15
    assert report["anchored"] == 5 and report["guarded"] == []


def test_stub_guard_gives_up_the_match_that_squeezes_a_span():
    # the false anchor kept (as pass 1 did before the chain): the four lines
    # after it would be stubs, so that match is given up
    found = [(22.0, 22.6, []), (11.0, 12.9, []), (13.0, 14.9, []), (15.0, 16.7, []),
             (17.0, 18.3, []), (22.0, 22.9, [])]
    assert asr_transfer._guard_stubs(FALSE_ANCHOR_LINES, found) == [0]
    assert found[0] is None and all(f is not None for f in found[1:])


def test_stub_guard_keeps_the_old_timing_of_a_run_nothing_explains():
    lines = [{"start": 0.0, "end": 1.0, "text": "a"}, {"start": 1.0, "end": 2.0, "text": "b"},
             {"start": 2.0, "end": 3.0, "text": "c"}, {"start": 3.0, "end": 3.3, "text": "d"}]
    found = [(0.0, 0.3, []), (0.3, 0.6, []), None, None]
    assert asr_transfer._guard_stubs(lines, found) == [0, 1]
    # one stub alone, or a line that was already short, is left as it is
    found = [(0.0, 0.3, []), None, None, None]
    assert asr_transfer._guard_stubs(lines, found) == [] and found[0] is not None


def test_pass_two_finds_a_garbled_line_between_its_neighbours():
    lines = [{"start": 20.0, "end": 22.0, "text": "おはようございます。"},
             {"start": 23.0, "end": 26.0, "text": "傘を持って出かけてください。"},
             {"start": 27.0, "end": 29.0, "text": "さようなら。"}]
    tokens = toks([
        (8.0, "傘を"), (8.5, "持って"), (9.0, "出かけて"), (9.5, "ください"),  # a full copy 15 s early
        (20.1, "おはよう"), (20.6, "ござい"), (21.0, "ます"),
        (23.5, "傘を"), (24.0, "持って"), (24.5, "あいうえお"), (25.0, "かきくけこ"),  # the real one, half garbled
        (27.1, "さよう"), (27.6, "なら"),
    ])
    new, report = asr_transfer.attach(lines, tokens, 6.0)
    assert report["anchored"] == 3
    assert abs(new[1]["start"] - 23.4) < 0.15
    assert asr_transfer.MIN_RATIO_2 <= new[1]["asr_ratio"] < asr_transfer.MIN_RATIO
    assert [p["text"] for p in new[1]["pieces"]] == ["傘", "を", "持って"]


def test_attach_without_tokens_keeps_every_line():
    lines = _fixture_lines()
    new, report = asr_transfer.attach(lines, [], 6.0)
    for a, b in zip(new, lines):
        assert a["start"] == pytest.approx(b["start"]) and a["end"] == pytest.approx(b["end"])
    assert report["anchored"] == 0 and report["median_shift_s"] == 0.0


def test_trim_tails_only_when_the_last_chunk_is_anchored():
    lit = {"start": 10.0, "end": 20.0, "text": "放送を始めます。",
           "pieces": [{"text": "放送", "start": 10.1, "end": 10.5}, {"text": "始めます。", "start": 10.8, "end": 11.5}]}
    loose = {"start": 10.0, "end": 20.0, "text": "放送を始めます。",
             "pieces": [{"text": "放送", "start": 10.1, "end": 10.5}]}
    short = {"start": 10.0, "end": 12.0, "text": "放送を始めます。",
             "pieces": [{"text": "始めます。", "start": 10.8, "end": 11.5}]}
    out = asr_transfer.trim_tails([lit, loose, short, {"start": 20.0, "end": 30.0, "text": "うん。"}])
    assert out[0]["end"] == pytest.approx(11.5 + asr_transfer.PAD_S)
    assert out[1]["end"] == 20.0 and out[2]["end"] == 12.0 and out[3]["end"] == 30.0


# --- the route and the retime job ----------------------------------------------

def make_video(texts=None):
    """A ready video island whose lines are the fixture's manual captions
    with today's even timing: what an island built before yt-precise holds."""
    lines = _fixture_lines()
    island_id = store.create_island("simple", 3, language="ja", source="youtube",
                                    source_name="abc", device=DEV)
    store.add_video(island_id, "abc", 0.0, "t", "")
    for i, ln in enumerate(lines):
        duration = round(ln["end"] - ln["start"], 3)
        store.add_line(island_id, i, {"ja": ln["text"]}, duration, [],
                       segment.align_pieces(ln["text"], [], duration), offset=ln["start"])
    store.set_ready(island_id, "t")
    return island_id


def post(island_id, body, headers=HEAD):
    return client.post(f"/shadow/islands/{island_id}/captions-timing", headers=headers, json=body)


def video(island_id):
    return client.get(f"/shadow/islands/{island_id}/video", headers=HEAD).json()


def lines_of(island_id):
    return store.get_island(island_id)["lines"]


def test_route_retimes_lines_and_closes():
    island_id = make_video()
    before = lines_of(island_id)
    resp = post(island_id, {"asr_events": FIXTURE["asr_events"]})
    assert resp.status_code == 200 and resp.json() == {"align": "queued"}
    # TestClient runs the background job before returning
    v = video(island_id)
    assert (v["align"], v["align_error"]) == ("done", "asr")
    folder = store.AUDIO_DIR / island_id
    assert json.loads((folder / "captions.json").read_text())["asr_events"] == FIXTURE["asr_events"]
    backup = json.loads((folder / "timing-before.json").read_text())
    assert [b["words"] for b in backup["lines"]] == [ln["words"] for ln in before]
    after = lines_of(island_id)
    for ln, truth in zip(after, FIXTURE["truth"]):
        assert abs(ln["offset"] - truth["start"]) <= 0.3, (ln["ja"], ln["offset"], truth["start"])
    moved = [i for i, (a, b) in enumerate(zip(before, after)) if a["words"] != b["words"]]
    assert len(moved) >= 10
    block = next(ln for ln in after if ln["ja"].startswith("はい"))
    assert block["words"][-1]["start"] >= 12.5  # よろしく… after the 9 s pause, relative to the block
    un = next(ln for ln in after if ln["ja"].startswith("うん"))
    assert un["offset"] == 8.5
    assert post(island_id, {"asr_events": FIXTURE["asr_events"]}).json()["detail"] == {"code": "align_closed"}
    assert store.get_video(island_id)["align_attempts"] == 1


def test_route_rejections():
    island_id = make_video()
    body = {"asr_events": FIXTURE["asr_events"]}
    assert client.post(f"/shadow/islands/{island_id}/captions-timing", json=body).status_code in (401, 503)
    assert post(island_id, body, headers={**HEAD, "X-Shadow-Device": "dddddddd-0000-4000-8000-0000000000b2"}).status_code == 404
    voice = store.create_island("simple", 3, device=DEV)
    assert post(voice, body).json()["detail"] == {"code": "not_video"}
    building = store.create_island("simple", 3, language="ja", source="youtube", source_name="abc", device=DEV)
    store.add_video(building, "abc", 0.0, "t", "")
    resp = post(building, body)
    assert resp.status_code == 409 and resp.json()["detail"] == {"code": "not_ready"}
    assert store.get_video(building)["align_attempts"] == 0
    bad = post(island_id, {"asr_events": [{"segs": [{"utf8": "x", "tOffsetMs": "no"}]}]})
    assert bad.status_code == 400 and bad.json()["detail"] == {"code": "captions_invalid"}
    assert post(island_id, {"asr_events": "x"}).status_code == 400
    store.set_align_status(island_id, "running")
    assert post(island_id, body).json()["detail"] == {"code": "align_busy"}
    store.set_align_status(island_id, "failed", "x", count_attempt=True)
    for _ in range(main.ALIGN_MAX_ATTEMPTS - 1):
        store.set_align_status(island_id, "failed", "x", count_attempt=True)
    assert post(island_id, body).json()["detail"] == {"code": "align_closed"}


def test_route_without_asr_track_is_asr_none_and_touches_nothing():
    island_id = make_video()
    before = lines_of(island_id)
    assert post(island_id, {"asr_events": []}).json() == {"align": "queued"}
    v = video(island_id)
    assert (v["align"], v["align_error"]) == ("done", "asr_none")
    assert lines_of(island_id) == before
    assert not (store.AUDIO_DIR / island_id / "timing-before.json").exists()


def test_retime_failure_is_asr_error_and_keeps_lines(monkeypatch):
    island_id = make_video()
    before = lines_of(island_id)

    def boom(*a, **k):
        raise RuntimeError("no")

    monkeypatch.setattr(caption_timing, "transfer", boom)
    assert post(island_id, {"asr_events": FIXTURE["asr_events"]}).status_code == 200
    v = video(island_id)
    assert (v["align"], v["align_error"]) == ("failed", "asr_error")
    assert lines_of(island_id) == before


def test_transfer_guards_each_write_and_restore_puts_the_old_timing_back(monkeypatch):
    island_id = make_video()
    before = lines_of(island_id)
    real = segment.align_pieces
    changed = [{"text": "changed", "start": 0, "end": 1, "pos": "other", "ruby": []}]
    state = {"done": False}

    def race(*a, **k):
        if not state["done"]:
            state["done"] = True
            store.set_words(island_id, 0, changed)
        return real(*a, **k)

    monkeypatch.setattr(segment, "align_pieces", race)
    report = caption_timing.transfer(island_id, _fixture_tokens(), apply=True)
    assert report["anchored"] == 11 and report["written"] == report["anchored"] - 1
    after = lines_of(island_id)
    assert after[0]["words"] == changed and after[0]["offset"] == before[0]["offset"]
    assert after[1]["offset"] != before[1]["offset"]
    table = caption_timing.format_transfer(report)
    assert "anchored" in table and str(after[1]["ja"][:8]) in table
    monkeypatch.setattr(segment, "align_pieces", real)

    assert caption_timing.restore(island_id) == len(before)
    restored = lines_of(island_id)
    assert [(ln["offset"], ln["duration"], ln["words"]) for ln in restored] == \
        [(ln["offset"], ln["duration"], ln["words"]) for ln in before]
    # a second transfer never overwrites the backup
    caption_timing.transfer(island_id, _fixture_tokens(), apply=True)
    backup = json.loads((store.AUDIO_DIR / island_id / "timing-before.json").read_text())
    assert [b["words"] for b in backup["lines"]] == [ln["words"] for ln in before]


def test_transfer_dry_run_writes_nothing():
    island_id = make_video()
    before = lines_of(island_id)
    report = caption_timing.transfer(island_id, _fixture_tokens(), apply=False)
    assert report["anchored"] == 11 and report["written"] == 0 and len(report["rows"]) == 12
    assert lines_of(island_id) == before
    assert not (store.AUDIO_DIR / island_id / "timing-before.json").exists()


def test_transfer_never_writes_a_guarded_line_and_marks_it(monkeypatch):
    island_id = make_video()
    before = lines_of(island_id)
    real = asr_transfer.attach

    def guarded_first(*a, **k):
        new, report = real(*a, **k)
        assert "pieces" in new[0]
        return new, dict(report, guarded=[0])

    monkeypatch.setattr(asr_transfer, "attach", guarded_first)
    report = caption_timing.transfer(island_id, _fixture_tokens(), apply=True)
    after = lines_of(island_id)
    assert (after[0]["offset"], after[0]["words"]) == (before[0]["offset"], before[0]["words"])
    assert report["rows"][0]["guarded"] and not report["rows"][0]["written"]
    assert not any(r["guarded"] for r in report["rows"][1:]) and report["rows"][1]["written"]
    table = caption_timing.format_transfer(report)
    assert "1 guarded" in table and table.splitlines()[2].split()[5] == "g"


def test_backup_write_is_atomic(monkeypatch):
    island_id = make_video()

    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(caption_timing.os, "replace", boom)
    with pytest.raises(OSError):
        caption_timing.transfer(island_id, _fixture_tokens(), apply=True)
    assert not (store.AUDIO_DIR / island_id / "timing-before.json").exists()


def test_restore_without_or_with_a_corrupt_backup_is_a_clear_error():
    island_id = make_video()
    before = lines_of(island_id)
    with pytest.raises(caption_timing.RestoreError, match="no timing-before.json"):
        caption_timing.restore(island_id)
    path = store.AUDIO_DIR / island_id / "timing-before.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    for junk in ('{"lines": [{"idx": 0, "off', '{"lines": [{"idx": 0}]}', '[]'):
        path.write_text(junk)
        with pytest.raises(caption_timing.RestoreError, match="unreadable"):
            caption_timing.restore(island_id)
    assert lines_of(island_id) == before
