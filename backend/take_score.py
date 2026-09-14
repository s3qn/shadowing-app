"""Score a shadow take: which words ran early, late or dropped out.

Both the reference render and the take are already 24 kHz float (see
aec.decode). This module turns each into a normalised log-energy envelope
and runs subsequence DTW of the reference against the take to find where
every word landed in time. Numpy only, no aec import, no file IO, so it is
cheap to test with synthetic signals.

The anchor is where line time 0 sits in the take (in take-milliseconds),
found by the caller from the echo delay or a phone-side clock reading. The
take envelope is sliced from 500 ms before the anchor, both to give the
path some room to start early and to keep the DTW matrix small; that slice
offset is carried through the offset arithmetic so `offsetsMs` are true
take-relative milliseconds.

Marks are relative to the take's own median word offset, not to the Lag
setting: a take spoken a steady beat behind is one fact (`behindMs`), not a
wall of "late" words. See the take-score plan for the full design.
"""

from __future__ import annotations

import numpy as np

HOP_MS = 10
WIN_MS = 20
TOLERANCE_MS = 250
VOICED = 0.2
DROPPED_FRACTION = 0.3
MIN_WORD_MS = 80

# Below this fraction of mapped take frames voiced, there is nothing to
# align: the take is silence or noise, not speech.
_VOICE_FLOOR = 0.15
# At or above this fraction of scored words dropped, the alignment itself is
# not trustworthy rather than the take being badly timed.
_LOST_FRACTION = 0.7
_ANCHOR_LEAD_MS = 500.0


def envelope(x: np.ndarray, sr: int) -> np.ndarray:
    """Normalised frame envelope: WIN_MS window, HOP_MS hop, log-energy per
    frame mapped so the signal's own 10th percentile sits at 0 and its 95th
    at 1, clipped to [0, 1]. The denominator is floored at 20 dB so a take
    that is all silence (floor and peak nearly equal) stays near 0 rather
    than being stretched to fill the range."""
    win = max(1, int(round(sr * WIN_MS / 1000)))
    hop = max(1, int(round(sr * HOP_MS / 1000)))
    x = np.asarray(x, dtype=np.float64)
    if len(x) < win:
        x = np.pad(x, (0, win - len(x)))
    n_frames = 1 + (len(x) - win) // hop
    frames = np.empty(n_frames, dtype=np.float64)
    for i in range(n_frames):
        seg = x[i * hop:i * hop + win]
        power = float(np.mean(seg * seg))
        frames[i] = 10.0 * np.log10(max(power, 1e-12))
    floor = float(np.percentile(frames, 10))
    peak = float(np.percentile(frames, 95))
    denom = max(peak - floor, 20.0)
    return np.clip((frames - floor) / denom, 0.0, 1.0)


def dtw_path(ref: np.ndarray, take: np.ndarray) -> list[tuple[int, int]]:
    """Subsequence DTW of `ref` against `take`: the path covers every frame
    of `ref` (index 0 to len(ref) - 1) but is free to start and end anywhere
    on the take axis, with steps (1, 1), (1, 0), (0, 1) and cost
    |ref[i] - take[j]|. A plain double loop over the cost matrix; budget is
    under 1 s for a 400 x 800 frame matrix (a 4 s reference against an 8 s
    take slice at the 10 ms hop)."""
    n, m = len(ref), len(take)
    if n == 0 or m == 0:
        return []
    cost = np.abs(ref[:, None] - take[None, :])
    dist = np.empty((n, m), dtype=np.float64)
    # 0 = came from (i-1, j-1), 1 = from (i-1, j), 2 = from (i, j-1).
    back = np.zeros((n, m), dtype=np.int8)
    dist[0, :] = cost[0, :]
    for i in range(1, n):
        dist[i, 0] = dist[i - 1, 0] + cost[i, 0]
        back[i, 0] = 1
        row_prev = dist[i - 1]
        row = dist[i]
        back_row = back[i]
        cost_row = cost[i]
        for j in range(1, m):
            diag, up, left = row_prev[j - 1], row_prev[j], row[j - 1]
            best, move = diag, 0
            if up < best:
                best, move = up, 1
            if left < best:
                best, move = left, 2
            row[j] = cost_row[j] + best
            back_row[j] = move
    j1 = int(np.argmin(dist[n - 1, :]))
    path: list[tuple[int, int]] = []
    i, j = n - 1, j1
    while True:
        path.append((i, j))
        if i == 0:
            break
        move = back[i, j]
        if move == 0:
            i, j = i - 1, j - 1
        elif move == 1:
            i, j = i - 1, j
        else:
            i, j = i, j - 1
    path.reverse()
    return path


def word_windows(
    words: list[dict], speed: float, span: tuple[int, int] | None
) -> list[tuple[float, float] | None]:
    """Milliseconds of the reference render, one window per word: `None`
    for a word entirely outside `span`, clipped to the span otherwise (and
    shifted so 0 is the span's start, matching the sliced reference the
    phone actually played), `None` again when the clipped width falls
    under MIN_WORD_MS."""
    span_start, span_end = span if span is not None else (None, None)
    out: list[tuple[float, float] | None] = []
    for w in words:
        a = w["start"] / speed * 1000.0
        b = w["end"] / speed * 1000.0
        if span is not None:
            if b <= span_start or a >= span_end:
                out.append(None)
                continue
            a = max(a, span_start) - span_start
            b = min(b, span_end) - span_start
        if b - a < MIN_WORD_MS:
            out.append(None)
            continue
        out.append((a, b))
    return out


def _unscorable(n: int, anchor: str | None, note: str) -> dict:
    return {
        "words": ["none"] * n,
        "offsetsMs": [None] * n,
        "behindMs": None,
        "anchor": anchor,
        "note": note,
    }


def score(
    ref_env: np.ndarray,
    take_env: np.ndarray,
    windows: list[tuple[float, float] | None],
    anchor_ms: float | None,
    lag_ms: int,
    anchor: str | None,
) -> dict:
    """Classify every word window against the take envelope. Pure: takes
    envelopes and windows in, returns the score dict of the Design."""
    n = len(windows)
    if anchor_ms is None:
        return _unscorable(n, None, "No timing anchor")
    if len(ref_env) == 0:
        return _unscorable(n, anchor, "No voice heard in the take")

    shift_ms = max(anchor_ms - _ANCHOR_LEAD_MS, 0.0)
    shift_frame = int(round(shift_ms / HOP_MS))
    take_slice = take_env[shift_frame:]
    if len(take_slice) == 0:
        # The anchor itself lands past the end of the take: there is no
        # voice or silence to judge there, just a bad anchor.
        return _unscorable(n, anchor, "No timing anchor")

    path = dtw_path(ref_env, take_slice)
    if not path:
        return _unscorable(n, anchor, "No voice heard in the take")

    mapped_take_idx = sorted({j for _, j in path})
    voiced_frac = float(np.mean(take_slice[mapped_take_idx] > VOICED))
    if voiced_frac < _VOICE_FLOOR:
        return _unscorable(n, anchor, "No voice heard in the take")

    by_ref: dict[int, list[int]] = {}
    for i, j in path:
        by_ref.setdefault(i, []).append(j)

    # take_idx (in the slice) expected for ref frame 0 if the take followed
    # the reference exactly with zero offset.
    base = anchor_ms / HOP_MS - shift_frame

    words: list[str] = []
    offsets: list[int | None] = []
    dropped_flags: list[bool] = []
    for win in windows:
        if win is None:
            words.append("none")
            offsets.append(None)
            dropped_flags.append(False)
            continue
        a_ms, b_ms = win
        fa = max(0, int(round(a_ms / HOP_MS)))
        fb = min(len(ref_env) - 1, max(fa, int(round(b_ms / HOP_MS))))
        pts = [(i, j) for i in range(fa, fb + 1) for j in by_ref.get(i, [])]
        if not pts:
            words.append("none")
            offsets.append(None)
            dropped_flags.append(False)
            continue
        js = [j for _, j in pts]
        offs = [(j - base - i) * HOP_MS for i, j in pts]
        offset_ms = int(round(float(np.median(offs))))
        voiced = float(np.mean([take_slice[j] > VOICED for j in js]))
        mapped_span = max(js) - min(js) + 1
        ref_len = fb - fa + 1
        is_dropped = voiced < DROPPED_FRACTION or (ref_len >= 5 and mapped_span < 3)
        dropped_flags.append(is_dropped)
        offsets.append(offset_ms)
        words.append("dropped" if is_dropped else "ok")

    scored_idx = [i for i, w in enumerate(windows) if w is not None]
    if scored_idx:
        dropped_count = sum(1 for i in scored_idx if dropped_flags[i])
        if dropped_count / len(scored_idx) >= _LOST_FRACTION:
            return _unscorable(n, anchor, "Could not follow the take")

    kept = [offsets[i] for i in scored_idx if not dropped_flags[i] and offsets[i] is not None]
    med = float(np.median(kept)) if kept else None

    if med is not None:
        for i in scored_idx:
            if dropped_flags[i] or offsets[i] is None:
                continue
            delta = offsets[i] - med
            if delta < -TOLERANCE_MS:
                words[i] = "early"
            elif delta > TOLERANCE_MS:
                words[i] = "late"
            else:
                words[i] = "ok"

    behind_ms = int(round(med - lag_ms)) if med is not None else None

    return {
        "words": words,
        "offsetsMs": offsets,
        "behindMs": behind_ms,
        "anchor": anchor,
        "note": "",
    }


def score_take(
    ref: np.ndarray,
    take: np.ndarray,
    sr: int,
    words: list[dict],
    speed: float,
    span: tuple[int, int] | None,
    anchor_ms: float | None,
    lag_ms: int,
    anchor: str | None,
) -> dict:
    """Envelope both signals and score the take against the line's words."""
    ref_env = envelope(ref, sr)
    take_env = envelope(take, sr)
    windows = word_windows(words, speed, span)
    return score(ref_env, take_env, windows, anchor_ms, lag_ms, anchor)
