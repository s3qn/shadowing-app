"""Constants for progression.py: XP rates, caps, milestones and award names.

progression.py binds each name back (DAILY_XP_CAP = progression_data.DAILY_XP_CAP)
so a test that patches progression.<NAME> still changes what progression reads.
"""

from pathlib import Path

CATALOG_PATH = Path(__file__).parent / "cosmetics_catalog.json"

MAX_LEVEL = 50
CATALOG_VERSION = 2
LEVEL_UP_COINS = 25

DAY_XP, DAY_COINS = 20, 5
PRACTICED_XP, PRACTICED_COINS = 20, 10
# One key per counted listening minute, owner-wide (all islands together),
# at most DAILY_MINUTES_MAX a UTC day. In the slow tail a minute pays
# MINUTE_XP_SLOW instead of MINUTE_XP // SLOW_DIVISOR (which would be 0).
MINUTE_XP, MINUTE_XP_SLOW, MINUTE_COINS = 2, 1, 1
DAILY_MINUTES_MAX = 180
TAKE_XP, TAKE_COINS = 15, 2
TAKES_PER_DAY = 60
# A take on a line already paid today (take:...) still pays a little, so every
# sentence said shows XP: REP_XP_BASE plus 1 per REP_XP_STEP score points, at
# most REP_XP_MAX, inside the daily cap like every other repeatable source.
REP_XP_BASE, REP_XP_STEP, REP_XP_MAX = 2, 25, 6

# Every repeatable source (take, minute, practiced, day, streak, quality,
# mastery) pays in two bands per UTC day: the FAST band, DAILY_XP_CAP XP at
# the full rate, then the SLOW tail at xp // SLOW_DIVISOR with no coins.
# Mastery waits for a day with fast room instead. Milestones are exempt.
DAILY_XP_CAP = 120
SLOW_DIVISOR = 10
QUALITY_GOOD = 0.5
QUALITY_GREAT = 0.8
QUALITY_MIN_WORDS = 3
QUALITY_XP, QUALITY_COINS = 5, 1
MASTERY_XP, MASTERY_COINS = 60, 20
# "Easy for me": once per line, only for a line that was ever taken whole.
# Outside the daily cap like the one-time milestones; TAKES_PER_DAY bounds
# it at 180 XP a day.
KNOWN_XP, KNOWN_COINS = 3, 1
# (minimum streak days, xp, coins), longest first.
STREAK_TIERS = ((365, 50, 12), (100, 40, 10), (30, 30, 8), (7, 20, 5), (3, 10, 3))
# Streak freeze: bought with coins, used on its own for a missed day. A frozen
# day bridges the run without adding to it. Sent in every snapshot.
FREEZE_PRICE = 150
FREEZE_CAP = 2
MILESTONES = {
    "first_take": (40, 10),
    "first_island": (40, 10),
    "perfect_take": (60, 15),
    "full_speed": (60, 15),
    "first_mastery": (80, 20),
    # Streak rungs (tier floors T2 to T10): each also grants its item.
    "streak_7": (60, 15),
    "streak_14": (100, 25),
    "streak_30": (150, 40),
    "streak_60": (200, 50),
    "streak_100": (250, 60),
    "streak_180": (350, 80),
    "streak_365": (500, 120),
    "streak_500": (600, 150),
    "streak_1000": (1000, 250),
    # Level milestones pay coins only: XP for a level would feed itself.
    "level_5": (0, 30),
    "level_10": (0, 60),
    "level_20": (0, 100),
    # Listening hours (lifetime, uncapped): each rung also grants its item.
    "hours_1": (40, 10),
    "hours_10": (60, 15),
    "hours_25": (80, 20),
    "hours_50": (100, 25),
    "hours_100": (200, 50),
    "hours_250": (250, 60),
    "hours_500": (300, 80),
    "hours_1000": (500, 120),
    # Secret awards, evaluated on long media only (see schedule.py).
    "replay_10": (60, 15),
    "marathon_60": (100, 25),
    "three_channels": (60, 15),
}
HOURS_RUNGS = (1, 10, 25, 50, 100, 250, 500, 1000)
HOURS_ITEMS = {
    1: "accessory.bell_sprout",
    10: "accessory.bowtie_tide",
    25: "head.beanie_night",
    50: "body.scarf_lantern",
    100: "face.whiskers_shiny",
    250: "accessory.collar_moon",
    500: "face.mask_kitsune",
    1000: "head.crown_hours",
}
# Each streak milestone also grants its item (free, never equipped).
STREAK_ITEMS = {
    7: "accessory.badge_ember",
    14: "face.streak_14",
    30: "body.scarf_ember",
    60: "head.streak_60",
    100: "head.crown_ember",
    180: "accessory.streak_180",
    365: "face.mask_phoenix",
    500: "body.streak_500",
    1000: "head.streak_1000",
}
# Streak tier floors, ascending: rung N is the floor of tier T2..T10. Each
# pays ms:streak_N once and grants STREAK_ITEMS[N]. Distinct from
# STREAK_TIERS, the daily bonus table.
STREAK_RUNGS = (7, 14, 30, 60, 100, 180, 365, 500, 1000)
SECRET_AWARDS = ("replay_10", "marathon_60", "three_channels")
# The owned share of an hours item is shown only once this many users exist.
RARITY_MIN_USERS = 200
# Display names for every MILESTONES id. A secret one shows no name until earned.
ACHIEVEMENTS = {
    "first_take": {"secret": False, "en": "First take", "he": "הקלטה ראשונה"},
    "first_island": {"secret": False, "en": "First island", "he": "אי ראשון"},
    "perfect_take": {"secret": False, "en": "Perfect take", "he": "הקלטה מושלמת"},
    "full_speed": {"secret": False, "en": "Full speed", "he": "מהירות מלאה"},
    "first_mastery": {"secret": False, "en": "First mastery", "he": "שליטה ראשונה"},
    "streak_7": {"secret": False, "en": "7 day streak", "he": "רצף של 7 ימים"},
    "streak_14": {"secret": False, "en": "14 day streak", "he": "רצף של 14 ימים"},
    "streak_30": {"secret": False, "en": "30 day streak", "he": "רצף של 30 ימים"},
    "streak_60": {"secret": False, "en": "60 day streak", "he": "רצף של 60 ימים"},
    "streak_100": {"secret": False, "en": "100 day streak", "he": "רצף של 100 ימים"},
    "streak_180": {"secret": False, "en": "180 day streak", "he": "רצף של 180 ימים"},
    "streak_365": {"secret": False, "en": "365 day streak", "he": "רצף של 365 ימים"},
    "streak_500": {"secret": False, "en": "500 day streak", "he": "רצף של 500 ימים"},
    "streak_1000": {"secret": False, "en": "1000 day streak", "he": "רצף של 1000 ימים"},
    "level_5": {"secret": False, "en": "Level 5", "he": "שלב 5"},
    "level_10": {"secret": False, "en": "Level 10", "he": "שלב 10"},
    "level_20": {"secret": False, "en": "Level 20", "he": "שלב 20"},
    "hours_1": {"secret": False, "en": "1 hour listened", "he": "שעה של האזנה"},
    "hours_10": {"secret": False, "en": "10 hours listened", "he": "10 שעות של האזנה"},
    "hours_25": {"secret": False, "en": "25 hours listened", "he": "25 שעות של האזנה"},
    "hours_50": {"secret": False, "en": "50 hours listened", "he": "50 שעות של האזנה"},
    "hours_100": {"secret": False, "en": "100 hours listened", "he": "100 שעות של האזנה"},
    "hours_250": {"secret": False, "en": "250 hours listened", "he": "250 שעות של האזנה"},
    "hours_500": {"secret": False, "en": "500 hours listened", "he": "500 שעות של האזנה"},
    "hours_1000": {"secret": False, "en": "1000 hours listened", "he": "1000 שעות של האזנה"},
    "replay_10": {"secret": True, "en": "Heard it ten times", "he": "שמעתי עשר פעמים"},
    "marathon_60": {"secret": True, "en": "Marathon listener", "he": "מאזין מרתון"},
    "three_channels": {"secret": True, "en": "Three channels in a day", "he": "שלושה ערוצים ביום"},
}

# Daily review (BL-51). Outside DAILY_XP_CAP, like milestones.
REVIEW_MIN_SENTENCES = 3
REVIEW_SECONDS_PER_SENTENCE = 3
REVIEW_MAX_COUNTED = 30
REVIEW_XP_PER_SENTENCE = 4
REVIEW_NEUTRAL_SCORE = 50.0
REVIEW_REPEAT_FACTORS = (1.0, 0.4, 0.2, 0.1)
REVIEW_MAX_PAID_PER_DAY = 10
REVIEW_FIRST_BONUS = 40
REVIEW_STREAK_BONUS_PER_DAY = 5
REVIEW_STREAK_BONUS_DAYS = 7
