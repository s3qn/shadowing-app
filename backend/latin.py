"""Word timing for space-separated languages (es, en), the counterpart to
segment.py's mora-based alignment for ja.

Kokoro (and any imported es/en source) gives no per-word timing of its own,
so every es/en line is re-transcribed with whisper's word_timestamps and the
words mapped onto the line's own text here.
"""

import difflib
import logging
import unicodedata

log = logging.getLogger(__name__)


def split_words(text: str) -> list[str]:
    """Split on whitespace; punctuation stays attached to its word, same as
    whisper's own word boundaries."""
    return text.split()


def _normalize(word: str) -> str:
    """Case-folded, accent-stripped, punctuation-stripped form used only to
    match a token against a whisper piece: `está` and `esta` compare equal."""
    decomposed = unicodedata.normalize("NFKD", word)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return "".join(ch for ch in stripped if ch.isalnum()).casefold()


def align(text: str, pieces: list[dict], duration: float) -> list[dict]:
    """Second input path into word highlighting for es/en, alongside
    segment.align_pieces for ja.

    `pieces` are whisper's word_timestamps, seconds relative to the line's
    own slice of audio, possibly none at all: `[{"text", "start", "end"}]`.
    Tokens are matched to pieces by difflib.SequenceMatcher on normalized
    text (case-folded, accents stripped, punctuation removed); a run of
    unanchored tokens is spread by character count between whatever anchors
    (or the line's own edges) bound it. With no usable pieces every token is
    unanchored, which is the same steady-pace spread as the fallback below,
    not a separate case. Same output shape and guarantees as segment.align:
    contiguous [{text, start, end, pos: "other", ruby: [{text, rt: ""}]}],
    first start 0, last end = duration, whole line as one word on failure.
    """
    if duration <= 0:
        return []
    tokens = split_words(text)
    whole = [
        {"text": text, "start": 0.0, "end": duration, "pos": "other",
         "ruby": [{"text": text, "rt": ""}]}
    ]
    if not tokens:
        return whole
    try:
        norm_tokens = [_normalize(t) for t in tokens]
        norm_pieces = [_normalize(p.get("text", "")) for p in pieces]

        starts: list[float | None] = [None] * len(tokens)
        ends: list[float | None] = [None] * len(tokens)
        if any(norm_tokens) and any(norm_pieces):
            matcher = difflib.SequenceMatcher(None, norm_tokens, norm_pieces, autojunk=False)
            for a, b, size in matcher.get_matching_blocks():
                for k in range(size):
                    if not norm_tokens[a + k]:
                        continue
                    piece = pieces[b + k]
                    s = max(0.0, min(duration, piece["start"]))
                    e = max(0.0, min(duration, piece["end"]))
                    if e <= s:
                        continue
                    i = a + k
                    starts[i] = s if starts[i] is None else min(starts[i], s)
                    ends[i] = e if ends[i] is None else max(ends[i], e)

        spans: list[list[float] | None] = [
            None if starts[i] is None else [starts[i], ends[i]] for i in range(len(tokens))
        ]
        weights = [len(t) or 1 for t in tokens]

        # Fill each run of unanchored tokens proportionally to character
        # count, between whichever anchors (or the line's edges) bound it.
        i = 0
        n = len(tokens)
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
                "text": tok,
                "start": round(s, 3),
                "end": round(e, 3),
                "pos": "other",
                "ruby": [{"text": tok, "rt": ""}],
            }
            for tok, (s, e) in zip(tokens, spans)
        ]
    except Exception:
        log.exception("latin: align failed for %r", text)
        return whole
