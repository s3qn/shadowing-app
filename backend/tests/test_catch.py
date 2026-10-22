"""Tests for catch the word: catch.py's picker, meanings cache, FSRS review
and its two routes."""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import catch
import generate
import main
import store

AUTH = f"Bearer {main.SHADOW_TOKEN}"
DEV = "eeeeeeee-0000-4000-8000-0000000000c1"
OTHER = "eeeeeeee-0000-4000-8000-0000000000c2"
NOW = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _init_db(monkeypatch):
    monkeypatch.setattr(catch, "BACKGROUND_FILL", False)
    store.init()
    catch.init()
    with catch.connect() as conn:
        conn.execute("DELETE FROM catch_cards")
        conn.execute("DELETE FROM word_meanings")


class FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _fake_cli(monkeypatch, stdout, calls):
    def fake_run(argv, *a, **kw):
        calls.append(kw.get("input", ""))
        return FakeCompleted(stdout=stdout)

    monkeypatch.setattr(generate.subprocess, "run", fake_run)


def _never_cli(monkeypatch):
    def fail(*a, **kw):
        raise AssertionError("the CLI must not run")

    monkeypatch.setattr(generate.subprocess, "run", fail)


# -- building islands ----------------------------------------------------


def _w(text, start, end, pos="noun"):
    return {"text": text, "start": start, "end": end, "pos": pos}


def _line(words, offset, duration=4.0, text=None, en="translation"):
    return {
        "ja": text if text is not None else " ".join(w["text"] for w in words),
        "en": en, "offset": offset, "duration": duration, "words": words,
    }


def _ja_island(lines):
    return {"language": "ja", "native": "en", "lines": lines}


def _three_lines():
    """猫 three times, 犬 twice, 鳥 once, a particle twice; 4 s per line."""
    return _ja_island([
        _line([_w("猫", 0.2, 0.6), _w("は", 0.6, 0.8, "particle"), _w("鳥", 1.0, 1.5)], 0.0),
        _line([_w("犬", 0.2, 0.6), _w("は", 0.6, 0.8, "particle"), _w("猫", 1.0, 1.5)], 4.0),
        _line([_w("猫", 0.2, 0.6), _w("犬", 1.0, 1.5)], 8.0),
    ])


def _pick(island, not_due=(), due=(), **kw):
    return catch.pick_targets(island, set(not_due), set(due), **kw)


def _ids(targets):
    return [t["id"] for t in targets]


# -- pick_targets --------------------------------------------------------


def test_a_word_heard_once_is_out():
    targets = _pick(_three_lines())
    assert "鳥" not in _ids(targets)
    assert set(_ids(targets)) == {"猫", "犬"}


def test_ranked_by_in_video_count():
    assert _ids(_pick(_three_lines(), max_targets=1)) == ["猫"]
    target = _pick(_three_lines(), max_targets=1)[0]
    assert target["count"] == 3 and target["line_idx"] == 0 and target["word_index"] == 0


def test_ja_pos_filter_drops_particles():
    assert "は" not in _ids(_pick(_three_lines()))


def _twice(*texts):
    """Every word in `texts` heard once in each of two 4 s lines."""
    words = lambda: [_w(t, 0.2 + i * 0.5, 0.6 + i * 0.5, "verb") for i, t in enumerate(texts)]
    return _ja_island([_line(words(), 0.0), _line(words(), 4.0)])


def test_ja_light_verbs_and_function_words_are_out():
    island = _twice("して", "した", "いる", "ある", "なって", "です", "こと", "よう", "そう", "でも", "えーと", "ね")
    assert _pick(island) == []


def test_ja_proper_nouns_pronouns_and_numbers_are_out():
    assert _pick(_twice("東京", "田中さん", "私", "十時")) == []


def test_ja_content_words_are_kept():
    island = _ja_island([
        _line([_w("走る", 0.2, 0.6), _w("大きい", 1.0, 1.5)], 0.0),
        _line([_w("もう", 0.2, 0.6), _w("綺麗", 1.0, 1.5)], 4.0),
        _line([_w("もう", 0.2, 0.6), _w("綺麗", 1.0, 1.5)], 8.0),
        _line([_w("走って", 0.2, 0.6), _w("大きい", 1.0, 1.5)], 12.0),
    ])
    assert sorted(_ids(_pick(island))) == sorted(["走る", "大きい", "もう", "綺麗"])


def test_ja_inflections_count_as_one_word_and_show_the_heard_form():
    # 走る is heard as 走って and 走りました: one word heard twice.
    island = _ja_island([
        _line([_w("走って", 0.2, 0.6)], 0.0),
        _line([_w("走りました", 0.2, 0.9)], 4.0),
    ])
    targets = _pick(island)
    assert [(t["id"], t["text"], t["count"]) for t in targets] == [("走る", "走って", 2)]


def test_es_stoplist_and_short_words():
    island = {"language": "es", "native": "en", "lines": [
        _line([_w("Para", 0.2, 0.6, "other"), _w("casa,", 1.0, 1.5, "other"), _w("sol", 2.0, 2.4, "other")], 0.0),
        _line([_w("para", 0.2, 0.6, "other"), _w("Casa", 1.0, 1.5, "other"), _w("sol", 2.0, 2.4, "other")], 4.0),
    ]}
    targets = _pick(island)
    assert _ids(targets) == ["casa"]
    assert targets[0]["text"] == "casa" and targets[0]["ruby"] is None


def test_not_due_is_skipped_and_due_is_marked():
    targets = _pick(_three_lines(), not_due={"猫"}, due={"犬"})
    assert _ids(targets) == ["犬"]
    assert targets[0]["state"] == "due"
    assert all(t["state"] == "new" for t in _pick(_three_lines()))


def test_one_target_per_line():
    targets = _pick(_three_lines())
    lines = [t["line_idx"] for t in targets]
    assert len(lines) == len(set(lines))


def test_a_word_in_the_last_second_takes_its_next_occurrence():
    # 犬 sits at 3.2 to 3.6 in a 4 s line: a late tap would land in the next line.
    island = _ja_island([
        _line([_w("犬", 3.2, 3.6)], 0.0),
        _line([_w("犬", 0.5, 1.0)], 4.0),
    ])
    targets = _pick(island)
    assert [(t["id"], t["line_idx"]) for t in targets] == [("犬", 1)]


def test_an_untimed_word_never_places():
    island = _ja_island([
        _line([{"text": "犬", "pos": "noun"}], 0.0),
        _line([_w("犬", 1.0, 1.0)], 4.0),
    ])
    assert _pick(island) == []


def test_cap_and_line_order():
    lines = [_line([_w(f"語{i}", 0.5, 1.0)], 4.0 * i) for i in range(70)]
    lines += [_line([_w(f"語{i}", 0.5, 1.0)], 4.0 * (70 + i)) for i in range(70)]
    targets = _pick(_ja_island(lines))
    assert len(targets) == 60
    assert [t["line_idx"] for t in targets] == sorted(t["line_idx"] for t in targets)


def test_ja_target_carries_ruby_and_sentence():
    island = _ja_island([
        _line([_w("美味しい", 0.2, 0.9)], 0.0, text="美味しいね", en="Tasty"),
        _line([_w("美味しい。", 0.2, 0.9)], 4.0, text="美味しい。", en="Tasty."),
    ])
    target = _pick(island)[0]
    assert target["text"] == "美味しい" and target["sentence"] == "美味しいね"
    assert target["sentence_translation"] == "Tasty"
    assert "".join(s["text"] for s in target["ruby"]) == "美味しい"


# -- meanings ------------------------------------------------------------


def test_meanings_cache_hit_makes_no_cli_call(monkeypatch):
    _never_cli(monkeypatch)
    with catch.connect() as conn:
        conn.execute(
            "INSERT INTO word_meanings VALUES ('ja','en','猫','cat','2026-01-01')"
        )
    assert catch.meanings("ja", "en", [{"word": "猫", "sentence": "猫だ"}]) == {"猫": "cat"}


def test_meanings_miss_parses_and_caches(monkeypatch):
    calls = []
    _fake_cli(monkeypatch, '["cat", "dog"]', calls)
    items = [{"word": "猫", "sentence": "猫だ"}, {"word": "犬", "sentence": "犬だ"}]
    assert catch.meanings("ja", "en", items) == {"猫": "cat", "犬": "dog"}
    assert len(calls) == 1 and "猫 | 猫だ" in calls[0] and "English" in calls[0]
    _never_cli(monkeypatch)
    assert catch.meanings("ja", "en", items) == {"猫": "cat", "犬": "dog"}


def test_meanings_bad_shape_gives_nothing(monkeypatch):
    calls = []
    _fake_cli(monkeypatch, '{"猫": "cat"}', calls)
    assert catch.meanings("ja", "en", [{"word": "猫", "sentence": ""}]) == {}
    _fake_cli(monkeypatch, '["cat"]', calls)
    two = [{"word": "猫", "sentence": ""}, {"word": "犬", "sentence": ""}]
    assert catch.meanings("ja", "en", two) == {}


def test_meanings_cli_failure_never_raises(monkeypatch):
    monkeypatch.setattr(generate, "_run_cli", lambda prompt, tag, **kw: None)
    assert catch.meanings("ja", "en", [{"word": "猫", "sentence": ""}]) == {}


def test_meanings_cli_has_a_short_timeout(monkeypatch):
    """The meanings call sits in front of the game's start, so it gives up
    long before the generator's 180 s, and a timeout still never raises."""
    timeouts = []

    def slow(argv, *a, **kw):
        timeouts.append(kw.get("timeout"))
        raise generate.subprocess.TimeoutExpired(argv, kw.get("timeout"))

    monkeypatch.setattr(generate.subprocess, "run", slow)
    assert catch.meanings("ja", "en", [{"word": "猫", "sentence": ""}]) == {}
    assert timeouts and timeouts[0] <= 30


# -- review --------------------------------------------------------------


def test_again_is_due_within_a_day():
    res = catch.review(DEV, "ja", "猫", caught=False, knew=False, now=NOW)
    assert res["word"] == "猫" and res["reviews"] == 1
    assert NOW < datetime.fromisoformat(res["due"]) <= NOW + timedelta(days=1)


def test_good_after_good_is_later_than_hard():
    catch.review(DEV, "ja", "猫", caught=True, knew=True, now=NOW)
    catch.review(DEV, "ja", "犬", caught=True, knew=True, now=NOW)
    later = NOW + timedelta(minutes=15)
    good = catch.review(DEV, "ja", "猫", caught=True, knew=True, now=later)
    hard = catch.review(DEV, "ja", "犬", caught=False, knew=True, now=later)
    assert datetime.fromisoformat(good["due"]) > datetime.fromisoformat(hard["due"])


def test_second_review_updates_the_same_row():
    catch.review(DEV, "ja", "猫", caught=True, knew=True, now=NOW, meaning="cat", island_id="i1")
    res = catch.review(DEV, "ja", "猫", caught=False, knew=False, now=NOW + timedelta(days=1))
    assert res["reviews"] == 2
    with catch.connect() as conn:
        rows = conn.execute("SELECT * FROM catch_cards").fetchall()
    assert len(rows) == 1
    assert rows[0]["reviews"] == 2 and rows[0]["lapses"] == 1
    assert rows[0]["caught"] == 1 and rows[0]["missed"] == 1
    assert rows[0]["meaning"] == "cat" and rows[0]["island_id"] == "i1"


def test_card_sets_split_on_due():
    catch.review(DEV, "ja", "猫", caught=True, knew=True, now=NOW)
    assert catch.card_sets(DEV, "ja", NOW) == ({"猫"}, set())
    assert catch.card_sets(DEV, "ja", NOW + timedelta(days=30)) == (set(), {"猫"})
    assert catch.card_sets(OTHER, "ja", NOW) == (set(), set())


# -- routes --------------------------------------------------------------


def _store_island(lines, language="ja", device=DEV, heard=True):
    """An island with `lines`; with `heard`, a captions.json whose ASR track
    says every timed word exactly at its line time, so every occurrence
    verifies."""
    island_id = store.create_island(
        "simple", 3, source="youtube", device=device, language=language,
    )
    for idx, line in enumerate(lines):
        store.add_line(island_id, idx, {"ja": line["ja"], "en": line["en"]},
                       line["duration"], [], words=line["words"], offset=line["offset"])
    store.set_ready(island_id, "Title")
    if heard:
        _write_asr(island_id, [
            (w["text"], line["offset"] + w["start"], line["offset"] + w["end"])
            for line in lines for w in line["words"] if "start" in w
        ])
    return island_id


def _write_asr(island_id, heard):
    """captions.json with an ASR track of one seg per (text, start, end)."""
    events = [{"tStartMs": round(a * 1000), "dDurationMs": round((b - a) * 1000),
               "segs": [{"utf8": text}]} for text, a, b in heard]
    path = store.AUDIO_DIR / island_id / "captions.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"video_id": "v", "events": [], "asr_events": events},
                               ensure_ascii=False))


def _words(island_id, device=DEV):
    return asyncio.run(catch.catch_words(
        island_id=island_id, authorization=AUTH, x_shadow_device=device))


def _review(island_id, word, caught=1, knew=1, device=DEV):
    return asyncio.run(catch.catch_review(
        island_id=island_id, word=word, caught=caught, knew=knew,
        authorization=AUTH, x_shadow_device=device))


def _status(fn, *a, **kw):
    with pytest.raises(HTTPException) as e:
        fn(*a, **kw)
    return e.value


def test_words_route_409_without_timed_words(monkeypatch):
    _never_cli(monkeypatch)
    island_id = _store_island([_line([{"text": "猫", "pos": "noun"}], 0.0)] * 2)
    err = _status(_words, island_id)
    assert err.status_code == 409 and err.detail == {"code": "no_words"}


def test_words_route_404_for_another_device(monkeypatch):
    _never_cli(monkeypatch)
    island_id = _store_island(_three_lines()["lines"])
    assert _status(_words, island_id, device=OTHER).status_code == 404
    assert _status(_words, "nope").status_code == 404
    assert _status(_review, island_id, "猫", device=OTHER).status_code == 404


def test_words_route_returns_cached_meanings(monkeypatch):
    _never_cli(monkeypatch)
    island_id = _store_island(_three_lines()["lines"])
    with catch.connect() as conn:
        conn.execute("INSERT INTO word_meanings VALUES ('ja','en','猫','cat','2026-01-01')")
        conn.execute("INSERT INTO word_meanings VALUES ('ja','en','犬','dog','2026-01-01')")
    res = _words(island_id)
    assert res["language"] == "ja" and res["native"] == "en"
    assert [(t["id"], t["meaning"]) for t in res["targets"]] == [("猫", "cat"), ("犬", "dog")]
    assert res["targets"][0]["state"] == "new"


def test_words_route_drops_names_and_refills_the_line(monkeypatch):
    """janome reads 神楽 as a common noun; the meanings call flags it as a
    name, so it is dropped and its line takes the next word."""
    _never_cli(monkeypatch)
    island_id = _store_island([
        _line([_w("神楽", 0.2, 0.6), _w("猫", 1.0, 1.5)], 0.0),
        _line([_w("神楽", 0.2, 0.6), _w("猫", 1.0, 1.5)], 4.0),
        _line([_w("神楽", 0.2, 0.6)], 8.0),
    ])
    with catch.connect() as conn:
        conn.execute("INSERT INTO word_meanings VALUES ('ja','en','神楽','Kagura (name)','2026-01-01')")
        conn.execute("INSERT INTO word_meanings VALUES ('ja','en','猫','cat','2026-01-01')")
    assert [(t["id"], t["line_idx"]) for t in _words(island_id)["targets"]] == [("猫", 0)]


def test_meaning_prompt_asks_to_flag_names():
    assert catch.NAME_MARK in catch._meaning_prompt("ja", "en", [{"word": "神楽", "sentence": ""}])


def test_review_route_grades_and_hides_the_word(monkeypatch):
    _never_cli(monkeypatch)
    island_id = _store_island(_three_lines()["lines"])
    res = _review(island_id, "猫")
    assert res["word"] == "猫" and res["reviews"] == 1 and res["state"] == "learning"
    with catch.connect() as conn:
        row = conn.execute("SELECT sentence, island_id FROM catch_cards").fetchone()
    assert row["sentence"] == "猫 は 鳥" and row["island_id"] == island_id
    # A graded word is scheduled past now, so the next words call leaves it out.
    assert _ids(_words(island_id)["targets"]) == ["犬"]
    assert _status(_review, island_id, "  ").status_code == 400


def test_words_route_places_targets_on_the_asr_times_only(monkeypatch):
    """猫 is heard 1.3 s before its line time in line 0 and never in line 1;
    犬 is never heard. Without captions.json nothing verifies."""
    _never_cli(monkeypatch)
    lines = [
        _line([_w("猫", 2.0, 2.4), _w("犬", 3.0, 3.3)], 0.0, duration=5.0),
        _line([_w("猫", 0.2, 0.6), _w("犬", 1.0, 1.5)], 5.0),
    ]
    island_id = _store_island(lines, heard=False)
    assert _status(_words, island_id).detail == {"code": "no_words"}
    _write_asr(island_id, [("猫", 0.7, 1.1), ("鳥", 6.0, 6.4)])
    targets = _words(island_id)["targets"]
    assert [(t["id"], t["line_idx"], t["start"], t["end"]) for t in targets] == [
        ("猫", 0, 0.7, 1.1)]


def test_meanings_split_into_chunks(monkeypatch):
    sizes = []

    def fake(prompt, tag, **kw):
        n = prompt.count(" | ") - 1
        sizes.append(n)
        return json.dumps([f"m{i}" for i in range(n)])

    monkeypatch.setattr(generate, "_run_cli", fake)
    items = [{"word": f"w{i}", "sentence": "s"} for i in range(45)]
    got = catch.meanings("ja", "en", items)
    assert len(got) == 45 and sorted(sizes) == [5, 20, 20]


def test_meanings_failed_chunk_is_refilled_in_background(monkeypatch):
    monkeypatch.setattr(catch, "BACKGROUND_FILL", True)
    calls = []

    def fake(prompt, tag, **kw):
        calls.append(kw.get("timeout"))
        if kw.get("timeout") == catch.MEANINGS_TIMEOUT_S:
            return None
        return '["cat"]'

    monkeypatch.setattr(generate, "_run_cli", fake)
    assert catch.meanings("ja", "en", [{"word": "猫", "sentence": ""}]) == {}
    import time
    for _ in range(50):
        if catch.cached_meanings("ja", "en", ["猫"]):
            break
        time.sleep(0.05)
    assert catch.cached_meanings("ja", "en", ["猫"]) == {"猫": "cat"}
    assert calls[-1] == catch.MEANINGS_BACKGROUND_TIMEOUT_S


def test_word_meaning_fills_one_word_and_checks_owner(monkeypatch):
    island_id = _store_island(_three_lines()["lines"])
    calls = []

    def fake(prompt, tag, **kw):
        calls.append(kw.get("timeout"))
        return '["cat"]'

    monkeypatch.setattr(generate, "_run_cli", fake)
    assert catch.word_meaning(island_id, DEV, "猫") == "cat"
    assert catch.word_meaning(island_id, DEV, "猫") == "cat" and len(calls) == 1
    with pytest.raises(HTTPException) as e:
        catch.word_meaning(island_id, OTHER, "猫")
    assert e.value.status_code == 404
