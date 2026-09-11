"""Split a Japanese line into words and give each one a time span.

VOICEVOX tells us when every mora is spoken but not which word it belongs to,
and its accent phrases glue particles onto the word before them. janome (a
pure Python morphological analyser with a built-in dictionary) gives surface
forms with katakana readings, so each token can claim as many moras as its
reading has. Particles stay separate on purpose; auxiliaries (ます, た, ない)
and punctuation are folded into the word before them so a verb reads as one
chunk.

Never raises. When the reading counts do not add up to the timeline (numbers,
names, loanwords), the chunk boundaries are scaled proportionally so they still
cover the line in order; on anything worse the whole line is one chunk.
"""

import logging

log = logging.getLogger(__name__)

_TOKENIZER = None

# Small kana that merge into the preceding mora rather than forming their own.
_SMALL = set("ャュョァィゥェォヮ")
# Parts of speech that never start a chunk of their own.
_ATTACH = ("助動詞", "記号", "補助記号")


def _tokenizer():
    global _TOKENIZER
    if _TOKENIZER is None:
        from janome.tokenizer import Tokenizer

        _TOKENIZER = Tokenizer()
    return _TOKENIZER


def _to_katakana(text: str) -> str:
    return "".join(
        chr(ord(ch) + 0x60) if "ぁ" <= ch <= "ゖ" else ch for ch in text
    )


def mora_count(reading: str) -> int:
    """Moras in a katakana reading, counted the way VOICEVOX splits them."""
    return sum(1 for ch in reading if ch not in _SMALL and ("ァ" <= ch <= "ー"))


def tokenize(text: str) -> list[dict]:
    """[{text, reading, moras}] with auxiliaries and punctuation attached to
    the previous chunk. Particles are their own chunks."""
    chunks: list[dict] = []
    for tok in _tokenizer().tokenize(text):
        pos = tok.part_of_speech.split(",")[0]
        reading = tok.reading if tok.reading != "*" else _to_katakana(tok.surface)
        if pos in _ATTACH or tok.surface in "、。！？":
            reading = "" if pos in ("記号", "補助記号") else reading
            if chunks:
                chunks[-1]["text"] += tok.surface
                chunks[-1]["moras"] += mora_count(reading)
                continue
        chunks.append({"text": tok.surface, "reading": reading, "moras": mora_count(reading)})
    return chunks


def align(text: str, timeline: list[dict]) -> list[dict]:
    """[{text, start, end}] covering the line, in order."""
    if not timeline:
        return []
    whole = [{"text": text, "start": timeline[0]["start"], "end": timeline[-1]["end"]}]
    try:
        chunks = [c for c in tokenize(text) if c["text"]]
        if not chunks:
            return whole
        expected = sum(c["moras"] for c in chunks)
        actual = len(timeline)
        if expected == 0:
            return whole
        scale = actual / expected
        if expected != actual:
            log.warning(
                "segment: %d moras from readings vs %d from VOICEVOX for %r, scaling",
                expected, actual, text,
            )
        words: list[dict] = []
        cursor = 0.0
        for chunk in chunks:
            if chunk["moras"] == 0:
                # A chunk with no reading (stray punctuation) borrows the
                # previous span so it never lands as an empty highlight.
                if words:
                    words[-1]["text"] += chunk["text"]
                continue
            first = min(actual - 1, int(round(cursor)))
            cursor += chunk["moras"] * scale
            last = min(actual - 1, max(first, int(round(cursor)) - 1))
            words.append(
                {"text": chunk["text"], "start": timeline[first]["start"], "end": timeline[last]["end"]}
            )
        if words:
            words[-1]["end"] = timeline[-1]["end"]
        return words or whole
    except Exception:
        log.exception("segment: alignment failed for %r", text)
        return whole
