"""Tests for take_analysis.py: the tracker, aligner and mora readings.

Everything here is built from synthetic tones and hand built timelines,
never a real recording, so the suite runs in well under two seconds.
Every random draw uses a numpy Generator seeded with a fixed integer, so
a failure here always means a real change in take_analysis.py, never a
different draw.
"""

from __future__ import annotations

import warnings

import numpy as np
import pytest

import take_analysis

SR = 24000


# --- tracker and aligner, copied from the parked pitch-contour branch -----


def _tone(freq: float, seconds: float, sr: int = SR, fade: float = 0.05) -> np.ndarray:
    """A pure sine with a fade in and out, so onset clicks do not confuse YIN."""
    n = int(seconds * sr)
    t = np.arange(n) / sr
    x = np.sin(2.0 * np.pi * freq * t)
    fade_n = int(fade * sr)
    env = np.ones(n)
    env[:fade_n] = np.linspace(0.0, 1.0, fade_n)
    env[-fade_n:] = np.linspace(1.0, 0.0, fade_n)
    return x * env


def _harmonic_tone(f0: float, seconds: float, sr: int = SR, k: int = 6, fade: float = 0.05) -> np.ndarray:
    """f0 plus harmonics 1..k at 1/k amplitude, the shape that fools an
    autocorrelation tracker into reporting an octave up or down."""
    n = int(seconds * sr)
    t = np.arange(n) / sr
    x = np.zeros(n)
    for h in range(1, k + 1):
        x += np.sin(2.0 * np.pi * f0 * h * t) / h
    fade_n = int(fade * sr)
    env = np.ones(n)
    env[:fade_n] = np.linspace(0.0, 1.0, fade_n)
    env[-fade_n:] = np.linspace(1.0, 0.0, fade_n)
    return x * env


def test_track_pure_tone_150hz_within_a_semitone():
    tr = take_analysis.track(_tone(150.0, 1.0), SR)
    voiced = ~np.isnan(tr.f0)
    assert voiced.mean() >= 0.8
    st_err = np.abs(12.0 * np.log2(tr.f0[voiced] / 150.0))
    assert np.all(st_err < 0.2)


def test_track_harmonic_tone_has_no_octave_error():
    tr = take_analysis.track(_harmonic_tone(120.0, 1.0), SR)
    st_err = abs(12.0 * np.log2(float(np.nanmedian(tr.f0)) / 120.0))
    assert st_err < 1.0


def test_track_white_noise_is_unvoiced():
    rng = np.random.default_rng(0)
    x = rng.normal(0.0, 1.0, SR)
    tr = take_analysis.track(x, SR)
    assert np.isnan(tr.f0).mean() >= 0.9


def _melody(n_frames: int, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A piecewise semitone contour with a small wiggle inside each "word"
    (so frames within a word are not literally identical, which would
    leave the DTW nothing to prefer one alignment over another) and a
    short unvoiced gap between words, the way real speech has a pause
    between phrases."""
    st = np.zeros(n_frames)
    energy = np.full(n_frames, -20.0)
    voiced = np.ones(n_frames, dtype=bool)
    word_len = 40
    pos = 0
    while pos < n_frames:
        seg = min(word_len, n_frames - pos)
        level = rng.uniform(-6.0, 6.0)
        local = np.arange(seg)
        wiggle = 1.5 * np.sin(2.0 * np.pi * local / 17.0 + rng.uniform(0.0, 2.0 * np.pi))
        st[pos : pos + seg] = level + wiggle
        energy[pos : pos + seg] = -15.0 + 3.0 * np.sin(2.0 * np.pi * local / 11.0)
        gap = 5
        if pos + seg < n_frames:
            gap_end = min(pos + seg + gap, n_frames)
            voiced[pos + seg : gap_end] = False
            energy[pos + seg : gap_end] = -50.0
        pos += seg + gap
    return st, energy, voiced


def _make_track(st: np.ndarray, energy: np.ndarray, voiced: np.ndarray, base_f0: float = 150.0) -> take_analysis.Track:
    hop = int(round(take_analysis.HOP_S * SR))
    n = len(st)
    times = (np.arange(n) * hop + take_analysis.WIN / 2.0) / SR
    f0 = base_f0 * (2.0 ** (st / 12.0))
    f0 = np.where(voiced, f0, np.nan)
    return take_analysis.Track(times=times, f0=f0, energy_db=energy)


def test_align_recovers_a_300ms_shift():
    rng = np.random.default_rng(1)
    n_line = 300
    st, energy, voiced = _melody(n_line, rng)
    line = _make_track(st, energy, voiced)

    shift = 30
    take_st = np.concatenate([np.zeros(shift), st])
    take_energy = np.concatenate([np.full(shift, -50.0), energy])
    take_voiced = np.concatenate([np.zeros(shift, dtype=bool), voiced])
    take = _make_track(take_st, take_energy, take_voiced)

    al = take_analysis.align(line, take)
    assert al.method == "dtw"

    diffs = al.path_i - np.arange(n_line)
    voiced_mask = ~np.isnan(line.f0)
    assert np.max(np.abs(diffs[voiced_mask] - shift)) <= 2

    line_st = take_analysis.semitones(line.f0)
    take_st_full = take_analysis.semitones(take.f0)
    mapped = take_st_full[al.path_i]
    assert np.nanmean(np.abs(line_st - mapped)) < 0.5


def test_align_recovers_a_stretch():
    rng = np.random.default_rng(1)
    n_line = 300
    st, energy, voiced = _melody(n_line, rng)
    line = _make_track(st, energy, voiced)

    n_take = int(round(n_line * 1.3))
    idx = np.linspace(0, n_line - 1, n_take)
    take_st = np.interp(idx, np.arange(n_line), st)
    take_energy = np.interp(idx, np.arange(n_line), energy)
    take_voiced = np.interp(idx, np.arange(n_line), voiced.astype(float)) > 0.5
    take = _make_track(take_st, take_energy, take_voiced)

    al = take_analysis.align(line, take)
    assert al.method == "dtw"

    line_st = take_analysis.semitones(line.f0)
    take_st_full = take_analysis.semitones(take.f0)
    mapped = take_st_full[al.path_i]
    assert np.nanmean(np.abs(line_st - mapped)) < 0.75


def test_align_ignores_a_long_lead_and_tail_of_silence():
    line_audio = _build_line([180.0, 230.0, 150.0, 150.0])
    silence = np.zeros(SR)
    take_audio = np.concatenate([silence, line_audio, silence])
    al = take_analysis.align(take_analysis.track(line_audio, SR), take_analysis.track(take_audio, SR))
    assert al.method == "dtw"
    assert al.cost < 0.05
    assert np.max(np.abs(al.path_i - np.arange(len(al.path_i)) - 100)) <= 2


def test_align_falls_back_to_offset_on_unrelated_contours():
    rng = np.random.default_rng(1)
    n_line = 300
    st, energy, voiced = _melody(n_line, rng)
    line = _make_track(st, energy, voiced)

    rng2 = np.random.default_rng(2)
    take_st = rng2.uniform(-6.0, 6.0, n_line)
    take_energy = rng2.uniform(-20.0, -10.0, n_line)
    take_voiced = rng2.uniform(0.0, 1.0, n_line) > 0.1
    take = _make_track(take_st, take_energy, take_voiced)

    al = take_analysis.align(line, take)
    assert al.method == "offset"
    assert len(al.path_i) == n_line


# --- vowel / classify ------------------------------------------------------


def _timeline(*specs: tuple[str, int, bool | None]) -> list[dict]:
    """Build a minimal timeline: (text, phrase, high) tuples with made up
    but strictly increasing start/end times, since classify and nuclei
    never look at the timing fields."""
    out = []
    t = 0.0
    for text, phrase, high in specs:
        out.append({"text": text, "kana": text, "start": t, "end": t + 0.1, "phrase": phrase, "high": high})
        t += 0.1
    return out


def test_classify_long_vowel_after_matching_carrier():
    tl = _timeline(("キョ", 0, None), ("オ", 0, None))
    assert take_analysis.classify(tl) == [None, "long"]


def test_classify_geminate_and_long_in_one_phrase():
    tl = _timeline(("ガ", 0, None), ("ッ", 0, None), ("コ", 0, None), ("オ", 0, None))
    assert take_analysis.classify(tl) == [None, "geminate", None, "long"]


def test_classify_ei_counts_as_long():
    tl = _timeline(("ケ", 0, None), ("イ", 0, None))
    assert take_analysis.classify(tl)[1] == "long"


def test_classify_non_matching_vowel_is_not_long():
    tl = _timeline(("カ", 0, None), ("オ", 0, None))
    assert take_analysis.classify(tl)[1] != "long"


def test_classify_n_mora():
    tl = _timeline(("ン", 0, None),)
    assert take_analysis.classify(tl) == ["n"]


def test_classify_empty_text_is_not_long():
    tl = _timeline(("ア", 0, None), ("", 0, None))
    assert take_analysis.classify(tl) == [None, None]


def test_classify_vowel_opening_a_new_phrase_is_not_long():
    tl = _timeline(("キョ", 0, None), ("オ", 1, None))
    assert take_analysis.classify(tl)[1] != "long"


# --- nuclei -----------------------------------------------------------------


def test_nuclei_finds_the_fall():
    tl = _timeline(("ハ", 0, True), ("シ", 0, False), ("タ", 0, False))
    assert take_analysis.nuclei(tl) == [0]


def test_nuclei_finds_a_later_fall():
    tl = _timeline(("ア", 0, False), ("メ", 0, True), ("ガ", 0, True), ("フ", 0, False))
    assert take_analysis.nuclei(tl) == [2]


def test_nuclei_heiban_is_none():
    tl = _timeline(("ア", 0, False), ("メ", 0, True), ("ガ", 0, True))
    assert take_analysis.nuclei(tl) == [None]


def test_nuclei_missing_high_is_none():
    tl = _timeline(("ハ", 0, True), ("シ", 0, None), ("タ", 0, False))
    assert take_analysis.nuclei(tl) == [None]


def test_nuclei_two_phrases_give_two_entries():
    tl = _timeline(("ハ", 0, True), ("シ", 0, False), ("タ", 1, True), ("ロ", 1, False))
    assert len(take_analysis.nuclei(tl)) == 2


# --- mora_windows ------------------------------------------------------------


def test_mora_windows_speed_halves_the_times():
    tl = [{"start": 0.0, "end": 0.1}, {"start": 0.1, "end": 0.2}]
    out = take_analysis.mora_windows(tl, 2.0, None)
    assert out[0] == (0.0, 50.0)
    assert out[1] == (50.0, 100.0)


def test_mora_windows_span_clips_and_shifts():
    tl = [{"start": 0.0, "end": 0.2}]
    out = take_analysis.mora_windows(tl, 1.0, (50, 150))
    assert out[0] == (0.0, 100.0)


def test_mora_windows_short_mora_is_none():
    tl = [{"start": 0.0, "end": 0.02}]
    out = take_analysis.mora_windows(tl, 1.0, None)
    assert out[0] is None


# --- length_marks -------------------------------------------------------------


def test_length_marks_flags_a_clipped_mora():
    kinds = [None, None, "long", None]
    line_ms = [100, 100, 200, 100]
    take_ms = [100, 100, 80, 100]
    assert take_analysis.length_marks(kinds, line_ms, take_ms) == [None, None, "clipped", None]


def test_length_marks_honest_slow_pace_is_ok():
    kinds = [None, None, "long", None]
    line_ms = [100, 100, 200, 100]
    take_ms = [50, 50, 100, 50]
    assert take_analysis.length_marks(kinds, line_ms, take_ms) == [None, None, "ok", None]


def test_length_marks_long_pair_is_judged_as_one():
    # The take moved 100 ms of the vowel onto its carrier: per mora it
    # looks clipped, but the pair is whole.
    kinds = [None, "long"]
    line_ms = [100, 100]
    take_ms = [200, 50]
    assert take_analysis.length_marks(kinds, line_ms, take_ms, [None, 200]) == [None, "ok"]
    assert take_analysis.length_marks(kinds, line_ms, take_ms, [None, 150]) == [None, "clipped"]


def test_length_marks_missing_take_is_none():
    kinds = ["geminate"]
    line_ms = [100]
    take_ms = [None]
    assert take_analysis.length_marks(kinds, line_ms, take_ms) == ["none"]


# --- nucleus_marks -------------------------------------------------------------


def test_nucleus_marks_hit():
    tl = _timeline(("ハ", 0, True), ("シ", 0, False))
    out = take_analysis.nucleus_marks(tl, [0], [2.0, -1.0])
    assert out[0] == "hit"


def test_nucleus_marks_miss():
    tl = _timeline(("ハ", 0, True), ("シ", 0, False))
    out = take_analysis.nucleus_marks(tl, [0], [0.0, 0.5])
    assert out[0] == "miss"


def test_nucleus_marks_skips_an_unmeasured_mora_to_the_next():
    tl = _timeline(("ハ", 0, True), ("シ", 0, False), ("タ", 0, False))
    out = take_analysis.nucleus_marks(tl, [0], [2.0, None, -1.0])
    assert out[0] == "hit"


def test_nucleus_marks_none_when_nothing_ahead_is_measurable():
    tl = _timeline(("ハ", 0, True), ("シ", 0, False), ("タ", 0, False))
    out = take_analysis.nucleus_marks(tl, [0], [2.0, None, None])
    assert out[0] == "none"


def test_nucleus_marks_non_nucleus_mora_is_none():
    tl = _timeline(("ハ", 0, True), ("シ", 0, False))
    out = take_analysis.nucleus_marks(tl, [0], [2.0, -1.0])
    assert out[1] is None


# --- analyse end to end -------------------------------------------------------


def _line_timeline() -> list[dict]:
    return [
        {"text": "コ", "kana": "コ", "start": 0.0, "end": 0.3, "phrase": 0, "high": False},
        {"text": "オ", "kana": "オ", "start": 0.3, "end": 0.6, "phrase": 0, "high": True},
        {"text": "ネ", "kana": "ネ", "start": 0.6, "end": 0.9, "phrase": 0, "high": False},
        {"text": "コ", "kana": "コ", "start": 0.9, "end": 1.2, "phrase": 0, "high": False},
    ]


def _build_line(freqs: list[float]) -> np.ndarray:
    return np.concatenate([_harmonic_tone(f, 0.3) for f in freqs])


def _take(vowel_s: float, lead_s: float, tail_s: float = 0.0) -> np.ndarray:
    """_line_timeline spoken with its long vowel (mora 1) lasting vowel_s."""
    body = np.concatenate(
        [_harmonic_tone(180.0, 0.3), _harmonic_tone(230.0, vowel_s), _harmonic_tone(150.0, 0.3), _harmonic_tone(150.0, 0.3)]
    )
    return np.concatenate([np.zeros(int(lead_s * SR)), body, np.zeros(int(tail_s * SR))])


def _same_pitch_timeline() -> list[dict]:
    """ネ|コ|オ|ト|モ: the long vowel オ keeps its carrier's pitch, so
    nothing but the pair's total length can show it was cut."""
    specs = [("ネ", False), ("コ", True), ("オ", True), ("ト", False), ("モ", False)]
    return [
        {"text": t, "kana": t, "start": 0.3 * k, "end": 0.3 * (k + 1), "phrase": 0, "high": h}
        for k, (t, h) in enumerate(specs)
    ]


def _same_pitch_audio(vowel_s: float) -> np.ndarray:
    """ネ at 230 Hz, コオ as one 180 Hz tone of 0.3 s plus vowel_s, ト at
    150 Hz, モ at 180 Hz. The 180 Hz majority keeps the median unambiguous."""
    return np.concatenate(
        [_harmonic_tone(230.0, 0.3), _harmonic_tone(180.0, 0.3 + vowel_s), _harmonic_tone(150.0, 0.3), _harmonic_tone(180.0, 0.3)]
    )


def _long_mark(out: dict, i: int) -> str | None:
    return {m["i"]: m for m in out["moras"]}[i]["length"]


def test_analyse_end_to_end_flags_a_clipped_mora_and_a_hit_nucleus():
    tl = _line_timeline()
    line = _build_line([180.0, 230.0, 150.0, 150.0])
    take = _take(0.12, 0.3)

    out = take_analysis.analyse(line, take, SR, tl, 1.0, None, None, False, None)

    assert out["note"] == ""
    assert out["aligned"] == "dtw"
    assert len(out["curve"]["line"]) == len(out["curve"]["take"])

    by_i = {m["i"]: m for m in out["moras"]}
    assert by_i[1]["length"] == "clipped"
    assert by_i[1]["nucleus"] == "hit"
    voiced_moras = [m for m in out["moras"] if m["takeSt"] is not None]
    assert len(voiced_moras) > 0


def test_analyse_unclipped_take_is_ok():
    tl = _line_timeline()
    line = _build_line([180.0, 230.0, 150.0, 150.0])
    out = take_analysis.analyse(line, _take(0.3, 0.3), SR, tl, 1.0, None, None, False, None)
    assert out["note"] == ""
    assert _long_mark(out, 1) == "ok"
    assert {m["i"]: m for m in out["moras"]}[1]["nucleus"] == "hit"


@pytest.mark.parametrize("lead_s", [0.6, 1.0, 2.0])
def test_analyse_long_lead_and_tail_still_measures(lead_s):
    tl = _line_timeline()
    line = _build_line([180.0, 230.0, 150.0, 150.0])
    clipped = take_analysis.analyse(line, _take(0.12, lead_s, 1.0), SR, tl, 1.0, None, None, False, None)
    whole = take_analysis.analyse(line, _take(0.3, lead_s, 1.0), SR, tl, 1.0, None, None, False, None)
    assert clipped["aligned"] == "dtw" and whole["aligned"] == "dtw"
    assert _long_mark(clipped, 1) == "clipped"
    assert _long_mark(whole, 1) == "ok"


@pytest.mark.parametrize("lead_s", [0.3, 1.0])
def test_analyse_same_pitch_long_vowel(lead_s):
    tl = _same_pitch_timeline()
    line = _same_pitch_audio(0.3)
    silence = np.zeros(int(lead_s * SR))
    clipped = take_analysis.analyse(
        line, np.concatenate([silence, _same_pitch_audio(0.12), silence]), SR, tl, 1.0, None, None, False, None
    )
    whole = take_analysis.analyse(
        line, np.concatenate([silence, _same_pitch_audio(0.3), silence]), SR, tl, 1.0, None, None, False, None
    )
    assert [m["kind"] for m in whole["moras"]] == [None, None, "long", None, None]
    assert clipped["aligned"] == "dtw" and whole["aligned"] == "dtw"
    assert _long_mark(clipped, 2) == "clipped"
    assert _long_mark(whole, 2) == "ok"


def test_analyse_with_anchor_slices_and_still_measures():
    tl = _line_timeline()
    line = _build_line([180.0, 230.0, 150.0, 150.0])
    clipped = take_analysis.analyse(line, _take(0.12, 1.5, 0.5), SR, tl, 1.0, None, 1500.0, False, None)
    whole = take_analysis.analyse(line, _take(0.3, 1.5, 0.5), SR, tl, 1.0, None, 1500.0, False, None)
    assert clipped["note"] == "" and whole["note"] == ""
    assert _long_mark(clipped, 1) == "clipped"
    assert _long_mark(whole, 1) == "ok"


def test_analyse_span_covers_only_its_moras():
    # The phone played the first three moras (0 to 900 ms) of the line.
    tl = _same_pitch_timeline()
    ref = _same_pitch_audio(0.3)[: int(0.9 * SR)]
    silence = np.zeros(int(0.6 * SR))
    clipped_body = _same_pitch_audio(0.12)[: int(0.72 * SR)]
    whole_body = _same_pitch_audio(0.3)[: int(0.9 * SR)]
    clipped = take_analysis.analyse(
        ref, np.concatenate([silence, clipped_body, silence]), SR, tl, 1.0, (0, 900), None, False, None
    )
    whole = take_analysis.analyse(
        ref, np.concatenate([silence, whole_body, silence]), SR, tl, 1.0, (0, 900), None, False, None
    )
    assert [m["i"] for m in whole["moras"]] == [0, 1, 2]
    assert _long_mark(clipped, 2) == "clipped"
    assert _long_mark(whole, 2) == "ok"


def test_analyse_span_missing_every_mora_has_a_note():
    tl = _line_timeline()
    line = _build_line([180.0])
    out = take_analysis.analyse(line, line, SR, tl, 1.0, (5000, 6000), None, False, None)
    assert out["note"] == "Nothing to analyse"
    assert out["moras"] == []


def test_analyse_end_to_end_flat_pitch_misses_the_nucleus():
    tl = _line_timeline()
    line = _build_line([180.0, 230.0, 150.0, 150.0])
    take_body = _build_line([180.0, 180.0, 180.0, 180.0])
    take = np.concatenate([np.zeros(int(0.3 * SR)), take_body])

    out = take_analysis.analyse(line, take, SR, tl, 1.0, None, None, False, None)
    by_i = {m["i"]: m for m in out["moras"]}
    assert by_i[1]["nucleus"] == "miss"


def test_analyse_silence_take_gives_no_voice_note():
    tl = _line_timeline()
    line = _build_line([180.0, 230.0, 150.0, 150.0])
    take = np.zeros(len(line) + int(0.3 * SR))

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        out = take_analysis.analyse(line, take, SR, tl, 1.0, None, None, False, None)
    assert out["note"] == "No voice heard in the take"
    assert all(m["length"] in (None, "none") for m in out["moras"])
    assert all(m["nucleus"] in (None, "none") for m in out["moras"])


def test_analyse_untrusted_erle_gives_too_noisy_note():
    tl = _line_timeline()
    line = _build_line([180.0, 230.0, 150.0, 150.0])
    take = _build_line([180.0, 230.0, 150.0, 150.0])

    out = take_analysis.analyse(line, take, SR, tl, 1.0, None, None, True, 3.0)
    assert out["note"] == "Take too noisy to analyse"


def test_analyse_empty_timeline_gives_empty_moras():
    line = _build_line([180.0])
    take = _build_line([180.0])
    out = take_analysis.analyse(line, take, SR, [], 1.0, None, None, False, None)
    assert out["moras"] == []
