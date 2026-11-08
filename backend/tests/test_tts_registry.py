"""tts_registry: ids resolve to a language and a provider, every language
has a local default, disabled providers stay out of the lists."""

import tts_registry
import tts_fakes
from tts_registry import Voice

LANGUAGES = ["ja", "en", "es", "fr", "pt", "zh", "de", "he", "ko", "ar"]


def test_ids_map_to_language_and_provider():
    assert tts_registry.language_for(3) == "ja"
    assert tts_registry.provider_for(3).name == "voicevox"
    assert tts_registry.voice(3).native_speed is True
    assert tts_registry.language_for(10021) == "fr"
    assert tts_registry.provider_for(10021).name == "kokoro"
    assert tts_registry.language_for(11002) == "he"
    assert tts_registry.provider_for(11002).name == "bluetts"
    assert tts_registry.language_for(11201) == "ar"
    assert tts_registry.voice(99999) is None
    assert tts_registry.language_for(99999) == ""


def test_every_language_has_a_local_default():
    for lang in LANGUAGES:
        vid = tts_registry.default_voice(lang)
        v = tts_registry.voice(vid)
        assert v is not None, lang
        assert v.language == lang
        assert v.hosted is False


def test_voices_for_omits_disabled_providers_and_puts_hosted_last(monkeypatch):
    off = tts_fakes.install(monkeypatch, tts_fakes.FakeProvider("off", [
        Voice(30001, "off", "fr", "Gone", "", "x"),
    ], on=False))
    on = tts_fakes.hosted(monkeypatch)
    ids = [v.id for v in tts_registry.voices_for("fr")]
    assert 30001 not in ids
    assert ids[0] == 10021
    assert ids[-1] == 22001
    assert off.calls == [] and on.calls == []


def test_hosted_off_switch_disables_hosted_providers_only(monkeypatch):
    import tts_budget

    tts_fakes.hosted(monkeypatch)
    monkeypatch.setattr(tts_budget, "DEV_FORCE", "hosted_off")
    ids = [v.id for v in tts_registry.voices_for("fr")]
    assert 22001 not in ids
    assert 10021 in ids
