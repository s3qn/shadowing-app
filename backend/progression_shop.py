"""Shop side of progression: buy, buy_freeze, grant_coins, equip, delete_owner.

Reads the db, catalog and snapshot through the progression module so a test
that patches progression.connect or progression.FREEZE_PRICE still applies.
"""

from fastapi import HTTPException

import progression


def _err(status: int, **body) -> HTTPException:
    return HTTPException(status, body)


def _locked(item: dict) -> HTTPException:
    """level_locked {level_req}, hours_locked {hours_req} or
    achievement_locked {achievement_req}, by the item's one source."""
    source, need = progression.unlock_source(item)
    return _err(400, code=f"{source}_locked", **{f"{source}_req": need})


def buy(owner: str, item_id: str) -> dict:
    item = progression._ITEMS.get(item_id)
    if item is None:
        raise _err(404, code="unknown_item")
    if item.get("grant_only"):
        raise _err(400, code="not_for_sale")
    conn = progression.connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        if conn.execute(
            "SELECT 1 FROM owned WHERE owner=? AND item_id=?", (owner, item_id)
        ).fetchone():
            conn.rollback()
            return progression.snapshot(owner)
        row = conn.execute("SELECT xp, coins FROM progress WHERE owner=?", (owner,)).fetchone()
        xp, coins = (row["xp"], row["coins"]) if row else (0, 0)
        # Hours pass as 0: hours items are earned by listening, never bought.
        if not progression.unlock_met(
            item, progression.level_for(xp), 0.0, set(progression._earned(conn, owner))
        ):
            conn.rollback()
            raise _locked(item)
        conn.execute(
            "INSERT OR IGNORE INTO progress (owner, xp, coins, updated_at) VALUES (?, 0, 0, ?)",
            (owner, progression._now()),
        )
        price = item["price"]
        cur = conn.execute(
            "UPDATE progress SET coins = coins - ?, updated_at = ? WHERE owner=? AND coins >= ?",
            (price, progression._now(), owner, price),
        )
        if cur.rowcount != 1:
            conn.rollback()
            raise _err(400, code="not_enough_coins", price=price, coins=coins)
        conn.execute(
            "INSERT OR IGNORE INTO owned (owner, item_id, bought_at) VALUES (?, ?, ?)",
            (owner, item_id, progression._now()),
        )
        conn.execute(
            "INSERT INTO equipped (owner, slot, item_id) VALUES (?, ?, ?)"
            " ON CONFLICT(owner, slot) DO UPDATE SET item_id = excluded.item_id",
            (owner, item["slot"], item_id),
        )
        conn.commit()
    except HTTPException:
        raise
    except BaseException:
        conn.rollback()
        raise
    return progression.snapshot(owner)


def buy_freeze(owner: str, purchase_id: str) -> dict:
    """Buys one streak freeze for FREEZE_PRICE coins, debit and row in one
    transaction. A replayed purchase_id returns the snapshot, no second debit."""
    conn = progression.connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        if conn.execute(
            "SELECT 1 FROM streak_freezes WHERE owner=? AND purchase_id=?", (owner, purchase_id)
        ).fetchone():
            conn.rollback()
            return progression.snapshot(owner)
        if progression._held(conn, owner) >= progression.FREEZE_CAP:
            conn.rollback()
            raise _err(400, code="freeze_cap", cap=progression.FREEZE_CAP)
        row = conn.execute("SELECT coins FROM progress WHERE owner=?", (owner,)).fetchone()
        coins = row["coins"] if row else 0
        cur = conn.execute(
            "UPDATE progress SET coins = coins - ?, updated_at = ? WHERE owner=? AND coins >= ?",
            (progression.FREEZE_PRICE, progression._now(), owner, progression.FREEZE_PRICE),
        )
        if cur.rowcount != 1:
            conn.rollback()
            raise _err(400, code="not_enough_coins", price=progression.FREEZE_PRICE, coins=coins)
        conn.execute(
            "INSERT INTO streak_freezes (owner, purchase_id, bought_on, created_at)"
            " VALUES (?, ?, ?, ?)",
            (owner, purchase_id, progression._today(), progression._now()),
        )
        conn.commit()
    except HTTPException:
        raise
    except BaseException:
        conn.rollback()
        raise
    return progression.snapshot(owner)


def grant_coins(owner: str, amount: int, clear_freezes: bool = False) -> dict:
    """Dev only (see the /shadow/dev/coins route): adds coins, optionally drops the
    unused freezes so a test can buy again, returns the snapshot."""
    conn = progression.connect()
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO progress (owner, xp, coins, updated_at) VALUES (?, 0, 0, ?)",
            (owner, progression._now()),
        )
        conn.execute(
            "UPDATE progress SET coins = coins + ?, updated_at = ? WHERE owner=?",
            (amount, progression._now(), owner),
        )
        if clear_freezes:
            conn.execute("DELETE FROM streak_freezes WHERE owner=? AND used_on IS NULL", (owner,))
    return progression.snapshot(owner)


def equip(owner: str, slot: str, item_id: str) -> dict:
    if slot not in progression.SLOTS:
        raise _err(400, code="bad_slot")
    conn = progression.connect()
    with conn:
        if not item_id:
            conn.execute("DELETE FROM equipped WHERE owner=? AND slot=?", (owner, slot))
        else:
            item = progression._ITEMS.get(item_id)
            if item is None:
                raise _err(400, code="not_owned")
            if item["slot"] != slot:
                raise _err(400, code="wrong_slot")
            if not conn.execute(
                "SELECT 1 FROM owned WHERE owner=? AND item_id=?", (owner, item_id)
            ).fetchone():
                raise _err(400, code="not_owned")
            conn.execute(
                "INSERT INTO equipped (owner, slot, item_id) VALUES (?, ?, ?)"
                " ON CONFLICT(owner, slot) DO UPDATE SET item_id = excluded.item_id",
                (owner, slot, item_id),
            )
    return progression.snapshot(owner)


def delete_owner(owner: str) -> None:
    with progression.connect() as conn:
        for table in (
            "progress", "awards", "owned", "equipped", "day_xp", "line_best", "streak_freezes",
        ):
            conn.execute(f"DELETE FROM {table} WHERE owner=?", (owner,))
