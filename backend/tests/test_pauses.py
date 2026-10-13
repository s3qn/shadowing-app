"""Tests for pauses.py: snapping whisper boundaries to real pauses."""

import math

import pauses

_RAW = [
    ("Los", 0.00, 0.28), ("fines", 0.28, 0.48), ("de", 0.48, 0.72), ("semana", 0.72, 1.02),
    ("me", 1.02, 1.28), ("gusta", 1.28, 1.52), ("caminar", 1.52, 1.98), ("por", 1.98, 2.16),
    ("el", 2.16, 2.34), ("parque", 2.34, 2.62), ("con", 2.62, 2.78), ("mi", 2.78, 3.02),
    ("perro", 3.02, 3.50), ("y", 3.50, 3.78), ("después", 3.78, 4.16), ("tomamos", 4.16, 4.62),
    ("un", 4.62, 4.84), ("café", 4.84, 5.00), ("en", 5.00, 5.18), ("la", 5.18, 5.38),
    ("plaza.", 5.38, 5.60),
]


def _words():
    return [{"text": t, "start": s, "end": e} for t, s, e in _RAW]


def test_recorded_line_snaps_the_comma_pause():
    words = pauses.snap_words(_words(), [(3.27, 3.62)])
    by = {w["text"]: w for w in words}
    assert by["y"]["start"] == 3.62
    assert by["perro"]["end"] == 3.27
    for (t, s, e) in _RAW:
        if t not in ("y", "perro"):
            assert (by[t]["start"], by[t]["end"]) == (s, e)
    for a, b in zip(words, words[1:]):
        assert a["end"] <= b["start"] + 1e-9


def test_far_pause_changes_nothing():
    words = pauses.snap_words(_words(), [(6.5, 6.8)])
    assert [(w["start"], w["end"]) for w in words] == [(s, e) for _, s, e in _RAW]


def test_pause_past_next_word_end_is_skipped():
    words = [
        {"text": "a", "start": 0.0, "end": 1.0},
        {"text": "b", "start": 1.0, "end": 1.2},
        {"text": "c", "start": 1.2, "end": 2.0},
    ]
    pauses.snap_words(words, [(1.0, 1.3)])
    assert (words[1]["start"], words[1]["end"]) == (1.0, 1.2)


def test_two_boundaries_near_one_pause_only_nearest_moves():
    words = [
        {"text": "a", "start": 0.0, "end": 1.0},
        {"text": "b", "start": 1.0, "end": 1.1},
        {"text": "c", "start": 1.1, "end": 2.0},
        {"text": "d", "start": 2.0, "end": 3.0},
    ]
    pauses.snap_words(words, [(0.9, 1.15)])
    assert words[2]["start"] == 1.15 or words[1]["start"] == 1.15
    moved = [w["text"] for w, o in zip(words, [0.0, 1.0, 1.1, 2.0]) if w["start"] != o]
    assert len(moved) == 1


def _tone(seconds, sr=16000):
    return [0.5 * math.sin(2 * math.pi * 440 * i / sr) for i in range(int(seconds * sr))]


def test_find_pauses_finds_a_long_silence():
    sr = 16000
    samples = _tone(0.5) + [0.0] * int(0.3 * sr) + _tone(0.5)
    found = pauses.find_pauses(samples, sr)
    assert len(found) == 1
    assert abs(found[0][0] - 0.5) <= 0.02 and abs(found[0][1] - 0.8) <= 0.02


def test_find_pauses_ignores_short_gaps():
    sr = 16000
    samples = _tone(0.5) + [0.0] * int(0.08 * sr) + _tone(0.5)
    assert pauses.find_pauses(samples, sr) == []
