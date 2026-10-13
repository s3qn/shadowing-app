"""Pure logic that moves whisper's word boundaries onto real pauses.

Whisper holds the word before a pause through the pause and starts the next
word early. The audio energy tells where the pause really is, so a boundary
near a pause is moved to it. The pause belongs to the word before it, which is
how the Japanese highlight already behaves.
"""

import math


def find_pauses(
    samples, sample_rate: int, min_ms: int = 120, floor_db: float = 30
) -> list[tuple[float, float]]:
    """Quiet runs of at least `min_ms`, as (start_s, end_s). Quiet means more
    than `floor_db` below the 95th percentile of 10ms frame levels. Shorter
    gaps (plosive closures, inter-word gaps) are ignored on purpose."""
    import numpy as np

    x = np.asarray(samples, dtype=np.float64)
    frame = max(1, int(sample_rate * 0.01))
    n = len(x) // frame
    if n == 0:
        return []
    frames = x[: n * frame].reshape(n, frame)
    rms = np.sqrt((frames**2).mean(axis=1))
    db = 20.0 * np.log10(np.maximum(rms, 1e-10))
    quiet = db < np.percentile(db, 95) - floor_db
    min_frames = max(1, math.ceil(min_ms / 10))
    out: list[tuple[float, float]] = []
    i = 0
    while i < n:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < n and quiet[j]:
            j += 1
        if j - i >= min_frames:
            out.append((i * frame / sample_rate, j * frame / sample_rate))
        i = j
    return out


def snap_words(words: list[dict], pauses: list[tuple[float, float]], window_s: float = 0.3) -> list[dict]:
    """Move the word boundary nearest each pause end onto the pause. Mutates
    and returns `words`. Never touches the first word's start or the last
    word's end, never moves a start past the next word's own end."""
    used: set[int] = set()
    for ps, pe in pauses:
        best = None
        best_d = window_s
        for i in range(len(words) - 1):
            if i in used:
                continue
            d = abs(words[i + 1]["start"] - pe)
            if d <= best_d:
                best, best_d = i, d
        if best is None:
            continue
        i = best
        nxt, cur = words[i + 1], words[i]
        if pe >= nxt["end"] or pe <= cur["start"]:
            continue
        if i + 2 < len(words) and pe > words[i + 2]["start"]:
            continue
        nxt["start"] = pe
        if ps > cur["start"]:
            cur["end"] = min(cur["end"], ps)
        else:
            cur["end"] = min(cur["end"], pe)
        used.add(i)
    return words
