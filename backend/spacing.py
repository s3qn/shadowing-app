"""Pure spacing math for the practice scheduler: no I/O, no sqlite.

A fixed level ladder, not full SM-2. Every practice event bumps an island's
level by one, capped at the last index; there is no decay or missed-day
penalty yet. That is real scheduling work for a later feature, this is just
the groundwork.
"""

from datetime import date, timedelta

LEVEL_INTERVALS_DAYS: tuple[int, ...] = (0, 1, 2, 4, 7, 14, 30)
MAX_LEVEL = len(LEVEL_INTERVALS_DAYS) - 1


def next_level(level: int) -> int:
    """The level after one more practice event, capped at MAX_LEVEL."""
    level = max(0, min(level, MAX_LEVEL))
    return min(level + 1, MAX_LEVEL)


def due_date(practiced_on: date, level: int) -> date:
    """The next due date after practicing at the given level."""
    level = max(0, min(level, MAX_LEVEL))
    return practiced_on + timedelta(days=LEVEL_INTERVALS_DAYS[level])
