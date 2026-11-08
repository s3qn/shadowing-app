"""lang_text: tokens, folding, scoring units, readings and transcript
script per language, all offline (jieba, pypinyin, korean_romanizer,
OpenCC are pure Python dictionaries)."""

import lang_text as lt
import languages


def test_table_facts_the_helpers_rely_on():
    assert lt.segmenter("ja") == "mora" and lt.segmenter("zh") == "jieba"
    assert lt.segmenter("fr") == "space" and lt.segmenter("xx") == "space"
    assert lt.is_cjk("ja") and lt.is_cjk("zh") and not lt.is_cjk("ko")
    assert lt.is_rtl("he") and lt.is_rtl("ar") and not lt.is_rtl("es")
    assert lt.joiner("ja") == "" and lt.joiner("zh") == "" and lt.joiner("es") == " "
    assert lt.asr_language("zh") == "zh" and lt.asr_language("xx") == "xx"
    assert lt.asr_prompt("zh") == languages.LANGUAGES["zh"].asr_prompt
    assert lt.asr_prompt("xx") == ""


# --- tokens ---------------------------------------------------------------

def test_zh_tokens_are_jieba_words_with_punctuation_glued():
    assert lt.tokens("我明天和朋友一起学习中文。", "zh") == [
        "我", "明天", "和", "朋友", "一起", "学习", "中文。",
    ]


def test_spaced_tokens_keep_a_lone_mark_on_its_word():
    assert lt.tokens("Comment allez-vous ?", "fr") == ["Comment", "allez-vous?"]
    assert lt.tokens("Hola, mucho gusto.", "es") == ["Hola,", "mucho", "gusto."]
    assert lt.tokens("  ", "es") == []


# --- fold -----------------------------------------------------------------

def test_fold_hebrew_drops_niqqud_and_maps_final_letters():
    assert lt.fold("שָׁלוֹם", "he") == lt.fold("שלום", "he") == "שלומ"
    assert lt.fold("ילדים־קטנים", "he") == "ילדימ קטנימ"


def test_fold_arabic_drops_tashkeel_and_folds_alef_ta_marbuta_and_digits():
    assert lt.fold("أَهْلاً", "ar") == "اهلا"
    assert lt.fold("مدرسةٌ", "ar") == "مدرسه"
    assert lt.fold("إلى ٣ كُتُبـــ؟", "ar") == "الي 3 كتب"


def test_fold_german_casefolds_eszett_and_strips_umlaut_marks():
    assert lt.fold("Straße", "de") == "strasse"
    assert lt.fold("schön", "de") == "schon"


def test_fold_french_apostrophes_and_narrow_spaces():
    assert lt.fold("L’homme est là ?", "fr") == "lhomme est la"
    assert lt.fold("l'homme", "fr") == lt.fold("L’HOMME", "fr")


def test_fold_korean_keeps_syllables_whole():
    assert lt.fold("학교에 가요.", "ko") == "학교에 가요"


# --- units ----------------------------------------------------------------

def test_units_zh_are_characters_without_punctuation():
    assert lt.units("你好，世界！", "zh") == ["你", "好", "世", "界"]


def test_units_ko_are_hangul_syllables_without_spaces():
    assert lt.units("학교에 가요.", "ko") == ["학", "교", "에", "가", "요"]


def test_units_words_and_moras_unchanged():
    assert lt.units("¿Dónde está?", "es") == ["donde", "esta"]
    assert lt.units("あさ", "ja") == ["ア", "サ"]


# --- readings -------------------------------------------------------------

def test_reading_zh_is_tone_marked_pinyin_by_word():
    assert lt.reading("你好", "zh") == "nǐhǎo"
    assert lt.reading("我明天学习中文。", "zh") == "wǒ míngtiān xuéxí zhōngwén."


def test_reading_ko_is_revised_romanization():
    # korean_romanizer's documented spelling-based form.
    assert lt.reading("학교", "ko") == "hakgyo"
    assert lt.reading("안녕하세요", "ko") == "annyeonghaseyo"


def test_reading_is_empty_for_kana_translit_and_none():
    assert lt.reading("日本", "ja") == ""
    assert lt.reading("שלום", "he") == ""
    assert lt.reading("Hola", "es") == ""
    assert lt.reading("", "zh") == ""


def test_ruby_fills_pinyin_per_zh_word_and_leaves_others():
    words = [{"text": "你好", "ruby": [{"text": "你好", "rt": ""}]},
             {"text": "。", "ruby": [{"text": "。", "rt": ""}]}]
    assert lt.ruby(words, "zh")[0]["ruby"] == [{"text": "你好", "rt": "nǐhǎo"}]
    assert words[1]["ruby"] == [{"text": "。", "rt": ""}]
    es = [{"text": "Hola", "ruby": [{"text": "Hola", "rt": ""}]}]
    assert lt.ruby(es, "es") == es and es[0]["ruby"][0]["rt"] == ""


# --- transcripts ----------------------------------------------------------

def test_normalize_transcript_turns_traditional_into_simplified():
    assert lt.normalize_transcript("軟體", "zh") == "软体"
    assert lt.normalize_transcript("我們在學校", "zh") == "我们在学校"
    assert lt.normalize_transcript("軟體", "ja") == "軟體"
    assert lt.normalize_transcript("", "zh") == ""
