"""Tests for aec.py, the speaker bleed remover.

Builds synthetic takes with aec's own room and noise helpers (_make_room,
_dbfs_noise) instead of real recordings, so the suite runs in a couple of
seconds and needs no wav fixtures. The one exception is the decode/encode
round trip, which has to touch a real file and so uses pytest's tmp_path.

Every random signal is drawn from a numpy Generator seeded with a fixed
integer, so a failure here always means a real change in aec.py's output,
never a different draw.
"""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

import aec

SR = aec.SR


def _make_line(rng: np.random.Generator, seconds: float) -> np.ndarray:
    """A stand-in for a decoded VOICEVOX line: filtered noise.

    aec._selfcheck builds its reference by decoding a real wav. These tests
    have none to decode, so this plays that role instead: broadband enough
    for find_delay to lock onto a real correlation peak, smoothed just
    enough that it is not pure white noise.
    """
    n = int(seconds * SR)
    raw = rng.normal(0.0, 1.0, n + 8)
    kernel = np.ones(8) / 8.0
    line = np.convolve(raw, kernel, mode="valid")[:n]
    return (line / (np.max(np.abs(line)) + 1e-9)).astype(np.float64)


def test_tile_to_length_repeats_short_input():
    x = np.array([1.0, 2.0, 3.0])
    out = aec._tile_to_length(x, 7)
    assert len(out) == 7
    assert np.array_equal(out, np.array([1.0, 2.0, 3.0, 1.0, 2.0, 3.0, 1.0]))


def test_tile_to_length_cuts_long_input():
    x = np.arange(10, dtype=np.float64)
    out = aec._tile_to_length(x, 4)
    assert len(out) == 4
    assert np.array_equal(out, x[:4])


def test_find_delay_recovers_known_delay_through_a_room():
    rng = np.random.default_rng(1)
    ref = _make_line(rng, 1.0)
    lead = np.zeros(int(0.3 * SR))
    played = np.concatenate([lead, ref])

    delay_samples = int(0.05 * SR)
    path_len = int(0.05 * SR)
    h = aec._make_room(rng, delay_samples, path_len)
    mic = np.convolve(played, h)[: len(played)]

    true_delay = len(lead) + delay_samples
    d = aec.find_delay(ref, mic)
    # the room's tail decays from the direct arrival, which is the loudest
    # tap by construction (see aec._make_room), so the peak should sit
    # right on the true delay rather than drifting into the tail
    assert abs(d - true_delay) <= 2


def test_find_delay_pure_noise_stays_sane():
    rng = np.random.default_rng(2)
    ref = _make_line(rng, 1.0)
    # mic holds noise with nothing derived from ref, so there is no true
    # delay to recover, only a valid sample index that find_delay must not
    # fall outside of or crash trying to produce
    mic = rng.normal(0.0, 1.0, int(1.0 * SR))
    max_lag = min(int(3.0 * SR), len(mic) - 1)
    d = aec.find_delay(ref, mic)
    assert isinstance(d, int)
    assert 0 <= d <= max_lag


@pytest.fixture(scope="module")
def room_case() -> SimpleNamespace:
    """A calibration take and its learned profile.

    Mirrors aec._selfcheck's setup: lead and tail silence around a line,
    passed through a room impulse response built by aec._make_room, then
    calibrated with nobody talking.
    """
    rng = np.random.default_rng(0)
    line = _make_line(rng, 1.5)
    lead = np.zeros(int(0.5 * SR))
    tail = np.zeros(int(0.5 * SR))
    played = np.concatenate([lead, line, tail])

    delay_samples = int(0.02 * SR)
    path_len = int(0.08 * SR)
    h = aec._make_room(rng, delay_samples, path_len)
    mic_clean = np.convolve(played, h)[: len(played)]
    line_start = len(lead) + delay_samples

    profile = aec.calibrate(line, mic_clean)

    return SimpleNamespace(
        line=line,
        mic_clean=mic_clean,
        line_start=line_start,
        profile=profile,
    )


def test_calibrate_removes_most_bleed(room_case: SimpleNamespace):
    # measured ~59.9 dB on this synthetic case with a fixed seed. 40 dB
    # leaves about 20 dB of margin, well above MIN_ERLE_DB (3 dB) and above
    # the 25 dB aec._selfcheck expects on real audio, while still catching a
    # real regression in the filter.
    assert room_case.profile.erle_db > 40.0


@pytest.fixture(scope="module")
def double_talk_case(room_case: SimpleNamespace) -> SimpleNamespace:
    """A take with the line playing and a near end voice absent from ref."""
    rng = np.random.default_rng(3)
    voice = np.zeros(len(room_case.mic_clean), dtype=np.float64)
    # clean() refits its gain on the first 300 ms of the line; starting the
    # voice after that (as aec._selfcheck also does) keeps the voice out of
    # that fit instead of contaminating it
    offset = room_case.line_start + int(0.35 * SR)
    voice_src = _make_line(rng, 1.0) * 1.5
    end = min(len(voice), offset + len(voice_src))
    voice[offset:end] = voice_src[: end - offset]
    mic_dt = room_case.mic_clean + voice

    result = aec.clean(room_case.line, mic_dt, room_case.profile)

    return SimpleNamespace(voice=voice, voice_span=slice(offset, end), result=result)


def test_clean_removes_most_bleed(double_talk_case: SimpleNamespace):
    result = double_talk_case.result
    assert result.cleaned is True
    # measured ~59.4 dB on this synthetic case, essentially matching
    # calibrate's own figure. Same 40 dB floor and rationale as
    # test_calibrate_removes_most_bleed.
    assert result.erle_db is not None
    assert result.erle_db > 40.0


def test_clean_preserves_voice_only_in_mic(double_talk_case: SimpleNamespace):
    voice = double_talk_case.voice
    span = double_talk_case.voice_span
    output = double_talk_case.result.output

    energy_before = float(np.mean(voice[span] ** 2))
    energy_after = float(np.mean(output[span] ** 2))
    # the voice must survive cleaning even though the mic over this span is
    # voice plus echo mixed together. 90% is a floor against real
    # cancellation, not a tight bound: measured ratio was ~1.0.
    assert energy_after > 0.9 * energy_before


def test_clean_no_bleed_leaves_take_unchanged(
    room_case: SimpleNamespace, double_talk_case: SimpleNamespace
):
    # headphones case: the mic never hears the line, only the voice plus a
    # little self noise
    rng = np.random.default_rng(5)
    voice = double_talk_case.voice
    mic_phones = voice + aec._dbfs_noise(rng, len(voice), -58.0)

    result = aec.clean(room_case.line, mic_phones, room_case.profile)
    assert result.cleaned is False
    # when clean() finds nothing to remove it returns take.copy(), so this
    # is exact equality, not an approximation
    assert np.array_equal(result.output, mic_phones)


def test_decode_encode_round_trip(tmp_path):
    rng = np.random.default_rng(6)
    n = int(0.5 * SR)
    x = rng.uniform(-1.0, 1.0, n).astype(np.float64)

    wav_path = tmp_path / "roundtrip.wav"
    aec.encode(wav_path, x)
    y = aec.decode(wav_path)

    assert len(y) == n
    # encode scales by 32767 (so +1.0 cannot overflow an int16) and decode
    # divides by 32768 (matching main.py's convention), on top of the
    # ordinary int16 rounding. Measured max error was ~6.1e-5 on this
    # signal; 1e-3 leaves headroom without hiding a real codec regression.
    assert np.max(np.abs(y - x)) < 1e-3
