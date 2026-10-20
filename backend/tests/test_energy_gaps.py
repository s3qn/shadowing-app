"""The four cost gaps from the BL-52 research, fixed flag or no flag:
explain-word needs a device and has a daily cap, regenerate reuses the stored
transcript, a phrases render is shared per (language, topic, speaker, native),
and explain runs on the cheapest Haiku at low effort."""

import asyncio
import json
import shutil
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

import explain
import main
import phrase_catalog
import starter
import store
import voices

AUTH = f"Bearer {main.SHADOW_TOKEN}"


@pytest.fixture(autouse=True)
def _init_db(monkeypatch, tmp_path):
    # A fresh data dir per test, so a shared render one test leaves behind
    # never turns another test's build into an instant copy.
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    store.init()


def _dev() -> str:
    return f"user_{uuid.uuid4().hex}"


def _explain_word(dev, sentence="猫が好きです。", word="猫"):
    return asyncio.run(main.explain_word(
        word=word, sentence_ja=sentence, authorization=AUTH, x_shadow_device=dev))


# --- gap 1: explain-word ---

def test_explain_word_without_a_device_is_401():
    with pytest.raises(HTTPException) as exc_info:
        _explain_word("")
    assert exc_info.value.status_code == 401


def test_explain_word_miss_takes_a_slot_and_a_hit_does_not(monkeypatch):
    monkeypatch.setattr(main.explain, "word_context", lambda *a, **k: "a gloss")
    dev = _dev()
    sentence = f"{uuid.uuid4().hex}は猫です。"
    assert _explain_word(dev, sentence) == {"context": "a gloss"}
    assert store.count_builds_today(dev, "explain_word") == 1
    assert _explain_word(dev, sentence) == {"context": "a gloss"}
    assert store.count_builds_today(dev, "explain_word") == 1


def test_the_101st_explain_word_miss_is_429(monkeypatch):
    calls = []
    monkeypatch.setattr(main.explain, "word_context", lambda *a, **k: calls.append(1) or "x")
    dev = _dev()
    for _ in range(100):
        store.log_build(dev, "explain_word")
    with pytest.raises(HTTPException) as exc_info:
        _explain_word(dev, f"{uuid.uuid4().hex}は犬です。")
    assert exc_info.value.status_code == 429
    assert exc_info.value.detail == {"code": "daily_limit", "limit": 100, "kind": "explain_word"}
    assert calls == []


# --- gap 2: regenerate reuses the transcript ---

def _voice_island(dev, transcript="きのう公園で猫を見ました。"):
    island_id = store.create_island("simple", 3, language="ja", native="en",
                                    source="voice", device=dev)
    store.set_transcript(island_id, transcript)
    wav = store.AUDIO_DIR / island_id / "source.wav"
    wav.parent.mkdir(parents=True, exist_ok=True)
    wav.write_bytes(b"RIFF")
    return island_id, wav


def test_build_island_with_a_transcript_never_transcribes(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("whisper ran on a regenerate")
    monkeypatch.setattr(main.transcribe, "transcribe", boom)
    seen = []
    monkeypatch.setattr(main.generate, "generate_lines",
                        lambda text, *a, **k: seen.append(text) or {"lines": []})
    island_id, wav = _voice_island(_dev())
    asyncio.run(main._build_island(island_id, wav, "simple", 3, 8, transcript="x"))
    assert seen == ["x"]
    assert store.get_island(island_id)["status"] == "failed"  # no lines, as monkeypatched


def test_a_regenerate_reads_the_language_from_the_script(monkeypatch):
    seen = []
    monkeypatch.setattr(main.generate, "generate_lines",
                        lambda text, c, n, language, *a, **k: seen.append(language) or {"lines": []})
    island_id, wav = _voice_island(_dev())
    asyncio.run(main._build_island(island_id, wav, "simple", 3, 8, transcript="猫を見ました"))
    asyncio.run(main._build_island(island_id, wav, "simple", 3, 8, transcript="ראיתי חתול"))
    asyncio.run(main._build_island(island_id, wav, "simple", 3, 8, transcript="I saw a cat"))
    assert seen == ["ja", "he", ""]


def test_regenerate_passes_the_stored_transcript():
    dev = _dev()
    island_id, _ = _voice_island(dev, "stored words")
    bg = BackgroundTasks()
    out = asyncio.run(main.regenerate(
        island_id, bg, complexity="simple", count=8, authorization=AUTH, x_shadow_device=dev))
    assert out["status"] == "working"
    assert bg.tasks[0].func is main._build_island
    assert bg.tasks[0].kwargs["transcript"] == "stored words"


# --- gap 3: shared phrase renders ---

OTHER_JA = 8 if voices.default_speaker("ja") != 8 else 2


def _fake_synth(island_id, lines, speaker, language="ja"):
    for idx, line in enumerate(lines):
        store.add_line(island_id, idx, line, 1.5, [{"text": line["ja"], "start": 0, "end": 1.5}],
                       [{"text": line["ja"], "start": 0.0, "end": 1.5}])
        store.line_audio_path(island_id, idx).write_bytes(f"wav-{idx}".encode())
    return len(lines)


def _import(dev, bg=None, topic="greetings", native="en"):
    return asyncio.run(main.import_phrases(
        bg or BackgroundTasks(), topic=topic, speaker=OTHER_JA, language="ja", native=native,
        authorization=AUTH, x_shadow_device=dev))


def test_phrases_build_is_cached_and_the_next_device_copies_it(monkeypatch):
    assert voices.language_for(OTHER_JA) == "ja"
    monkeypatch.setattr(main.segment, "reading", lambda text: text)

    async def fake_synth(*a, **k):
        return _fake_synth(*a, **k)
    monkeypatch.setattr(main, "_synthesize_lines", fake_synth)
    assert not starter.has_cached("ja", "greetings", OTHER_JA, "en")

    first = _dev()
    bg = BackgroundTasks()
    out = _import(first, bg)
    assert out["status"] == "pending"
    assert store.count_builds_today(first, "create") == 1
    asyncio.run(bg.tasks[0]())
    built = store.get_island(out["id"])
    assert built["status"] == "ready"

    assert starter.has_cached("ja", "greetings", OTHER_JA, "en")
    cache = starter.cache_dir("ja", "greetings", OTHER_JA, "en")
    saved = json.loads((cache / "island.json").read_text(encoding="utf-8"))
    assert len(saved["lines"]) == len(built["lines"])
    assert saved["lines"][0]["gloss"] == {"en": built["lines"][0]["en"]}
    assert (cache / "0.wav").read_bytes() == b"wav-0"
    assert not list(cache.parent.glob("*.tmp"))

    second = _dev()
    out2 = _import(second)
    assert out2["status"] == "ready"
    assert store.count_builds_today(second, "create") == 0
    copy = store.get_island(out2["id"])
    assert copy["device"] == second and copy["source_name"] == "greetings"
    assert [l["ja"] for l in copy["lines"]] == [l["ja"] for l in built["lines"]]
    assert store.line_audio_path(out2["id"], 1).read_bytes() == b"wav-1"

    # Another native language is another render.
    assert not starter.has_cached("ja", "greetings", OTHER_JA, "he")


def _build_once(monkeypatch, native="en", synth=_fake_synth, translate=None):
    """Run one phrases build for greetings in OTHER_JA and return its island."""
    monkeypatch.setattr(main.segment, "reading", lambda text: text)

    async def fake_synth(*a, **k):
        return synth(*a, **k)
    monkeypatch.setattr(main, "_synthesize_lines", fake_synth)
    if translate is not None:
        monkeypatch.setattr(main.generate, "translate_lines", translate)
        # The catalogue now ships Hebrew glosses; drop them so the stub runs.
        real = phrase_catalog.phrases
        monkeypatch.setattr(phrase_catalog, "phrases", lambda lang, topic: [
            {k: v for k, v in e.items() if k != "he"} for e in real(lang, topic)])
    bg = BackgroundTasks()
    out = _import(_dev(), bg, native=native)
    asyncio.run(bg.tasks[0]())
    return store.get_island(out["id"])


def test_a_failed_translation_is_never_cached(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("claude is down")
    island = _build_once(monkeypatch, native="he", translate=boom)
    assert island["status"] == "ready"
    assert not starter.has_cached("ja", "greetings", OTHER_JA, "he")


def test_a_partial_translation_is_never_cached(monkeypatch):
    island = _build_once(monkeypatch, native="he",
                         translate=lambda texts, *a, **k: ["שלום"] * (len(texts) - 1))
    assert island["status"] == "ready"
    assert not starter.has_cached("ja", "greetings", OTHER_JA, "he")


def test_a_full_translation_is_cached(monkeypatch):
    _build_once(monkeypatch, native="he",
                translate=lambda texts, *a, **k: [f"he{i}" for i in range(len(texts))])
    assert starter.has_cached("ja", "greetings", OTHER_JA, "he")


def test_a_build_with_a_silent_line_is_never_cached(monkeypatch):
    def synth_skipping_line_1(island_id, lines, speaker, language="ja"):
        kept = [(i, l) for i, l in enumerate(lines) if i != 1]
        for idx, line in kept:
            store.add_line(island_id, idx, line, 1.5, [], [])
            store.line_audio_path(island_id, idx).write_bytes(f"wav-{idx}".encode())
        return len(kept)
    island = _build_once(monkeypatch, synth=synth_skipping_line_1)
    assert island["status"] == "ready"
    assert not starter.has_cached("ja", "greetings", OTHER_JA, "en")


def test_a_cache_missing_a_wav_falls_through_to_a_build(monkeypatch):
    _build_once(monkeypatch)
    cache = starter.cache_dir("ja", "greetings", OTHER_JA, "en")
    (cache / "2.wav").unlink()
    assert not starter.has_cached("ja", "greetings", OTHER_JA, "en")
    monkeypatch.setattr(main, "_build_phrases", lambda *a, **k: None)
    assert _import(_dev())["status"] == "pending"


def test_a_second_save_mid_copy_never_breaks_the_first(monkeypatch):
    """B starting while A is mid-copy must not delete A's files: each save
    writes its own temp dir and the first rename wins."""
    island = _build_once(monkeypatch)
    cache = starter.cache_dir("ja", "greetings", OTHER_JA, "en")
    shutil.rmtree(cache)
    real_copy = shutil.copyfile
    nested = []

    def copy_then_race(src, dst, *a, **k):
        if not nested:
            nested.append(1)
            starter.save_cache(island["id"], "ja", "greetings", OTHER_JA, "en")
        return real_copy(src, dst, *a, **k)
    monkeypatch.setattr(starter.shutil, "copyfile", copy_then_race)
    starter.save_cache(island["id"], "ja", "greetings", OTHER_JA, "en")
    assert nested and starter.has_cached("ja", "greetings", OTHER_JA, "en")
    assert not list(cache.parent.glob("*.tmp"))
    assert not list(cache.parent.glob(".*.tmp"))


def test_the_cache_key_changes_with_the_topic_text(monkeypatch):
    before = starter.cache_dir("ja", "greetings", OTHER_JA, "en")
    real = phrase_catalog.phrases

    def edited(language, topic):
        entries = [dict(e) for e in real(language, topic)]
        entries[0]["text"] += "！"
        return entries
    monkeypatch.setattr(starter.phrase_catalog, "phrases", edited)
    assert starter.cache_dir("ja", "greetings", OTHER_JA, "en") != before
    assert str(starter.CACHE_FORMAT) in before.name


def test_a_cache_failure_never_fails_the_island(monkeypatch):
    monkeypatch.setattr(main.segment, "reading", lambda text: text)

    async def fake_synth(*a, **k):
        return _fake_synth(*a, **k)
    monkeypatch.setattr(main, "_synthesize_lines", fake_synth)

    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(main.starter, "save_cache", boom)
    dev = _dev()
    bg = BackgroundTasks()
    out = _import(dev, bg, topic=phrase_catalog.catalog("ja")["topics"][1]["id"])
    asyncio.run(bg.tasks[0]())
    assert store.get_island(out["id"])["status"] == "ready"


# --- gap 4: explain on the cheapest Haiku ---

def test_explain_argv_carries_the_model_and_low_effort():
    argv = explain._cli_argv()
    assert argv[argv.index("--model") + 1] == "claude-haiku-5-5"
    assert argv[argv.index("--effort") + 1] == "low"
    assert explain.CLI_ENV_OVERRIDES == {"MAX_THINKING_TOKENS": "0"}


def test_empty_effort_drops_the_flag(monkeypatch):
    monkeypatch.setattr(explain, "CLI_EFFORT", "")
    assert "--effort" not in explain._cli_argv()
