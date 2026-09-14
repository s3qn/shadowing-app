"""Tests for the pure logic in segment.py.

Uses the real janome tokenizer (no network, no VOICEVOX). Timelines are built
by hand from the moras that tokenize() itself reports for a sentence, which
keeps these tests independent of what any live engine would actually speak.
"""

import segment


# ---------------------------------------------------------------------------
# split_moras / mora_count
# ---------------------------------------------------------------------------

def test_small_kana_glues_to_previous_mora():
    # キョウ: キ+small ョ glue into one mora, ウ is its own. 2 moras total.
    assert segment.split_moras("キョウ") == ["キョ", "ウ"]
    assert segment.mora_count("キョウ") == 2


def test_long_vowel_mark_is_its_own_mora():
    assert segment.split_moras("ラーメン") == ["ラ", "ー", "メ", "ン"]


def test_non_kana_characters_are_dropped():
    assert segment.split_moras("AキBC") == ["キ"]
    assert segment.split_moras("abc123") == []


def test_mora_count_of_empty_reading_is_zero():
    assert segment.mora_count("") == 0


# ---------------------------------------------------------------------------
# tokenize
# ---------------------------------------------------------------------------

def test_particle_stays_its_own_chunk():
    chunks = segment.tokenize("今日は学校に行きます。")
    # は is a particle, so it does not fold into 今日 before it. Particles
    # also read は as ワ, which is why its normalised mora is not ハ.
    particle = next(c for c in chunks if c["text"] == "は")
    assert particle["moras"] == ["ワ"]
    assert [c["text"] for c in chunks] == ["今日", "は", "学校", "に", "行きます。"]


def test_auxiliary_chain_folds_into_the_verb_before_it():
    # 飲んでいます: 飲ん(verb) + で(conn. particle) + い(non-independent verb)
    # + ます(auxiliary) all fold into one chunk, not four.
    chunks = segment.tokenize("十時に飲んでいます。")
    texts = [c["text"] for c in chunks]
    assert "飲んでいます。" in texts


def test_counter_folds_into_the_number_before_it():
    # 十時: 十(number) + 時(counter, 接尾) become one chunk.
    chunks = segment.tokenize("十時に飲んでいます。")
    assert chunks[0]["text"] == "十時"
    assert chunks[0]["moras"] == ["ジュ", "ウ", "ジ"]


def test_punctuation_never_becomes_its_own_chunk():
    chunks = segment.tokenize("今日は、学校に行きます。")
    for c in chunks:
        assert c["text"].strip("、。！？!?…「」『』（）()・") != ""


def test_token_with_no_dictionary_reading_is_unknown_with_empty_moras():
    # "Tokyo" has no janome reading and is not followed by anything that
    # attaches to it, so it stays its own chunk with no moras.
    chunks = segment.tokenize("Tokyoに行きます。")
    assert chunks[0]["text"] == "Tokyo"
    assert chunks[0]["moras"] == []
    assert chunks[0]["unknown"] is True


# ---------------------------------------------------------------------------
# align / is_fallback
# ---------------------------------------------------------------------------

def _fake_timeline(chunks, step=0.1):
    """A synthetic mora timeline built from tokenize()'s own moras, standing
    in for what VOICEVOX would have returned."""
    timeline = []
    t = 0.0
    for chunk in chunks:
        for mora in chunk["moras"]:
            timeline.append({"text": mora, "start": round(t, 4), "end": round(t + step, 4)})
            t += step
    return timeline


def test_align_produces_ordered_contiguous_spans_covering_the_line():
    text = "今日は学校に行きます。"
    chunks = segment.tokenize(text)
    timeline = _fake_timeline(chunks)

    words = segment.align(text, timeline)

    assert [w["text"] for w in words] == [c["text"] for c in chunks]
    assert "".join(w["text"] for w in words) == text
    assert words[0]["start"] == 0.0
    assert words[-1]["end"] == timeline[-1]["end"]
    for a, b in zip(words, words[1:]):
        assert a["end"] == b["start"]


def test_align_empty_timeline_returns_empty_list():
    assert segment.align("今日は学校に行きます。", []) == []


def test_align_falls_back_to_one_chunk_when_moras_do_not_match():
    text = "今日は学校に行きます。"
    # Moras that do not appear anywhere in this sentence's reading.
    unmatched_timeline = [
        {"text": "ペ", "start": 0.0, "end": 0.1},
        {"text": "ラ", "start": 0.1, "end": 0.2},
    ]

    words = segment.align(text, unmatched_timeline)

    assert len(words) == 1
    assert words[0]["text"] == text
    assert words[0]["start"] == 0.0
    assert words[0]["end"] == unmatched_timeline[-1]["end"]


def test_is_fallback_true_for_whole_line_result():
    text = "今日は学校に行きます。"
    unmatched_timeline = [{"text": "ペ", "start": 0.0, "end": 0.1}]
    words = segment.align(text, unmatched_timeline)
    assert segment.is_fallback(text, words) is True


def test_is_fallback_false_for_a_real_split():
    text = "今日は学校に行きます。"
    chunks = segment.tokenize(text)
    timeline = _fake_timeline(chunks)
    words = segment.align(text, timeline)
    assert segment.is_fallback(text, words) is False


# ---------------------------------------------------------------------------
# ruby / ensure_ruby
# ---------------------------------------------------------------------------

def test_ruby_okurigana_stays_plain():
    assert segment.ruby("行きます。") == [{"text": "行", "rt": "い"}, {"text": "きます。", "rt": ""}]


def test_ruby_kanji_on_both_sides_of_kana():
    assert segment.ruby("食べ物") == [
        {"text": "食", "rt": "た"},
        {"text": "べ", "rt": ""},
        {"text": "物", "rt": "もの"},
    ]


def test_ruby_each_token_reads_on_its_own():
    assert segment.ruby("十時") == [{"text": "十", "rt": "じゅう"}, {"text": "時", "rt": "じ"}]


def test_ruby_kana_only_words_have_no_reading():
    for word in ("こんにちは", "コーヒー", "は"):
        segs = segment.ruby(word)
        assert len(segs) == 1
        assert segs[0]["rt"] == ""
        assert segs[0]["text"] == word


def test_ruby_tokens_without_a_reading_stay_plain():
    assert segment.ruby("Tokyo") == [{"text": "Tokyo", "rt": ""}]
    assert segment.ruby("10時") == [{"text": "10", "rt": ""}, {"text": "時", "rt": "じ"}]


def test_ruby_segments_concatenate_to_the_word():
    for word in ["引き出し", "お母さん", "一ヶ月", "気持ち", "今、", "行って、"]:
        segs = segment.ruby(word)
        assert "".join(s["text"] for s in segs) == word


def test_align_words_carry_ruby():
    text = "今日は学校に行きます。"
    chunks = segment.tokenize(text)
    timeline = _fake_timeline(chunks)

    words = segment.align(text, timeline)

    for w in words:
        assert "".join(s["text"] for s in w["ruby"]) == w["text"]
    assert words[0]["ruby"] == [{"text": "今日", "rt": "きょう"}]
    particle_word = next(w for w in words if w["text"] == "は")
    assert particle_word["ruby"] == [{"text": "は", "rt": ""}]


def test_align_fallback_carries_ruby():
    text = "今日は学校に行きます。"
    unmatched_timeline = [
        {"text": "ペ", "start": 0.0, "end": 0.1},
        {"text": "ラ", "start": 0.1, "end": 0.2},
    ]

    words = segment.align(text, unmatched_timeline)

    assert words[0]["ruby"][0] == {"text": "今日", "rt": "きょう"}


def _spoken(moras, step=0.1):
    return [{"text": m, "start": round(i * step, 4), "end": round((i + 1) * step, 4)}
            for i, m in enumerate(moras)]


def test_align_drops_ruby_that_disagrees_with_the_spoken_moras():
    # janome reads 月 alone as つき; VOICEVOX says さんがつ.
    text = "3月に行きます。"
    timeline = _spoken(["サ", "ン", "ガ", "ツ", "ニ", "イ", "キ", "マ", "ス"])

    words = segment.align(text, timeline)

    assert words[0]["text"] == "3月"
    assert words[0]["ruby"] == [{"text": "3月", "rt": ""}]
    assert words[-1]["ruby"] == [{"text": "行", "rt": "い"}, {"text": "きます。", "rt": ""}]


def test_align_keeps_ruby_that_matches_the_spoken_moras():
    text = "学校に行きます。"
    timeline = _spoken(["ガ", "ッ", "コ", "オ", "ニ", "イ", "キ", "マ", "ス"])

    words = segment.align(text, timeline)

    assert words[0]["ruby"] == [{"text": "学校", "rt": "がっこう"}]


def test_ruby_matches_lets_digits_stand_for_their_moras():
    segs = segment.ruby("10時")
    assert segment.ruby_matches(segs, ["ジュ", "ウ", "ジ"]) is True
    assert segment.ruby_matches(segment.ruby("3月"), ["サ", "ン", "ガ", "ツ"]) is False


def test_ensure_ruby_checks_against_the_moras_in_the_word_span():
    timeline = _spoken(["サ", "ン", "ガ", "ツ", "ニ"])
    words = [{"text": "3月", "start": 0.0, "end": 0.4}, {"text": "に", "start": 0.4, "end": 0.5}]

    assert segment.ensure_ruby(words, timeline) is True

    assert words[0]["ruby"] == [{"text": "3月", "rt": ""}]


def test_ensure_ruby_fills_only_missing():
    words = [{"text": "今日", "start": 0.0, "end": 0.1}, {"text": "は", "start": 0.1, "end": 0.2, "ruby": []}]

    changed = segment.ensure_ruby(words)

    assert changed is True
    assert words[0]["ruby"] == segment.ruby("今日")
    assert words[1]["ruby"] == []
    assert segment.ensure_ruby(words) is False
