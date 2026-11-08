"""Per-language text helpers, pure and offline: how a line splits into
tappable words, how two spellings are folded before they are compared, the
unit a take is scored on, and the reading line (pinyin, Revised
Romanization) a learner sees under a line.

Every rule keys off the row in `languages.LANGUAGES`; nothing here checks a
language code directly except the folding tables, which are script facts
rather than table fields. Japanese keeps its mora path in `segment.py`.
"""

import logging
import re
import unicodedata

import languages

log = logging.getLogger(__name__)

_HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
# Full-width marks the model writes in a Chinese line, mapped to the ASCII
# mark the pinyin line shows under it.
_CJK_PUNCT = {
    "。": ".", "，": ",", "、": ",", "？": "?", "！": "!", "：": ":", "；": ";",
    "“": '"', "”": '"', "‘": "'", "’": "'", "（": "(", "）": ")", "《": "", "》": "",
    "……": "...", "…": "...",
}
_HE_FINALS = str.maketrans({"ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ", "־": " ", "׳": "'", "״": '"'})
_AR_LETTERS = str.maketrans({
    "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي", "ء": "",
    "ـ": "", "،": ",", "؟": "?", "؛": ";",
})
_AR_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_FR_MARKS = str.maketrans({"’": "'", "‘": "'", " ": " ", " ": " ", " ": " "})
_INVISIBLE = re.compile(r"[​-‏‪-‮⁦-⁩﻿]")
_IN_WORD = "'’‘-"


def _row(code: str):
    return languages.LANGUAGES.get(code)


def segmenter(code: str) -> str:
    row = _row(code)
    return row.segmenter if row else "space"


def reading_kind(code: str) -> str | None:
    row = _row(code)
    return row.reading if row else None


def score_unit(code: str) -> str:
    row = _row(code)
    return row.score_unit if row else "word"


def is_cjk(code: str) -> bool:
    row = _row(code)
    return bool(row and row.cjk)


def is_rtl(code: str) -> bool:
    row = _row(code)
    return bool(row and row.rtl)


def asr_language(code: str) -> str:
    """The whisper code for a learning language (the same letters for every
    language we carry today, read from the table so a split never hides)."""
    row = _row(code)
    return (row.asr_language if row else "") or code


def asr_prompt(code: str) -> str:
    """The short `initial_prompt` that steers whisper's script and spelling
    for a pinned language; "" when the table has none."""
    row = _row(code)
    return (row.asr_prompt if row else "") or ""


def joiner(code: str) -> str:
    """What sits between two words of a line: nothing in a CJK script."""
    return "" if is_cjk(code) else " "


# --- tokens ---------------------------------------------------------------

def _jieba():
    import jieba  # heavy dictionary load, so only when a Chinese line arrives

    jieba.setLogLevel(logging.ERROR)
    return jieba


def tokens(text: str, code: str) -> list[str]:
    """The tappable words of a line. Chinese is cut by jieba with each
    punctuation mark glued to the word before it (a lone 。 is not a word);
    every other language splits on whitespace, punctuation attached, the
    same boundaries whisper's word pieces use. Japanese words come from
    `segment.align`, so its tokens here are whitespace runs too."""
    text = (text or "").strip()
    if not text:
        return []
    if segmenter(code) == "jieba":
        raw, glue = _jieba().lcut(text), ""
    else:
        # A French "allez-vous ?" keeps its mark on the word with no space
        # between, so a word never holds a space and the mark never wraps alone.
        raw, glue = text.split(), ""
    out: list[str] = []
    for tok in raw:
        if not tok.strip():
            continue
        if out and not fold(tok, code):
            out[-1] += glue + tok
        else:
            out.append(tok)
    return out


# --- folding --------------------------------------------------------------

def fold(text: str, code: str) -> str:
    """The comparison form of a string: NFKC, the script's own spelling
    variants collapsed, combining marks (accents, niqqud, tashkeel) dropped,
    punctuation removed (an apostrophe or hyphen inside a word closes up,
    l'homme and geht's stay one unit), case folded, whitespace collapsed.
    Never shown."""
    text = unicodedata.normalize("NFKC", text or "")
    text = _INVISIBLE.sub("", text)
    if code == "he":
        text = text.translate(_HE_FINALS)
    elif code == "ar":
        text = text.translate(_AR_LETTERS).translate(_AR_DIGITS)
    elif code == "fr":
        text = text.translate(_FR_MARKS)
    # NFD exposes the marks, NFC puts Hangul syllables back together.
    decomposed = unicodedata.normalize("NFD", text)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    text = unicodedata.normalize("NFC", stripped)
    kept = "".join(
        ch if ch.isalnum() or ch.isspace() else ("" if ch in _IN_WORD else " ") for ch in text
    )
    return " ".join(kept.casefold().split())


# --- scoring units --------------------------------------------------------

def units(text: str, code: str) -> list[str]:
    """What a take is scored on: moras for Japanese, characters for Chinese,
    Hangul syllables for Korean, folded words elsewhere."""
    unit = score_unit(code)
    if unit == "mora":
        import segment  # segment imports latin, which imports this module

        return segment.moras_of(text)
    folded = fold(text, code)
    if unit in ("char", "syllable"):
        return [ch for ch in folded if not ch.isspace()]
    return folded.split()


# --- readings -------------------------------------------------------------

def _pinyin_of(word: str) -> str:
    from pypinyin import Style, lazy_pinyin

    out = []
    for syl in lazy_pinyin(word, style=Style.TONE):
        out.append(_CJK_PUNCT.get(syl, syl))
    return "".join(out)


def _pinyin_line(text: str) -> str:
    parts: list[str] = []
    for tok in tokens(text, "zh"):
        piece = _pinyin_of(tok) if _HAN.search(tok) else "".join(_CJK_PUNCT.get(c, c) for c in tok)
        parts.append(piece)
    return " ".join(p for p in parts if p)


def reading(text: str, code: str) -> str:
    """The reading line under a line: tone-marked pinyin by jieba word for
    Chinese, Revised Romanization for Korean, "" for every other language
    (Japanese kana comes from `segment.reading`, a transliteration for
    Hebrew or Arabic from the model). Never raises."""
    text = (text or "").strip()
    if not text:
        return ""
    try:
        kind = reading_kind(code)
        if kind == "pinyin":
            return _pinyin_line(text)
        if kind == "rr":
            from korean_romanizer.romanizer import Romanizer

            return Romanizer(text).romanize()
    except Exception:
        log.exception("reading failed for %s %r", code, text)
    return ""


def ruby(words: list[dict], code: str) -> list[dict]:
    """Fills each word's `ruby` with its pinyin when the language shows
    pinyin above words; other languages keep the empty `rt` they came with.
    Returns the same list."""
    if reading_kind(code) != "pinyin":
        return words
    for word in words:
        text = word.get("text", "")
        # Marks inside a token ("好。") stay out of the rt; the line reading keeps them.
        rt = _pinyin_of("".join(c for c in text if c.isalnum())) if _HAN.search(text) else ""
        word["ruby"] = [{"text": text, "rt": rt}]
    return words


# --- transcripts ----------------------------------------------------------

_t2s = None


def normalize_transcript(text: str, code: str) -> str:
    """What whisper wrote, in the script the lines use: Traditional Chinese
    characters become Simplified (OpenCC t2s). Other languages pass through."""
    if not text or (code or "").split("-")[0] != "zh":
        return text
    global _t2s
    try:
        if _t2s is None:
            import opencc

            _t2s = opencc.OpenCC("t2s")
        return _t2s.convert(text)
    except Exception:
        log.exception("opencc t2s failed")
        return text
