"""The LLM cost ledger: one row per API call, plus the spend queries."""

import store


def log_llm_call(tag: str, model: str, input_tokens: int, output_tokens: int,
                 usd: float, ok: bool, ref: str = "") -> None:
    """One row per API call, the cost ledger. A failed call lands with ok=0
    and whatever tokens were billed (0 when the request never completed)."""
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO llm_calls (tag, model, input_tokens, output_tokens, usd, ok, ref, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (tag, model, int(input_tokens), int(output_tokens), float(usd),
             1 if ok else 0, ref or "", store._now()),
        )


def _month_start() -> str:
    return store._now()[:7] + "-01T00:00:00"


def llm_spent_month() -> float:
    """USD billed since the first of the current UTC month."""
    with store.connect() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(usd), 0) AS usd FROM llm_calls WHERE created_at >= ?",
            (_month_start(),),
        ).fetchone()
    return float(row["usd"] or 0)


def llm_spent_today() -> float:
    """USD billed since 00:00 UTC today, the same query as llm_spent_month."""
    with store.connect() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(usd), 0) AS usd FROM llm_calls WHERE created_at >= ?",
            (store._now()[:10] + "T00:00:00",),
        ).fetchone()
    return float(row["usd"] or 0)


def llm_spend_summary() -> dict:
    """This month's bill: total USD, call count, and both per tag."""
    with store.connect() as conn:
        rows = conn.execute(
            "SELECT tag, COUNT(*) AS calls, COALESCE(SUM(usd), 0) AS usd"
            " FROM llm_calls WHERE created_at >= ? GROUP BY tag ORDER BY usd DESC",
            (_month_start(),),
        ).fetchall()
    by_tag = {r["tag"]: {"calls": int(r["calls"]), "usd": round(float(r["usd"]), 6)} for r in rows}
    return {
        "month_usd": round(sum(v["usd"] for v in by_tag.values()), 6),
        "calls": sum(v["calls"] for v in by_tag.values()),
        "by_tag": by_tag,
    }
