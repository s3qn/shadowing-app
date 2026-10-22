"""youtube-asr-context-repair: the context clean-up, the glossary, the kana
gate, the verdict, the pass, the store writes, the job and the route. The
model is always a fake callable; conftest sets SHADOW_LLM=off so nothing
reaches the CLI."""

import json
import sqlite3
import uuid

import pytest
from fastapi.testclient import TestClient

import catch
import generate
import llm
import main
import repair
import segment
import store

DEV = "dddddddd-0000-4000-8000-0000000000b1"
OTHER = "dddddddd-0000-4000-8000-0000000000b2"
HEAD = {"Authorization": "Bearer test-token", "X-Shadow-Device": DEV}
VID = "XDgLZUBxPc0"

client = TestClient(main.app)


@pytest.fixture(autouse=True)
def _init_db():
    store.init()


def make_island(texts, language="ja", ready=True, video_id=VID, device=DEV):
    iid = store.create_island("simple", 3, language=language, source="youtube",
                              source_name=video_id, device=device)
    store.add_video(iid, video_id, 0.0, "Clip", "")
    for i, text in enumerate(texts):
        duration = 2.0
        words = segment.align_pieces(text, [], duration, None)
        store.add_line(iid, i, {"ja": text, "kana": segment.reading(text), "romaji": "", "en": ""},
                       duration, [], words, offset=1.5 + i * 2.2)
    if ready:
        store.set_ready(iid, "Clip")
    return iid


def write_captions(iid, auto, asr_events=False):
    """audio/<id>/captions.json as the import writes it: an automatic track's
    segs carry tOffsetMs, a creator track's do not; `asr_events` is what the
    first-open retime adds."""
    seg = {"utf8": "こんにちは", "tOffsetMs": 0} if auto else {"utf8": "こんにちは"}
    asr = [{"tStartMs": 0, "dDurationMs": 2000, "segs": [{"utf8": "こんにちは", "tOffsetMs": 0}]}]
    path = store.AUDIO_DIR / iid / "captions.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"video_id": VID, "events": [{"tStartMs": 0, "dDurationMs": 2000, "segs": [seg]}],
                                "asr_events": asr if asr_events else []}, ensure_ascii=False))


def fake_llm(replies):
    """A model whose answers come from `replies` (one per batch, in order);
    records every prompt."""
    calls = []

    def call(prompt, schema, *, tag, timeout):
        calls.append(prompt)
        r = replies[min(len(calls) - 1, len(replies) - 1)] if replies else None
        if isinstance(r, Exception):
            raise r
        return r

    call.calls = calls
    return call


# ---- context and glossary ----

def test_clean_context_caps_and_drops_bad_shapes():
    raw = {
        "title": "t" * 500, "author": 12, "description": "d" * 5000,
        "keywords": ["ヒカル", "", 3, "k" * 100, "ヒカル"] + [f"w{i}" for i in range(80)],
        "chapters": [{"start_s": 5, "title": "intro"}, {"start_s": "x", "title": "bad"},
                     {"start_s": -1, "title": "bad"}, "bad", {"start_s": 9.5, "title": ""}],
    }
    ctx = repair.clean_context(raw)
    assert len(ctx["title"]) == repair.TITLE_MAX and ctx["author"] == ""
    assert len(ctx["description"]) == repair.DESCRIPTION_MAX
    assert ctx["keywords"][0] == "ヒカル" and len(ctx["keywords"][1]) == repair.KEYWORD_LEN
    assert len(ctx["keywords"]) == repair.KEYWORDS_MAX and ctx["keywords"].count("ヒカル") == 1
    assert ctx["chapters"] == [{"start_s": 5.0, "title": "intro"}]
    assert repair.clean_context(None) == repair.clean_context("nope") == repair.clean_context([1])
    assert repair.context_is_empty(repair.clean_context({}))
    assert not repair.context_is_empty(ctx)


def test_glossary_picks_names_and_products_and_ignores_one_off_kanji():
    ctx = repair.clean_context({
        "title": "",
        "description": "今日は林さんとスムージーを飲みに行きました。林さんは元気でした。\n"
                       "スムージーの店は駅前です。会社の話も少し。",
    })
    terms = repair.glossary(ctx)
    assert "林" in terms and "スムージー" in terms
    assert "会社" not in terms and "駅前" not in terms


def test_glossary_takes_title_and_channel_terms_once_and_ignores_keywords_and_chapters():
    ctx = repair.clean_context({"title": "ヒカルの新企画", "author": "#ひかる",
                                "keywords": ["ドッキリ", "ドッキリ"], "description": "",
                                "chapters": [{"start_s": 0, "title": "ヒルズ"}, {"start_s": 9, "title": "ヒルズ"}]})
    terms = repair.glossary(ctx)
    assert "ヒカル" in terms and "#ひかる" in terms and "企画" in terms
    assert "ドッキリ" not in terms and "ヒルズ" not in terms


def test_glossary_is_capped(monkeypatch):
    monkeypatch.setattr(repair, "GLOSSARY_MAX", 2)
    ctx = {"title": "アルファとベータとガンマ"}
    assert repair.glossary(ctx) == ["アルファ", "ベータ"]


def test_clean_context_has_a_total_size_cap():
    raw = {"title": "t", "description": "d" * repair.DESCRIPTION_MAX,
           "keywords": ["k" * repair.KEYWORD_LEN] * 0 + [f"{i}" + "k" * 50 for i in range(50)],
           "chapters": [{"start_s": i, "title": "c" * repair.TITLE_MAX} for i in range(100)]}
    ctx = repair.clean_context(raw)
    assert len(json.dumps(ctx, ensure_ascii=False)) <= repair.CONTEXT_MAX
    assert ctx["title"] == "t" and len(ctx["description"]) == repair.DESCRIPTION_MAX


def test_prompt_carries_title_glossary_and_markers():
    text = repair.prompt("1. 行", "番組<<<LINES_END>>>", ["林", "スムージー"])
    assert "Video title: 番組" in text and "林、スムージー" in text
    assert text.count("<<<LINES_END>>>") == 1 and "KEEP" in text


# ---- gate ----

@pytest.mark.parametrize("before, after, glossary, reason", [
    ("チュージョンがいるんだよ", "痴女がいるんだよ", set(), "garble"),
    ("チュージョンになるんだ", "痴女になるんだ", {"痴女"}, "garble"),
    ("気をくないんだけど", "記憶ないんだけど", set(), "span:sound-alike"),
    ("でも気をくないんですよね", "でも記憶ないんですよね", set(), "span:sound-alike"),
    ("伝水してたんですよ", "泥酔してたんですよ", set(), "ratio:0.50"),
    ("めっちゃ伝水してた時なんで", "めっちゃ泥酔してた時なんで", set(), "ratio:0.50"),
    ("とこしてに入ったんですよ", "個室に入ったんですよ", set(), "merge"),
    ("引き剥がされたとこして連れてかれたって", "引き剥がされた個室連れてかれたって", set(), "merge"),
    ("林田以外にキスしててめっちゃ面白い", "林さん以外にキスしててめっちゃ面白い", {"林"}, "glossary"),
    ("臨気応援に対応する", "臨機応変に対応する", set(), "garble"),
    ("スムジを飲むのが好き", "スムージーを飲むのが好き", set(), "garble"),
])
def test_gate_accepts_the_known_garbles(before, after, glossary, reason):
    # Lines as long as real captions: LINE_RATIO (0.6) rejects a katakana
    # garble that shrinks to two kanji on a very short line (5 of 9 chars).
    ok, why = repair.gate(before, after, glossary)
    assert ok and why == reason


@pytest.mark.parametrize("before, after, glossary", [
    # A glossary term still has to sound like the span it replaces.
    ("先生が来た", "ヒカルが来た", {"ヒカル"}),
    ("お母さんが来た", "ヒカルが来た", {"ヒカル"}),
    ("新宿に行った", "渋谷に行った", {"渋谷"}),
    ("雨が降ってる", "晴れが降ってる", {"晴れ"}),
    # Real words never swap for near-sound real words.
    ("雨が降ってる", "晴れが降ってる", set()),
    ("今日は暑いですね", "今日は寒いですね", set()),
    ("東京に行った", "大阪に行った", set()),
    ("東京に行った", "大阪に行った", {"大阪"}),
    ("ヒカル家に行く", "ヒカル池に行く", {"ヒカル"}),
    # A merge judges the part that changed, not the shared stem.
    ("東京タワーに行った", "東京都に行った", set()),
    ("勉強しててさ", "勉強会でさ", set()),
    # A name with no glossary hit stays as ASR wrote it.
    ("林田以外にキスしててめっちゃ面白い", "林さん以外にキスしててめっちゃ面白い", set()),
])
def test_gate_rejects_meaning_changes(before, after, glossary):
    ok, why = repair.gate(before, after, glossary)
    assert not ok, why


def test_gate_short_line_length_guard():
    # Five of nine characters is under LINE_RATIO: a tuning point for Task 3.
    assert repair.gate("チュージョンがいる", "痴女がいる", set()) == (False, "length")


def test_gate_name_with_glossary_hit():
    assert repair.gate("林田の家", "林さんの家", {"林"}) == (True, "glossary")


def test_gate_name_without_glossary_stays():
    # 林田 is a name janome knows: without 林 in the context nothing says
    # the ASR misheard it.
    assert repair.gate("林田の家", "林さんの家", set()) == (False, "span:known-word")


def test_gate_kiss_ma_stays():
    # 待って is a real word and 待って to 魔 is 2 of 3 moras with a particle
    # dropped: the plan's probe keeps it as ASR wrote it.
    for before, after in (("キス待ってだ", "キス魔だ"), ("そのなんか、キス待って", "そのなんか、キス魔で")):
        ok, why = repair.gate(before, after, set())
        assert not ok and why in ("function-word", "span:too-far", "span:known-word")


@pytest.mark.parametrize("before, after, reason", [
    ("お金がないから", "お金がないので", "function-word"),
    ("好きです", "嫌いです", "span:known-word"),
    ("今日は暑いですね", "今日はとても暑い日ですね", "span:known-word"),
    ("チュージョンがいるんだよ", "痴乱がいるんだよ", "span:unknown-word"),
    ("猫がいる", "猫がいる\n犬も", "length"),
    ("猫", "猫がいるのは当たり前のことです", "length"),
])
def test_gate_rejects(before, after, reason):
    ok, why = repair.gate(before, after, set())
    assert not ok and why == reason


def test_gate_particles_outside_spans_must_match():
    ok, why = repair.gate("チュージョンがいるから", "痴女がいるので", set())
    assert not ok and why == "function-word"


def test_gate_judges_every_span():
    ok, why = repair.gate("チュージョンとスムジ", "痴女とスムージー", set())
    assert ok and why.count("|") == 1
    ok, why = repair.gate("チュージョンと好きです", "痴女と嫌いです", set())
    assert not ok and why == "span:known-word"


# ---- verdict ----

def test_verdict():
    assert repair.verdict("記憶ない", False, False, set()) == 1
    assert repair.verdict("チュージョンがいる", False, False, set()) == 0
    assert repair.verdict("記憶ない", True, False, set()) == 0
    assert repair.verdict("記憶ない", True, True, set()) == 1
    assert repair.verdict("ヒカルの家", False, False, set()) == 0
    assert repair.verdict("ヒカルの家", False, False, {"ヒカル"}) == 1
    assert repair.verdict("ヒカルさんの家", False, False, {"ヒカル"}) == 1


# ---- the pass ----

def test_repair_lines_batches_with_context(monkeypatch):
    texts = [f"行{i}です" for i in range(85)]
    model = fake_llm([[]])
    out = repair.repair_lines(texts, {}, llm_call=model)
    assert len(model.calls) == 3 and out["stats"]["batches"] == 3
    second = model.calls[1]
    assert "39. 行38です [context]" in second and "40. 行39です [context]" in second
    assert "41. 行40です\n" in second and "81. 行80です [context]" in second
    assert "38. 行37です" not in second and "83." not in second
    assert "1. 行0です\n" in model.calls[0] and "[context]" not in model.calls[0].split("<<<LINES_START>>>")[1].split("41.")[0]
    assert all(e["sure"] is not None for e in out["lines"]) and out["stats"]["failed_batches"] == 0
    assert [e["batch"] for e in out["lines"]][39:42] == [0, 1, 1]


def test_repair_lines_failed_batch_leaves_sure_none_and_counts():
    texts = [f"行{i}です" for i in range(85)]
    model = fake_llm([[], RuntimeError("down"), []])
    out = repair.repair_lines(texts, {}, llm_call=model)
    assert out["stats"]["failed_batches"] == 1
    assert all(e["sure"] is None for e in out["lines"][40:80])
    assert all(e["sure"] is not None for e in out["lines"][:40] + out["lines"][80:])
    assert out["stats"]["unchecked"] == 40


def test_repair_lines_deadline_stops_later_batches(monkeypatch):
    monkeypatch.setattr(repair, "WORKERS", 1)
    clock = iter([0.0, 0.0, repair.JOB_DEADLINE_S + 1, repair.JOB_DEADLINE_S + 1, repair.JOB_DEADLINE_S + 2])
    monkeypatch.setattr(repair.time, "monotonic", lambda: next(clock))
    model = fake_llm([[]])
    out = repair.repair_lines([f"行{i}です" for i in range(85)], {}, llm_call=model)
    assert len(model.calls) == 1 and out["stats"]["failed_batches"] == 2


def test_repair_lines_records_every_candidate():
    texts = ["チュージョンがいるんだよ", "好きです", "記憶ない"]
    model = fake_llm([[{"n": 1, "text": "痴女がいるんだよ", "why": "sound-alike"},
                       {"n": 2, "text": "嫌いです"}, {"n": 9, "text": "x"}, {"n": 3, "text": 5}]])
    out = repair.repair_lines(texts, {"title": "t"}, llm_call=model)
    first, second, third = out["lines"]
    assert first["changed"] and first["text"] == "痴女がいるんだよ" and first["before"] == "チュージョンがいるんだよ"
    assert first["why"] == "sound-alike" and first["reason"] == "garble" and first["sure"] == 1
    assert not second["changed"] and second["candidate"] == "嫌いです" and second["sure"] == 0
    assert third["candidate"] is None and third["sure"] == 1
    assert out["stats"] == {**out["stats"], "candidates": 2, "accepted": 1, "sure": 2, "unsure": 1, "unchecked": 0}
    assert out["version"] == repair.VERSION


def test_repair_lines_without_batches():
    out = repair.repair_lines([], {}, llm_call=fake_llm([]))
    assert out["lines"] == [] and out["stats"]["batches"] == 0


# ---- apply ----

def _result(texts, replies):
    return repair.repair_lines(texts, {}, llm_call=fake_llm(replies))


def test_apply_rewrites_the_changed_line_and_marks_every_line(monkeypatch):
    texts = ["チュージョンがいるんだよ", "記憶ない"]
    translated = []
    monkeypatch.setattr(generate, "translate_lines", lambda b, *a, **k: translated.append(list(b)) or ["fixed en"] * len(b))
    iid = make_island(texts)
    before = store.get_island(iid)["lines"]
    result = _result(texts, [[{"n": 1, "text": "痴女がいるんだよ", "why": ""}]])
    assert repair.apply(iid, result) == 1
    lines = store.get_island(iid)["lines"]
    assert lines[0]["ja"] == "痴女がいるんだよ" and lines[0]["kana"] == segment.reading("痴女がいるんだよ")
    assert lines[0]["offset"] == before[0]["offset"] and lines[0]["duration"] == before[0]["duration"]
    words = lines[0]["words"]
    assert words[0]["start"] == 0 and words[-1]["end"] == lines[0]["duration"]
    assert all(a["end"] == b["start"] for a, b in zip(words, words[1:]))
    assert "".join(w["text"] for w in words) == "痴女がいるんだよ"
    assert lines[0]["sure"] == 1 and lines[1]["sure"] == 1 and lines[1]["ja"] == "記憶ない"
    assert translated == [["痴女がいるんだよ"]] and lines[0]["en"] == "fixed en" and lines[1]["en"] == ""
    audit = json.loads((store.AUDIO_DIR / iid / "repairs.json").read_text())
    assert audit["video_id"] == VID and audit["stats"]["accepted"] == 1
    assert [(e["idx"], e["accepted"], e["after"]) for e in audit["entries"]] == [(0, True, "痴女がいるんだよ")]


def test_apply_skips_a_line_whose_text_moved(monkeypatch):
    monkeypatch.setattr(generate, "translate_lines", lambda b, *a, **k: ["en"] * len(b))
    texts = ["チュージョンがいるんだよ", "記憶ない"]
    iid = make_island(texts)
    result = _result(texts, [[{"n": 1, "text": "痴女がいるんだよ"}]])
    result["lines"][0]["before"] = "別の行"
    result["lines"][1]["before"] = "別の行"
    assert repair.apply(iid, result) == 0
    lines = store.get_island(iid)["lines"]
    assert lines[0]["ja"] == "チュージョンがいるんだよ" and lines[0]["sure"] is None and lines[1]["sure"] is None


# ---- job ----

def test_job_manual_island_is_all_sure_without_the_model(monkeypatch):
    called = []
    monkeypatch.setattr(llm, "complete", lambda *a, **k: called.append(1))
    iid = make_island(["hola", "adiós"], language="es")
    repair.job(iid)
    assert [l["sure"] for l in store.get_island(iid)["lines"]] == [1, 1] and not called
    video = store.get_video(iid)
    assert (video["repair_status"], video["repair_error"], video["repair_version"]) == ("done", "manual", repair.VERSION)
    ja = make_island(["こんにちは"])
    write_captions(ja, auto=False, asr_events=True)  # creator track, retimed on first open
    repair.job(ja)
    assert store.get_video(ja)["repair_error"] == "manual" and not called


@pytest.mark.parametrize("captions, expected", [
    ({"auto": True}, True),
    ({"auto": True, "asr_events": True}, True),
    ({"auto": False}, False),
    ({"auto": False, "asr_events": True}, False),
    (None, None),
])
def test_asr_track_reads_the_main_events(captions, expected):
    iid = make_island(["こんにちは"])
    if captions is not None:
        write_captions(iid, **captions)
    assert repair.asr_track(iid) is expected


def test_asr_track_with_no_main_events_is_unknown():
    iid = make_island(["こんにちは"])
    path = store.AUDIO_DIR / iid / "captions.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"video_id": VID, "events": [], "asr_events": [{"tStartMs": 0}]}))
    assert repair.asr_track(iid) is None


def test_job_auto_track_island_is_repaired_and_marked(monkeypatch):
    monkeypatch.setattr(generate, "translate_lines", lambda b, *a, **k: ["en"] * len(b))
    vid = str(uuid.uuid4())[:11]
    model = fake_llm([[{"n": 1, "text": "痴女がいるんだよ", "why": "w"}]])
    monkeypatch.setattr(llm, "complete", model)
    iid = make_island(["チュージョンがいるんだよ", "記憶ない"], video_id=vid)
    write_captions(iid, auto=True, asr_events=True)
    repair.job(iid)
    lines = store.get_island(iid)["lines"]
    assert len(model.calls) == 1 and lines[0]["ja"] == "痴女がいるんだよ"
    assert [l["sure"] for l in lines] == [1, 1]
    assert (store.get_video(iid)["repair_status"], store.get_video(iid)["repair_error"]) == ("done", "")


def test_job_without_captions_json_repairs_but_marks_nothing(monkeypatch):
    # The source cannot be told: the gate still guards the text, but no line
    # turns sure or unsure, so catch-the-word sees the island as before.
    monkeypatch.setattr(generate, "translate_lines", lambda b, *a, **k: ["en"] * len(b))
    vid = str(uuid.uuid4())[:11]
    model = fake_llm([[{"n": 1, "text": "痴女がいるんだよ", "why": "w"},
                       {"n": 2, "text": "犬がいる", "why": "w"}]])
    monkeypatch.setattr(llm, "complete", model)
    iid = make_island(["チュージョンがいるんだよ", "猫がいる", "スムジ"], video_id=vid)
    repair.job(iid)
    lines = store.get_island(iid)["lines"]
    assert [l["ja"] for l in lines] == ["痴女がいるんだよ", "猫がいる", "スムジ"]
    assert [l["sure"] for l in lines] == [None, None, None]
    video = store.get_video(iid)
    assert (video["repair_status"], video["repair_error"]) == ("done", "unknown_track")


def test_job_partial_failure_applies_without_caching_then_retries(monkeypatch):
    monkeypatch.setattr(generate, "translate_lines", lambda b, *a, **k: ["en"] * len(b))
    monkeypatch.setattr(repair, "BATCH", 1)
    monkeypatch.setattr(repair, "WORKERS", 1)
    vid = str(uuid.uuid4())[:11]
    texts = ["チュージョンがいるんだよ", "記憶ない"]
    iid = make_island(texts, video_id=vid)
    write_captions(iid, auto=True)
    store.claim_repair(iid, repair.REPAIR_MAX_ATTEMPTS, repair.VERSION)
    monkeypatch.setattr(llm, "complete", fake_llm([[{"n": 1, "text": "痴女がいるんだよ", "why": "w"}], None]))
    repair.job(iid)
    video = store.get_video(iid)
    assert (video["repair_status"], video["repair_error"]) == ("failed", "llm_partial")
    assert [l["sure"] for l in store.get_island(iid)["lines"]] == [1, None]
    assert store.get_island(iid)["lines"][0]["ja"] == "痴女がいるんだよ"
    assert (store.get_repair(vid) or {}).get("result") is None
    # A second island of the same video does not reuse the partial pass, and
    # the next open of the first one claims a retry.
    assert store.claim_repair(iid, repair.REPAIR_MAX_ATTEMPTS, repair.VERSION)
    model = fake_llm([[], []])
    monkeypatch.setattr(llm, "complete", model)
    repair.job(iid)
    assert len(model.calls) == 2
    assert [l["sure"] for l in store.get_island(iid)["lines"]] == [1, 1]
    assert store.get_video(iid)["repair_status"] == "done"


def test_job_ignores_a_cached_partial_result(monkeypatch):
    vid = str(uuid.uuid4())[:11]
    texts = ["チュージョンがいる"]
    partial = repair.repair_lines(texts, {}, llm_call=fake_llm([None]))
    store.set_repair_result(vid, repair.VERSION, repair.lines_hash(texts), partial)
    model = fake_llm([[]])
    monkeypatch.setattr(llm, "complete", model)
    iid = make_island(texts, video_id=vid)
    repair.job(iid, asr=True)
    assert len(model.calls) == 1


def test_job_off_switch(monkeypatch):
    monkeypatch.setattr(repair, "ON", False)
    iid = make_island(["チュージョンがいる"])
    repair.job(iid, asr=True)
    video = store.get_video(iid)
    assert (video["repair_status"], video["repair_error"]) == ("done", "off")
    assert store.get_island(iid)["lines"][0]["sure"] is None


def test_job_runs_caches_and_a_second_island_applies_with_no_model_call(monkeypatch):
    monkeypatch.setattr(generate, "translate_lines", lambda b, *a, **k: ["en"] * len(b))
    vid = str(uuid.uuid4())[:11]
    texts = ["チュージョンがいるんだよ", "記憶ない"]
    model = fake_llm([[{"n": 1, "text": "痴女がいるんだよ", "why": "w"}]])
    monkeypatch.setattr(llm, "complete", model)
    store.set_repair_context(vid, {"title": "Hikaru"})
    first = make_island(texts, video_id=vid)
    repair.job(first, asr=True)
    assert len(model.calls) == 1 and "Video title: Hikaru" in model.calls[0]
    assert store.get_island(first)["lines"][0]["ja"] == "痴女がいるんだよ"
    assert store.get_video(first)["repair_status"] == "done"
    cached = store.get_repair(vid)
    assert cached["version"] == repair.VERSION and cached["lines_hash"] == repair.lines_hash(texts)
    second = make_island(texts, video_id=vid)
    repair.job(second, asr=True)
    assert len(model.calls) == 1
    assert store.get_island(second)["lines"][0]["ja"] == "痴女がいるんだよ"
    assert store.get_video(second)["repair_status"] == "done"
    third = make_island(["別の動画の行"], video_id=vid)
    repair.job(third, asr=True)
    assert len(model.calls) == 2


def test_job_all_batches_failed_is_failed_and_caches_nothing(monkeypatch):
    vid = str(uuid.uuid4())[:11]
    iid = make_island(["チュージョンがいる"], video_id=vid)
    repair.job(iid, asr=True)  # SHADOW_LLM=off: every batch answers None
    video = store.get_video(iid)
    assert (video["repair_status"], video["repair_error"]) == ("failed", "llm_failed")
    assert store.get_island(iid)["lines"][0]["sure"] is None
    assert (store.get_repair(vid) or {}).get("result") is None


def test_job_exception_marks_failed(monkeypatch):
    monkeypatch.setattr(repair, "repair_lines", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    iid = make_island(["チュージョンがいる"])
    repair.job(iid, asr=True)
    assert store.get_video(iid)["repair_status"] == "failed"
    assert store.get_video(iid)["repair_error"] == "repair_error"


# ---- store ----

def test_init_migrates_a_database_without_the_repair_columns(tmp_path, monkeypatch):
    db_path = tmp_path / "old.db"
    raw = sqlite3.connect(db_path)
    raw.execute("CREATE TABLE islands (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',"
                " status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',"
                " complexity TEXT NOT NULL DEFAULT 'simple', register TEXT NOT NULL DEFAULT 'polite',"
                " speaker INTEGER NOT NULL DEFAULT 3, transcript TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)")
    raw.execute("CREATE TABLE lines (island_id TEXT NOT NULL, idx INTEGER NOT NULL, ja TEXT NOT NULL,"
                " kana TEXT NOT NULL DEFAULT '', romaji TEXT NOT NULL DEFAULT '', en TEXT NOT NULL DEFAULT '',"
                " duration REAL NOT NULL DEFAULT 0, timeline TEXT NOT NULL DEFAULT '[]',"
                " words TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (island_id, idx))")
    raw.execute("CREATE TABLE videos (island_id TEXT PRIMARY KEY, video_id TEXT NOT NULL,"
                " start_s REAL NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0,"
                " title TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)")
    raw.execute("INSERT INTO islands (id, status, created_at) VALUES ('old', 'ready', 'now')")
    raw.execute("INSERT INTO lines (island_id, idx, ja) VALUES ('old', 0, 'line')")
    raw.execute("INSERT INTO videos (island_id, video_id, created_at) VALUES ('old', 'v', 'now')")
    raw.commit()
    raw.close()
    monkeypatch.setattr(store, "DB_PATH", db_path)
    if hasattr(store._local, "conn"):
        del store._local.conn
    try:
        store.init()
        store.init()
        assert store.get_island("old")["lines"][0]["sure"] is None
        video = store.get_video("old")
        assert (video["repair_status"], video["repair_error"], video["repair_attempts"], video["repair_version"]) == ("", "", 0, 0)
        assert store.get_repair("v") is None
    finally:
        if hasattr(store._local, "conn"):
            del store._local.conn


def test_claim_repair_wins_once_and_counts():
    iid = make_island(["a"])
    assert store.claim_repair(iid, 3, repair.VERSION)
    assert not store.claim_repair(iid, 3, repair.VERSION)
    video = store.get_video(iid)
    assert video["repair_status"] == "queued" and video["repair_attempts"] == 1
    store.set_repair_status(iid, "failed", "x")
    assert store.claim_repair(iid, 3, repair.VERSION)
    store.set_repair_status(iid, "failed", "x")
    assert store.claim_repair(iid, 3, repair.VERSION)
    store.set_repair_status(iid, "failed", "x")
    assert not store.claim_repair(iid, 3, repair.VERSION)  # attempts spent
    done = make_island(["b"])
    store.set_repair_status(done, "done", "", repair.VERSION - 1)
    assert store.claim_repair(done, 3, repair.VERSION)  # older version re-queues
    store.set_repair_status(done, "done", "", repair.VERSION)
    assert not store.claim_repair(done, 3, repair.VERSION)


def test_set_repair_context_keeps_the_old_one_when_the_new_is_empty():
    store.set_repair_context("ctx-video", {"title": "T", "description": "D"})
    store.set_repair_context("ctx-video", repair.clean_context({}))
    assert store.get_repair("ctx-video")["context"]["title"] == "T"
    store.set_repair_context("ctx-video", {"title": "U"})
    assert store.get_repair("ctx-video")["context"]["title"] == "U"
    store.set_repair_context("ctx-empty", repair.clean_context(None))
    assert store.get_repair("ctx-empty")["context"] == {}


def test_set_line_text_checks_the_expected_text():
    iid = make_island(["a", "b"])
    assert not store.set_line_text(iid, 0, "x", "x", [], 1, expected_ja="moved")
    assert store.set_line_text(iid, 0, "x", "エックス", [{"text": "x", "start": 0, "end": 2}], 0, expected_ja="a")
    line = store.get_island(iid)["lines"][0]
    assert (line["ja"], line["kana"], line["sure"], line["words"][0]["text"]) == ("x", "エックス", 0, "x")
    store.set_line_sure(iid, 1, 1)
    assert store.get_island(iid)["lines"][1]["sure"] == 1


# ---- route ----

def _post(iid, body=None, headers=HEAD):
    return client.post(f"/shadow/islands/{iid}/repair", headers=headers,
                       json={"context": body if body is not None else {"title": "t"}})


def _video(iid):
    return client.get(f"/shadow/islands/{iid}/video", headers=HEAD).json()


def test_route_404_for_another_device():
    iid = make_island(["a"], device=OTHER)
    assert _post(iid).status_code == 404


def test_route_400_not_video():
    iid = store.create_island("simple", 3, device=DEV)
    store.set_ready(iid, "t")
    r = _post(iid)
    assert r.status_code == 400 and r.json()["detail"]["code"] == "not_video"


def test_route_409_while_building():
    iid = make_island(["a"], ready=False)
    r = _post(iid)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_ready"


def test_route_queues_then_done_and_island_video_reports_it():
    iid = make_island(["こんにちは"])
    write_captions(iid, auto=False)
    assert _video(iid)["repair"] == "" and _video(iid)["repair_error"] == ""
    r = _post(iid, {"title": "Hikaru", "description": "desc"})
    assert r.status_code == 200 and r.json() == {"repair": "queued"}
    # The TestClient runs the background job before returning: a manual
    # island is done at once.
    video = _video(iid)
    assert video["repair"] == "done" and video["repair_error"] == "manual"
    assert "repair_status" not in video and "repair_attempts" not in video
    assert store.get_repair(VID)["context"]["title"] == "Hikaru"
    assert _post(iid).json() == {"repair": "done"}
    assert store.get_video(iid)["repair_attempts"] == 1


def test_route_old_version_reads_as_empty_and_requeues_once():
    iid = make_island(["こんにちは"])
    write_captions(iid, auto=False)
    store.set_repair_status(iid, "done", "", repair.VERSION - 1)
    assert _video(iid)["repair"] == ""
    assert _post(iid).json() == {"repair": "queued"}
    assert _video(iid)["repair"] == "done"
    assert store.get_video(iid)["repair_version"] == repair.VERSION


def test_route_closed_after_max_attempts():
    iid = make_island(["こんにちは"])
    for _ in range(repair.REPAIR_MAX_ATTEMPTS):
        store.set_repair_status(iid, "failed", "llm_failed", count_attempt=True)
    assert _video(iid)["repair"] == "closed"
    r = _post(iid)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "repair_closed"


def test_route_reports_queued_or_running_without_a_second_claim(monkeypatch):
    iid = make_island(["こんにちは"])
    store.set_repair_status(iid, "running")
    assert _post(iid).json() == {"repair": "running"}
    assert store.get_video(iid)["repair_attempts"] == 0


# ---- wiring ----

def test_build_from_captions_hands_the_island_to_the_repair_job(monkeypatch):
    import asyncio
    calls = []
    monkeypatch.setattr(main.repair, "job", lambda iid, asr=None: calls.append((iid, asr)))
    monkeypatch.setattr(generate, "translate_lines", lambda b, *a, **k: ["en"] * len(b))
    iid = make_island([], ready=False)
    lines = [{"start": 0.0, "end": 2.0, "text": "上緒がある", "pieces": [{"text": "上緒がある", "start": 0.0, "end": 2.0}]}]
    asyncio.run(main._build_from_captions(iid, lines, "Clip", asr=True))
    island = store.get_island(iid)
    assert island["status"] == "ready" and island["stage"] != "correcting"
    assert calls == [(iid, True)]
    assert store.get_video(iid)["repair_status"] == "running"


def test_build_claims_the_repair_before_ready_so_an_open_mid_translation_is_a_no_op(monkeypatch):
    # The player opens as soon as the island is ready, while the build is
    # still translating: its post must not start a second pass that the
    # translation loop would then overwrite with English for the old text.
    import asyncio
    calls, seen = [], []
    monkeypatch.setattr(main.repair, "job", lambda iid, asr=None: calls.append((iid, asr)))
    iid = make_island([], ready=False)

    def translate(batch, *a, **k):
        seen.append((store.get_island(iid)["status"], store.get_video(iid)["repair_status"],
                     _post(iid).json(), calls[:]))
        return ["en"] * len(batch)

    monkeypatch.setattr(generate, "translate_lines", translate)
    lines = [{"start": 0.0, "end": 2.0, "text": "上緒がある", "pieces": [{"text": "上緒がある", "start": 0.0, "end": 2.0}]}]
    asyncio.run(main._build_from_captions(iid, lines, "Clip", asr=True))
    assert seen == [("ready", "queued", {"repair": "queued"}, [])]
    assert calls == [(iid, True)]
    assert store.get_video(iid)["repair_attempts"] == 1


def test_import_route_stores_the_context(monkeypatch):
    monkeypatch.setattr(main, "DAILY_CREATES", 1000)
    monkeypatch.setattr(main.repair, "job", lambda *a, **k: None)
    monkeypatch.setattr(generate, "translate_lines", lambda b, *a, **k: ["en"] * len(b))
    body = {"url": f"https://youtu.be/{VID}", "title": "Clip", "speaker": 3,
            "events": [{"tStartMs": 0, "dDurationMs": 2000, "segs": [{"utf8": "こんにちは"}]}],
            "context": {"title": "Hikaru live", "description": "x" * 10, "keywords": ["k"]}}
    r = client.post("/shadow/youtube/captions", headers=HEAD, json=body)
    assert r.status_code == 200, r.text
    assert store.get_repair(VID)["context"]["title"] == "Hikaru live"
    body.pop("context")
    assert client.post("/shadow/youtube/captions", headers=HEAD, json=body).status_code == 200
    assert store.get_repair(VID)["context"]["title"] == "Hikaru live"


def test_pick_targets_skips_unsure_lines_and_keeps_unchecked():
    def w(text, start, end):
        return {"text": text, "start": start, "end": end, "pos": "noun"}

    def line(words, offset, sure):
        return {"ja": "".join(x["text"] for x in words), "en": "", "offset": offset,
                "duration": 4.0, "words": words, "sure": sure}

    island = {"language": "ja", "native": "en", "lines": [
        line([w("猫", 0.2, 0.6), w("鳥", 1.0, 1.5)], 0.0, 0),
        line([w("猫", 0.2, 0.6), w("犬", 1.0, 1.5)], 4.0, None),
        line([w("猫", 0.2, 0.6), w("犬", 1.0, 1.5)], 8.0, 1),
    ]}
    targets = catch.pick_targets(island, set(), set())
    assert targets and all(t["line_idx"] != 0 for t in targets)
    assert {t["line_idx"] for t in targets} <= {1, 2}


# ---- llm seam ----

def test_llm_off_returns_none_and_logs(caplog):
    import logging
    with caplog.at_level(logging.INFO, logger="llm"):
        assert llm.complete("p", {"type": "array"}, tag="repair") is None
    assert "llm repair: backend=off" in caplog.text and "ok=False" in caplog.text


def test_llm_cli_backend_checks_the_schema(monkeypatch):
    monkeypatch.setenv("SHADOW_LLM", "cli")
    replies = iter(['[{"n": 1, "text": "x"}]', '{"n": 1}', 'not json'])
    monkeypatch.setattr(generate, "_run_cli", lambda prompt, tag, timeout: next(replies))
    assert llm.complete("p", repair.SCHEMA, tag="repair") == [{"n": 1, "text": "x"}]
    assert llm.complete("p", repair.SCHEMA, tag="repair") is None
    assert llm.complete("p", repair.SCHEMA, tag="repair") is None


def test_llm_schema_matcher():
    assert llm.matches([{"n": 1, "text": "a", "why": "b"}], repair.SCHEMA)
    assert not llm.matches([{"n": True, "text": "a"}], repair.SCHEMA)
    assert not llm.matches([{"n": 1}], repair.SCHEMA)
    assert not llm.matches([{"n": 1, "text": 3}], repair.SCHEMA)
    assert llm.matches({"a": 1.5}, {"type": "object", "properties": {"a": {"type": "number"}}})
    assert not llm.matches(1, {"type": "string"})


def test_llm_api_backend_is_not_wired(monkeypatch):
    monkeypatch.setenv("SHADOW_LLM", "api")
    with pytest.raises(NotImplementedError):
        llm.complete("p", {}, tag="x")
