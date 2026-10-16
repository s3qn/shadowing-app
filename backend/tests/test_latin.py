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


# ---------------------------------------------------------------------------
# aligner rescue
# ---------------------------------------------------------------------------

def test_collapsed_podcast_run_is_respread():
    text = "Estudio en Ornot, que prepara rocas de bicicleta, en 2013."
    spec = [
        ("Estudio", 0.00, 0.64), ("en", 0.64, 1.16), ("Ornot,", 1.16, 2.48),
        ("que", 2.48, 2.48), ("prepara", 2.48, 2.48), ("rocas", 2.48, 2.48),
        ("de", 2.48, 2.48), ("bicicleta,", 2.48, 2.48), ("en", 2.60, 2.78),
        ("2013.", 2.78, 4.40),
    ]
    pieces = [{"text": t, "start": s, "end": e} for t, s, e in spec]
    out = latin.align(text, pieces, 4.40)

    assert [w["text"] for w in out] == text.split()
    assert len(out) == 10
    assert out[0]["start"] == 0.0
    assert out[-1]["end"] == 4.40
    for a, b in zip(out, out[1:]):
        assert a["end"] == b["start"]
    # Plan said 0.1s; a two-letter word gets about 0.09s of a 1.6s run.
    assert all(w["end"] - w["start"] >= 0.08 for w in out)
    assert out[2]["end"] - out[2]["start"] <= 0.8
    assert (out[0]["start"], out[0]["end"]) == (0.0, 0.64)
    assert (out[1]["start"], out[1]["end"]) == (0.64, 1.16)


def test_zero_length_piece_does_not_anchor():
    text = "uno dos tres"
    pieces = [
        {"text": "uno", "start": 0.0, "end": 1.0},
        {"text": "dos", "start": 1.5, "end": 1.5},
        {"text": "tres", "start": 2.0, "end": 3.0},
    ]
    out = latin.align(text, pieces, 3.0)
    assert (out[1]["start"], out[1]["end"]) == (1.0, 2.0)


# ---------------------------------------------------------------------------
# align_phonemes
# ---------------------------------------------------------------------------

def _ph(*spec):
    return [{"phoneme": p, "start": a, "end": b} for p, a, b in spec]


HOLA = _ph(
    ("o", 0.05, 0.2), ("l", 0.2, 0.3), ("a", 0.3, 0.4), (",", 0.4, 0.5), (" ", 0.5, 0.55),
    ("m", 0.6, 0.7), ("u", 0.7, 0.9), (" ", 0.9, 0.95),
    ("g", 1.0, 1.1), ("u", 1.1, 1.3), (".", 1.3, 1.35),
)


def test_align_phonemes_spans_are_contiguous_and_own_their_trailing_gap_and_keep_absolute_times():
    words = latin.align_phonemes("Hola, mucho gusto.", HOLA, 1.4)
    assert [w["text"] for w in words] == ["Hola,", "mucho", "gusto."]
    assert [(w["start"], w["end"]) for w in words] == [(0.05, 0.6), (0.6, 1.0), (1.0, 1.35)]


def test_align_phonemes_shape_matches_align():
    words = latin.align_phonemes("Hola, mucho gusto.", HOLA, 1.4)
    ref = latin.align("Hola, mucho gusto.", [], 1.4)[0]
    assert set(words[0]) == set(ref)
    assert words[0]["pos"] == "other"
    assert words[0]["ruby"] == [{"text": "Hola,", "rt": ""}]


def test_align_phonemes_mismatch_returns_empty():
    assert latin.align_phonemes("Hola mucho gusto amigos", HOLA, 1.4) == []


def test_align_phonemes_empty_timings_returns_empty():
    assert latin.align_phonemes("Hola", [], 1.0) == []


def test_align_phonemes_tolerates_edge_spaces():
    t = _ph((" ", 0.0, 0.1)) + _ph(("o", 0.1, 0.5), ("a", 0.5, 0.9)) + _ph((" ", 0.9, 1.0))
    words = latin.align_phonemes("Hola", t, 1.0)
    assert [(w["start"], w["end"]) for w in words] == [(0.1, 0.9)]


def test_align_phonemes_keeps_absolute_times_with_pads_and_gap():
    t = _ph(("a", 0.054, 0.5), (" ", 0.5, 0.6), ("b", 0.6, 1.1), (".", 1.1, 1.154),
            (" ", 1.154, 1.374), ("c", 1.374, 2.5))
    words = latin.align_phonemes("aa bb. cc", t, 2.7)
    assert [(w["start"], w["end"]) for w in words] == [(0.054, 0.6), (0.6, 1.374), (1.374, 2.5)]
