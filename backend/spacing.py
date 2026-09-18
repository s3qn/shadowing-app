"""Pure spacing math for the practice scheduler: no I/O, no sqlite.

A fixed level ladder, not full SM-2. A level moves at most once a day, and
only once that day's playback on the island reaches PRACTICED_MIN_SECONDS.
Practising well after the island was due moves the level back down one
instead of up, so a forgotten island returns sooner. schedule.py owns the
once-a-day rule and the second counting; this module is the arithmetic.
"""

from datetime import date, timedelta

LEVEL_INTERVALS_DAYS: tuple[int, ...] = (0, 1, 2, 4, 7, 14, 30)
MAX_LEVEL = len(LEVEL_INTERVALS_DAYS) - 1

# Seconds of line playback an island needs in one day before its level moves
# at all: about two ladder lines. Below it the island stays due.
PRACTICED_MIN_SECONDS = 45.0


def next_level(level: int, days_late: int = 0) -> int:
    """The level after a day of real practice, capped at MAX_LEVEL.

    A practice more than one whole interval past the due date is a lapse: the
    level drops by one (never below 1, the island was practised after all).
    """
    level = max(0, min(level, MAX_LEVEL))
    if days_late > LEVEL_INTERVALS_DAYS[level]:
        return max(1, level - 1)
    return min(level + 1, MAX_LEVEL)


def due_date(practiced_on: date, level: int) -> date:
    """The next due date after practicing at the given level."""
    level = max(0, min(level, MAX_LEVEL))
    return practiced_on + timedelta(days=LEVEL_INTERVALS_DAYS[level])
