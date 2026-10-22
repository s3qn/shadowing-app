"""Tests for gloss.py: dictionary lookup for one tapped word.

_headword only runs janome, which is instant. gloss() for a real word also
hits jamdict's offline SQLite dictionary; that first call is around 0.3s on
this machine (tokenizer plus dictionary load), so it is kept to a single test
here rather than exercised on every word.
"""

import gloss


def test_headword_plain_noun():
    assert gloss._headword("猫") == ("猫", "ねこ")


def test_headword_inflected_verb():
    # 起きます is the polite form of 起きる: base form should come back dictionary-form.
    assert gloss._headword("起きます") == ("起きる", "おきます")


def test_headword_particle():
    assert gloss._headword("は") == ("は", "は")


def test_gloss_empty_word_is_not_found():
    out = gloss.gloss("")
    assert out == {"word": "", "base": "", "reading": "", "entries": [], "found": False}


def test_gloss_particle_uses_builtin_entry():
    # Particles short-circuit before jamdict: JMdict would otherwise gloss
    # は as the noun "feather".
    out = gloss.gloss("は")
    assert set(out.keys()) == {"word", "base", "reading", "entries", "found"}
    assert out["found"] is True
    assert out["base"] == "は"
    assert out["reading"] == "は"
    assert out["entries"] == [
        {
            "kanji": [],
            "kana": ["は"],
            "senses": [{"pos": ["particle"], "glosses": ["topic marker (as for …)"]}],
        }
    ]


def test_gloss_common_word_shape():
    out = gloss.gloss("猫")

    assert set(out.keys()) == {"word", "base", "reading", "entries", "found"}
    assert out["word"] == "猫"
    assert out["base"] == "猫"
    assert out["reading"] == "ねこ"
    assert out["found"] is True
    assert len(out["entries"]) >= 1

    entry = out["entries"][0]
    assert set(entry.keys()) == {"kanji", "kana", "senses"}
    assert "猫" in entry["kanji"]
    assert len(entry["senses"]) >= 1

    sense = entry["senses"][0]
    assert set(sense.keys()) == {"pos", "glosses"}
    assert any("cat" in g for g in sense["glosses"])


def test_lookups_work_on_a_worker_thread_after_the_main_thread():
    # jamdict's SQLite connection is bound to the thread that opened it; the
    # repair job and the gloss route run on worker threads.
    from concurrent.futures import ThreadPoolExecutor

    gloss._WORDS.clear()
    gloss._CACHE.pop("泥酔", None)
    assert gloss.is_word("東京")
    with ThreadPoolExecutor(1) as pool:
        words = pool.submit(lambda: [gloss.is_word(w) for w in ("泥酔", "東京", "記憶")]).result()
        found = pool.submit(lambda: gloss.gloss("泥酔")["found"]).result()
    assert words == [True, True, True] and found is True


def test_a_failed_lookup_is_not_cached(monkeypatch):
    class Broken:
        def lookup(self, form):
            raise RuntimeError("db closed")

    gloss._WORDS.pop("記憶", None)
    gloss._CACHE.pop("記憶", None)
    monkeypatch.setattr(gloss, "_jam", lambda: Broken())
    assert gloss.is_word("記憶") is False
    assert gloss.gloss("記憶")["found"] is False
    monkeypatch.undo()
    assert gloss.is_word("記憶") is True
    assert gloss.gloss("記憶")["found"] is True
