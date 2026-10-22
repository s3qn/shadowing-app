"""Build-time estimate for imports and video islands. Pure: no I/O.

`history` is a list of (media_s, work_s) pairs, newest first, for one kind.
"""
from statistics import median

DEFAULT_RTF = {"import": 0.35, "video": 0.05}
FIXED_S = {"import": 25.0, "video": 20.0}
MIN_MEDIA_S = 20.0
MIN_ROWS = 3
WINDOW = 20
OVERRUN = 1.5


def rate_for(kind: str, history: list[tuple[float, float]]) -> float:
    rows = [(m, w) for m, w in history[:WINDOW] if m >= MIN_MEDIA_S and w > 0]
    if len(rows) < MIN_ROWS:
        return DEFAULT_RTF.get(kind, DEFAULT_RTF["import"])
    return median(w / m for m, w in rows)


def estimate(kind: str, media_s: float, elapsed_s: float,
             history: list[tuple[float, float]]) -> int | None:
    """Seconds left, 0 when the build has overrun its estimate, None when the
    media length is not known yet."""
    if media_s <= 0:
        return None
    total = rate_for(kind, history) * media_s + FIXED_S.get(kind, FIXED_S["import"])
    if elapsed_s > total * OVERRUN:
        return 0
    return max(0, round(total - elapsed_s))
