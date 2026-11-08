"""Word timing for every language but Japanese (whose mora path lives in
segment.py): whitespace words for es, en, fr, pt, ko, de, he and ar, jieba
words for zh.

Kokoro (and any imported source) gives no per-word timing of its own, so a
line is timed from its phoneme durations when the export has them, else
re-transcribed with whisper's word_timestamps and the words mapped onto the
line's own text here.
"""

import difflib
import logging

import lang_text

log = logging.getLogger(__name__)

# Whisper sometimes returns zero-length pieces for words it could not time. A
# piece shorter than this is an artefact, not a time, and does not anchor.
MIN_PIECE_S = 0.04
# A real word has far more than this per letter. A run of unanchored tokens
# squeezed below it means the anchors around it swallowed its time.
MIN_CHAR_S = 0.03
# A CJK word is one or two characters and is lit for at least this long.
MIN_CJK_WORD_S = 0.1


def split_words(text: str) -> list[str]:
    """Split on whitespace; punctuation stays attached to its word, same as
    whisper's own word boundaries."""
    return text.split()


def _normalize(word: str, code: str = "en") -> str:
    """Case-folded, accent-stripped, punctuation-stripped form used only to
    match a token against a whisper piece: `está` and `esta` compare equal,
    and the script's own variants (final letters, hamza seats) fold too."""
    return lang_text.fold(word, code).replace(" ", "")


def normalize_words(text: str, code: str = "en") -> list[str]:
    """Normalised words of a line: whitespace split, accents and punctuation
    stripped, case folded, empties dropped."""
    return [w for w in (_normalize(t, code) for t in text.split()) if w]


def _anchor_chars(norm_tokens: list[str], pieces: list[dict], norm_pieces: list[str],
                  duration: float, starts: list, ends: list) -> None:
    """Character matching for a script with no spaces: whisper's pieces cut
    Chinese wherever they like, so a piece's time is shared evenly by its
    characters and a token owns the span from its first to its last matched
    character (align.split_pieces hands captions out the same way)."""
    tok_chars: list[str] = []
    tok_of: list[int] = []
    for i, tok in enumerate(norm_tokens):
        for ch in tok:
            tok_chars.append(ch)
            tok_of.append(i)
    piece_chars: list[str] = []
    piece_of: list[int] = []
    piece_pos: list[int] = []
    for p, piece in enumerate(norm_pieces):
        for j, ch in enumerate(piece):
            piece_chars.append(ch)
            piece_of.append(p)
            piece_pos.append(j)
    if not tok_chars or not piece_chars:
        return
    matcher = difflib.SequenceMatcher(None, "".join(tok_chars), "".join(piece_chars), autojunk=False)
    for a, b, size in matcher.get_matching_blocks():
        for k in range(size):
            p = piece_of[b + k]
            piece = pieces[p]
            s = max(0.0, min(duration, piece["start"]))
            e = max(0.0, min(duration, piece["end"]))
            if e - s < MIN_PIECE_S:
                continue
            n = len(norm_pieces[p])
            cs = s + (e - s) * piece_pos[b + k] / n
            ce = s + (e - s) * (piece_pos[b + k] + 1) / n
            i = tok_of[a + k]
            starts[i] = cs if starts[i] is None else min(starts[i], cs)
            ends[i] = ce if ends[i] is None else max(ends[i], ce)


def fill_spans(spans: list, weights: list[float], duration: float) -> list[list[float]]:
    """Completes partly anchored [start, end] spans in place. Each run of None
    is filled proportionally to `weights`, between whichever anchors (or 0 and
    `duration`) bound it; then the spans are made monotonic and contiguous and
    pinned to 0 and `duration`. Shared by latin.align and segment.align_pieces."""
    i = 0
    n = len(spans)
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

    prev_end = 0.0
    for span in spans:
        span[0] = max(span[0], prev_end)
        span[1] = max(span[1], span[0])
        prev_end = span[1]
    for a, b in zip(spans, spans[1:]):
        a[1] = b[0]
    spans[0][0] = 0.0
    spans[-1][1] = duration
    return spans


def _widen_cjk(words: list[dict]) -> list[dict]:
    """Give every word of a CJK line at least MIN_CJK_WORD_S by taking time
    from its neighbours: the boundaries between contiguous words are pushed
    apart forward, then back, so the line's first start and last end stay
    put. Left alone when the line is too short for every word to get it."""
    n = len(words)
    if n < 2:
        return words
    b = [w["start"] for w in words] + [words[-1]["end"]]
    m = MIN_CJK_WORD_S
    if b[-1] - b[0] < n * m or all(b[i + 1] - b[i] >= m for i in range(n)):
        return words
    for i in range(n):
        if b[i + 1] - b[i] < m:
            b[i + 1] = b[i] + m
    if b[-1] > words[-1]["end"]:
        b[-1] = words[-1]["end"]
        for i in range(n - 1, 0, -1):
            if b[i + 1] - b[i] < m:
                b[i] = b[i + 1] - m
    for i, w in enumerate(words):
        w["start"] = round(b[i], 3)
        w["end"] = round(b[i + 1], 3)
    return words


def align(text: str, pieces: list[dict], duration: float, code: str = "en") -> list[dict]:
    """Second input path into word highlighting for every non-Japanese
    language, alongside segment.align_pieces for ja.

    `pieces` are whisper's word_timestamps, seconds relative to the line's
    own slice of audio, possibly none at all: `[{"text", "start", "end"}]`.
    Tokens (`lang_text.tokens` for `code`) are matched to pieces by
    difflib.SequenceMatcher on folded text (case-folded, accents stripped,
    punctuation removed), whole words for a spaced script and characters
    for a CJK one; a run of unanchored tokens is spread by character count
    between whatever anchors (or the line's own edges) bound it. With no
    usable pieces every token is unanchored, which is the same steady-pace
    spread as the fallback below, not a separate case. Same output shape
    and guarantees as segment.align: contiguous [{text, start, end, pos:
    "other", ruby: [{text, rt: ""}]}], first start 0, last end = duration,
    whole line as one word on failure.
    """
    if duration <= 0:
        return []
    tokens = lang_text.tokens(text, code)
    whole = [
        {"text": text, "start": 0.0, "end": duration, "pos": "other",
         "ruby": [{"text": text, "rt": ""}]}
    ]
    if not tokens:
        return whole
    try:
        norm_tokens = [_normalize(t, code) for t in tokens]
        norm_pieces = [_normalize(p.get("text", ""), code) for p in pieces]

        starts: list[float | None] = [None] * len(tokens)
        ends: list[float | None] = [None] * len(tokens)
        if lang_text.is_cjk(code):
            _anchor_chars(norm_tokens, pieces, norm_pieces, duration, starts, ends)
        elif any(norm_tokens) and any(norm_pieces):
            matcher = difflib.SequenceMatcher(None, norm_tokens, norm_pieces, autojunk=False)
            for a, b, size in matcher.get_matching_blocks():
                for k in range(size):
                    if not norm_tokens[a + k]:
                        continue
                    piece = pieces[b + k]
                    s = max(0.0, min(duration, piece["start"]))
                    e = max(0.0, min(duration, piece["end"]))
                    if e - s < MIN_PIECE_S:
                        continue
                    i = a + k
                    starts[i] = s if starts[i] is None else min(starts[i], s)
                    ends[i] = e if ends[i] is None else max(ends[i], e)

        spans: list[list[float] | None] = [
            None if starts[i] is None else [starts[i], ends[i]] for i in range(len(tokens))
        ]
        weights = [len(t) or 1 for t in tokens]

        # A run squeezed into a sliver means its bounding anchors are wrong:
        # drop them and look again, until no run is squeezed.
        for _ in range(len(tokens)):
            changed = False
            i = 0
            while i < len(tokens):
                if spans[i] is not None:
                    i += 1
                    continue
                j = i
                while j < len(tokens) and spans[j] is None:
                    j += 1
                lo = spans[i - 1][1] if i > 0 else 0.0
                hi = spans[j][0] if j < len(tokens) else duration
                if hi - lo < MIN_CHAR_S * sum(weights[i:j]):
                    if i > 0:
                        spans[i - 1] = None
                        changed = True
                    if j < len(tokens):
                        spans[j] = None
                        changed = True
                    if changed:
                        break
                i = j
            if not changed:
                break

        fill_spans(spans, weights, duration)

        out = [
            {
                "text": tok,
                "start": round(s, 3),
                "end": round(e, 3),
                "pos": "other",
                "ruby": [{"text": tok, "rt": ""}],
            }
            for tok, (s, e) in zip(tokens, spans)
        ]
        return _widen_cjk(out) if lang_text.is_cjk(code) else out
    except Exception:
        log.exception("latin: align failed for %r", text)
        return whole


def align_phonemes(text: str, timings: list[dict], duration: float, code: str = "en") -> list[dict]:
    """Word timing from Kokoro's own phoneme durations. `timings` is
    [{"phoneme", "start", "end"}] with " " phonemes between words, in absolute
    seconds of the audio. Times are never scaled: the leading pad stays
    before the first word and the silent tail after the last. Each word
    starts where its phoneme group starts; the gap after a word belongs to
    that word (it ends where the next starts) and the last word ends at its
    own last phoneme. A CJK line has no spaces, so its groups may come one
    per character instead; they are folded into the jieba words. Same shape
    as `align`. Returns [] (caller falls back to whisper) when there are no
    timings, the group count matches neither the words nor the characters,
    or anything goes wrong."""
    try:
        tokens = lang_text.tokens(text, code)
        if duration <= 0 or not tokens or not timings:
            return []
        groups: list[list[dict]] = []
        run: list[dict] = []
        for t in timings:
            if t["phoneme"] == " ":
                if run:
                    groups.append(run)
                    run = []
            else:
                run.append(t)
        if run:
            groups.append(run)
        owner = list(range(len(tokens)))
        if len(groups) != len(tokens) and lang_text.is_cjk(code):
            chars = [i for i, tok in enumerate(tokens) for _ in lang_text.fold(tok, code).replace(" ", "")]
            if len(groups) == len(chars):
                owner = chars
        if len(groups) != len(owner):
            log.warning(
                "phoneme groups (%d) do not match words (%d) for %r",
                len(groups), len(tokens), text,
            )
            return []
        starts = [min(duration, max(0.0, g[0]["start"])) for g in groups]
        for i in range(1, len(starts)):
            starts[i] = max(starts[i], starts[i - 1])
        tok_start: dict[int, float] = {}
        tok_end: dict[int, float] = {}
        for g, i in enumerate(owner):
            if g + 1 < len(groups):
                end = starts[g + 1]
            else:
                end = min(duration, max(0.0, groups[g][-1]["end"]))
            tok_start.setdefault(i, starts[g])
            tok_end[i] = max(end, tok_start[i])
        out = [
            {
                "text": token,
                "start": round(tok_start[i], 3),
                "end": round(tok_end[i], 3),
                "pos": "other",
                "ruby": [{"text": token, "rt": ""}],
            }
            for i, token in enumerate(tokens)
        ]
        return _widen_cjk(out) if lang_text.is_cjk(code) else out
    except Exception:
        log.exception("align_phonemes failed for %r", text)
        return []
