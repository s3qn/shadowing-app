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
anything unexpected the whole line becomes one chunk. Every word also carries
its furigana segments, dropped where they disagree with what was spoken.
"""

import difflib
import logging
import re
import threading

from voicevox import to_hiragana

log = logging.getLogger(__name__)

_TOKENIZER = None
_LOCK = threading.Lock()

_SMALL = set("ャュョァィゥェォヮ")
# Parts of speech (top level, or second level) that never start a chunk.
_ATTACH_TOP = ("助動詞", "記号", "補助記号")
_ATTACH_SUB = ("接尾", "非自立", "接続助詞")
_PUNCT = set("、。！？!?…「」『』（）()・")
_POS_GROUP = {"名詞": "noun", "動詞": "verb", "形容詞": "adjective", "形状詞": "adjective"}


def _pos_group(top: str, is_particle: bool) -> str:
    return _POS_GROUP.get(top, "particle" if is_particle else "other")

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
            chunks.append({"text": pending + tok.surface, "moras": [], "unknown": True, "pos": _pos_group(top, is_particle)})
            pending = ""
            continue
        if is_punct and not chunks:
            pending += tok.surface
            continue
        chunks.append({"text": pending + tok.surface, "moras": moras, "unknown": False, "pos": _pos_group(top, is_particle)})
        pending = ""
    if pending and chunks:
        chunks[-1]["text"] += pending
    return chunks


_KANJI = re.compile(r"[一-鿿㐀-䶿々〆ヶ]+")


def _split_ruby(surface: str, reading: str) -> list[dict]:
    """[{text, rt}] for one token: each kanji run with its own reading, kana
    runs with rt "". The reading is matched against the surface with the
    okurigana as literals, so 行きます gives い over 行 and nothing over きます.
    When that match fails the whole token carries the whole reading."""
    if not reading or not _KANJI.search(surface):
        return [{"text": surface, "rt": ""}]
    parts: list[tuple[str, bool]] = []
    pattern = "^"
    pos = 0
    for m in _KANJI.finditer(surface):
        if m.start() > pos:
            plain = surface[pos:m.start()]
            parts.append((plain, False))
            pattern += re.escape(to_hiragana(plain))
        parts.append((m.group(), True))
        pattern += "(.+?)"
        pos = m.end()
    if pos < len(surface):
        plain = surface[pos:]
        parts.append((plain, False))
        pattern += re.escape(to_hiragana(plain))
    matched = re.match(pattern + "$", to_hiragana(reading))
    if not matched:
        return [{"text": surface, "rt": to_hiragana(reading)}]
    groups = iter(matched.groups())
    return [{"text": text, "rt": next(groups) if kanji else ""} for text, kanji in parts]


def ruby(text: str) -> list[dict]:
    """Furigana segments for one word as shown in the line: [{text, rt}],
    concatenating back to `text`. Kanji runs carry their hiragana reading in
    rt, everything else has rt "". Never raises: on anything unexpected the
    whole word is one plain segment."""
    try:
        out: list[dict] = []
        for tok in _tokenizer().tokenize(text):
            reading = "" if tok.reading == "*" else tok.reading
            for seg in _split_ruby(tok.surface, reading):
                if out and not seg["rt"] and not out[-1]["rt"]:
                    out[-1]["text"] += seg["text"]
                else:
                    out.append(seg)
        return out or [{"text": text, "rt": ""}]
    except Exception:
        log.exception("segment: ruby failed for %r", text)
        return [{"text": text, "rt": ""}]


_KANA = re.compile(r"[ァ-ヴぁ-ゖー]")
_SAME_SOUND = str.maketrans({"ハ": "ワ", "ヘ": "エ"})
_ANY_MORAS = r"(?:[^|]+\|)+"


def ruby_matches(segs: list[dict], spoken: list[str]) -> bool:
    """True when a word's ruby reads the way VOICEVOX spoke it. janome reads
    a word on its own, so 3月 gets つき over 月 while the line says がつ.
    Kanji runs contribute their rt, kana contributes itself, and anything with
    no reading (digits, Latin letters) matches one or more moras, so 10時
    still keeps じ over 時. Punctuation is ignored. Particle は and へ compare
    equal to ワ and エ on both sides."""
    items: list[str | None] = []  # a mora, or None for "some moras"
    run: list[str] = []

    def flush() -> None:
        items.extend(_normalise(run))
        run.clear()

    for seg in segs:
        if seg["rt"]:
            run.extend(split_moras(_to_katakana(seg["rt"])))
            continue
        for ch in seg["text"]:
            if _KANA.match(ch):
                run.extend(split_moras(_to_katakana(ch)))
            elif ch.strip() and ch not in _PUNCT:
                flush()
                if not items or items[-1] is not None:
                    items.append(None)
    flush()
    pattern = r"\|"
    for item in items:
        pattern += _ANY_MORAS if item is None else re.escape(item.translate(_SAME_SOUND)) + r"\|"
    said = "|" + "|".join(m.translate(_SAME_SOUND) for m in _normalise(spoken)) + "|"
    return re.fullmatch(pattern, said) is not None


def checked_ruby(text: str, spoken: list[str]) -> list[dict]:
    """ruby(text), or one plain segment when its readings disagree with the
    moras the word was spoken with. No moras means nothing to check against."""
    segs = ruby(text)
    if spoken and any(s["rt"] for s in segs) and not ruby_matches(segs, spoken):
        return [{"text": text, "rt": ""}]
    return segs


def ensure_ruby(words: list[dict], timeline: list[dict] | None = None) -> bool:
    """Add ruby to words stored before furigana existed, checked against the
    moras inside each word's time span when a timeline is given. Returns True
    when anything was added, so the caller knows to persist."""
    changed = False
    for w in words:
        if "ruby" not in w:
            spoken = [
                m["text"] for m in timeline or []
                if m["start"] >= w["start"] - 1e-6 and m["end"] <= w["end"] + 1e-6
            ]
            w["ruby"] = checked_ruby(w["text"], spoken)
            changed = True
    return changed


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
    whole = [{"text": text, "start": 0.0, "end": timeline[-1]["end"], "ruby": ruby(text)}]
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
            words.append({"text": chunk["text"], "_first": first, "_last": last, "pos": chunk["pos"]})
        if not words:
            return whole
        # Close the gaps so spans are contiguous, then stretch to the edges.
        for a, b in zip(words, words[1:]):
            a["_last"] = b["_first"] - 1
        words[0]["_first"] = 0
        words[-1]["_last"] = total - 1
        out = [
            {
                "text": w["text"],
                "start": timeline[w["_first"]]["start"],
                "end": timeline[w["_last"]]["end"],
                "ruby": checked_ruby(
                    w["text"], [m["text"] for m in timeline[w["_first"]:w["_last"] + 1]]
                ),
                "pos": w["pos"],
            }
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


def reading(text: str) -> str:
    """Hiragana reading of a line from janome, for the reading line under
    imported text (which has no VOICEVOX mora timeline to read moras off of)."""
    out = []
    for tok in _tokenizer().tokenize(text):
        r = tok.reading
        out.append(tok.surface if r == "*" else to_hiragana(r))
    return "".join(out)


def align_pieces(text: str, pieces: list[dict], duration: float) -> list[dict]:
    """Second input path into word highlighting, alongside align().

    align() anchors a line against VOICEVOX's own mora timeline. This anchors
    it against pieces instead: timed fragments of the line (whisper words,
    seconds relative to the line's own slice of audio), possibly none at all.
    A chunk whose characters match a piece (by difflib, so a kanji the source
    text uses and a piece spelled in kana can still anchor on the characters
    they share) is anchored to that piece's time; the rest are spread
    proportionally to mora count between whatever anchors exist. With no
    usable pieces every chunk is spread, which is the same constant mora-rate
    result as when nothing anchors at all: that is the fallback, and only the
    fallback. Same output shape and guarantees as align(): contiguous
    [{text, start, end, pos, ruby}], first start 0, last end = duration,
    whole line as one chunk on any failure. `ruby` here is not checked
    against a mora timeline (there is none), unlike align()'s `checked_ruby`.
    """
    if duration <= 0:
        return []
    whole = [{"text": text, "start": 0.0, "end": duration, "pos": "other", "ruby": ruby(text)}]
    try:
        chunks = [c for c in tokenize(text) if c["text"]]
        if not chunks or "".join(c["text"] for c in chunks) != text:
            return whole

        weights = []
        for c in chunks:
            w = len(c["moras"])
            if w == 0:
                w = sum(1 for ch in c["text"] if ch not in _PUNCT and not ch.isspace())
            weights.append(w or 1)

        # Character ranges per chunk: text characters that are punctuation or
        # whitespace never take part in matching.
        text_chars: list[str] = []
        char_chunk: list[int] = []
        for i, c in enumerate(chunks):
            for ch in c["text"]:
                if ch in _PUNCT or ch.isspace():
                    continue
                text_chars.append(ch)
                char_chunk.append(i)

        # Piece characters: each piece's text, punctuation and whitespace
        # dropped, spread linearly across the piece's clamped time span.
        piece_chars: list[str] = []
        piece_times: list[tuple[float, float]] = []
        for p in pieces:
            ps = max(0.0, min(duration, p["start"]))
            pe = max(0.0, min(duration, p["end"]))
            if pe <= ps:
                continue
            filtered = [ch for ch in p["text"] if ch not in _PUNCT and not ch.isspace()]
            n = len(filtered)
            if n == 0:
                continue
            span = pe - ps
            for k, ch in enumerate(filtered):
                piece_chars.append(ch)
                piece_times.append((ps + span * k / n, ps + span * (k + 1) / n))

        starts: list[float | None] = [None] * len(chunks)
        ends: list[float | None] = [None] * len(chunks)
        if text_chars and piece_chars:
            matcher = difflib.SequenceMatcher(None, text_chars, piece_chars, autojunk=False)
            for a, b, size in matcher.get_matching_blocks():
                for k in range(size):
                    i = char_chunk[a + k]
                    s, e = piece_times[b + k]
                    starts[i] = s if starts[i] is None else min(starts[i], s)
                    ends[i] = e if ends[i] is None else max(ends[i], e)

        spans: list[list[float] | None] = [
            None if starts[i] is None else [starts[i], ends[i]] for i in range(len(chunks))
        ]

        # Fill each run of unanchored chunks proportionally to weight,
        # between whichever anchors (or the line's own edges) bound it.
        i = 0
        n = len(chunks)
        while i < n:
            if spans[i] is not None:
                i += 1
                continue
            j = i
            while j < n and spans[j] is None:
                j += 1
            lo = spans[i - 1][1] if i > 0 else 0.0
            hi = spans[j][0] if j < n else duration
            run_weight = sum(weights[i:j])
            t = lo
            for k in range(i, j):
                share = (hi - lo) * (weights[k] / run_weight) if run_weight else 0.0
                spans[k] = [t, t + share]
                t += share
            i = j

        # Make monotonic, then contiguous, then pin the edges.
        prev_end = 0.0
        for span in spans:
            span[0] = max(span[0], prev_end)
            span[1] = max(span[1], span[0])
            prev_end = span[1]
        for a, b in zip(spans, spans[1:]):
            a[1] = b[0]
        spans[0][0] = 0.0
        spans[-1][1] = duration

        return [
            {
                "text": c["text"],
                "start": round(s, 3),
                "end": round(e, 3),
                "pos": c["pos"],
                "ruby": ruby(c["text"]),
            }
            for c, (s, e) in zip(chunks, spans)
        ]
    except Exception:
        log.exception("segment: align_pieces failed for %r", text)
        return whole
