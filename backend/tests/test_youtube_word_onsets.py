"""json3 seg onsets become word times through align_pieces / latin.align."""

import pytest

import latin
import segment
import youtube


def tev(start_ms, dur_ms, *segs):
    """segs: (text, offset_ms or None)."""
    out = []
    for t, off in segs:
        d = {"utf8": t}
        if off is not None:
            d["tOffsetMs"] = off
        out.append(d)
    return {"tStartMs": start_ms, "dDurationMs": dur_ms, "segs": out}


ASR = tev(10000, 3000, ("今日", None), ("は", 800), ("いい", 1400), ("天気", 1900))


def test_asr_onsets_to_word_starts():
    lines = youtube.json3_to_lines([ASR])
    assert [round(p["start"], 3) for p in lines[0]["pieces"]] == [10.0, 10.8, 11.4, 11.9]
    cue = youtube.cues_from_lines(lines)[0]
    words = segment.align_pieces(cue["text"], cue["pieces"], 3.0)
    starts = [w["start"] for w in words]
    assert starts[0] == 0.0
    assert words[-1]["end"] == pytest.approx(3.0)
    for a, b in zip(words, words[1:]):
        assert a["end"] == pytest.approx(b["start"])
    for want in (0.8, 1.4, 1.9):
        assert min(abs(s - want) for s in starts) < 0.15


def test_manual_track_has_no_pieces():
    lines = youtube.json3_to_lines([tev(0, 3000, ("今日", None), ("は", None), ("いい天気", None))])
    assert "pieces" not in lines[0]
    cue = youtube.cues_from_lines(lines)[0]
    assert cue["pieces"] == []
    assert segment.align_pieces(cue["text"], cue["pieces"], 3.0) == segment.align_pieces(cue["text"], [], 3.0)


def test_straddling_word_starts_at_first_seg():
    ev = tev(0, 2000, ("勉", None), ("強", 700))
    cue = youtube.cues_from_lines(youtube.json3_to_lines([ev]))[0]
    words = segment.align_pieces(cue["text"], cue["pieces"], 2.0)
    assert words[0]["start"] == 0.0
    for a, b in zip(words, words[1:]):
        assert a["end"] == pytest.approx(b["start"])
    assert words[-1]["end"] == pytest.approx(2.0)


def test_merge_keeps_both_pieces():
    a = tev(0, 2000, ("ab", None), ("cd", 500))
    b = tev(2000, 100, ("ef", None), ("gh", 50))
    lines = youtube.json3_to_lines([a, b])
    assert len(lines) == 1 and len(lines[0]["pieces"]) == 4


def test_overlap_clip_keeps_pieces_in_range():
    a = tev(0, 4000, ("ab", None), ("cd", 3000))
    b = tev(2000, 4000, ("ef", None), ("gh", 500))
    lines = youtube.json3_to_lines([a, b])
    cues = youtube.cues_from_lines(lines)
    for c in cues:
        dur = c["end"] - c["start"]
        for p in c["pieces"]:
            assert 0 <= p["start"] < p["end"] <= dur + 1e-9


def test_english_offsets_through_latin_align():
    ev = tev(5000, 3000, ("hello", None), (" brave", 1000), (" world", 2000))
    cue = youtube.cues_from_lines(youtube.json3_to_lines([ev]))[0]
    words = latin.align(cue["text"], cue["pieces"], 3.0)
    assert [round(w["start"], 1) for w in words] == [0.0, 1.0, 2.0]
    assert words[-1]["end"] == pytest.approx(3.0)


@pytest.mark.parametrize("bad", ["5", -1, True, float("nan")])
def test_bad_offset_drops_pieces(bad):
    lines = youtube.json3_to_lines([tev(0, 1000, ("a", None), ("b", bad))])
    assert len(lines) == 1
    assert "pieces" not in lines[0]


def test_merge_with_one_sided_pieces_drops_pieces():
    first = tev(0, 1000, ("a", None), ("b", 500))
    short = tev(1000, 100, ("c", None))
    lines = youtube.json3_to_lines([first, short])
    assert len(lines) == 1
    assert "pieces" not in lines[0]
