"""Fake providers for the tts tests: no model, no network. `install` registers
one for the test's duration (the registry maps are restored by monkeypatch)."""

import io
import wave

import tts_registry
from tts_registry import Render, Voice


def wav_bytes(seconds: float = 1.0, rate: int = 24000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(2)
        dst.setframerate(rate)
        dst.writeframes(b"\x00\x00" * int(seconds * rate))
    return buf.getvalue()


class FakeProvider:
    def __init__(self, name, voices, hosted=False, on=True, fail=False, pieces=None):
        self.name = name
        self.label = name.capitalize()
        self.hosted = hosted
        self.on = on
        self.fail = fail
        self.pieces = pieces or []
        self._voices = voices
        self.calls: list[tuple[str, int, float]] = []

    def enabled(self):
        return self.on

    def voices(self):
        return list(self._voices)

    async def render(self, text, voice, speed=1.0):
        self.calls.append((text, voice.id, speed))
        if self.fail:
            raise RuntimeError(f"{self.name} is down")
        return Render(wav=wav_bytes(), duration=1.0, pieces=list(self.pieces), voice=voice.id)


def install(monkeypatch, provider) -> FakeProvider:
    monkeypatch.setattr(tts_registry, "_PROVIDERS", dict(tts_registry._PROVIDERS))
    monkeypatch.setattr(tts_registry, "_VOICES", dict(tts_registry._VOICES))
    tts_registry.register(provider)
    return provider


def hosted(monkeypatch, **kw) -> FakeProvider:
    """A hosted provider with one French voice 22001 (timing "pieces")."""
    return install(monkeypatch, FakeProvider("fakehosted", [
        Voice(22001, "fakehosted", "fr", "Sarah", "female", "sarah", timing="pieces", hosted=True),
    ], hosted=True, **kw))


def local_default(monkeypatch, **kw) -> FakeProvider:
    """Replaces Kokoro with a fake that owns the French default 10021."""
    return install(monkeypatch, FakeProvider("kokoro", [
        Voice(10021, "kokoro", "fr", "Siwis", "female", "ff_siwis", timing="phoneme"),
        Voice(10011, "kokoro", "es", "Dora", "female", "ef_dora", timing="phoneme"),
    ], **kw))
