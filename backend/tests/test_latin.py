"""Tests for the pure logic in latin.py: word timing for space-separated
languages (es, en), the counterpart to test_segment.py for ja."""

import latin


# ---------------------------------------------------------------------------
# split_words
# ---------------------------------------------------------------------------

def test_split_keeps_punctuation_attached():
    assert latin.split_words("Hola, mucho gusto.") == ["Hola,", "mucho", "gusto."]


def test_split_empty_text_is_empty():
    assert latin.split_words("") == []


# ---------------------------------------------------------------------------
# align
# ---------------------------------------------------------------------------

def test_align_anchors_on_matching_pieces():
    text = "Hola mucho gusto"
    pieces = [
        {"text": "Hola", "start": 0.0, "end": 0.5},
        {"text": "mucho", "start": 0.5, "end": 1.0},
        {"text": "gusto", "start": 1.0, "end": 1.5},
    ]
    words = latin.align(text, pieces, 1.5)
    assert [w["text"] for w in words] == ["Hola", "mucho", "gusto"]
    assert words[0]["start"] == 0.0
    assert words[-1]["end"] == 1.5
    for w in words:
        assert w["pos"] == "other"
        assert w["ruby"] == [{"text": w["text"], "rt": ""}]


def test_align_is_accent_and_case_insensitive():
    # "esta" (whisper's piece) matches "está" (the stored text) despite the
    # accent and case difference.
    text = "Esta bien"
    pieces = [
        {"text": "esta", "start": 0.0, "end": 0.4},
        {"text": "bien", "start": 0.4, "end": 0.8},
    ]
    words = latin.align(text, pieces, 0.8)
    assert words[0]["start"] == 0.0
    assert words[0]["end"] == 0.4
    assert words[1]["start"] == 0.4
    assert words[1]["end"] == 0.8


def test_align_spreads_unanchored_run_by_character_count():
    # "y" (1 char) and "gusto" (5 chars) both fall between the two anchors,
    # so "gusto" gets five times the share of "y".
    text = "Hola y gusto adios"
    pieces = [
        {"text": "Hola", "start": 0.0, "end": 1.0},
        {"text": "adios", "start": 7.0, "end": 8.0},
    ]
    words = latin.align(text, pieces, 8.0)
    assert words[0]["text"] == "Hola"
    assert words[0]["start"] == 0.0
    assert words[0]["end"] == 1.0
    y, gusto = words[1], words[2]
    assert y["text"] == "y"
    assert gusto["text"] == "gusto"
    y_span = y["end"] - y["start"]
    gusto_span = gusto["end"] - gusto["start"]
    assert abs(gusto_span - 5 * y_span) < 1e-6
    assert y["start"] == 1.0
    assert gusto["end"] == 7.0
    assert words[-1]["text"] == "adios"
    assert words[-1]["end"] == 8.0


def test_align_with_no_pieces_gives_a_steady_pace():
    text = "one two six"  # three equal-length (3-char) tokens
    words = latin.align(text, [], 3.0)
    assert [w["text"] for w in words] == ["one", "two", "six"]
    assert words[0]["start"] == 0.0
    assert words[-1]["end"] == 3.0
    # Equal-length tokens split the duration evenly.
    spans = [round(w["end"] - w["start"], 3) for w in words]
    assert spans == [1.0, 1.0, 1.0]


def test_align_first_start_is_zero_and_last_end_is_duration():
    text = "a b c"
    pieces = [{"text": "b", "start": 1.0, "end": 1.2}]
    words = latin.align(text, pieces, 2.5)
    assert words[0]["start"] == 0.0
    assert words[-1]["end"] == 2.5


def test_align_garbage_pieces_fall_back_to_one_word():
    # Pieces are the wrong shape (missing start/end), so alignment raises and
    # the whole line comes back as a single word.
    text = "Hola mucho gusto"
    pieces = [{"text": "Hola"}]
    words = latin.align(text, pieces, 1.5)
    assert len(words) == 1
    assert words[0]["text"] == text
    assert words[0]["start"] == 0.0
    assert words[0]["end"] == 1.5


def test_align_empty_text_returns_whole_fallback_shape():
    words = latin.align("", [], 1.0)
    assert words == [
        {"text": "", "start": 0.0, "end": 1.0, "pos": "other", "ruby": [{"text": "", "rt": ""}]}
    ]


def test_align_non_positive_duration_is_empty():
    assert latin.align("hola", [], 0.0) == []
