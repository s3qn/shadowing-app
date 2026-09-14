"""Tests for the pure logic in voicevox.py: to_hiragana, build_timeline and
total_duration. The async HTTP functions (audio_query, synthesis, speak, ...)
are never imported or called here, VOICEVOX must never run for this suite.

audio_query dicts are hand-written, shaped like what VOICEVOX's AudioQuery
actually returns: accent_phrases -> moras (consonant_length/vowel_length) and
an optional pause_mora, plus prePhonemeLength/postPhonemeLength/speedScale.
"""

import io
import wave

import pytest

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


# ---------------------------------------------------------------------------
# pad_wav
# ---------------------------------------------------------------------------

def _make_wav(framerate: int, nchannels: int, sampwidth: int, duration_ms: int) -> bytes:
    nframes = round(framerate * duration_ms / 1000)
    # A non-zero pattern, so "the original frames are a prefix" is a real check
    # and not just a run of the same byte silence would also produce.
    frame = bytes((i % 250) + 1 for i in range(sampwidth * nchannels))
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(nchannels)
        w.setsampwidth(sampwidth)
        w.setframerate(framerate)
        w.writeframes(frame * nframes)
    return out.getvalue()


def test_pad_wav_appends_silence_frames():
    wav = _make_wav(24000, 1, 2, 100)
    with wave.open(io.BytesIO(wav)) as src:
        original_params = src.getparams()
        original_frames = src.readframes(src.getnframes())

    padded = voicevox.pad_wav(wav, 2000)

    with wave.open(io.BytesIO(padded)) as out:
        assert out.getnframes() == original_params.nframes + 48000
        params = out.getparams()
        assert params.nchannels == original_params.nchannels
        assert params.sampwidth == original_params.sampwidth
        assert params.framerate == original_params.framerate
        frames = out.readframes(out.getnframes())

    assert frames[: len(original_frames)] == original_frames
    added = frames[len(original_frames):]
    assert added == b"\x00" * len(added)


def test_pad_wav_zero_or_negative_returns_input_unchanged():
    wav = _make_wav(24000, 1, 2, 100)
    assert voicevox.pad_wav(wav, 0) == wav
    assert voicevox.pad_wav(wav, -5) == wav


def test_pad_wav_keeps_stereo_and_other_rates():
    wav = _make_wav(44100, 2, 2, 500)
    with wave.open(io.BytesIO(wav)) as src:
        original_nframes = src.getnframes()

    padded = voicevox.pad_wav(wav, 500)

    with wave.open(io.BytesIO(padded)) as out:
        assert out.getnframes() == original_nframes + 22050
        assert out.getnchannels() == 2


# ---------------------------------------------------------------------------
# accent_highs / needs_accent / backfill_accent
# ---------------------------------------------------------------------------

def test_accent_highs_atamadaka():
    assert voicevox.accent_highs(1, 3) == [True, False, False]


def test_accent_highs_nakadaka():
    assert voicevox.accent_highs(3, 5) == [False, True, True, False, False]


def test_accent_highs_heiban_is_low_then_high_to_the_end():
    assert voicevox.accent_highs(5, 5) == [False, True, True, True, True]


def test_accent_highs_single_mora_and_empty():
    assert voicevox.accent_highs(1, 1) == [True]
    assert voicevox.accent_highs(1, 0) == []


def test_accent_highs_clamps_out_of_range():
    assert voicevox.accent_highs(0, 3) == [False, True, True]
    assert voicevox.accent_highs(9, 3) == [False, True, True]


def test_build_timeline_marks_each_mora_high_or_low():
    query = {
        "accent_phrases": [
            {"accent": 1, "moras": [_mora("キョ", 0.0, 0.1), _mora("オ", 0.0, 0.1), _mora("ワ", 0.0, 0.1)]},
            {
                "accent": 5,
                "moras": [
                    _mora("ガ", 0.0, 0.1),
                    _mora("ッ", 0.0, 0.1),
                    _mora("コ", 0.0, 0.1),
                    _mora("オ", 0.0, 0.1),
                    _mora("ニ", 0.0, 0.1),
                ],
            },
        ],
        "prePhonemeLength": 0.0,
        "postPhonemeLength": 0.0,
    }

    timeline = voicevox.build_timeline(query)

    assert [m["high"] for m in timeline] == [True, False, False, False, True, True, True, True]


def test_build_timeline_without_accent_key_is_flat():
    query = {
        "accent_phrases": [{"moras": [_mora("キ", 0.0, 0.1), _mora("ョ", 0.0, 0.1), _mora("ウ", 0.0, 0.1)]}],
        "prePhonemeLength": 0.0,
        "postPhonemeLength": 0.0,
    }

    timeline = voicevox.build_timeline(query)

    assert [m["high"] for m in timeline] == [False, True, True]


def test_needs_accent():
    assert voicevox.needs_accent([]) is False
    assert voicevox.needs_accent([{"text": "コ"}]) is True
    assert voicevox.needs_accent([{"text": "コ", "high": None}, {"text": "ン", "high": None}]) is False
    assert voicevox.needs_accent([{"text": "コ", "high": True}, {"text": "ン", "high": False}]) is False


def test_backfill_accent_copies_highs_when_moras_match():
    timeline = [
        {"text": "キョ", "kana": "きょ", "start": 0.0, "end": 0.1, "phrase": 0},
        {"text": "オ", "kana": "お", "start": 0.1, "end": 0.2, "phrase": 0},
        {"text": "ワ", "kana": "わ", "start": 0.2, "end": 0.3, "phrase": 0},
    ]
    query = {
        "accent_phrases": [
            {"accent": 1, "moras": [_mora("キョ", 0.0, 0.1), _mora("オ", 0.0, 0.1), _mora("ワ", 0.0, 0.1)]},
        ],
        "prePhonemeLength": 0.0,
        "postPhonemeLength": 0.0,
    }

    filled = voicevox.backfill_accent(timeline, query)

    assert filled is not None
    assert [m["high"] for m in filled] == [True, False, False]
    for stored, result in zip(timeline, filled):
        assert result["start"] == stored["start"]
        assert result["end"] == stored["end"]
        assert result["kana"] == stored["kana"]
        assert result["phrase"] == stored["phrase"]


def test_backfill_accent_returns_none_on_mora_mismatch():
    timeline = [{"text": "キョ", "start": 0.0, "end": 0.1, "phrase": 0}]
    query_shorter = {"accent_phrases": [], "prePhonemeLength": 0.0, "postPhonemeLength": 0.0}
    query_different = {
        "accent_phrases": [{"accent": 1, "moras": [_mora("ワ", 0.0, 0.1)]}],
        "prePhonemeLength": 0.0,
        "postPhonemeLength": 0.0,
    }

    assert voicevox.backfill_accent(timeline, query_shorter) is None
    assert voicevox.backfill_accent(timeline, query_different) is None


# ---------------------------------------------------------------------------
# slice_wav
# ---------------------------------------------------------------------------

def test_slice_wav_keeps_the_span_frames():
    wav = _make_wav(24000, 1, 2, 1000)
    with wave.open(io.BytesIO(wav)) as src:
        source_frames = src.readframes(src.getnframes())
        source_params = src.getparams()

    sliced = voicevox.slice_wav(wav, 200, 500)

    with wave.open(io.BytesIO(sliced)) as out:
        assert out.getnframes() == 7200
        params = out.getparams()
        assert params.nchannels == source_params.nchannels
        assert params.sampwidth == source_params.sampwidth
        assert params.framerate == source_params.framerate
        frames = out.readframes(out.getnframes())

    frame_bytes = source_params.sampwidth * source_params.nchannels
    assert (
        frames[120 * frame_bytes: 7080 * frame_bytes]
        == source_frames[4920 * frame_bytes: 11880 * frame_bytes]
    )


def test_slice_wav_fades_both_cuts():
    wav = _make_wav(24000, 1, 2, 1000)

    sliced = voicevox.slice_wav(wav, 200, 500)

    with wave.open(io.BytesIO(sliced)) as out:
        nframes = out.getnframes()
        frame_bytes = out.getsampwidth() * out.getnchannels()
        frames = out.readframes(nframes)

    zero_frame = b"\x00" * frame_bytes
    assert frames[:frame_bytes] == zero_frame
    assert frames[-frame_bytes:] == zero_frame
    mid = nframes // 2
    assert frames[mid * frame_bytes: (mid + 1) * frame_bytes] != zero_frame


def test_slice_wav_clamps_end_to_the_file():
    wav = _make_wav(24000, 1, 2, 1000)

    sliced = voicevox.slice_wav(wav, 800, 5000)

    with wave.open(io.BytesIO(sliced)) as out:
        assert out.getnframes() == 4800


def test_slice_wav_rejects_an_empty_span():
    wav = _make_wav(24000, 1, 2, 1000)

    with pytest.raises(ValueError):
        voicevox.slice_wav(wav, 500, 500)
    with pytest.raises(ValueError):
        voicevox.slice_wav(wav, 700, 300)
    with pytest.raises(ValueError):
        voicevox.slice_wav(wav, 1200, 1500)


def test_slice_wav_stereo_fades_every_channel():
    wav = _make_wav(44100, 2, 2, 1000)

    sliced = voicevox.slice_wav(wav, 200, 500)

    with wave.open(io.BytesIO(sliced)) as out:
        frame_bytes = out.getsampwidth() * out.getnchannels()
        first_frame = out.readframes(1)

    assert first_frame == b"\x00" * frame_bytes
