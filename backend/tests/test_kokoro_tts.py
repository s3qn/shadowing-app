"""Tests for kokoro_tts.synthesize: always render at 1.0, stretch for speed."""

import io
import subprocess
import wave

import numpy as np
import pytest

import kokoro_tts

SR = 24000


def _sine(seconds=1.0):
    t = np.arange(int(SR * seconds)) / SR
    return (0.5 * np.sin(2 * np.pi * 440 * t)).astype("float32")


class _FakeKokoro:
    def __init__(self):
        self.speeds = []

    def create(self, text, voice, speed, lang):
        self.speeds.append(speed)
        return _sine(), SR


@pytest.fixture
def fake(monkeypatch):
    k = _FakeKokoro()
    monkeypatch.setattr(kokoro_tts, "_get_kokoro", lambda: k)
    return k


def _info(wav):
    with wave.open(io.BytesIO(wav), "rb") as w:
        return w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes() / w.getframerate()


def test_speed_one_skips_the_stretch(fake, monkeypatch):
    def fail(*a, **k):
        raise AssertionError("stretch called")

    monkeypatch.setattr(kokoro_tts, "_stretch_wav", fail)
    wav, dur = kokoro_tts.synthesize("hola", "ef_dora", "es", 1.0)
    assert fake.speeds == [1.0]
    ch, sw, rate, secs = _info(wav)
    assert (ch, sw, rate) == (1, 2, SR)
    assert abs(secs - 1.0) < 0.01 and abs(dur - 1.0) < 0.01


def test_slow_speed_renders_at_one_and_stretches(fake):
    wav, dur = kokoro_tts.synthesize("hola", "ef_dora", "es", 0.5)
    assert fake.speeds == [1.0]
    ch, _, rate, secs = _info(wav)
    assert (ch, rate) == (1, SR)
    assert abs(secs - 2.0) < 0.15 and abs(dur - secs) < 0.01


def test_stretch_wav_length():
    src = kokoro_tts._to_wav(_sine(), SR)
    out = kokoro_tts._stretch_wav(src, 0.7)
    assert out[:4] == b"RIFF"
    ch, _, rate, secs = _info(out)
    assert (ch, rate) == (1, SR)
    assert abs(secs - 1 / 0.7) < 0.15


def test_missing_ffmpeg_raises_kokoro_error(fake, monkeypatch):
    def nope(*a, **k):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(kokoro_tts.subprocess, "run", nope)
    with pytest.raises(kokoro_tts.KokoroError):
        kokoro_tts.synthesize("hola", "ef_dora", "es", 0.5)
