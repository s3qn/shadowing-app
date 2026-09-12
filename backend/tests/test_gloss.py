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
