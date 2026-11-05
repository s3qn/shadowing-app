"""Say it in your language: generate.say_lines (prompt, schema, parse, cache)
and POST /shadow/say. No models or network: the CLI is a fake subprocess.run,
whisper, the voices, the aligners and ffmpeg are monkeypatched."""

import asyncio
import io
import json
import subprocess
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile

import energy
import generate
import llm
import main
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
JA_VOICE = 3
ES_VOICE = 10011
HE_WEATHER = "היום מזג האוויר יפה, אז אלך לטייל."


class FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    with store.connect() as conn:
        conn.execute("DELETE FROM say_cache")


def _reply(intent, lines, title="t"):
    return json.dumps({"intent": intent, "title": title, "lines": lines})


def _fake_cli(monkeypatch, stdout):
    """A fake claude CLI answering `stdout`; returns the call log (prompts)."""
    calls = []

    def fake_run(*args, **kw):
        calls.append(kw.get("input"))
        return FakeCompleted(returncode=0, stdout=stdout)

    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


def _ja_item(i):
    return {"text": f"行きます{i}", "reading": f"いきます{i}", "romaji": f"ikimasu{i}",
            "translation": f"going {i}"}


# -- schema and routing ----------------------------------------------------


def test_say_schema_is_strict_and_closes_the_items():
    strict = llm._strict(generate.SAY_SCHEMA)
    assert strict is not None
    assert strict["additionalProperties"] is False
    assert strict["required"] == ["intent", "lines"]
    items = strict["properties"]["lines"]["items"]
    assert items["additionalProperties"] is False
    assert items["required"] == ["text", "translation"]
    assert set(items["properties"]) == {"text", "reading", "romaji", "translation"}


def test_say_routes_to_sonnet_and_costs_one_energy():
    assert llm.model_for("say") == llm.TIERS["sonnet"]
    assert llm.MAX_TOKENS["say"] == 1024
    assert energy.PRICES["say"] == 1
    assert "say" not in main.guardrails.BUILD_KINDS


# -- parse -----------------------------------------------------------------


def test_sentence_keeps_one_line_and_maps_the_fields(monkeypatch):
    _fake_cli(monkeypatch, _reply("sentence", [
        {"text": "今日は天気がいいので、散歩に行きます。", "reading": "きょうはてんきがいいので、さんぽにいきます。",
         "romaji": "kyou wa tenki ga ii node, sanpo ni ikimasu.", "translation": "היום מזג האוויר יפה אז אלך לטייל"},
        _ja_item(2),
    ], title="טיול"))
    out = generate.say_lines(HE_WEATHER, "ja", "he", "polite")
    assert out["intent"] == "sentence"
    assert out["title"] == "טיול"
    assert out["lines"] == [{
        "ja": "今日は天気がいいので、散歩に行きます。",
        "kana": "きょうはてんきがいいので、さんぽにいきます。",
        "romaji": "kyou wa tenki ga ii node, sanpo ni ikimasu.",
        "en": "היום מזג האוויר יפה אז אלך לטייל",
    }]


def test_phrases_cap_at_eight_and_story_at_six(monkeypatch):
    _fake_cli(monkeypatch, _reply("phrases", [_ja_item(i) for i in range(12)]))
    assert len(generate.say_lines("תן לי עשרה משפטים", "ja", "he")["lines"]) == 8
    _fake_cli(monkeypatch, _reply("story", [_ja_item(i) for i in range(12)]))
    assert len(generate.say_lines("קמתי. שתיתי קפה. הלכתי.", "ja", "he")["lines"]) == 6


def test_unclear_has_no_lines_and_is_not_cached(monkeypatch):
    calls = _fake_cli(monkeypatch, _reply("unclear", [_ja_item(1)]))
    out = generate.say_lines("אה... אממ", "ja", "he")
    assert out == {"intent": "unclear", "title": "t", "lines": []}
    generate.say_lines("אה... אממ", "ja", "he")
    assert len(calls) == 2


def test_unknown_intent_reads_as_sentence(monkeypatch):
    _fake_cli(monkeypatch, _reply("poem", [_ja_item(1), _ja_item(2)]))
    out = generate.say_lines("שלום", "ja", "he")
    assert out["intent"] == "sentence"
    assert len(out["lines"]) == 1


def test_line_equal_to_the_transcript_is_dropped(monkeypatch):
    _fake_cli(monkeypatch, _reply("sentence", [
        {"text": " היום מזג  האוויר יפה, אז אלך לטייל ", "translation": "x"},
        _ja_item(1),
    ]))
    out = generate.say_lines(HE_WEATHER, "ja", "he")
    assert [ln["ja"] for ln in out["lines"]] == ["行きます1"]


def test_latin_learning_has_empty_kana_and_romaji(monkeypatch):
    _fake_cli(monkeypatch, _reply("sentence", [
        {"text": "Hoy hace buen tiempo.", "reading": "x", "romaji": "y", "translation": "היום יפה"},
    ]))
    out = generate.say_lines("היום יפה", "es", "he")
    assert out["lines"] == [{"ja": "Hoy hace buen tiempo.", "kana": "", "romaji": "", "en": "היום יפה"}]


def test_empty_transcript_makes_no_cli_call(monkeypatch):
    def fail(*a, **k):
        raise AssertionError("no CLI call for an empty transcript")

    monkeypatch.setattr(subprocess, "run", fail)
    assert generate.say_lines("   ", "ja", "he") == {"intent": "unclear", "title": "", "lines": []}


def test_cli_failure_is_unclear_without_raising(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: FakeCompleted(returncode=1, stdout=""))
    assert generate.say_lines("שלום", "ja", "he")["lines"] == []


# -- prompt ----------------------------------------------------------------


def test_ja_prompt_names_languages_markers_and_register(monkeypatch):
    calls = _fake_cli(monkeypatch, _reply("sentence", [_ja_item(1)]))
    generate.say_lines(HE_WEATHER, "ja", "he", "casual")
    prompt = calls[0]
    assert "<<<TRANSCRIPT_START>>>" in prompt and "<<<TRANSCRIPT_END>>>" in prompt
    assert HE_WEATHER in prompt
    assert "Hebrew" in prompt and "Japanese" in prompt
    assert generate.REGISTER_RULES["casual"] in prompt
    assert "hiragana" in prompt


def test_es_prompt_has_no_register_text(monkeypatch):
    calls = _fake_cli(monkeypatch, _reply("sentence", [{"text": "Hola.", "translation": "שלום"}]))
    generate.say_lines("שלום", "es", "he", "polite")
    prompt = calls[0]
    assert "Spanish" in prompt and "Hebrew" in prompt
    assert generate.REGISTER_RULES["polite"] not in prompt
    assert generate.REGISTER_RULES["casual"] not in prompt


# -- cache -----------------------------------------------------------------


def test_same_text_hits_the_cache_and_a_different_register_misses(monkeypatch):
    calls = _fake_cli(monkeypatch, _reply("sentence", [_ja_item(1)]))
    first = generate.say_lines(HE_WEATHER, "ja", "he", "polite")
    again = generate.say_lines("  היום מזג   האוויר יפה, אז אלך לטייל", "ja", "he", "polite")
    assert again == first
    assert len(calls) == 1
    generate.say_lines(HE_WEATHER, "ja", "he", "casual")
    assert len(calls) == 2
    generate.say_lines(HE_WEATHER, "ja", "en", "polite")
    assert len(calls) == 3


def test_a_question_and_a_statement_key_differently():
    # A question mark changes the meaning, a full stop does not.
    q = generate._say_key("אתה בא?", "ja", "he", "polite")
    s = generate._say_key("אתה בא.", "ja", "he", "polite")
    assert q != s
    assert s == generate._say_key("אתה בא", "ja", "he", "polite")
    assert generate._say_key("来ますか。", "ja", "he", "polite") == generate._say_key("来ますか", "ja", "he", "polite")
    assert generate._say_key("Ven!", "es", "he", "") != generate._say_key("Ven", "es", "he", "")


def test_bumping_the_prompt_version_misses_the_cache(monkeypatch):
    calls = _fake_cli(monkeypatch, _reply("sentence", [_ja_item(1)]))
    generate.say_lines(HE_WEATHER, "ja", "he")
    monkeypatch.setattr(generate, "SAY_PROMPT_VERSION", generate.SAY_PROMPT_VERSION + 1)
    generate.say_lines(HE_WEATHER, "ja", "he")
    assert len(calls) == 2


# -- route -----------------------------------------------------------------


@pytest.fixture
def pipeline(monkeypatch):
    seen = {"transcribe": 0, "say": []}

    async def speak_timed(text, speaker):
        return b"RIFF", [], 1.0, "", []

    def to_wav(src, dst):
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(b"RIFF")
        return True

    def transcribe(path, language=None, *a, **k):
        seen["transcribe"] += 1
        seen["whisper_language"] = language
        return {"text": HE_WEATHER, "language": language or "he"}

    def say_lines(text, learning, native, register):
        seen["say"].append((text, learning, native, register))
        return {"intent": "sentence", "title": "טיול", "lines": [
            {"ja": "今日は天気がいいので、散歩に行きます。", "kana": "きょう", "romaji": "kyou", "en": "x"},
        ]}

    monkeypatch.setattr(main, "_to_wav", to_wav)
    monkeypatch.setattr(main.transcribe, "transcribe", transcribe)
    monkeypatch.setattr(main.generate, "say_lines", say_lines)
    monkeypatch.setattr(main.voices, "speak_timed", speak_timed)
    monkeypatch.setattr(main.segment, "align", lambda *a, **k: [])
    monkeypatch.setattr(main.latin, "align", lambda *a, **k: [])
    return seen


def _post(device, language="ja", speaker=JA_VOICE, native="he", register="polite",
          dev_transcript=""):
    background = BackgroundTasks()
    out = asyncio.run(main.create_say(
        background, audio=UploadFile(file=io.BytesIO(b"x"), filename="r.m4a"),
        language=language, native=native, speaker=speaker, register=register,
        dev_transcript=dev_transcript, authorization=AUTH, x_shadow_device=device,
    ))

    async def run():
        for task in background.tasks:
            await task.func(*task.args, **task.kwargs)

    asyncio.run(run())
    return out


def _device():
    return f"dddddddd-0000-4000-8000-{uuid.uuid4().hex[:12]}"


def test_say_builds_a_one_line_voice_island_titled_with_the_transcript(pipeline):
    dev = _device()
    out = _post(dev)
    assert out["status"] == "pending"
    island = store.get_island(out["id"])
    assert island["status"] == "ready"
    assert island["source"] == "voice"
    assert island["source_name"] == "say"
    assert island["title"] == HE_WEATHER[:40]
    assert island["transcript"] == HE_WEATHER
    assert len(island["lines"]) == 1
    assert island["lines"][0]["ja"] == "今日は天気がいいので、散歩に行きます。"
    assert pipeline["whisper_language"] == "he"
    assert pipeline["say"] == [(HE_WEATHER, "ja", "he", "polite")]
    assert store.count_builds_today(dev, "say") == 1
    assert store.count_builds_today(dev, "create") == 0


def test_unknown_language_and_mismatched_voice_are_400(pipeline):
    with pytest.raises(HTTPException) as err:
        _post(_device(), language="fr", speaker=JA_VOICE)
    assert err.value.status_code == 400
    with pytest.raises(HTTPException) as err:
        _post(_device(), language="es", speaker=JA_VOICE)
    assert err.value.status_code == 400
    with pytest.raises(HTTPException) as err:
        _post(_device(), language="en", native="en", speaker=main.voices.default_speaker("en"))
    assert err.value.status_code == 400


def test_unclear_fails_with_say_unclear_and_refunds_the_slot(pipeline, monkeypatch):
    monkeypatch.setattr(main.generate, "say_lines",
                        lambda *a, **k: {"intent": "unclear", "title": "", "lines": []})
    dev = _device()
    out = _post(dev)
    island = store.get_island(out["id"])
    assert island["status"] == "failed"
    assert island["error_code"] == "say_unclear"
    assert island["lines"] == []
    assert store.count_builds_today(dev, "say") == 0


def test_daily_says_cap_is_429_with_kind_say(pipeline, monkeypatch):
    monkeypatch.setattr(main, "DAILY_SAYS", 2)
    dev = _device()
    _post(dev)
    _post(dev)
    with pytest.raises(HTTPException) as err:
        _post(dev)
    assert err.value.status_code == 429
    assert err.value.detail["code"] == "daily_limit"
    assert err.value.detail["kind"] == "say"
    assert err.value.detail["limit"] == 2


def test_dev_transcript_skips_whisper_in_dev_and_is_ignored_in_prod(pipeline, monkeypatch):
    monkeypatch.setenv("SHADOW_ENV", "dev")
    out = _post(_device(), dev_transcript="תן לי שלושה משפטים לחדר כושר")
    assert pipeline["transcribe"] == 0
    assert pipeline["say"][-1][0] == "תן לי שלושה משפטים לחדר כושר"
    assert store.get_island(out["id"])["transcript"] == "תן לי שלושה משפטים לחדר כושר"

    monkeypatch.setenv("SHADOW_ENV", "prod")
    _post(_device(), dev_transcript="ignored")
    assert pipeline["transcribe"] == 1
    assert pipeline["say"][-1][0] == HE_WEATHER


def test_es_say_uses_the_latin_path(pipeline):
    out = _post(_device(), language="es", speaker=ES_VOICE)
    island = store.get_island(out["id"])
    assert island["status"] == "ready"
    assert island["language"] == "es"


def test_a_failed_say_is_not_listed_on_home_but_stays_readable_by_id(pipeline, monkeypatch):
    dev = _device()
    ok = _post(dev)
    monkeypatch.setattr(main.generate, "say_lines",
                        lambda *a, **k: {"intent": "unclear", "title": "", "lines": []})
    bad = _post(dev)
    assert store.get_island(bad["id"])["status"] == "failed"
    listed = main.list_islands(authorization=AUTH, device="", x_shadow_device=dev)
    assert [r["id"] for r in listed] == [ok["id"]]
