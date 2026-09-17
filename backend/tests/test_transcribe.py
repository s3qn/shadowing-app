"""Tests for transcribe.py's word timestamp and VAD plumbing.

The real model takes ~8s to load and is slow on this CPU, so every test here
monkeypatches transcribe._get_model with a fake whose .transcribe() records
its kwargs and returns canned segments. No network, no model load.
"""

from types import SimpleNamespace

import pytest

import transcribe


def _fake_segment():
    return SimpleNamespace(
        start=0.0,
        end=1.5,
        text=" 今日は",
        words=[
            SimpleNamespace(start=0.1, end=0.5, word="今日"),
            SimpleNamespace(start=0.5, end=0.7, word="は"),
        ],
    )


class _FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, path, **kwargs):
        self.calls.append(kwargs)
        return iter([_fake_segment()]), SimpleNamespace(language="ja")


@pytest.fixture
def fake_model(monkeypatch):
    model = _FakeModel()
    monkeypatch.setattr(transcribe, "_get_model", lambda: model)
    return model


@pytest.fixture
def audio_path(tmp_path):
    path = tmp_path / "a.wav"
    path.touch()
    return path


def test_word_timestamps_true_carries_words_on_segment_and_flat_list(fake_model, audio_path):
    result = transcribe.transcribe(audio_path, language="ja", word_timestamps=True)

    assert result["segments"][0]["words"] == [
        {"start": 0.1, "end": 0.5, "text": "今日"},
        {"start": 0.5, "end": 0.7, "text": "は"},
    ]
    assert result["words"] == [
        {"start": 0.1, "end": 0.5, "text": "今日"},
        {"start": 0.5, "end": 0.7, "text": "は"},
    ]


def test_word_timestamps_true_passes_expected_kwargs_to_model(fake_model, audio_path):
    transcribe.transcribe(audio_path, language="ja", word_timestamps=True)

    kwargs = fake_model.calls[0]
    assert kwargs["word_timestamps"] is True
    assert kwargs["condition_on_previous_text"] is False


def test_defaults_have_no_words_and_no_vad(fake_model, audio_path):
    result = transcribe.transcribe(audio_path)

    assert result["words"] == []
    assert result["segments"][0]["words"] == []
    kwargs = fake_model.calls[0]
    assert kwargs["vad_filter"] is False
    assert kwargs["word_timestamps"] is False
    assert "condition_on_previous_text" not in kwargs


def test_vad_true_passes_vad_filter(fake_model, audio_path):
    transcribe.transcribe(audio_path, vad=True)

    assert fake_model.calls[0]["vad_filter"] is True


def test_missing_file_returns_empty_shape_without_calling_model(fake_model, tmp_path):
    missing = tmp_path / "missing.wav"

    result = transcribe.transcribe(missing, word_timestamps=True)

    assert result == {"ok": False, "text": "", "language": "", "segments": [], "words": []}
    assert fake_model.calls == []


def test_successful_run_reports_ok(fake_model, audio_path):
    assert transcribe.transcribe(audio_path)["ok"] is True


def test_run_that_hears_nothing_is_ok_with_empty_words(monkeypatch, audio_path):
    class _SilentModel:
        def transcribe(self, path, **kwargs):
            return iter([]), SimpleNamespace(language="ja")

    monkeypatch.setattr(transcribe, "_get_model", lambda: _SilentModel())
    result = transcribe.transcribe(audio_path, language="ja", word_timestamps=True, vad=True)
    assert result == {"ok": True, "text": "", "language": "ja", "segments": [], "words": []}


def test_whisper_crash_is_not_ok_and_does_not_raise(monkeypatch, audio_path):
    class _BrokenModel:
        def transcribe(self, path, **kwargs):
            def segments():
                raise RuntimeError("decoder blew up")
                yield
            return segments(), SimpleNamespace(language="ja")

    monkeypatch.setattr(transcribe, "_get_model", lambda: _BrokenModel())
    result = transcribe.transcribe(audio_path, language="ja", word_timestamps=True)
    assert result == {"ok": False, "text": "", "language": "", "segments": [], "words": []}


def test_model_load_failure_is_not_ok_and_does_not_raise(monkeypatch, audio_path):
    def boom():
        raise OSError("model files missing")

    monkeypatch.setattr(transcribe, "_get_model", boom)
    assert transcribe.transcribe(audio_path)["ok"] is False
