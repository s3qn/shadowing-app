"""The cat leaderboards: all-time and weekly. Reads the progression ledger
through the `progression` module (connect, SLOTS, level_for, _streaks_for)."""

import math

import progression

LEADERBOARD_MAX = 50


def leaderboard(owner: str, limit: int, handles) -> dict:
    """Top cats by xp then level. `handles` returns {owner: handle} for every
    named owner, so a user with a handle but no XP yet still appears (level 1,
    nothing equipped).

    Owners without a handle are hidden and take no rank. An entry carries only
    username, level and equipped; nothing that identifies the owner."""
    limit = max(1, min(int(limit), LEADERBOARD_MAX))
    conn = progression.connect()
    names = handles()
    rows = conn.execute("SELECT owner, xp, updated_at FROM progress").fetchall()
    xp_by = {r["owner"]: r["xp"] for r in rows}
    upd_by = {r["owner"]: r["updated_at"] for r in rows}
    # Every named owner, left-joined to progress: no progress row means 0 XP
    # (level 1). xp desc, then the progress tiebreak (updated_at asc, owner asc).
    # A 0-XP user has no updated_at, so these level-1 users sort to the bottom.
    ranked = sorted(
        ((o, xp_by.get(o, 0)) for o in names),
        key=lambda t: (-t[1], upd_by.get(t[0], ""), t[0]),
    )
    top = ranked[:limit]
    slots: dict[str, dict] = {o: {slot: None for slot in progression.SLOTS} for o, _ in top}
    if top:
        marks = ",".join("?" * len(top))
        for r in conn.execute(
            f"SELECT owner, slot, item_id FROM equipped WHERE owner IN ({marks})",
            [o for o, _ in top],
        ):
            if r["slot"] in slots[r["owner"]]:
                slots[r["owner"]][r["slot"]] = r["item_id"]
    streaks = progression._streaks_for(conn, [o for o, _ in top])
    entries = [
        {"username": names[o], "level": progression.level_for(xp), "equipped": slots[o],
         "streak_days": streaks[o]}
        for o, xp in top
    ]
    own = conn.execute("SELECT xp FROM progress WHERE owner=?", (owner,)).fetchone()
    rank = next((i + 1 for i, (o, _) in enumerate(ranked) if o == owner), None)
    return {
        "entries": entries,
        "me": {
            "rank": rank,
            "level": progression.level_for(own["xp"] if own else 0),
            "username": names.get(owner),
        },
    }


def weekly_leaderboard(
    owner: str, limit: int, handles, week_start: str, minutes: dict, island_lang: dict,
    language: str,
) -> dict:
    """This week's board for one language: score = counted minutes (the
    caller's `minutes` {owner: n}) plus the lines first taken since
    `week_start` on islands in `language` (`island_lang` {island id: language}).
    Only named owners with a score above 0 are ranked."""
    limit = max(1, min(int(limit), LEADERBOARD_MAX))
    conn = progression.connect()
    names = handles()
    lines: dict[str, int] = {}
    for r in conn.execute(
        "SELECT owner, key FROM awards WHERE key LIKE 'take:%' AND created_at >= ?", (week_start,)
    ):
        parts = r["key"].split(":")
        if len(parts) >= 4 and island_lang.get(":".join(parts[1:-2])) == language:
            lines[r["owner"]] = lines.get(r["owner"], 0) + 1
    xp_by = {r["owner"]: r["xp"] for r in conn.execute("SELECT owner, xp FROM progress")}

    def row(o: str) -> dict:
        m, n = int(minutes.get(o, 0)), lines.get(o, 0)
        return {"minutes": m, "lines": n, "score": m + n}

    ranked = sorted(
        ((o, row(o)) for o in names if row(o)["score"] > 0),
        key=lambda t: (-t[1]["score"], -t[1]["minutes"], names[t[0]]),
    )
    top = ranked[:limit]
    slots: dict[str, dict] = {o: {slot: None for slot in progression.SLOTS} for o, _ in top}
    if top:
        marks = ",".join("?" * len(top))
        for r in conn.execute(
            f"SELECT owner, slot, item_id FROM equipped WHERE owner IN ({marks})",
            [o for o, _ in top],
        ):
            if r["slot"] in slots[r["owner"]]:
                slots[r["owner"]][r["slot"]] = r["item_id"]
    streaks = progression._streaks_for(conn, [o for o, _ in top])
    entries = [
        {"username": names[o], "level": progression.level_for(xp_by.get(o, 0)),
         "equipped": slots[o], "streak_days": streaks[o], **v}
        for o, v in top
    ]
    rank = next((i + 1 for i, (o, _) in enumerate(ranked) if o == owner), None)
    return {
        "week_start": week_start[:10],
        "language": language,
        "entries": entries,
        "me": {
            "rank": rank,
            "username": names.get(owner),
            "level": progression.level_for(xp_by.get(owner, 0)),
            **row(owner),
            "top_pct": math.ceil(rank / len(ranked) * 100) if rank else None,
        },
    }
