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


class _T:
    def __init__(self, phoneme, start, end):
        self.phoneme, self.start, self.end = phoneme, start, end


class _FakeKokoro:
    has_timings = True

    def __init__(self):
        self.speeds = []
        self.pauses = []

    def create_timed(self, text, voice, speed, lang, **kw):
        self.speeds.append(speed)
        self.pauses.append(kw)
        return _sine(), SR, [_T("o", 0.0, 0.4), _T(" ", 0.4, 0.5), _T("a", 0.5, 1.0)]

    def create(self, text, voice, speed, lang, **kw):
        self.speeds.append(speed)
        self.pauses.append(kw)
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


def test_synthesize_timed_renders_at_one_with_timings(fake):
    wav, dur, timings = kokoro_tts.synthesize_timed("hola", "ef_dora", "es")
    assert fake.speeds == [1.0]
    assert abs(dur - len(_sine()) / SR) < 1e-9
    assert timings == [
        {"phoneme": "o", "start": 0.0, "end": 0.4},
        {"phoneme": " ", "start": 0.4, "end": 0.5},
        {"phoneme": "a", "start": 0.5, "end": 1.0},
    ]
    assert _info(wav)[2] == SR


def test_synthesize_timed_without_duration_output_gives_no_timings(fake):
    fake.has_timings = False
    wav, dur, timings = kokoro_tts.synthesize_timed("hola", "ef_dora", "es")
    assert timings == []
    assert abs(dur - 1.0) < 0.01


def test_has_timings_is_none_before_load(monkeypatch):
    monkeypatch.setattr(kokoro_tts, "_KOKORO", None)
    assert kokoro_tts.has_timings() is None


def test_has_timings_reflects_the_loaded_model(fake, monkeypatch):
    monkeypatch.setattr(kokoro_tts, "_KOKORO", fake)
    assert kokoro_tts.has_timings() is True
    fake.has_timings = False
    assert kokoro_tts.has_timings() is False


NO_PAUSES = {"sentence_pause": 0.0, "clause_pause": 0.0}


def test_both_renders_turn_off_the_extra_pauses(fake, monkeypatch):
    # The timed model pads gaps after marks unless told not to, which would
    # make a timed render longer than the stock one for the same text.
    kokoro_tts.synthesize("Hola, amigo. Adiós.", "ef_dora", "es")
    kokoro_tts.synthesize_timed("Hola, amigo. Adiós.", "ef_dora", "es")
    monkeypatch.setattr(fake, "has_timings", False)
    kokoro_tts.synthesize_timed("Hola, amigo. Adiós.", "ef_dora", "es")
    assert fake.pauses == [NO_PAUSES, NO_PAUSES, NO_PAUSES]


def _model(dir_path):
    dir_path.mkdir(parents=True)
    (dir_path / kokoro_tts.ONNX_NAME).write_bytes(b"")


def test_model_dir_prefers_the_timed_export(tmp_path, monkeypatch):
    monkeypatch.delenv("KOKORO_MODEL_DIR", raising=False)
    monkeypatch.setattr(kokoro_tts.Path, "home", lambda: tmp_path)
    _model(tmp_path / "models" / "kokoro")
    assert kokoro_tts.resolve_model_dir() == tmp_path / "models" / "kokoro"
    _model(tmp_path / "models" / "kokoro-timed")
    assert kokoro_tts.resolve_model_dir() == tmp_path / "models" / "kokoro-timed"


def test_model_dir_env_overrides(tmp_path, monkeypatch):
    monkeypatch.setattr(kokoro_tts.Path, "home", lambda: tmp_path)
    _model(tmp_path / "models" / "kokoro-timed")
    monkeypatch.setenv("KOKORO_MODEL_DIR", str(tmp_path / "custom"))
    assert kokoro_tts.resolve_model_dir() == tmp_path / "custom"
