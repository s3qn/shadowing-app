"""Tests for the pure logic in voicevox.py: to_hiragana, build_timeline and
total_duration. The async HTTP functions (audio_query, synthesis, speak, ...)
are never imported or called here, VOICEVOX must never run for this suite.

audio_query dicts are hand-written, shaped like what VOICEVOX's AudioQuery
actually returns: accent_phrases -> moras (consonant_length/vowel_length) and
an optional pause_mora, plus prePhonemeLength/postPhonemeLength/speedScale.
"""

import voicevox


# ---------------------------------------------------------------------------
# to_hiragana
# ---------------------------------------------------------------------------

def test_to_hiragana_converts_katakana_syllabary():
    assert voicevox.to_hiragana("コンニチワ") == "こんにちわ"


def test_to_hiragana_long_vowel_mark_passes_through():
    assert voicevox.to_hiragana("ラーメン") == "らーめん"


def test_to_hiragana_non_katakana_passes_through():
    assert voicevox.to_hiragana("Tokyo3時") == "Tokyo3時"


# ---------------------------------------------------------------------------
# build_timeline
# ---------------------------------------------------------------------------

def _mora(text, consonant, vowel):
    return {"text": text, "consonant_length": consonant, "vowel_length": vowel}


def test_moras_accumulate_in_order_with_no_gaps_within_a_phrase():
    query = {
        "accent_phrases": [
            {
                "moras": [
                    _mora("コ", 0.03, 0.07),
                    _mora("ン", None, 0.08),
                    _mora("ニ", 0.02, 0.06),
                ],
            },
        ],
        "prePhonemeLength": 0.11,
        "postPhonemeLength": 0.09,
    }

    timeline = voicevox.build_timeline(query)

    assert [m["text"] for m in timeline] == ["コ", "ン", "ニ"]
    assert timeline[0]["start"] == 0.11  # first mora starts after prePhonemeLength
    for a, b in zip(timeline, timeline[1:]):
        assert a["end"] == b["start"]
    assert timeline[-1]["end"] == round(0.11 + 0.1 + 0.08 + 0.08, 4)


def test_pause_mora_advances_the_clock_but_emits_no_entry():
    query = {
        "accent_phrases": [
            {
                "moras": [_mora("コ", 0.03, 0.07), _mora("ン", None, 0.08)],
                "pause_mora": {"text": "、", "consonant_length": 0.0, "vowel_length": 0.2},
            },
            {
                "moras": [_mora("ニ", 0.02, 0.06)],
                "pause_mora": None,
            },
        ],
        "prePhonemeLength": 0.0,
        "postPhonemeLength": 0.0,
    }

    timeline = voicevox.build_timeline(query)

    # The pause never becomes its own timeline entry (see the pause_mora
    # comment in build_timeline), so only the 3 real moras show up.
    assert [m["text"] for m in timeline] == ["コ", "ン", "ニ"]
    phrase0_end = timeline[1]["end"]
    phrase1_start = timeline[2]["start"]
    # But the pause's own duration does open a gap between the phrases.
    assert round(phrase1_start - phrase0_end, 4) == 0.2


def test_moras_carry_their_phrase_index():
    query = {
        "accent_phrases": [
            {"moras": [_mora("コ", 0.03, 0.07)]},
            {"moras": [_mora("ニ", 0.02, 0.06)]},
        ],
        "prePhonemeLength": 0.0,
        "postPhonemeLength": 0.0,
    }

    timeline = voicevox.build_timeline(query)

    assert [m["phrase"] for m in timeline] == [0, 1]


def test_missing_lengths_default_to_zero_duration():
    query = {
        "accent_phrases": [{"moras": [{"text": "ン"}]}],
        "prePhonemeLength": 0.0,
        "postPhonemeLength": 0.0,
    }

    timeline = voicevox.build_timeline(query)

    assert timeline[0]["start"] == timeline[0]["end"] == 0.0


def test_build_timeline_ignores_speed_scale_field():
    # speedScale is set on the query the caller sends to /synthesis, but
    # build_timeline only reads the per-mora lengths already in the dict; it
    # does not multiply them by speedScale itself.
    query = {
        "accent_phrases": [{"moras": [_mora("コ", 0.03, 0.07)]}],
        "prePhonemeLength": 0.0,
        "postPhonemeLength": 0.0,
        "speedScale": 1.5,
    }

    timeline = voicevox.build_timeline(query)

    assert timeline[0]["end"] == 0.1


# ---------------------------------------------------------------------------
# total_duration
# ---------------------------------------------------------------------------

def test_total_duration_covers_last_mora_plus_post_phoneme_length():
    query = {
        "accent_phrases": [{"moras": [_mora("コ", 0.03, 0.07)]}],
        "prePhonemeLength": 0.1,
        "postPhonemeLength": 0.2,
    }
    timeline = voicevox.build_timeline(query)

    assert voicevox.total_duration(query, timeline) == round(0.1 + 0.1 + 0.2, 4)


def test_total_duration_with_empty_timeline_is_just_post_phoneme_length():
    query = {"postPhonemeLength": 0.2}
    assert voicevox.total_duration(query, []) == 0.2
