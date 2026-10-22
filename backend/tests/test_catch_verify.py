"""Tests for catch_verify: which catch-the-word occurrences YouTube's ASR
track confirms, and the ASR times the targets take."""

import json

import pytest

import catch
import catch_verify
import store


def _w(text, start, end):
    return {"text": text, "start": start, "end": end}


def _line(words, offset, duration=4.0):
    return {"ja": "", "en": "", "offset": offset, "duration": duration, "words": words}


def _tok(text, start, end):
    return {"text": text, "start": start, "end": end}


def _verify(lines, tokens, language="ja"):
    return catch_verify.verify(lines, tokens, language)


# -- verify ---------------------------------------------------------------


def test_a_word_heard_near_its_time_is_verified_at_the_asr_onset():
    lines = [_line([_w("猫", 0.5, 0.9)], 10.0)]
    got = _verify(lines, [_tok("猫", 10.4, 10.8)])
    assert got[(0, 0)] == pytest.approx((0.4, 0.8))


def test_a_word_the_asr_never_heard_is_not_verified():
    lines = [_line([_w("猫", 0.5, 0.9)], 10.0)]
    assert _verify(lines, [_tok("犬", 10.4, 10.8)]) == {}


def test_pick_targets_moves_to_a_later_verified_occurrence_or_drops_the_word():
    island = {"language": "ja", "lines": [
        _line([_w("猫", 0.5, 0.9), _w("犬", 1.5, 1.9)], 0.0),
        _line([_w("猫", 0.5, 0.9), _w("犬", 1.5, 1.9)], 4.0),
    ]}
    verified = _verify(island["lines"], [_tok("猫", 4.6, 5.0)])
    targets = catch.pick_targets(island, set(), set(), verified=verified)
    assert [(t["id"], t["line_idx"], t["start"]) for t in targets] == [("猫", 1, 0.6)]


def test_an_asr_onset_well_before_the_line_word_moves_the_target():
    """The Hikaru case: the line's word time sits 1.3 s after the voice."""
    lines = [_line([_w("猫", 2.0, 2.1)], 10.0)]
    assert _verify(lines, [_tok("猫", 10.7, 11.1)])[(0, 0)] == pytest.approx((0.7, 1.1))


def test_a_match_deep_in_a_long_token_is_not_anchored():
    long_text = "あいうえお" + "ねこ" + "かきくけこ" * 6 + "さしす"
    assert len(catch_verify._moras(long_text)) == 40
    lines = [_line([_w("猫", 0.5, 0.9)], 10.0)]
    assert _verify(lines, [_tok(long_text, 10.0, 14.0)]) == {}


def test_the_same_word_at_the_onset_of_a_short_token_is_verified():
    lines = [_line([_w("猫", 0.5, 0.9)], 10.0)]
    got = _verify(lines, [_tok("ねこだ", 10.3, 10.9)])
    assert got[(0, 0)] == pytest.approx((0.3, 0.7))


def test_a_slow_token_is_not_trusted():
    lines = [_line([_w("猫", 0.5, 0.9)], 10.0)]
    assert _verify(lines, [_tok("ねこ", 10.4, 11.6)]) == {}


def test_an_onset_outside_its_own_line_is_not_placed():
    lines = [
        _line([_w("猫", 0.2, 0.6)], 10.0),
        _line([_w("犬", 3.0, 3.3)], 14.0),
    ]
    # 猫 heard before line 0 starts; 犬 heard where its end plus the late
    # tolerance runs past line 1's span (its own duration, 4 s).
    tokens = [_tok("猫", 9.5, 9.9), _tok("犬", 17.2, 17.6)]
    assert _verify(lines, tokens) == {}


def test_one_mora_words_and_caption_markers_never_verify():
    lines = [_line([_w("目", 0.2, 0.4), _w("[", 0.5, 0.6), _w("笑い", 0.6, 1.0),
                    _w("]", 1.0, 1.1)], 10.0)]
    tokens = catch_verify.youtube.asr_tokens([
        {"tStartMs": 10200, "dDurationMs": 300, "segs": [{"utf8": "目"}]},
        {"tStartMs": 10500, "dDurationMs": 600, "segs": [{"utf8": "[笑い]"}]},
    ])
    assert [t["text"] for t in tokens] == ["目"]
    assert _verify(lines, tokens) == {}


def test_es_matches_by_word_key_inside_the_window():
    lines = [_line([_w("Palabra,", 0.5, 0.9)], 10.0, duration=10.0)]
    got = _verify(lines, [_tok("palabra", 10.6, 11.0)], "es")
    assert got[(0, 0)] == pytest.approx((0.6, 1.0))
    assert _verify(lines, [_tok("palabra", 14.0, 14.4)], "es") == {}


def test_no_tokens_verifies_nothing():
    assert _verify([_line([_w("猫", 0.5, 0.9)], 0.0)], []) == {}


# -- reference_tokens ----------------------------------------------------


def _write(island_id, payload):
    path = store.AUDIO_DIR / island_id / "captions.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False))


ASR = [{"tStartMs": 1000, "dDurationMs": 2000,
        "segs": [{"utf8": "猫"}, {"utf8": "が", "tOffsetMs": 400}]}]
MANUAL = [{"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "猫がいる"}]}]


def test_reference_without_a_file_is_empty():
    assert catch_verify.reference_tokens("cv-missing") == ([], "")


def test_reference_prefers_the_asr_track():
    _write("cv-asr", {"video_id": "v", "events": MANUAL, "asr_events": ASR})
    tokens, ref = catch_verify.reference_tokens("cv-asr")
    assert ref == "asr" and [(t["text"], t["start"]) for t in tokens] == [("猫", 1.0), ("が", 1.4)]


def test_reference_falls_back_to_an_automatic_picked_track():
    _write("cv-auto", {"video_id": "v", "events": ASR, "asr_events": []})
    tokens, ref = catch_verify.reference_tokens("cv-auto")
    assert ref == "auto" and len(tokens) == 2


def test_reference_ignores_manual_events_without_offsets():
    _write("cv-manual", {"video_id": "v", "events": MANUAL, "asr_events": []})
    assert catch_verify.reference_tokens("cv-manual") == ([], "")


def test_reference_survives_broken_json_and_bad_tracks():
    _write("cv-broken", "{not json")
    assert catch_verify.reference_tokens("cv-broken") == ([], "")
    _write("cv-bad", {"asr_events": [{"tStartMs": "x", "segs": [{"utf8": "猫"}]}]})
    assert catch_verify.reference_tokens("cv-bad") == ([], "")
