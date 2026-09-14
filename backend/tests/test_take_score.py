"""Tests for take_score.py, the envelope DTW take scorer.

Builds synthetic lines from bursts of filtered noise (four words, generous
silent gaps so a shifted word cannot collide with its neighbours) instead of
real recordings, so the suite needs no wav fixtures and runs in well under a
second. Every random draw is seeded, so a failure here always means a real
change in take_score.py's output, never a different draw.
"""

from __future__ import annotations

import numpy as np
import pytest

import take_score as ts

SR = 24000

# ms layout shared by most tests: four 300 ms words with 500 ms of silence
# between them, so a word can move up to 350 ms in either direction without
# touching its neighbour.
_WORD_MS = 300
_GAP_MS = 500
_STARTS_MS = [0, _WORD_MS + _GAP_MS, 2 * (_WORD_MS + _GAP_MS), 3 * (_WORD_MS + _GAP_MS)]
_LINE_MS = _STARTS_MS[-1] + _WORD_MS

WORDS = [{"start": s / 1000.0, "end": (s + _WORD_MS) / 1000.0} for s in _STARTS_MS]


def _burst(rng: np.random.Generator, ms: float) -> np.ndarray:
    n = int(SR * ms / 1000)
    raw = rng.normal(0.0, 1.0, n + 8)
    kernel = np.ones(8) / 8.0
    x = np.convolve(raw, kernel, mode="valid")[:n]
    return (x / (np.max(np.abs(x)) + 1e-9)).astype(np.float64)


def _silence(ms: float) -> np.ndarray:
    return np.zeros(int(SR * ms / 1000), dtype=np.float64)


def _reference(rng: np.random.Generator) -> np.ndarray:
    parts = []
    for i, _ in enumerate(_STARTS_MS):
        parts.append(_burst(rng, _WORD_MS))
        if i < len(_STARTS_MS) - 1:
            parts.append(_silence(_GAP_MS))
    return np.concatenate(parts)


def test_identical_take_is_all_ok_with_behind_near_zero():
    rng = np.random.default_rng(1)
    ref = _reference(rng)
    take = ref.copy()
    result = ts.score_take(ref, take, SR, WORDS, 1.0, None, 0.0, 0, "echo")
    assert result["words"] == ["ok", "ok", "ok", "ok"]
    assert result["note"] == ""
    assert abs(result["behindMs"]) <= 40
    for off in result["offsetsMs"]:
        assert off is not None
        assert abs(off) <= 40


def test_shifted_take_reads_as_behind_until_lag_absorbs_it():
    rng = np.random.default_rng(2)
    ref = _reference(rng)
    take = np.concatenate([_silence(300), ref])

    no_lag = ts.score_take(ref, take, SR, WORDS, 1.0, None, 0.0, 0, "echo")
    assert no_lag["words"] == ["ok", "ok", "ok", "ok"]
    assert abs(no_lag["behindMs"] - 300) <= 40

    with_lag = ts.score_take(ref, take, SR, WORDS, 1.0, None, 0.0, 300, "echo")
    assert with_lag["words"] == ["ok", "ok", "ok", "ok"]
    assert abs(with_lag["behindMs"]) <= 40


def test_dropped_word_is_marked_dropped_and_the_rest_ok():
    rng = np.random.default_rng(3)
    ref = _reference(rng)
    take = ref.copy()
    a = int(SR * _STARTS_MS[2] / 1000)
    b = a + int(SR * _WORD_MS / 1000)
    take[a:b] = 0.0
    result = ts.score_take(ref, take, SR, WORDS, 1.0, None, 0.0, 0, "echo")
    assert result["words"] == ["ok", "ok", "dropped", "ok"]


def test_word_moved_earlier_reads_early_and_the_rest_ok():
    rng = np.random.default_rng(4)
    ref = _reference(rng)
    take = np.concatenate([
        _burst(rng, _WORD_MS),              # word 0, on time
        _silence(_GAP_MS - 350),            # gap shrunk: word 1 arrives 350ms early
        _burst(rng, _WORD_MS),               # word 1
        _silence(_GAP_MS + 350),            # gap grown back: word 2 lands on time
        _burst(rng, _WORD_MS),               # word 2
        _silence(_GAP_MS),
        _burst(rng, _WORD_MS),               # word 3
    ])
    result = ts.score_take(ref, take, SR, WORDS, 1.0, None, 0.0, 0, "echo")
    assert result["words"] == ["ok", "early", "ok", "ok"]


def test_noise_only_take_is_unscored_as_no_voice_heard():
    rng = np.random.default_rng(5)
    ref = _reference(rng)
    take = rng.normal(0.0, 1e-6, len(ref))
    result = ts.score_take(ref, take, SR, WORDS, 1.0, None, 0.0, 0, "echo")
    assert result["words"] == ["none", "none", "none", "none"]
    assert result["offsetsMs"] == [None, None, None, None]
    assert result["behindMs"] is None
    assert result["note"] == "No voice heard in the take"


def test_no_anchor_is_unscored_without_running_dtw():
    rng = np.random.default_rng(6)
    ref = _reference(rng)
    take = ref.copy()
    result = ts.score_take(ref, take, SR, WORDS, 1.0, None, None, 0, None)
    assert result["words"] == ["none", "none", "none", "none"]
    assert result["anchor"] is None
    assert result["note"] == "No timing anchor"


def test_anchor_past_end_of_take_is_no_timing_anchor_not_no_voice():
    rng = np.random.default_rng(7)
    ref = _reference(rng)
    take = _burst(rng, 300)
    # A clock anchor far past the end of a short take: after the 500ms lead
    # is stripped there are no take frames left to slice, so there is
    # nothing to say the take was silent, only that the anchor is bad.
    result = ts.score_take(ref, take, SR, WORDS, 1.0, None, 10_000.0, 0, "clock")
    assert result["words"] == ["none", "none", "none", "none"]
    assert result["note"] == "No timing anchor"


def test_word_windows_span_keeps_only_covered_words_and_clips_edges():
    words = [
        {"start": 0.0, "end": 0.5},
        {"start": 0.5, "end": 1.0},
        {"start": 1.0, "end": 1.5},
        {"start": 1.5, "end": 2.0},
    ]
    windows = ts.word_windows(words, 1.0, (600, 1400))
    assert windows[0] is None
    assert windows[1] == pytest.approx((0.0, 400.0))
    assert windows[2] == pytest.approx((400.0, 800.0))
    assert windows[3] is None


def test_word_windows_divides_by_speed():
    words = [{"start": 0.0, "end": 0.5}, {"start": 0.5, "end": 1.0}]
    windows = ts.word_windows(words, 2.0, None)
    assert windows[0] == pytest.approx((0.0, 250.0))
    assert windows[1] == pytest.approx((250.0, 500.0))


def test_word_windows_drops_a_clip_shorter_than_min_word_ms():
    words = [{"start": 1.39, "end": 1.42}]
    windows = ts.word_windows(words, 1.0, (0, 1400))
    assert windows[0] is None


def test_dtw_path_is_monotone_and_spans_all_of_ref():
    rng = np.random.default_rng(7)
    ref = np.clip(rng.normal(0.5, 0.3, 40), 0.0, 1.0)
    take = np.clip(rng.normal(0.5, 0.3, 70), 0.0, 1.0)
    path = ts.dtw_path(ref, take)
    assert path[0][0] == 0
    assert path[-1][0] == len(ref) - 1
    for (i0, j0), (i1, j1) in zip(path, path[1:]):
        assert i1 - i0 in (0, 1)
        assert j1 - j0 in (0, 1)
        assert (i1, j1) != (i0, j0)
