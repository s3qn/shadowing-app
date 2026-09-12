"""Split a Japanese line into words and give each one a time span.

VOICEVOX tells us when every mora is spoken but not which word it belongs to,
and its accent phrases glue particles onto the word before them. janome (a
pure Python morphological analyser with a built-in dictionary) gives surface
forms with katakana readings. Each word's reading is split into moras and
anchored against the mora texts VOICEVOX actually spoke, so a word owns exactly
the moras it was heard in. Particles stay separate on purpose; auxiliaries,
suffixes such as counters, non-independent verbs and punctuation fold into the
word before them so 飲んでいます and 十時 read as one chunk each.

Tokens VOICEVOX pronounces differently from the dictionary (digits, Latin
letters, names) are resynchronised on the next word that matches, and the
unmatched moras are given to the token that caused the gap. Never raises: on
anything unexpected the whole line becomes one chunk.
"""

import logging
import threading

log = logging.getLogger(__name__)

_TOKENIZER = None
_LOCK = threading.Lock()

_SMALL = set("ャュョァィゥェォヮ")
# Parts of speech (top level, or second level) that never start a chunk.
_ATTACH_TOP = ("助動詞", "記号", "補助記号")
_ATTACH_SUB = ("接尾", "非自立", "接続助詞")
_PUNCT = set("、。！？!?…「」『』（）()・")

# Vowel of each katakana mora, used to normalise long vowels: janome writes
# セイ and トウ, VOICEVOX speaks セエ and トオ, and ー becomes the vowel before it.
_ROWS = {
    "ア": "アカサタナハマヤラワガザダバパァャヮ",
    "イ": "イキシチニヒミリギジヂビピィ",
    "ウ": "ウクスツヌフムユルグズヅブプゥュヴ",
    "エ": "エケセテネヘメレゲゼデベペェ",
    "オ": "オコソトノホモヨロヲゴゾドボポォョ",
}
_VOWEL = {ch: v for v, chars in _ROWS.items() for ch in chars}


def _tokenizer():
    global _TOKENIZER
    with _LOCK:
        if _TOKENIZER is None:
            from janome.tokenizer import Tokenizer

            _TOKENIZER = Tokenizer()
    return _TOKENIZER


def _to_katakana(text: str) -> str:
    return "".join(chr(ord(ch) + 0x60) if "ぁ" <= ch <= "ゖ" else ch for ch in text)


def split_moras(reading: str) -> list[str]:
    """Katakana reading → moras the way VOICEVOX splits them (キョ|オ|ワ)."""
    moras: list[str] = []
    for ch in reading:
        if not ("ァ" <= ch <= "ヴ" or ch == "ー"):
            continue
        if ch in _SMALL and moras:
            moras[-1] += ch
        else:
            moras.append(ch)
    return moras


def mora_count(reading: str) -> int:
    return len(split_moras(reading))


def _normalise(moras: list[str], particle: bool = False) -> list[str]:
    """Canonical form for comparing dictionary moras with spoken ones."""
    out: list[str] = []
    prev_vowel = ""
    for m in moras:
        base = m[-1] if m[-1] in _SMALL else m[0]
        vowel = _VOWEL.get(base, "")
        if m == "ー":
            m = prev_vowel or m
        elif m == "イ" and prev_vowel == "エ":
            m = "エ"
        elif m == "ウ" and prev_vowel == "オ":
            m = "オ"
        elif m == "ヲ":
            m = "オ"
        elif particle and m == "ハ":
            m = "ワ"
        elif particle and m == "ヘ":
            m = "エ"
        prev_vowel = _VOWEL.get(m[-1] if m[-1] in _SMALL else m[0], vowel)
        out.append(m)
    return out


def tokenize(text: str) -> list[dict]:
    """[{text, moras (normalised list, may be empty)}] in reading order."""
    chunks: list[dict] = []
    pending = ""  # text with no reading that has not found a home yet
    for tok in _tokenizer().tokenize(text):
        pos = tok.part_of_speech.split(",")
        top, sub = pos[0], (pos[1] if len(pos) > 1 else "")
        # Particles read は as ワ and へ as エ; so do greetings like こんにちは.
        is_particle = top in ("助詞", "感動詞")
        is_punct = top in ("記号", "補助記号") or tok.surface.strip() in _PUNCT
        reading = "" if is_punct else (tok.reading if tok.reading != "*" else _to_katakana(tok.surface))
        moras = _normalise(split_moras(reading), particle=is_particle)
        attach = is_punct or top in _ATTACH_TOP or sub in _ATTACH_SUB
        if attach and chunks:
            chunks[-1]["text"] += tok.surface
            chunks[-1]["moras"] += moras
            continue
        if not moras and not is_punct:
            # Digits, Latin letters, unknown names: VOICEVOX will say something
            # here, we just do not know how many moras. Keep the text and let
            # the alignment hand it the gap before the next matched word.
            chunks.append({"text": pending + tok.surface, "moras": [], "unknown": True})
            pending = ""
            continue
        if is_punct and not chunks:
            pending += tok.surface
            continue
        chunks.append({"text": pending + tok.surface, "moras": moras, "unknown": False})
        pending = ""
    if pending and chunks:
        chunks[-1]["text"] += pending
    return chunks


def _find(spoken: list[str], pattern: list[str], start: int, window: int = 8) -> int:
    """First index >= start (within a window) where pattern occurs, else -1."""
    n = len(pattern)
    for i in range(start, min(len(spoken) - n, start + window) + 1):
        if spoken[i:i + n] == pattern:
            return i
    return -1


def align(text: str, timeline: list[dict]) -> list[dict]:
    """[{text, start, end}] covering the line, in order. The first word starts
    at 0 so the highlight is on from the moment playback begins."""
    if not timeline:
        return []
    whole = [{"text": text, "start": 0.0, "end": timeline[-1]["end"]}]
    try:
        chunks = [c for c in tokenize(text) if c["text"]]
        if not chunks:
            return whole
        spoken = _normalise([m["text"] for m in timeline])
        total = len(spoken)
        # Each chunk gets [first, last] mora indexes, filled in two passes:
        # anchor every matchable chunk, then give gaps to whatever sits between.
        spans: list[list[int] | None] = [None] * len(chunks)
        cursor = 0
        for i, chunk in enumerate(chunks):
            if not chunk["moras"]:
                continue
            at = _find(spoken, chunk["moras"], cursor)
            if at < 0:
                chunk["unknown"] = True
                continue
            spans[i] = [at, at + len(chunk["moras"]) - 1]
            cursor = at + len(chunk["moras"])
        if all(s is None for s in spans):
            return whole
        # Fill: an unmatched chunk takes the moras between its neighbours.
        prev_end = -1
        for i, span in enumerate(spans):
            if span is not None:
                prev_end = span[1]
                continue
            nxt = next((s[0] for s in spans[i + 1:] if s is not None), total)
            if nxt - 1 >= prev_end + 1:
                spans[i] = [prev_end + 1, nxt - 1]
                prev_end = nxt - 1
        # Anything still unassigned (no room) merges into the previous word.
        words: list[dict] = []
        for chunk, span in zip(chunks, spans):
            if span is None:
                if words:
                    words[-1]["text"] += chunk["text"]
                continue
            first, last = max(0, span[0]), min(total - 1, span[1])
            if words and first <= words[-1]["_last"]:
                first = words[-1]["_last"] + 1
                if first > last:
                    words[-1]["text"] += chunk["text"]
                    continue
            words.append({"text": chunk["text"], "_first": first, "_last": last})
        if not words:
            return whole
        # Close the gaps so spans are contiguous, then stretch to the edges.
        for a, b in zip(words, words[1:]):
            a["_last"] = b["_first"] - 1
        words[0]["_first"] = 0
        words[-1]["_last"] = total - 1
        out = [
            {"text": w["text"], "start": timeline[w["_first"]]["start"], "end": timeline[w["_last"]]["end"]}
            for w in words
        ]
        out[0]["start"] = 0.0
        if "".join(w["text"] for w in out) != text:
            log.warning("segment: text drift for %r -> %r", text, [w["text"] for w in out])
        return out
    except Exception:
        log.exception("segment: alignment failed for %r", text)
        return whole


def is_fallback(text: str, words: list[dict]) -> bool:
    """True when align gave up and returned the whole line as one chunk."""
    return len(words) == 1 and words[0]["text"] == text and len(tokenize(text)) > 1
