"""BL-51 sessions: one Practice now across every source.

review_deck and schedule are per-source stores. This module reads both plus
the islands and the take scores, and plans a sized session: which projects,
and which lines of each, weakest first. `plan` is pure (no write); `start`
records the plan; `finish` records what was actually done.
"""

import json
import uuid
from statistics import median

import review_deck
import schedule
import store

SIZES = (5, 10, 20, 30)
MAX_PROJECTS = {5: 2, 10: 3, 20: 4, 30: 5}
MAX_EDIT_PROJECTS = 8
DEFAULT_SPS = 36.0
MIN_SPS, MAX_SPS = 15.0, 120.0
SPS_SESSIONS = 5
SPS_MIN_SENTENCES = 3

_CARD_KIND = {"podcast": "podcast", "youtube": "video"}


def seconds_per_sentence(device: str) -> float:
    """Median seconds per sentence over the last 5 finished sessions with 3+
    sentences, clamped to 15..120. 36 until there is any history (20
    sentences is about 12 minutes)."""
    rates = [
        s["actual_seconds"] / s["actual_sentences"]
        for s in store.list_sessions(device, 50)
        if s["actual_sentences"] >= SPS_MIN_SENTENCES
    ][:SPS_SESSIONS]
    if not rates:
        return DEFAULT_SPS
    return min(MAX_SPS, max(MIN_SPS, float(median(rates))))


def latest_scores(device: str) -> dict[tuple[str, int], int | None]:
    """Newest whole-line take total per (island_id, idx) for this device."""
    out: dict[tuple[str, int], int | None] = {}
    for row in store.list_take_scores(device):
        if row["whole_line"] == 1:
            out[(row["island_id"], row["idx"])] = row["total"]
    return out


def rank_lines(lines: list[dict], scores: dict[int, int | None]) -> list[dict]:
    """Weakest first: a line with no score ranks first, then ascending total,
    then earliest `due_on` (cards), then idx."""
    def key(line: dict):
        total = scores.get(line["idx"])
        return (total is not None, total if total is not None else 0,
                line.get("due_on", ""), line["idx"])

    return sorted(lines, key=key)


def split_shares(counts: list[int], size: int) -> list[int]:
    """How many lines each project plays. Everything when it all fits; else
    largest remainder over the candidate counts, at least 1 each, never more
    than a project has, with what a short project cannot use handed on."""
    total = sum(counts)
    if total <= size:
        return list(counts)
    ideal = [size * c / total for c in counts]
    shares = [min(c, max(1, int(x))) for c, x in zip(counts, ideal)]
    while sum(shares) > size:
        biggest = max((i for i, s in enumerate(shares) if s > 1), key=lambda i: shares[i])
        shares[biggest] -= 1
    while sum(shares) < size:
        open_ = [i for i, s in enumerate(shares) if s < counts[i]]
        if not open_:
            break
        best = max(open_, key=lambda i: (ideal[i] - shares[i], -i))
        shares[best] += 1
    return shares


def candidates(device: str, today: str, language: str | None = None) -> list[dict]:
    """Every project that can supply lines today, in play order: card
    projects by due count desc, due islands by due_on asc (never practised
    counts as today), then card projects with nothing due by latest save desc.
    `language` keeps only projects in that learning language; None keeps all."""
    with_due, islands, idle = _projects(device, today, language)
    return with_due + [p for p in islands if p["due_on"] <= today] + idle


def _all(device: str, today: str, language: str | None = None) -> list[dict]:
    """candidates plus the islands not due yet: everything a learner can add."""
    with_due, islands, idle = _projects(device, today, language)
    return with_due + islands + idle


def available(device: str, language: str | None = None) -> list[dict]:
    """Every project with saved lines, for the start screen's Add list."""
    out = []
    for p in _all(device, schedule._today(), language):
        total = len(p["lines"]) if p["lines"] is not None else p["line_count"]
        out.append({"island_id": p["island_id"], "title": p["title"], "source": p["source"],
                    "kind": p["kind"], "total": total})
    return out


def _projects(device: str, today: str,
              language: str | None = None) -> tuple[list[dict], list[dict], list[dict]]:
    all_islands = store.list_islands(device)
    # Cards saved before they kept a language fall back to their island's, then 'ja'.
    island_lang = {isl["id"]: isl.get("language") or "ja" for isl in all_islands}
    by_island: dict[str, list[dict]] = {}
    for card in review_deck.list_cards(device):
        lang = card.get("language") or island_lang.get(card["island_id"], "ja")
        if language and lang != language:
            continue
        by_island.setdefault(card["island_id"], []).append(card)

    with_due, idle = [], []
    for island_id, cards in by_island.items():
        due = sum(1 for c in cards if c["due_on"] <= today)
        proj = {
            "island_id": island_id,
            "title": cards[0]["island_title"],
            "source": cards[0]["source"],
            "kind": _CARD_KIND.get(cards[0]["source"], "island"),
            "lines": [{"idx": c["idx"], "due_on": c["due_on"]} for c in cards],
            "cards": {c["idx"]: c for c in cards},
            "due": due,
            "saved": max(c["created_at"] for c in cards),
        }
        (with_due if due else idle).append(proj)
    with_due.sort(key=lambda p: -p["due"])
    idle.sort(key=lambda p: p["saved"], reverse=True)

    with schedule.connect() as conn:
        rows = conn.execute(
            "SELECT island_id, due_on FROM schedule_state WHERE device=?", (device,)
        ).fetchall()
    due_on = {r["island_id"]: r["due_on"] for r in rows}
    islands = []
    for isl in all_islands:
        if (isl["status"] != "ready" or isl["line_count"] < 1
                or isl["source"] in schedule.NO_SCHEDULE_SOURCES or isl["id"] in by_island
                or (language and island_lang[isl["id"]] != language)):
            continue
        when = due_on.get(isl["id"], today)
        islands.append({
            "island_id": isl["id"],
            "title": isl["title"] or "",
            "source": isl["source"],
            "kind": "island",
            "lines": None,
            "line_count": isl["line_count"],
            "due_on": when,
        })
    islands.sort(key=lambda p: p["due_on"])
    return with_due, islands, idle


def _first_line(device: str, proj: dict, idx: int) -> dict:
    if proj.get("cards"):
        c = proj["cards"][idx]
        return {"island_id": proj["island_id"], "idx": idx, "ja": c["ja"], "kana": c["kana"],
                "en": c["en"], "words": c["words"]}
    isl = store.get_island(proj["island_id"]) or {"lines": []}
    line = next((ln for ln in isl["lines"] if ln["idx"] == idx), None) or {}
    return {"island_id": proj["island_id"], "idx": idx, "ja": line.get("ja", ""),
            "kana": line.get("kana", ""), "en": line.get("en", ""),
            "words": line.get("words", [])}


def _load_lines(p: dict) -> list[dict]:
    if p["lines"] is None:
        isl = store.get_island(p["island_id"]) or {"lines": []}
        p["lines"] = [{"idx": ln["idx"]} for ln in isl["lines"]]
    return p["lines"]


def _edited(device: str, today: str, edit: list[tuple[str, int]],
            language: str | None = None) -> tuple[list[dict], list[int]]:
    """The learner's own plan: these projects in this order, each with up to
    its count of lines. Unknown ids, repeats, other languages and counts
    under 1 drop out."""
    pool = {p["island_id"]: p for p in _all(device, today, language)}
    projs, shares = [], []
    for island_id, n in edit:
        p = pool.pop(island_id, None)
        if p is None or n < 1 or not _load_lines(p):
            continue
        projs.append(p)
        shares.append(min(n, len(p["lines"])))
        if len(projs) == MAX_EDIT_PROJECTS:
            break
    return projs, shares


def plan(device: str, size: int, order: list[str] | None = None,
         edit: list[tuple[str, int]] | None = None, language: str | None = None) -> dict:
    """The session for `size` sentences. Pure: nothing is written. `order`
    (island ids) only moves the chosen projects: listed ones play first in
    that order, the rest keep their place after them. `edit` replaces the
    choice: (island id, count) pairs in play order, each project filled with
    its weakest lines, and `size` becomes the sum. `language` keeps only
    projects in that learning language; None mixes every language."""
    today = schedule._today()
    if edit is not None:
        projs, shares = _edited(device, today, edit, language)
        size = sum(shares)
    else:
        projs = [p for p in candidates(device, today, language)[: MAX_PROJECTS[size]] if _load_lines(p)]
        shares = split_shares([len(p["lines"]) for p in projs], size)
    scores = latest_scores(device)
    out = []
    for p, share in zip(projs, shares):
        mine = {i: t for (isl, i), t in scores.items() if isl == p["island_id"]}
        picked = sorted(ln["idx"] for ln in rank_lines(p["lines"], mine)[:share])
        out.append({"island_id": p["island_id"], "title": p["title"], "source": p["source"],
                    "kind": p["kind"], "total": len(p["lines"]), "picked": picked, "_p": p})
    if order:
        pos = {key: i for i, key in enumerate(order)}
        out.sort(key=lambda o: pos.get(o["island_id"], len(pos)))
    count = sum(len(o["picked"]) for o in out)
    sps = seconds_per_sentence(device)
    first = _first_line(device, out[0]["_p"], out[0]["picked"][0]) if out else None
    for o in out:
        o.pop("_p")
    return {
        "session_id": None,
        "size": size,
        "count": count,
        "minutes": max(1, round(count * sps / 60)) if count else 0,
        "seconds_per_sentence": sps,
        "projects": out,
        "first": first,
    }


def start(device: str, size: int, order: list[str] | None = None,
          edit: list[tuple[str, int]] | None = None, language: str | None = None) -> dict:
    """Plans, records the session row and returns the plan with its id."""
    result = plan(device, size, order, edit, language)
    result["session_id"] = uuid.uuid4().hex
    store.add_session(device, result["session_id"], result["size"], result["count"],
                      result["count"] * result["seconds_per_sentence"],
                      {"projects": result["projects"]})
    return result


def finish(device: str, session_id: str, sentences: int, seconds: float,
           avg_score: float | None, lines: list[dict], completed: bool) -> bool:
    """Records the actuals. No-op (False) for an unknown or finished id."""
    return store.finish_session(device, session_id, sentences, seconds, avg_score,
                                lines, completed)
