"""Energy ledger and grants, plus the per-owner row deletion that settles them.

Split out of store.py. It reaches the shared connection through `import store`.
"""

import sqlite3

import store

# bl52-energy: the ledger holds one row per charged call (units, and how many
# of them came out of a grant); a refund is the same row negated, so every
# sum nets out. Grants are additive and never expire. A UTC day starts at
# created_at >= "<date>T00:00:00", the same boundary as count_builds_today.

# The device a deleted owner's ledger rows keep: no device id or user id can
# match it, and the rows still count toward today's global total.
ENERGY_DELETED_DEVICE = "deleted"


def _day_start() -> str:
    return store._now()[:10] + "T00:00:00"


def _spent_today(conn: sqlite3.Connection, device: str) -> tuple[int, int]:
    row = conn.execute(
        "SELECT COALESCE(SUM(units),0) AS units, COALESCE(SUM(from_grant),0) AS g"
        " FROM energy_ledger WHERE device=? AND created_at>=?",
        (device, _day_start()),
    ).fetchone()
    return int(row["units"]), int(row["g"])


def _grant_totals(conn: sqlite3.Connection, device: str) -> tuple[int, int]:
    granted = conn.execute(
        "SELECT COALESCE(SUM(amount),0) AS n FROM energy_grants WHERE target_device=?",
        (device,),
    ).fetchone()["n"]
    spent = conn.execute(
        "SELECT COALESCE(SUM(from_grant),0) AS n FROM energy_ledger WHERE device=?",
        (device,),
    ).fetchone()["n"]
    return int(granted), int(spent)


def _global_today(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(units),0) AS n FROM energy_ledger WHERE created_at>=?",
        (_day_start(),),
    ).fetchone()
    return int(row["n"])


def energy_balances(device: str, daily_max: int) -> tuple[int, int]:
    """(daily_left, granted_left). Daily units are spent first, then the
    grant balance; `from_grant` on each ledger row records the split, so the
    grant balance is exact over all time while the daily part resets with
    the UTC day."""
    return _balances(store.connect(), device, daily_max)


def _balances(conn: sqlite3.Connection, device: str, daily_max: int) -> tuple[int, int]:
    units, from_grant = _spent_today(conn, device)
    granted, spent_from_grant = _grant_totals(conn, device)
    # min(): a refund landing just after midnight for a charge made just
    # before it can leave today's daily spend below zero.
    daily_left = min(daily_max, max(0, daily_max - (units - from_grant)))
    return daily_left, max(0, granted - spent_from_grant)


def energy_spend(device: str, kind: str, units: int, daily_max: int,
                 global_max: int, warn_line: float) -> tuple[str, int, bool]:
    """Spends `units` in one BEGIN IMMEDIATE transaction, so two workers or
    threads can never both spend the same last units. Returns (code,
    global_after, warn): code is "ok" when the row was written, else
    "no_energy" or "global_limit" and nothing was written. `warn` is True
    for the first spend of the UTC day that reaches `warn_line`; the day is
    stored in energy_warned, so a refund that dips under the line does not
    warn again."""
    conn = store.connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        daily_left, granted_left = _balances(conn, device, daily_max)
        take_daily = min(units, daily_left)
        take_grant = units - take_daily
        before = _global_today(conn)
        after = before + units
        if take_grant > granted_left:
            conn.rollback()
            return "no_energy", before, False
        if after > global_max:
            conn.rollback()
            return "global_limit", before, False
        conn.execute(
            "INSERT INTO energy_ledger (device, kind, units, from_grant, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (device, kind, units, take_grant, store._now()),
        )
        warn = False
        if after >= warn_line:
            cur = conn.execute(
                "INSERT OR IGNORE INTO energy_warned (day) VALUES (?)", (store._now()[:10],)
            )
            warn = cur.rowcount > 0
        conn.commit()
        return "ok", after, warn
    except Exception:
        conn.rollback()
        raise


def energy_refund(device: str, kind: str) -> bool:
    """Negates the device's latest charge of `kind` that no refund has
    netted out yet, with the same daily/grant split. False when there is
    none."""
    conn = store.connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT units, from_grant FROM energy_ledger WHERE device=? AND kind=?"
            " AND units>0 ORDER BY id DESC LIMIT 1",
            (device, kind),
        ).fetchone()
        net = conn.execute(
            "SELECT COALESCE(SUM(units),0) AS n FROM energy_ledger WHERE device=? AND kind=?",
            (device, kind),
        ).fetchone()["n"]
        if row is None or net <= 0:
            conn.rollback()
            return False
        conn.execute(
            "INSERT INTO energy_ledger (device, kind, units, from_grant, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (device, kind, -row["units"], -row["from_grant"], store._now()),
        )
        conn.commit()
        return True
    except Exception:
        conn.rollback()
        raise


def energy_add_grant(target_device: str, target_username: str, amount: int,
                     note: str, granted_by: str) -> int:
    with store.connect() as conn:
        cur = conn.execute(
            "INSERT INTO energy_grants (target_device, target_username, amount, note,"
            " granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (target_device, target_username, amount, note, granted_by, store._now()),
        )
        return int(cur.lastrowid)


def energy_last_grant(device: str) -> dict | None:
    with store.connect() as conn:
        row = conn.execute(
            "SELECT id, amount, created_at FROM energy_grants WHERE target_device=?"
            " ORDER BY id DESC LIMIT 1",
            (device,),
        ).fetchone()
    return dict(row) if row else None


def energy_global_today() -> int:
    """Units charged to every device today: the global daily stop reads this."""
    return _global_today(store.connect())


def delete_owner_rows(device: str) -> None:
    with store.connect() as conn:
        conn.execute(
            "UPDATE energy_ledger SET device=? WHERE device=?", (ENERGY_DELETED_DEVICE, device)
        )
        conn.execute("DELETE FROM energy_grants WHERE target_device=?", (device,))
        conn.execute("DELETE FROM builds WHERE device=?", (device,))
        conn.execute("DELETE FROM take_scores WHERE device=?", (device,))
        conn.execute("DELETE FROM review_session_lines WHERE device=?", (device,))
        conn.execute("DELETE FROM review_sessions WHERE device=?", (device,))
        conn.execute("DELETE FROM known_lines WHERE device=?", (device,))
