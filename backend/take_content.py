"""Content accuracy of a take: what whisper heard against the line's text,
blended with the timing and pitch parts into one 0 to 100 number. Pure."""

import re
import unicodedata

import latin
import segment
from take_analysis import vowel

WEIGHTS = {"content": 0.6, "timing": 0.3, "pitch": 0.1}
EARLY_LATE_CREDIT = 0.5
NEAR_MORA_COST = 0.5
# Heard units past the line's own length plus this many (or the line's length,
# if longer) each cost a little, so a short line is not matched for free
# somewhere inside a long hallucination.
EXTRA_UNIT_COST = 0.15
FREE_EXTRA_FLOOR = 3

_KANJI_DIGITS = "〇一二三四五六七八九"
_ES_SMALL = (
    "cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince "
    "dieciseis diecisiete dieciocho diecinueve veinte veintiuno veintidos veintitres veinticuatro "
    "veinticinco veintiseis veintisiete veintiocho veintinueve"
).split()
_ES_TENS = {3: "treinta", 4: "cuarenta", 5: "cincuenta", 6: "sesenta", 7: "setenta", 8: "ochenta", 9: "noventa"}
_ES_HUNDREDS = {
    1: "ciento", 2: "doscientos", 3: "trescientos", 4: "cuatrocientos", 5: "quinientos",
    6: "seiscientos", 7: "setecientos", 8: "ochocientos", 9: "novecientos",
}


def _kanji_under_10000(n: int) -> str:
    out = ""
    for value, mark in ((1000, "千"), (100, "百"), (10, "十")):
        d, n = divmod(n, value)
        if d:
            out += ("" if d == 1 else _KANJI_DIGITS[d]) + mark
    return out + (_KANJI_DIGITS[n] if n else "")


def kanji_number(n: int) -> str | None:
    """3 -> 三, 2025 -> 二千二十五, 0 -> ゼロ; None past 9999兆. Line text and
    whisper's digits both go through janome afterwards, so a counter keeps
    the reading janome gives it either way (三時 and 3時 both read サンジ)."""
    if n == 0:
        return "ゼロ"
    if n >= 10 ** 16:
        return None
    out = ""
    for power, mark in ((12, "兆"), (8, "億"), (4, "万"), (0, "")):
        group, n = divmod(n, 10 ** power)
        if group:
            out += _kanji_under_10000(group) + mark
    return out


def _es_under_1000(n: int) -> str:
    if n == 100:
        return "cien"
    hundreds, rest = divmod(n, 100)
    parts = [_ES_HUNDREDS[hundreds]] if hundreds else []
    if rest or not parts:
        if rest < 30:
            parts.append(_ES_SMALL[rest])
        else:
            tens, ones = divmod(rest, 10)
            parts.append(_ES_TENS[tens] + (f" y {_ES_SMALL[ones]}" if ones else ""))
    return " ".join(parts)


def spanish_number(n: int) -> str | None:
    """3 -> tres, 1999 -> mil novecientos noventa y nueve, without accents
    (units() strips them from the line too); None from a million up."""
    if n >= 1_000_000:
        return None
    thousands, rest = divmod(n, 1000)
    if not thousands:
        return _es_under_1000(rest)
    head = "mil" if thousands == 1 else re.sub(r"uno$", "un", _es_under_1000(thousands)) + " mil"
    return head if not rest else f"{head} {_es_under_1000(rest)}"


def _spell_numbers(text: str, language: str) -> str:
    if language == "ja":
        def ja(m: re.Match) -> str:
            digits = re.sub(r"[,，]", "", m.group(0))
            return kanji_number(int(digits)) or m.group(0)

        return re.sub(r"[0-9０-９]+(?:[,，][0-9０-９]{3})*", ja, text)
    if language == "es":
        def es(m: re.Match) -> str:
            spelled = spanish_number(int(m.group(0).replace(".", "")))
            return f" {spelled} " if spelled else m.group(0)

        return re.sub(r"\d{1,3}(?:\.\d{3})+(?!\d)|\d+", es, text)
    return text


def units(text: str, language: str) -> list[str]:
    text = _spell_numbers(text, language)
    if language == "ja":
        return segment.moras_of(text)
    return latin.normalize_words(text)


def span_text(words: list[dict], span: tuple[int, int] | None, speed: float,
              full_text: str, language: str) -> str:
    """The part of the line a take was recorded over: the whole line with no
    span, else the words that overlap the span (ms of the render at `speed`,
    as take_score.word_windows reads it). Empty when no word overlaps."""
    if span is None:
        return full_text
    start, end = span
    inside = [
        w["text"] for w in words
        if w["end"] / speed * 1000.0 > start and w["start"] / speed * 1000.0 < end
    ]
    return ("" if language == "ja" else " ").join(inside)


def _base(ch_text: str) -> str:
    d = unicodedata.normalize("NFD", ch_text)
    return "".join(c for c in d if c not in ("゙", "゚"))


def _lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def sub_cost(a: str, b: str, language: str) -> float:
    if a == b:
        return 0.0
    if language == "ja":
        va, vb = vowel(a), vowel(b)
        if (va is not None and va == vb) or _base(a) == _base(b):
            return NEAR_MORA_COST
        return 1.0
    return _lev(a, b) / max(len(a), len(b))


def distance(ref: list[str], heard: list[str], language: str) -> float:
    """Weighted edit distance with a free prefix and suffix on `heard`."""
    row = [0.0] * (len(heard) + 1)
    for r in ref:
        cur = [row[0] + 1.0]
        for j, h in enumerate(heard, 1):
            cur.append(min(row[j] + 1.0, cur[j - 1] + 1.0, row[j - 1] + sub_cost(r, h, language)))
        row = cur
    return min(row)


def content_score(line_text: str, heard_text: str, language: str) -> int | None:
    ref = units(line_text, language)
    if not ref:
        return None
    heard = units(heard_text, language)
    if not heard:
        return 0
    extra = max(0, len(heard) - len(ref) - max(FREE_EXTRA_FLOOR, len(ref)))
    cost = distance(ref, heard, language) + EXTRA_UNIT_COST * extra
    return round(100 * max(0.0, 1 - cost / len(ref)))


def timing_score(score: dict) -> int | None:
    words = [w for w in score.get("words", []) if w != "none"]
    if score.get("note") or not words:
        return None
    credit = {"ok": 1.0, "early": EARLY_LATE_CREDIT, "late": EARLY_LATE_CREDIT}
    return round(100 * sum(credit.get(w, 0.0) for w in words) / len(words))


def pitch_score(analysis: dict) -> int | None:
    marks = [m.get("nucleus") for m in analysis.get("moras", [])]
    marks = [n for n in marks if n in ("hit", "miss")]
    if analysis.get("note") or not marks:
        return None
    return round(100 * marks.count("hit") / len(marks))


def blend(content: int | None, timing: int | None, pitch: int | None) -> int | None:
    if content is None and timing is None:
        return None
    parts = {"content": content, "timing": timing, "pitch": pitch}
    used = {k: v for k, v in parts.items() if v is not None}
    weight = sum(WEIGHTS[k] for k in used)
    return round(sum(WEIGHTS[k] * v for k, v in used.items()) / weight)
