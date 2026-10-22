"""BL-45: the kana guard, ASR corrections and clause splitting (pure, no CLI)."""

import logging

import pytest

import segment
import youtube


@pytest.mark.parametrize("orig,cand,reason", [
    ("決めてが大事です", "決め手が大事です", "moras:"),
    ("分かりました", "別れました", "moras:"),
    ("レ フラッグだよ", "レッドフラッグだよ", "moras:"),
    ("上緒がある", "情緒がある", "kanji-swap"),
])
def test_sean_cases_pass_the_guard(orig, cand, reason):
    ok, why = segment.sound_alike(orig, cand)
    assert ok, why
    assert why.startswith(reason)


@pytest.mark.parametrize("orig,cand", [
    ("お金がないから", "お金がないので"),
    ("好きです", "嫌いです"),
    ("食べた", "食べない"),
    ("行きます", "行きました"),
    ("私が行く", "私は行く"),
    ("行くけど", "行くから"),
])
def test_meaning_changes_are_rejected(orig, cand):
    ok, why = segment.sound_alike(orig, cand)
    assert not ok, why


def test_rewrite_is_rejected():
    ok, why = segment.sound_alike("お金がないから", "財布が空っぽです")
    assert not ok and why == "function-word"


def test_length_reject():
    assert segment.sound_alike("お金がないから別れました", "お金") == (False, "length")
    assert segment.sound_alike("お金", "") == (False, "length")


TEXT = "お金がないから、別れましたけど、まあそれって普通とかじゃないので、そう思います"


def test_split_at_clause_ends_with_monotonic_times():
    ln = {"start": 10.0, "end": 22.0, "text": TEXT}
    kids = youtube.split_lines([ln])
    assert len(kids) > 1
    assert "".join(k["text"] for k in kids) == TEXT
    assert all(len(k["text"]) <= 25 for k in kids)
    assert kids[0]["start"] == 10.0 and kids[-1]["end"] == 22.0
    for a, b in zip(kids, kids[1:]):
        assert a["end"] == b["start"] and a["start"] < a["end"]
    assert sum(k["end"] - k["start"] for k in kids) == pytest.approx(12.0)
    assert all(k["text"].endswith(("、", "ので", "けど")) or k is kids[-1] for k in kids)


def test_short_line_passes_through_same_object():
    ln = {"start": 0.0, "end": 4.0, "text": "あいうえおかきくけこさしすせそたちつてと"}
    assert youtube.split_lines([ln])[0] is ln


def test_pieces_go_to_exactly_one_child_and_cut_follows_onset():
    parts = ["お金がないから、", "別れましたけど、", "まあそれって普通とかじゃないので、", "そう思います"]
    pieces, t = [], 10.0
    for p in parts:
        pieces.append({"text": p, "start": t, "end": t + 3.0})
        t += 3.0
    ln = {"start": 10.0, "end": t, "text": TEXT, "pieces": pieces}
    kids = youtube.split_lines([ln])
    assert len(kids) > 1
    got = [p for k in kids for p in k["pieces"]]
    assert sorted(p["start"] for p in got) == [p["start"] for p in pieces]
    onsets = [p["start"] for p in pieces]
    for k in kids[1:]:
        assert min(abs(k["start"] - o) for o in onsets) <= 0.15


def test_no_pieces_splits_linearly():
    kids = youtube.split_lines([{"start": 0.0, "end": 12.0, "text": TEXT}])
    assert "pieces" not in kids[0]
    first = len(kids[0]["text"]) / len(TEXT)
    assert kids[0]["end"] == pytest.approx(12.0 * first, abs=0.01)


def test_no_pieces_with_rate_cuts_on_the_mora_clock():
    kids = youtube.split_lines([{"start": 0.0, "end": 12.0, "text": TEXT}], rate=6.0)
    assert len(kids) > 1
    assert "".join(k["text"] for k in kids) == TEXT
    assert "pieces" not in kids[0]
    assert kids[0]["end"] == pytest.approx(len(segment.moras_of(kids[0]["text"])) / 6.0, abs=0.02)
    assert kids[-1]["end"] == 12.0


def test_hard_cap_cuts_on_chunk_boundary_only():
    text = "今日は友達と一緒に新しいレストランへ行って美味しい料理をたくさん食べて楽しい時間を過ごしました"
    kids = youtube.split_lines([{"start": 0.0, "end": 9.0, "text": text}])
    assert len(kids) > 1
    assert "".join(k["text"] for k in kids) == text
    ends, pos = set(), 0
    for c in segment.tokenize(text):
        pos += len(c["text"])
        ends.add(pos)
    pos = 0
    for k in kids[:-1]:
        pos += len(k["text"])
        assert pos in ends


def _assert_sane(kids, ln):
    assert "".join(k["text"] for k in kids).replace("　", "") == ln["text"].replace("　", "").strip()
    for k in kids:
        assert sum(ch.isalnum() for ch in k["text"]) >= 2, k
    for a, b in zip(kids, kids[1:]):
        assert a["start"] < b["start"] and a["end"] == b["start"]
    if "pieces" in ln:
        for k in kids:
            assert k["pieces"], k
            assert "".join(p["text"] for p in k["pieces"]).replace(" ", "") == k["text"].replace(" ", "")
            starts = [p["start"] for p in k["pieces"]]
            assert starts == sorted(starts) and k["start"] <= starts[0] < k["end"]


def test_punctuation_only_tail_merges_into_previous_child():
    ln = {"start": 0.0, "end": 10.0, "text": "今日はとても楽しかったです。ね。"}
    kids = youtube.split_lines([ln])
    _assert_sane(kids, ln)
    assert kids[-1]["text"].endswith("ね。")


def test_whitespace_child_is_never_emitted(monkeypatch):
    left = "あいうえおかきくけこさしすせそたちつてとなにぬねの"
    gap = "\u3000" * 10
    right = "はひふへほまみむめもやゆよらりるれろわをん" * 2 + "がぎぐ"
    text = left + gap + right
    monkeypatch.setattr(segment, "tokenize", lambda t: [{"text": left}, {"text": gap}, {"text": right}])
    ln = {"start": 0.0, "end": 16.0, "text": text}
    kids = youtube.split_lines([ln])
    _assert_sane(kids, ln)


def test_pieces_cover_child_text_when_cut_falls_inside_a_piece():
    parts = ["お金がない", "から、別れ", "ましたけど、まあそれって", "普通とかじゃないので、そう思います"]
    pieces, t = [], 10.0
    for p in parts:
        pieces.append({"text": p, "start": t, "end": t + 3.0})
        t += 3.0
    ln = {"start": 10.0, "end": t, "text": TEXT, "pieces": pieces}
    kids = youtube.split_lines([ln])
    assert len(kids) > 1
    _assert_sane(kids, ln)


# ---- CLI calls and wiring (the claude CLI is always faked) ----

import asyncio
import json
import uuid

import align
import generate
import main
import store


class FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


def _fake_cli(monkeypatch, replies):
    prompts = []

    def run(cmd, *a, **k):
        prompts.append(" ".join(map(str, cmd)) + str(k.get("input", "")))
        r = replies.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    monkeypatch.setattr(generate.subprocess, "run", run)
    return prompts


def test_translate_with_context_still_returns_len(monkeypatch):
    prompts = _fake_cli(monkeypatch, [FakeCompleted(stdout='["a", "b"]')])
    out = generate.translate_lines(["一", "二"], "ja", "en", before=["前"], after=["後"])
    assert out == ["a", "b"]
    assert "Context before (do not translate)" in prompts[0] and "後" in prompts[0]


def _island():
    store.init()
    iid = store.create_island("simple", 3, source="youtube", source_name="dQw4w9WgXcQ", device=str(uuid.uuid4()))
    store.add_video(iid, "dQw4w9WgXcQ", 0.0, "Clip", "")
    return iid


def _fake_wav(src, dst, max_seconds=None):
    import wave

    with wave.open(str(dst), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 16000 * 20)
    return True


def _upload_while_building(monkeypatch):
    """An island mid-build with the phone's audio already queued."""
    monkeypatch.setattr(main, "_align_queue", None)
    monkeypatch.setattr(main, "_align_deferred", set())
    monkeypatch.setattr(main, "_to_wav", _fake_wav)
    monkeypatch.setattr(main.repair, "job", lambda *a, **k: None)
    monkeypatch.setattr(generate, "translate_lines", lambda b, *a, **k: ["en"] * len(b))
    iid = _island()
    store.set_stage(iid, "aligning")
    store.video_audio_path(iid, "src").write_bytes(b"x")
    store.set_align_status(iid, "queued", count_attempt=True)
    return iid


def test_upload_during_build_aligns_the_lines_once(monkeypatch):
    jobs = []

    def fake_run(job, out, **kw):
        jobs.append(json.loads(job.read_text(encoding="utf-8")))
        return {"windows": [], "errors": []}

    monkeypatch.setattr(align, "run_job", fake_run)
    iid = _upload_while_building(monkeypatch)
    asyncio.run(main._align_one(iid))
    video = store.get_video(iid)
    assert (video["align_status"], video["align_attempts"]) == ("queued", 1)
    assert store.video_audio_path(iid, "src").exists() and jobs == []

    lines = [{"start": 0.0, "end": 2.0, "text": "上緒がある"}, {"start": 2.0, "end": 14.0, "text": TEXT}]
    asyncio.run(main._build_from_captions(iid, lines, "Clip", asr=True))
    queue = main._get_align_queue()
    assert queue.qsize() == 1 and queue.get_nowait() == iid
    asyncio.run(main._align_one(iid))
    assert len(jobs) == 1
    text = " ".join(w["text"] for w in jobs[0]["windows"])
    assert "上緒がある" in text
    assert store.get_video(iid)["align_status"] == "done"
    assert main._align_deferred == set()


def test_build_done_before_the_consumer_looks_does_not_requeue(monkeypatch):
    runs = []
    monkeypatch.setattr(align, "run_job", lambda job, out, **kw: runs.append(1) or {"windows": []})
    iid = _upload_while_building(monkeypatch)
    asyncio.run(main._build_from_captions(iid, [{"start": 0.0, "end": 2.0, "text": "上緒がある"}], "Clip", asr=True))
    assert main._get_align_queue().qsize() == 0
    asyncio.run(main._align_one(iid))
    assert runs == [1] and store.get_video(iid)["align_status"] == "done"


def test_failed_build_fails_a_deferred_alignment(monkeypatch):
    iid = _upload_while_building(monkeypatch)
    asyncio.run(main._align_one(iid))
    monkeypatch.setattr(youtube, "cues_from_lines", lambda lines: 1 / 0)
    asyncio.run(main._build_from_captions(iid, [{"start": 0.0, "end": 2.0, "text": "x"}], "Clip"))
    assert main._get_align_queue().get_nowait() == iid
    asyncio.run(main._align_one(iid))
    video = store.get_video(iid)
    assert (video["align_status"], video["align_error"]) == ("failed", "align_not_ready")
    assert not store.video_audio_path(iid, "src").exists()


def _chunks(*parts):
    return [{"text": p, "moras": ["ア"] * len(p), "unknown": False, "pos": "other"} for p in parts]


@pytest.mark.parametrize("parts", [
    ("そろそろ", "か。7", "時", "に", "なったら", "ね、", "俺", "は", "生放送", "を", "やって"),
    ("そろそろ", "か。", "7", "時", "に", "なったら", "ね、", "俺", "は", "生放送", "を", "やって"),
    ("そろそろ", "か。", "1", "0", "月", "に", "なったら", "ね、", "俺", "は", "生放送", "を", "やって"),
])
def test_never_cuts_a_number_off_its_counter(monkeypatch, parts):
    text = "".join(parts)
    monkeypatch.setattr(segment, "tokenize", lambda t: _chunks(*parts))
    kids = youtube.split_lines([{"start": 0.0, "end": 12.0, "text": text}], max_chars=8, max_s=3.0)
    assert "".join(k["text"] for k in kids) == text
    assert len(kids) > 1
    for k in kids:
        assert not k["text"][-1].isdigit(), k["text"]
    assert kids[0]["text"] == "そろそろか。"


def test_real_tokenizer_keeps_counters_whole():
    for text in ("そろそろか。7時になったらね、俺は生放送をやって", "6時半に3人で10月の話をして"):
        kids = youtube.split_lines([{"start": 0.0, "end": 8.0, "text": text}], max_chars=6, max_s=2.0)
        assert "".join(k["text"] for k in kids) == text
        assert not any(k["text"][-1].isdigit() for k in kids)
