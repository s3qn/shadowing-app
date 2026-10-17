"""BL-51: content score, blend, and the total on a take's score."""

import asyncio
import io
import uuid

import pytest
from fastapi import UploadFile

import main
import store
import take_content as tc
import transcribe

AUTH = f"Bearer {main.SHADOW_TOKEN}"
LINE = "おはようございます"  # 9 moras
SILENT = "No voice heard in the take"


def test_ja_identical_is_100():
    assert tc.content_score(LINE, LINE, "ja") == 100


def test_ja_wrong_vowel_and_near_mora():
    ref = tc.units("あさごはんをたべる", "ja")
    assert len(ref) == 9
    # ta -> mi: different vowel, cost 1 of 9
    assert tc.content_score("あさごはんをたべる", "あさごはんをみべる", "ja") == 89
    # ka vs ga share the base: cost 0.5
    assert tc.content_score("かさかさかさかさかさ", "かさかさかさかさかさ".replace("か", "が", 1), "ja") == 95


def test_ja_semi_global_ignores_echo_and_tail():
    assert tc.content_score(LINE, f"えっとはい{LINE}ね", "ja") == 100


def test_empty_heard_and_empty_line():
    assert tc.content_score(LINE, "", "ja") == 0
    assert tc.content_score("", LINE, "ja") is None


def test_es_accents_and_slip():
    assert tc.content_score("¿Dónde está la estación?", "donde esta la estacion", "es") == 100
    assert tc.content_score("¿Dónde está la estación?", "donde esta la estacian", "es") >= 90


def test_timing_score():
    assert tc.timing_score({"words": ["ok", "early", "dropped", "none"], "note": ""}) == 50
    assert tc.timing_score({"words": ["ok"], "note": SILENT}) is None
    assert tc.timing_score({"words": ["none"], "note": ""}) is None


def test_pitch_score():
    ok = {"note": "", "moras": [{"nucleus": "hit"}, {"nucleus": "hit"}, {"nucleus": "miss"}, {"nucleus": None}]}
    assert tc.pitch_score(ok) == 67
    assert tc.pitch_score({**ok, "note": "x"}) is None
    assert tc.pitch_score({"note": "", "moras": [{"nucleus": None}]}) is None


def test_blend():
    assert tc.blend(80, 60, None) == 73
    assert tc.blend(None, None, 100) is None


def _score(note=""):
    return {"words": ["ok", "ok"], "note": note}


ANALYSIS = {"note": "", "moras": [{"nucleus": "hit"}]}


def test_total_fills_fields(monkeypatch, tmp_path):
    monkeypatch.setattr(transcribe, "transcribe", lambda *a, **k: {"ok": True, "text": LINE})
    out = main._bl51_total(_score(), ANALYSIS, tmp_path / "t.wav", LINE, "ja")
    assert out["total"] == 100 and out["heard"] == LINE and out["totalNote"] == ""
    assert out["parts"] == {"content": 100, "timing": 100, "pitch": 100}


def test_total_skips_whisper_on_silence(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise AssertionError("whisper ran")

    monkeypatch.setattr(transcribe, "transcribe", boom)
    out = main._bl51_total(_score(SILENT), ANALYSIS, tmp_path / "t.wav", LINE, "ja")
    assert out["total"] is None and out["totalNote"] == SILENT and out["heard"] == ""


def test_total_never_raises(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise RuntimeError("model")

    monkeypatch.setattr(transcribe, "transcribe", boom)
    out = main._bl51_total(_score(), ANALYSIS, tmp_path / "t.wav", LINE, "ja")
    assert out["total"] is None and out["totalNote"] == "Could not score the take"


def test_upload_stores_a_row(monkeypatch, tmp_path):
    owner = f"user_{uuid.uuid4().hex}"
    store.init()
    island = {"id": "isl", "device": owner, "language": "ja", "lines": [{"idx": 0}]}

    async def fake_audio(*a, **k):
        return tmp_path / "ref.wav"

    monkeypatch.setattr(main, "_own_island", lambda island_id, device: island)
    monkeypatch.setattr(main, "_load_take_profile", lambda aec, device: None)
    monkeypatch.setattr(main, "_take_use_slot", lambda device, kind: None)
    monkeypatch.setattr(main, "_resolve_line_audio", fake_audio)
    monkeypatch.setattr(main, "_run_clean", lambda *a, **k: {
        "score": {"words": ["ok"], "total": 88, "parts": {"content": 90, "timing": 80, "pitch": None}}})
    asyncio.run(main.upload_take(
        island_id="isl", idx=0, speed=1.0, calibrate="0", start=-1, end=-1, lag=0, line_start=-1,
        take=UploadFile(file=io.BytesIO(b"RIFF"), filename="t.wav"),
        authorization=AUTH, x_shadow_device=owner,
    ))
    rows = store.list_take_scores(owner)
    assert len(rows) == 1 and rows[0]["total"] == 88 and rows[0]["pitch"] is None


# --- review fixes ---

WORDS = [
    {"text": "おはよう", "start": 0.0, "end": 0.6},
    {"text": "ございます", "start": 0.6, "end": 1.2},
]


def test_span_text_keeps_only_words_in_the_span():
    assert tc.span_text(WORDS, None, 1.0, LINE, "ja") == LINE
    # at half speed the second word renders from 1200 ms to 2400 ms
    assert tc.span_text(WORDS, (1300, 2400), 0.5, LINE, "ja") == "ございます"
    assert tc.span_text(WORDS, (5000, 6000), 1.0, LINE, "ja") == ""
    es = [{"text": "Buenos", "start": 0.0, "end": 0.5}, {"text": "días", "start": 0.5, "end": 1.0}]
    assert tc.span_text(es, (0, 1000), 1.0, "Buenos días", "es") == "Buenos días"


def test_phrase_take_scores_against_its_span(monkeypatch, tmp_path):
    import aec
    import numpy as np
    import take_analysis
    import take_score

    seen = {}
    monkeypatch.setattr(aec, "decode", lambda p: np.zeros(10))
    monkeypatch.setattr(aec, "encode", lambda p, x: None)
    monkeypatch.setattr(aec, "clean", lambda r, m, p: aec.Result(cleaned=False, note="", output=m))
    monkeypatch.setattr(aec, "heard_speaker", lambda r, m: False)
    monkeypatch.setattr(store, "take_paths", lambda i, x: (tmp_path / "r.wav", tmp_path / "c.wav"))
    monkeypatch.setattr(take_score, "score_take", lambda *a, **k: _score())
    monkeypatch.setattr(take_analysis, "analyse", lambda *a, **k: ANALYSIS)
    monkeypatch.setattr(transcribe, "transcribe", lambda *a, **k: {"ok": True, "text": "ございます"})

    def spy(score, analysis, path, line_text, language, echo_left=False):
        seen.update(text=line_text, echo=echo_left)
        return score

    monkeypatch.setattr(main, "_bl51_total", spy)
    line = {"ja": LINE, "words": WORDS, "timeline": []}
    main._run_clean(tmp_path / "u.wav", tmp_path / "ref.wav", None, "isl", 0, line, 1.0,
                    (650, 1200), 0, 0, "ja")
    assert seen == {"text": "ございます", "echo": False}

    monkeypatch.setattr(aec, "heard_speaker", lambda r, m: True)
    main._run_clean(tmp_path / "u.wav", tmp_path / "ref.wav", None, "isl", 0, line, 1.0,
                    None, 0, 0, "ja")
    assert seen == {"text": LINE, "echo": True}


def test_total_drops_content_when_the_echo_is_left(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise AssertionError("whisper ran on an echo")

    monkeypatch.setattr(transcribe, "transcribe", boom)
    out = main._bl51_total(_score(), ANALYSIS, tmp_path / "t.wav", LINE, "ja", echo_left=True)
    assert out["parts"] == {"content": None, "timing": 100, "pitch": 100}
    assert out["total"] == 100 and out["heard"] == ""


def test_total_asks_whisper_for_the_fast_path(monkeypatch, tmp_path):
    seen = {}

    def fake(path, **kwargs):
        seen.update(kwargs)
        return {"ok": True, "text": LINE}

    monkeypatch.setattr(transcribe, "transcribe", fake)
    main._bl51_total(_score(), ANALYSIS, tmp_path / "t.wav", LINE, "ja")
    assert seen == {"language": "ja", "fast": True}


def test_numerals_read_as_words():
    assert tc.content_score("三時です", "3時です", "ja") == 100
    assert tc.content_score("二千二十五年", "2025年", "ja") == 100
    assert tc.content_score("Son las tres", "son las 3", "es") == 100
    assert tc.content_score("mil novecientos noventa y nueve", "1.999", "es") == 100
    assert tc.kanji_number(0) == "ゼロ" and tc.kanji_number(10 ** 16) is None
    assert tc.spanish_number(21000) == "veintiun mil" and tc.spanish_number(10 ** 6) is None


def test_long_hallucination_does_not_match_a_short_line():
    assert tc.content_score("はい", "ご視聴ありがとうございました", "ja") <= 10
    assert tc.content_score("はい", "はい", "ja") == 100


def test_hiragana_long_mark_matches_katakana():
    assert tc.content_score("コーヒー", "こーひー", "ja") == 100
