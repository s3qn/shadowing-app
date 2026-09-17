"""Tests for the pure logic in cues.py.

Hand-written .srt strings and word lists, no files and no network: every
input here is small enough to reason about by hand and every expected value
below was worked out from the function it tests.
"""

import cues


# ---------------------------------------------------------------------------
# parse_srt
# ---------------------------------------------------------------------------

def test_parses_two_cues_with_comma_milliseconds_and_index_lines():
    srt = (
        "1\n"
        "00:00:01,000 --> 00:00:02,500\n"
        "こんにちは\n"
        "\n"
        "2\n"
        "00:00:03,000 --> 00:00:04,000\n"
        "さようなら\n"
    )
    result = cues.parse_srt(srt)
    assert result == [
        {"start": 1.0, "end": 2.5, "text": "こんにちは"},
        {"start": 3.0, "end": 4.0, "text": "さようなら"},
    ]


def test_handles_crlf_and_bom_and_dot_milliseconds_without_index_lines():
    srt = (
        "﻿00:00:00.500 --> 00:00:01.250\r\n"
        "おはよう\r\n"
        "\r\n"
        "00:00:02.000 --> 00:00:03.000\r\n"
        "こんばんは\r\n"
    )
    result = cues.parse_srt(srt)
    assert result == [
        {"start": 0.5, "end": 1.25, "text": "おはよう"},
        {"start": 2.0, "end": 3.0, "text": "こんばんは"},
    ]


def test_strips_tags_and_joins_cjk_lines_without_a_space():
    srt = (
        "1\n"
        "00:00:00,000 --> 00:00:01,000\n"
        "<i>行こう</i>\n"
        "\n"
        "2\n"
        "00:00:01,500 --> 00:00:03,000\n"
        "{\\an8}ねえ、聞いて\n"
        "本当なの？\n"
        "\n"
        "3\n"
        "00:00:03,500 --> 00:00:04,500\n"
        "Hello\n"
        "World\n"
    )
    result = cues.parse_srt(srt)
    texts = [c["text"] for c in result]
    # <i> and {\an8} are stripped; the second cue's two lines are both CJK
    # on the join point (て | 本) so they glue with no space; the third
    # cue's two Latin lines join with one space.
    assert texts == ["行こう", "ねえ、聞いて本当なの？", "Hello World"]


def test_drops_sound_effect_and_empty_and_zero_length_cues():
    srt = (
        "1\n"
        "00:00:00,000 --> 00:00:01,000\n"
        "（ドアの音）\n"
        "\n"
        "2\n"
        "00:00:01,000 --> 00:00:02,000\n"
        "[笑い]\n"
        "\n"
        "3\n"
        "00:00:02,000 --> 00:00:03,000\n"
        "   \n"
        "\n"
        "4\n"
        "00:00:05,000 --> 00:00:05,000\n"
        "同じ時刻\n"
        "\n"
        "5\n"
        "00:00:06,000 --> 00:00:07,000\n"
        "残る\n"
    )
    result = cues.parse_srt(srt)
    assert result == [{"start": 6.0, "end": 7.0, "text": "残る"}]


def test_out_of_order_cues_come_back_sorted_by_start():
    srt = (
        "1\n"
        "00:00:05,000 --> 00:00:06,000\n"
        "あとで\n"
        "\n"
        "2\n"
        "00:00:01,000 --> 00:00:02,000\n"
        "さきに\n"
    )
    result = cues.parse_srt(srt)
    assert [c["start"] for c in result] == [1.0, 5.0]
    assert [c["text"] for c in result] == ["さきに", "あとで"]


def test_junk_block_without_a_timing_line_is_skipped_not_raised():
    srt = (
        "1\n"
        "just some text\n"
        "no timing here at all\n"
        "\n"
        "00:00:00,000 --> 00:00:01,000\n"
        "テスト\n"
    )
    result = cues.parse_srt(srt)
    assert result == [{"start": 0.0, "end": 1.0, "text": "テスト"}]


# ---------------------------------------------------------------------------
# clean_cue_text
# ---------------------------------------------------------------------------

def test_collapses_whitespace_runs_and_strips():
    assert cues.clean_cue_text("  a    b\tc  ") == "a b c"


def test_removes_tags_and_ass_override_blocks():
    assert cues.clean_cue_text("{\\an8}<i>italic</i> text") == "italic text"


# ---------------------------------------------------------------------------
# window
# ---------------------------------------------------------------------------

def test_window_shifts_cues_by_start_s():
    cue_list = [{"start": 10.0, "end": 12.0, "text": "a"}, {"start": 15.0, "end": 17.0, "text": "b"}]

    result = cues.window(cue_list, 10.0, 100.0)

    assert result == [{"start": 0.0, "end": 2.0, "text": "a"}, {"start": 5.0, "end": 7.0, "text": "b"}]


def test_window_drops_cues_entirely_outside_the_trimmed_range():
    cue_list = [
        {"start": 0.0, "end": 5.0, "text": "before"},
        {"start": 10.0, "end": 12.0, "text": "inside"},
        {"start": 40.0, "end": 42.0, "text": "after"},
    ]

    result = cues.window(cue_list, 10.0, 20.0)

    assert [c["text"] for c in result] == ["inside"]


def test_window_clamps_a_cue_that_spills_past_total():
    cue_list = [{"start": 8.0, "end": 35.0, "text": "spans the edge"}]

    result = cues.window(cue_list, 10.0, 20.0)

    assert result == [{"start": 0.0, "end": 20.0, "text": "spans the edge"}]


def test_window_does_not_mutate_the_input_cues():
    original = [{"start": 10.0, "end": 12.0, "text": "a"}]

    cues.window(original, 10.0, 100.0)

    assert original == [{"start": 10.0, "end": 12.0, "text": "a"}]


# ---------------------------------------------------------------------------
# attach_words
# ---------------------------------------------------------------------------

def _base_cues():
    return [{"start": 1.0, "end": 2.0, "text": "a"}, {"start": 3.0, "end": 4.0, "text": "b"}]


def test_word_inside_a_cue_attaches_to_it():
    words = [{"text": "w1", "start": 1.2, "end": 1.4}]
    result = cues.attach_words(_base_cues(), words, 10.0)
    assert result[0]["words"] == [{"text": "w1", "start": 1.2, "end": 1.4}]
    assert result[1]["words"] == []


def test_word_in_the_pad_before_a_cue_attaches():
    # cue 1 starts at 3.0; with pad_before=0.15 its window opens at 2.85.
    words = [{"text": "w2", "start": 2.85, "end": 2.95}]
    result = cues.attach_words(_base_cues(), words, 10.0)
    assert result[0]["words"] == []
    assert result[1]["words"] == [{"text": "w2", "start": 2.85, "end": 2.95}]


def test_word_in_the_gap_between_cues_is_dropped():
    # cue 0's window ends at 2.3 (end 2.0 + pad_after 0.3); cue 1's window
    # opens at 2.85 (start 3.0 - pad_before 0.15). 2.55 falls in neither.
    words = [{"text": "gap", "start": 2.5, "end": 2.6}]
    result = cues.attach_words(_base_cues(), words, 10.0)
    assert result[0]["words"] == []
    assert result[1]["words"] == []


def test_cue_with_no_matching_words_gets_empty_list():
    result = cues.attach_words(_base_cues(), [], 10.0)
    assert result[0]["words"] == []
    assert result[1]["words"] == []


def test_attach_words_does_not_mutate_the_input_cues():
    original = _base_cues()
    cues.attach_words(original, [{"text": "w", "start": 1.2, "end": 1.4}], 10.0)
    assert "words" not in original[0]
    assert "words" not in original[1]


def _assert_every_word_sits_in_its_cues_slice(cue_list, result, words, total):
    """A word attached to cue i has its midpoint inside cue i's slice, and a
    word whose midpoint is inside any slice is attached exactly once."""
    bounds = [cues.slice_bounds(cue_list, i, total) for i in range(len(cue_list))]
    for i, cue in enumerate(result):
        start, end = bounds[i]
        for w in cue["words"]:
            mid = (w["start"] + w["end"]) / 2
            assert start <= mid < end, f"{w['text']} at {mid} is outside cue {i}'s slice {bounds[i]}"
    for w in words:
        mid = (w["start"] + w["end"]) / 2
        in_some_slice = any(s <= mid < e for s, e in bounds)
        attached = sum(1 for cue in result for x in cue["words"] if x["text"] == w["text"])
        assert attached == (1 if in_some_slice else 0), w["text"]


def test_first_word_of_a_back_to_back_cue_attaches_to_that_cue():
    # A's padded span runs to 2.3, but its slice stops at B's start (2.0), so
    # a word at 2.05 to 2.35 is only ever heard in B's audio.
    cue_list = [{"start": 0.5, "end": 2.0, "text": "a"}, {"start": 2.0, "end": 3.5, "text": "b"}]
    words = [
        {"text": "last", "start": 1.6, "end": 1.95},
        {"text": "first", "start": 2.05, "end": 2.35},
    ]
    result = cues.attach_words(cue_list, words, 10.0)
    assert [w["text"] for w in result[0]["words"]] == ["last"]
    assert [w["text"] for w in result[1]["words"]] == ["first"]
    _assert_every_word_sits_in_its_cues_slice(cue_list, result, words, 10.0)


def test_word_after_a_small_gap_attaches_to_the_next_cue():
    # 0.1 s gap: A's slice ends at 2.1 (B's start), B's slice opens at 2.0
    # (A's end). A word at 2.12 to 2.3 is past A's slice.
    cue_list = [{"start": 0.5, "end": 2.0, "text": "a"}, {"start": 2.1, "end": 3.5, "text": "b"}]
    words = [
        {"text": "last", "start": 1.7, "end": 1.98},
        {"text": "first", "start": 2.12, "end": 2.3},
    ]
    result = cues.attach_words(cue_list, words, 10.0)
    assert [w["text"] for w in result[0]["words"]] == ["last"]
    assert [w["text"] for w in result[1]["words"]] == ["first"]
    _assert_every_word_sits_in_its_cues_slice(cue_list, result, words, 10.0)


def test_word_after_a_small_overlap_attaches_to_a_cue_whose_slice_holds_it():
    # A ends at 2.2, B starts at 2.0: no pad on the overlapping sides, so A's
    # slice is [0.35, 2.2) and B's is [2.0, 3.8). A word at 2.25 to 2.45 is
    # only in B's slice even though A's padded span (to 2.5) holds it.
    cue_list = [{"start": 0.5, "end": 2.2, "text": "a"}, {"start": 2.0, "end": 3.5, "text": "b"}]
    words = [
        {"text": "last", "start": 1.5, "end": 1.9},
        {"text": "shared", "start": 2.05, "end": 2.15},
        {"text": "first", "start": 2.25, "end": 2.45},
    ]
    result = cues.attach_words(cue_list, words, 10.0)
    assert "last" in [w["text"] for w in result[0]["words"]]
    assert "first" in [w["text"] for w in result[1]["words"]]
    _assert_every_word_sits_in_its_cues_slice(cue_list, result, words, 10.0)


def test_word_past_the_end_of_the_audio_is_dropped():
    cue_list = [{"start": 0.5, "end": 2.0, "text": "a"}]
    words = [{"text": "late", "start": 2.05, "end": 2.25}]
    result = cues.attach_words(cue_list, words, 2.1)
    assert result[0]["words"] == []


# ---------------------------------------------------------------------------
# slice_bounds
# ---------------------------------------------------------------------------

def test_pad_applied_when_there_is_room():
    three = [{"start": 1.0, "end": 2.0}, {"start": 3.0, "end": 4.0}, {"start": 5.0, "end": 6.0}]
    assert cues.slice_bounds(three, 1, 10.0) == (2.85, 4.3)


def test_start_clamped_at_zero_and_end_clamped_at_total():
    one = [{"start": 0.05, "end": 1.0}]
    assert cues.slice_bounds(one, 0, 1.2) == (0.0, 1.2)


def test_clamped_to_the_neighbouring_cues_edge():
    three = [{"start": 0.0, "end": 1.1}, {"start": 1.2, "end": 2.0}, {"start": 2.05, "end": 3.0}]
    # unpadded start (1.2 - 0.15 = 1.05) would land before the previous
    # cue's end (1.1); unpadded end (2.0 + 0.30 = 2.3) would land past the
    # next cue's start (2.05). Both get clamped to that neighbour's edge.
    assert cues.slice_bounds(three, 1, 10.0) == (1.1, 2.05)


def test_pad_not_applied_when_neighbours_overlap():
    left_overlap = [{"start": 0.0, "end": 1.5}, {"start": 1.2, "end": 2.0}, {"start": 3.0, "end": 4.0}]
    start, _ = cues.slice_bounds(left_overlap, 1, 10.0)
    assert start == 1.2  # previous cue's end (1.5) is past this cue's start

    right_overlap = [{"start": 0.0, "end": 1.0}, {"start": 1.2, "end": 2.5}, {"start": 2.0, "end": 3.0}]
    _, end = cues.slice_bounds(right_overlap, 1, 10.0)
    assert end == 2.5  # next cue's start (2.0) is before this cue's end


# ---------------------------------------------------------------------------
# split_long
# ---------------------------------------------------------------------------

def test_splits_an_eleven_second_cue_at_the_period_before_eight_seconds():
    words = [
        {"text": "これは", "start": 0.0, "end": 1.0},
        {"text": "テストです。", "start": 1.0, "end": 6.5},
        {"text": "そして", "start": 7.0, "end": 7.8},
        {"text": "まだ続きます", "start": 7.9, "end": 10.8},
        {"text": "ね", "start": 10.85, "end": 11.0},
    ]
    cue = {"start": 0.0, "end": 11.0, "text": "".join(w["text"] for w in words), "words": words}
    result = cues.split_long([cue])
    assert [(p["start"], p["end"], p["text"]) for p in result] == [
        (0.0, 6.5, "これはテストです。"),
        (7.0, 11.0, "そしてまだ続きますね"),
    ]


def test_splits_at_a_gap_when_there_is_no_punctuation():
    words = [
        {"text": "これは", "start": 0.0, "end": 1.0},
        {"text": "テストです", "start": 1.0, "end": 6.0},
        {"text": "そして", "start": 7.0, "end": 7.8},
        {"text": "まだ", "start": 7.85, "end": 8.5},
        {"text": "つづきます", "start": 8.6, "end": 10.5},
    ]
    cue = {"start": 0.0, "end": 10.5, "text": "".join(w["text"] for w in words), "words": words}
    result = cues.split_long([cue])
    assert [(p["start"], p["end"], p["text"]) for p in result] == [
        (0.0, 6.0, "これはテストです"),
        (7.0, 10.5, "そしてまだつづきます"),
    ]


def test_cue_without_words_passes_through_unchanged():
    cue = {"start": 0.0, "end": 20.0, "text": "no words on this one"}
    result = cues.split_long([cue])
    assert result == [cue]
    assert result[0] is cue


def test_cue_not_longer_than_max_seconds_passes_through_unchanged():
    cue = {
        "start": 0.0,
        "end": 5.0,
        "text": "short",
        "words": [{"text": "short", "start": 0.0, "end": 5.0}],
    }
    result = cues.split_long([cue])
    assert result == [cue]
    assert result[0] is cue


def test_single_word_cue_is_left_even_if_over_length():
    cue = {
        "start": 0.0,
        "end": 9.0,
        "text": "single",
        "words": [{"text": "single", "start": 0.0, "end": 9.0}],
    }
    result = cues.split_long([cue])
    assert len(result) == 1
    assert result[0]["start"] == 0.0
    assert result[0]["end"] == 9.0
    assert result[0]["text"] == "single"
