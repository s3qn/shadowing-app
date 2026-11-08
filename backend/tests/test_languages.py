"""The learning-language table and its gate (lang-core)."""

import uuid

import pytest
from fastapi import HTTPException

import access
import beta
import config
import languages
import starter
import tts_registry
import voices
from routers import admin as admin_r

ORDER = ["ja", "es", "en", "fr", "pt", "zh", "ko", "de", "he", "ar"]


def _dev() -> str:
    return uuid.uuid4().hex[:12]


def test_table_has_the_ten_codes_in_order_with_valid_fields():
    assert list(languages.LANGUAGES) == ORDER
    for code, row in languages.LANGUAGES.items():
        assert row.code == code and row.name_en
        assert row.asr_language and row.asr_model
        assert row.reading in languages.READINGS
        assert row.segmenter in languages.SEGMENTERS
        assert row.score_unit in languages.SCORE_UNITS
        # es and en carry no style so the launch prompts and say keys match main.
        assert row.style.count(". ") >= 1 or (code in ("es", "en") and row.style == "")
        assert isinstance(row.rtl, bool) and isinstance(row.cjk, bool)
    assert [c for c, r in languages.LANGUAGES.items() if r.launch] == ["ja", "es", "en"]
    assert languages.LANGUAGES["ja"].segmenter == "mora"
    assert languages.LANGUAGES["zh"].segmenter == "jieba" and languages.LANGUAGES["zh"].cjk
    assert languages.LANGUAGES["he"].rtl and languages.LANGUAGES["ar"].rtl
    assert languages.NAMES["ja"] == "Japanese" and languages.NAMES["es"] == "Spanish"


def test_env_lists_drop_unknown_codes_and_keep_table_order(monkeypatch):
    monkeypatch.setenv("SHADOW_LANGS", "en, zz ,ja")
    monkeypatch.setenv("SHADOW_LANGS_BETA", "")
    assert languages.launch_codes() == ["ja", "en"]
    assert languages.beta_codes() == []
    monkeypatch.delenv("SHADOW_LANGS")
    assert languages.launch_codes() == ["ja", "es", "en"]


def test_enabled_for_adds_the_beta_list_only_for_a_beta_device(monkeypatch):
    monkeypatch.setenv("SHADOW_LANGS", "ja,es,en")
    monkeypatch.setenv("SHADOW_LANGS_BETA", "fr")
    monkeypatch.setattr(access, "_beta_on", lambda device: device == "beta-dev")
    assert languages.enabled_for("beta-dev") == ["ja", "es", "en", "fr"]
    assert languages.enabled_for("plain-dev") == ["ja", "es", "en"]
    # An empty beta list never looks the switch up.
    monkeypatch.setenv("SHADOW_LANGS_BETA", "")
    monkeypatch.setattr(access, "_beta_on", lambda device: (_ for _ in ()).throw(AssertionError))
    assert languages.enabled_for("beta-dev") == ["ja", "es", "en"]


def test_available_needs_a_voice_and_both_intros(monkeypatch):
    assert languages.available("ja") and languages.available("en") and languages.available("es")
    assert not voices.has_voice("ko")
    assert not languages.available("ko")
    assert not languages.available("zz")
    # A voice alone is not enough.
    monkeypatch.setattr(voices, "has_voice", lambda code: True)
    monkeypatch.setattr(starter, "has_intro", lambda code, level="new": level == "new")
    assert not languages.available("ko")


def test_require_learning_400_body(monkeypatch):
    monkeypatch.setenv("SHADOW_LANGS", "ja,es,en")
    monkeypatch.setenv("SHADOW_LANGS_BETA", "fr")
    monkeypatch.setattr(access, "_beta_on", lambda device: device == "beta-dev")
    monkeypatch.setattr(voices, "has_voice", lambda code: code in ("ja", "es", "en", "fr"))
    monkeypatch.setattr(starter, "has_intro", lambda code, level="new": True)
    languages.require_learning("ja", "plain-dev")
    languages.require_learning("fr", "beta-dev")
    for code, device in (("fr", "plain-dev"), ("ko", "beta-dev"), ("zz", "beta-dev")):
        with pytest.raises(HTTPException) as err:
            languages.require_learning(code, device)
        assert err.value.status_code == 400
        assert err.value.detail == {"code": "language_unavailable", "language": code}


def test_beta_answer_carries_languages_with_speakers(monkeypatch):
    import asyncio

    monkeypatch.setattr(config, "SHADOW_TOKEN", "t0k")
    monkeypatch.setenv("SHADOW_LANGS", "ja,es,en")
    monkeypatch.setenv("SHADOW_LANGS_BETA", "fr,ko")
    monkeypatch.setattr(voices, "has_voice", lambda code: code in ("ja", "es", "en", "fr"))
    monkeypatch.setattr(starter, "has_intro", lambda code, level="new": True)
    beta.init()
    plain, on = _dev(), _dev()
    beta.set_flag(on, True, on)
    answer = asyncio.run(admin_r.beta_get("Bearer t0k", plain))
    assert answer["languages"] == [
        {"id": "ja", "speaker": voices.default_speaker("ja")},
        {"id": "es", "speaker": 10011},
        {"id": "en", "speaker": 10001},
    ]
    answer = asyncio.run(admin_r.beta_get("Bearer t0k", on))
    # ko is gated on but has no voice, so it stays out.
    assert [row["id"] for row in answer["languages"]] == ["ja", "es", "en", "fr"]
    assert answer["languages"][-1]["speaker"] == 10021


def test_kokoro_rows_for_the_new_languages():
    for code, speaker in (("fr", 10021), ("pt", 10031)):
        assert voices.has_voice(code)
        assert voices.default_speaker(code) == speaker
        assert voices.language_for(speaker) == code
        assert voices.engine_for(speaker) == "kokoro"
    # zh defaults to Melo (11102); Kokoro's zh voices (10041, 10042) are retired
    # from the list, and a saved id resolves to the zh default.
    assert voices.default_speaker("zh") == 11102
    assert voices.language_for(10041) == "zh" and voices.engine_for(10041) == "melo"
    assert 10041 not in [v.id for v in tts_registry.voices_for("zh")]
    assert 10042 not in [v.id for v in tts_registry.voices_for("zh")]
    assert voices.language_for(10032) == "pt" and voices.language_for(10042) == "zh"
    for code in ("ko", "de", "he", "ar"):
        assert not voices.has_voice(code)


def test_has_voice_follows_the_default_voice_engine(monkeypatch):
    melo = tts_registry.provider("melo")
    # zh defaults to Melo: a Kokoro zh voice existing is not enough.
    monkeypatch.setattr(type(melo), "enabled", lambda self: False)
    assert not voices.has_voice("zh")
    monkeypatch.setattr(type(melo), "enabled", lambda self: True)
    assert voices.has_voice("zh")
    assert voices.has_voice("fr") and not voices.has_voice("zz")


def test_catalogue_is_empty_for_a_known_language_without_phrases():
    import phrase_catalog

    assert phrase_catalog.catalog("fr") == {"topics": [], "categories": []}
    assert phrase_catalog.search("zh", q="hello") == {"topics": [], "categories": []}
    assert phrase_catalog.catalog("ja")["topics"]
    with pytest.raises(KeyError):
        phrase_catalog.catalog("zz")


def test_check_startup_logs_without_raising(monkeypatch):
    monkeypatch.setenv("SHADOW_LANGS_BETA", "ko")
    languages.check_startup()
