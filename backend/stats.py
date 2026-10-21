"""Profile aggregation for GET /shadow/profile/{username}. Calls the
per-database helpers and never joins across db files."""

from datetime import datetime, timedelta, timezone

import progression
import schedule
import store
import user_profile


def _now() -> datetime:
    return datetime.now(timezone.utc)


def week_start() -> str:
    """This week's Monday (UTC) as YYYY-MM-DD."""
    today = _now().date()
    return (today - timedelta(days=today.weekday())).isoformat()


def weekly_league(owner: str, language: str, limit: int, handles) -> dict:
    """The weekly board: minutes from schedule.db, lines from progression.db,
    island languages from store, joined here in Python."""
    since = week_start()
    return progression.weekly_leaderboard(
        owner, limit, handles, since, schedule.weekly_minutes(language, since),
        store.island_languages(), language,
    )


def profile(username: str, handles, ui: str = "en") -> dict | None:
    found = user_profile.lookup(username)
    if found is None:
        return None
    owner = found["owner"]
    snap = progression.snapshot(owner)
    st = progression.stats(owner)
    imm = schedule.immersion(owner)
    total = imm["total"]
    video = imm["by_source"].get("youtube", 0.0)
    podcast = imm["by_source"].get("podcast", 0.0)
    return {
        "username": found["username"],
        "serial": found["serial"],
        "member_since": (found["created_at"] or "")[:7],
        "level": snap["level"],
        "xp": snap["xp"],
        "rank": progression.leaderboard(owner, 1, handles)["me"]["rank"],
        "equipped": snap["equipped"],
        "streak_days": snap["streak_days"],
        "longest_streak": st["longest_streak"],
        "days_active": st["days_active"],
        "best_xp_day": st["best_xp_day"],
        "cap_days": st["cap_days"],
        "immersion_seconds": total,
        "video_seconds": video,
        "podcast_seconds": podcast,
        "shadow_seconds": max(0.0, total - video - podcast),
        "islands_started": store.count_islands(owner),
        "islands_mastered": st["islands_mastered"],
        "lines_practiced": st["lines_practiced"],
        "lines_mastered": st["lines_mastered"],
        "average_accuracy": st["average_accuracy"],
        "milestones": st["milestones"],
        "milestones_total": len(progression.MILESTONES),
        "cosmetics_owned": len(snap["owned"]),
        "cosmetics_total": len(progression.catalog(with_rarity=False)["items"]),
        "by_language": imm["by_language"],
        "hours_next": progression.hours_next(imm["counted_total"]),
        "achievements": progression.achievements(owner, ui if ui == "he" else "en"),
    }
