"""Tests for review_session.py (BL-51 sessions): shares, ranking, the plan,
start and finish, and the routes. Runs on the throwaway SHADOW_DATA_DIR."""

import asyncio
import sqlite3

import pytest
from fastapi import HTTPException

import beta
import main
from routers import review as review_r
from routers import takes as takes_r
import config
import progression
import review_deck
import review_session as rs
import schedule
import store

AUTH = f"Bearer {config.SHADOW_TOKEN}"
DEV = "eeeeeeee-0000-4000-8000-0000000000c1"


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    schedule.init()
    review_deck.init()
    with review_deck.connect() as conn:
        conn.execute("DELETE FROM review_cards")
    with store.connect() as conn:
        conn.execute("DELETE FROM review_session_lines")
        conn.execute("DELETE FROM review_sessions")
        conn.execute("DELETE FROM take_scores WHERE device=?", (DEV,))
        conn.execute("DELETE FROM known_lines WHERE device=?", (DEV,))
        conn.execute("DELETE FROM islands WHERE device=?", (DEV,))
    with schedule.connect() as conn:
        conn.execute("DELETE FROM schedule_state")
    # These tests mix video and podcast cards in, which only a beta user gets.
    beta.init()
    beta.set_flag(DEV, True, "test")


def _island(source, n, title="T"):
    iid = store.create_island("simple", 3, source=source, device=DEV)
    for i in range(n):
        store.add_line(iid, i, {"ja": f"j{i}", "kana": f"k{i}", "romaji": "r", "en": f"e{i}"},
                       2.0, [], words=[{"w": "a"}])
    store.set_ready(iid, title)
    return iid


def _cards(iid, n):
    isl = store.get_island(iid)
    for i in range(n):
        path = store.line_audio_path(iid, i)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"RIFFfake")
        review_deck.create_card(DEV, isl, isl["lines"][i], None)


def test_split_shares_even_remainder_short_cap_and_small():
    assert rs.split_shares([50, 50], 10) == [5, 5]
    assert rs.split_shares([50, 50, 50], 10) == [4, 3, 3]
    assert rs.split_shares([1, 50], 10) == [1, 9]  # short project hands its lines on
    assert rs.split_shares([2, 100, 100], 10) == [1, 5, 4]
    assert rs.split_shares([100, 1, 1], 10) == [8, 1, 1]
    assert rs.split_shares([3, 4], 20) == [3, 4]  # fewer candidates than the size
    assert sum(rs.split_shares([7, 9, 30, 2, 40], 30)) == 30


def test_rank_lines_unscored_first_then_total_then_idx():
    lines = [{"idx": i} for i in range(5)]
    scores = {0: 90, 1: 40, 3: 40}
    assert [ln["idx"] for ln in rs.rank_lines(lines, scores)] == [2, 4, 1, 3, 0]
    assert [ln["idx"] for ln in rs.rank_lines(lines, {0: None})] == [0, 1, 2, 3, 4]


def test_rank_lines_ties_by_due_on():
    lines = [{"idx": 0, "due_on": "2026-02-01"}, {"idx": 1, "due_on": "2026-01-01"}]
    assert [ln["idx"] for ln in rs.rank_lines(lines, {})] == [1, 0]


def test_plan_podcast_cards_plus_due_voice_island():
    pod = _island("podcast", 5, "Pod")
    _cards(pod, 5)
    voice = _island("voice", 10, "Voice")
    p10 = rs.plan(DEV, 10)
    assert [x["island_id"] for x in p10["projects"]] == [pod, voice]
    assert p10["count"] == 10
    assert [len(x["picked"]) for x in p10["projects"]] == [3, 7]
    assert p10["projects"][0]["kind"] == "podcast" and p10["projects"][1]["kind"] == "island"
    assert p10["first"]["island_id"] == pod and p10["first"]["ja"] == "j0"
    assert p10["session_id"] is None and p10["minutes"] == 6
    p30 = rs.plan(DEV, 30)
    assert p30["count"] == 15
    assert p30["projects"][1]["picked"] == list(range(10))
    assert p30["projects"][1]["total"] == 10


def test_plan_picks_weakest_lines_in_line_order():
    voice = _island("voice", 10)
    for idx, total in [(0, 90), (1, 20), (2, 30)]:
        store.add_take_score(DEV, voice, idx, "ja", {"total": total, "parts": {}}, 1.0, True)
    store.add_take_score(DEV, voice, 3, "ja", {"total": 5, "parts": {}}, 1.0, False)
    # 12 lines in two islands would split; one island of 10 at size 10 fits whole
    assert rs.plan(DEV, 10)["projects"][0]["picked"] == list(range(10))
    big = _island("voice", 40)
    store.add_take_score(DEV, big, 7, "ja", {"total": 95, "parts": {}}, 1.0, True)
    picked = [x for x in rs.plan(DEV, 10)["projects"] if x["island_id"] == big][0]["picked"]
    assert 7 not in picked and picked == sorted(picked)


def test_plan_skips_a_not_yet_due_island_and_empty_account():
    voice = _island("voice", 4)
    with schedule.connect() as conn:
        conn.execute(
            "INSERT INTO schedule_state (island_id, level, due_on, last_practiced_on,"
            " updated_at, device) VALUES (?, 1, '2999-01-01', '', '', ?)", (voice, DEV))
    out = rs.plan(DEV, 20)
    assert out["count"] == 0 and out["projects"] == [] and out["first"] is None


def test_start_then_finish_writes_both_tables_and_median_moves():
    _island("voice", 10)
    plan = rs.start(DEV, 10)
    assert plan["session_id"]
    with store.connect() as conn:
        row = conn.execute("SELECT * FROM review_sessions WHERE id=?", (plan["session_id"],)).fetchone()
    assert row["planned_sentences"] == 10 and row["planned_seconds"] == 360 and row["finished_at"] == ""
    lines = [{"island_id": "x", "idx": i, "seconds": 5.0, "score": 70 if i else None}
             for i in range(3)]
    assert rs.finish(DEV, plan["session_id"], 3, 60.0, 70.0, lines, True)
    with store.connect() as conn:
        row = conn.execute("SELECT * FROM review_sessions WHERE id=?", (plan["session_id"],)).fetchone()
        n = conn.execute("SELECT COUNT(*) FROM review_session_lines WHERE session_id=?",
                         (plan["session_id"],)).fetchone()[0]
    assert row["completed"] == 1 and row["actual_sentences"] == 3 and n == 3
    assert rs.seconds_per_sentence(DEV) == 20.0
    assert not rs.finish(DEV, plan["session_id"], 3, 60.0, 70.0, lines, True)  # already finished
    with store.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM review_session_lines").fetchone()[0] == 3


def test_seconds_per_sentence_default_and_clamp():
    assert rs.seconds_per_sentence(DEV) == 36.0
    sid = rs.start(DEV, 10)["session_id"]
    rs.finish(DEV, sid, 4, 4.0, None, [], True)
    assert rs.seconds_per_sentence(DEV) == 15.0


def _finish_route(session_id, sentences=3, seconds=120.0, lines=()):
    body = takes_r.ReviewFinishedBody(session_id=session_id, sentences=sentences, seconds=seconds,
                                   local_day=progression._today(), lines=list(lines))
    return asyncio.run(takes_r.review_session_finished(
        body=body, authorization=AUTH, x_shadow_device=DEV))


def test_finish_unknown_id_writes_nothing_and_route_still_pays():
    out = _finish_route("no-such-session")
    assert "xp" in out
    with store.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM review_session_lines").fetchone()[0] == 0


def test_routes_plan_start_finish_and_bad_size():
    _island("voice", 6)
    got = asyncio.run(review_r.review_session_plan(size=10, authorization=AUTH, x_shadow_device=DEV))
    assert got["count"] == 6 and got["session_id"] is None
    with pytest.raises(HTTPException) as e:
        asyncio.run(review_r.review_session_plan(size=15, authorization=AUTH, x_shadow_device=DEV))
    assert e.value.status_code == 422
    started = asyncio.run(review_r.review_session_start(
        body=review_r.SessionStartBody(size=10), authorization=AUTH, x_shadow_device=DEV))
    lines = [takes_r.SessionLine(island_id="a", idx=i, seconds=9, score=None) for i in range(3)]
    out = _finish_route(started["session_id"], lines=lines)
    assert "xp" in out
    with store.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM review_session_lines").fetchone()[0] == 3


def test_backup_runs_once_for_a_db_without_the_tables(tmp_path):
    db = tmp_path / "islands.db"
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE islands (id TEXT)")
    c.execute("INSERT INTO islands VALUES ('keep')")
    c.commit()
    c.close()
    first = store.backup_before_bl51(db, tmp_path)
    assert first is not None and first.name.startswith("islands.db.bak-bl51-")
    assert sqlite3.connect(first).execute("SELECT id FROM islands").fetchone()[0] == "keep"
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE review_sessions (id TEXT)")
    c.commit()
    c.close()
    assert store.backup_before_bl51(db, tmp_path) is None
    assert len(list(tmp_path.glob("islands.db.bak-bl51-*"))) == 1
    assert store.backup_before_bl51(tmp_path / "none.db", tmp_path) is None


def test_plan_size_5_caps_at_two_projects():
    for _ in range(3):
        _island("voice", 4)
    out = rs.plan(DEV, 5)
    assert out["count"] == 5 and len(out["projects"]) == 2
    got = asyncio.run(review_r.review_session_plan(size=5, authorization=AUTH, x_shadow_device=DEV))
    assert got["count"] == 5


def test_plan_order_puts_projects_first_and_keeps_shares_and_weakest():
    pod = _island("podcast", 5, "Pod")
    _cards(pod, 5)
    voice = _island("voice", 10, "Voice")
    store.add_take_score(DEV, voice, 0, "ja", {"total": 95, "parts": {}}, 1.0, True)
    base = rs.plan(DEV, 10)
    moved = rs.plan(DEV, 10, [voice])
    assert [x["island_id"] for x in moved["projects"]] == [voice, pod]
    assert moved["first"]["island_id"] == voice and moved["first"]["idx"] == 1
    shares = {x["island_id"]: x["picked"] for x in base["projects"]}
    assert {x["island_id"]: x["picked"] for x in moved["projects"]} == shares
    assert 0 not in shares[voice]
    # an unknown key changes nothing
    assert [x["island_id"] for x in rs.plan(DEV, 10, ["nope"])["projects"]] == [pod, voice]
    started = asyncio.run(review_r.review_session_start(
        body=review_r.SessionStartBody(size=10, order=[voice, pod]), authorization=AUTH,
        x_shadow_device=DEV))
    assert [x["island_id"] for x in started["projects"]] == [voice, pod]
    got = asyncio.run(review_r.review_session_plan(size=10, order=f"{voice},{pod}",
                                               authorization=AUTH, x_shadow_device=DEV))
    assert got["first"]["island_id"] == voice


def test_edited_plan_counts_order_added_project_and_weakest():
    pod = _island("podcast", 6, "Pod")
    _cards(pod, 6)
    later = _island("voice", 8, "Later")
    with schedule.connect() as conn:  # not due: never in the default plan, still addable
        conn.execute(
            "INSERT INTO schedule_state (island_id, level, due_on, last_practiced_on,"
            " updated_at, device) VALUES (?, 1, '2999-01-01', '', '', ?)", (later, DEV))
    assert later not in [x["island_id"] for x in rs.plan(DEV, 10)["projects"]]
    assert {x["island_id"]: x["total"] for x in rs.available(DEV)} == {pod: 6, later: 8}
    store.add_take_score(DEV, later, 0, "ja", {"total": 99, "parts": {}}, 1.0, True)
    out = rs.plan(DEV, 20, edit=[(later, 3), (pod, 50), ("nope", 4), (pod, 2), (later, 0)])
    assert [(x["island_id"], len(x["picked"])) for x in out["projects"]] == [(later, 3), (pod, 6)]
    assert out["projects"][0]["picked"] == [1, 2, 3]  # weakest: the scored line 0 drops out
    assert out["size"] == 9 and out["count"] == 9 and out["first"]["island_id"] == later
    started = asyncio.run(review_r.review_session_start(
        body=review_r.SessionStartBody(projects=[review_r.SessionPick(island_id=pod, count=2)]),
        authorization=AUTH, x_shadow_device=DEV))
    assert started["count"] == 2 and started["size"] == 2
    with store.connect() as conn:
        row = conn.execute("SELECT * FROM review_sessions WHERE id=?",
                           (started["session_id"],)).fetchone()
    assert row["planned_sentences"] == 2
    got = asyncio.run(review_r.review_session_plan(size=20, projects=f"{pod}:1,{later}:2",
                                               authorization=AUTH, x_shadow_device=DEV))
    assert [len(x["picked"]) for x in got["projects"]] == [1, 2]
    with pytest.raises(HTTPException):
        asyncio.run(review_r.review_session_plan(size=20, projects="x:a", authorization=AUTH,
                                             x_shadow_device=DEV))
    listed = asyncio.run(review_r.review_session_projects(authorization=AUTH, x_shadow_device=DEV))
    assert len(listed["projects"]) == 2


def test_available_and_projects_route_list_every_saved_project():
    voice = _island("voice", 6, "Voice")
    _island("voice", 4, "Other")
    _cards(voice, 2)
    got = rs.available(DEV)
    by_id = {p["island_id"]: p for p in got}
    assert len(got) == 2 and by_id[voice]["total"] >= 2
    assert set(by_id[voice]) == {"island_id", "title", "source", "kind", "total"}
    out = asyncio.run(review_r.review_session_projects(authorization=AUTH, x_shadow_device=DEV))
    assert {p["island_id"] for p in out["projects"]} == set(by_id)
    with pytest.raises(HTTPException) as e:
        asyncio.run(review_r.review_session_projects(authorization="Bearer nope", x_shadow_device=DEV))
    assert e.value.status_code in (401, 403)


def test_known_lines_leave_plan_edited_and_available_and_an_all_known_island_drops():
    pod = _island("podcast", 4, "Pod")
    _cards(pod, 4)
    voice = _island("voice", 6, "Voice")
    store.mark_known(DEV, pod, 1)
    store.mark_known(DEV, voice, 0)
    store.mark_known(DEV, voice, 5)
    assert {x["island_id"]: x["total"] for x in rs.available(DEV)} == {pod: 3, voice: 4}
    by = {x["island_id"]: x for x in rs.plan(DEV, 30)["projects"]}
    assert (by[pod]["picked"], by[pod]["total"]) == ([0, 2, 3], 3)
    assert (by[voice]["picked"], by[voice]["total"]) == ([1, 2, 3, 4], 4)
    edited = rs.plan(DEV, 30, edit=[(voice, 50), (pod, 50)])
    assert [x["picked"] for x in edited["projects"]] == [[1, 2, 3, 4], [0, 2, 3]]
    assert edited["size"] == 7
    # Every line known: the island is gone from all three.
    for i in (0, 2, 3):
        store.mark_known(DEV, pod, i)
    for i in range(1, 5):
        store.mark_known(DEV, voice, i)
    assert rs.available(DEV) == []
    assert rs.plan(DEV, 10)["projects"] == []
    assert rs.plan(DEV, 10, edit=[(pod, 5), (voice, 5)])["projects"] == []
    # Unmarking one line brings the island back with just that line.
    store.unmark_known(DEV, voice, 3)
    assert [(x["island_id"], x["total"]) for x in rs.available(DEV)] == [(voice, 1)]
    assert rs.plan(DEV, 10)["projects"][0]["picked"] == [3]


def test_language_filter_keeps_only_the_learning_language():
    ja_pod = _island("podcast", 5, "Pod")
    _cards(ja_pod, 3)
    es_isl = store.create_island("simple", 3, language="es", source="voice", device=DEV)
    for i in range(4):
        store.add_line(es_isl, i, {"ja": f"s{i}", "kana": "", "romaji": "", "en": f"e{i}"},
                       2.0, [], words=[])
    store.set_ready(es_isl, "First Date")
    _cards(es_isl, 2)
    es_voice = _island("voice", 4, "Spanish voice")
    with store.connect() as conn:
        conn.execute("UPDATE islands SET language='es' WHERE id=?", (es_voice,))
    with review_deck.connect() as conn:  # a card saved before cards kept their language
        conn.execute("UPDATE review_cards SET language='' WHERE island_id=?", (ja_pod,))

    ja = rs.plan(DEV, 30, language="ja")
    assert [p["island_id"] for p in ja["projects"]] == [ja_pod]
    es = rs.plan(DEV, 30, language="es")
    assert {p["island_id"] for p in es["projects"]} == {es_isl, es_voice}
    assert len(rs.plan(DEV, 30)["projects"]) == 3  # no language: every language
    assert [p["island_id"] for p in rs.available(DEV, "ja")] == [ja_pod]
    # an edited plan cannot pull in a project from another language
    edited = rs.plan(DEV, 5, edit=[(es_isl, 2), (ja_pod, 2)], language="ja")
    assert [p["island_id"] for p in edited["projects"]] == [ja_pod]

    got = asyncio.run(review_r.review_session_plan(size=30, language="es", authorization=AUTH,
                                               x_shadow_device=DEV))
    assert {p["island_id"] for p in got["projects"]} == {es_isl, es_voice}
    listed = asyncio.run(review_r.review_session_projects(language="ja", authorization=AUTH,
                                                      x_shadow_device=DEV))
    assert [p["island_id"] for p in listed["projects"]] == [ja_pod]
    started = asyncio.run(review_r.review_session_start(
        body=review_r.SessionStartBody(size=30, language="ja"), authorization=AUTH,
        x_shadow_device=DEV))
    assert [p["island_id"] for p in started["projects"]] == [ja_pod]


def test_beta_off_drops_video_and_podcast_cards_from_plan_available_and_routes():
    beta.delete_owner(DEV)
    pod = _island("podcast", 4, "Pod")
    _cards(pod, 4)
    vid = _island("youtube", 3, "Vid")
    _cards(vid, 3)
    voice = _island("voice", 5, "Voice")
    _cards(voice, 2)
    ids = lambda got: {p["island_id"] for p in got}  # noqa: E731
    assert ids(rs.plan(DEV, 30, beta_on=False)["projects"]) == {voice}
    assert ids(rs.available(DEV, beta_on=False)) == {voice}
    edited = rs.plan(DEV, 30, edit=[(pod, 2), (vid, 2), (voice, 2)], beta_on=False)
    assert ids(edited["projects"]) == {voice}
    assert ids(rs.plan(DEV, 30)["projects"]) == {pod, vid, voice}
    # The routes ask _beta_on: a plain device with no flag is off.
    got = asyncio.run(review_r.review_session_plan(size=30, authorization=AUTH, x_shadow_device=DEV))
    assert ids(got["projects"]) == {voice}
    listed = asyncio.run(review_r.review_session_projects(authorization=AUTH, x_shadow_device=DEV))
    assert ids(listed["projects"]) == {voice}
    started = asyncio.run(review_r.review_session_start(
        body=review_r.SessionStartBody(size=30), authorization=AUTH, x_shadow_device=DEV))
    assert ids(started["projects"]) == {voice}
    beta.set_flag(DEV, True, "test")
    got = asyncio.run(review_r.review_session_plan(size=30, authorization=AUTH, x_shadow_device=DEV))
    assert ids(got["projects"]) == {pod, vid, voice}


def _old_lines(island_id, known):
    """_load_lines before the light query: the whole island, lines filtered."""
    isl = store.get_island(island_id) or {"lines": []}
    return [{"idx": ln["idx"]} for ln in isl["lines"] if ln["idx"] not in known]


def _old_first(island_id, idx):
    isl = store.get_island(island_id) or {"lines": []}
    line = next((ln for ln in isl["lines"] if ln["idx"] == idx), None) or {}
    return {"island_id": island_id, "idx": idx, "ja": line.get("ja", ""),
            "kana": line.get("kana", ""), "en": line.get("en", ""),
            "words": line.get("words", [])}


def _old_latest(device):
    out = {}
    for row in store.list_take_scores(device):
        if row["whole_line"] == 1:
            out[(row["island_id"], row["idx"])] = row["total"]
    return out


def test_light_line_queries_match_the_whole_island_load():
    iid = store.create_island("simple", 3, source="voice", device=DEV)
    for i in (0, 1, 3, 4, 7):  # a gap, and lines added out of order below
        store.add_line(iid, i, {"ja": f"j{i}", "kana": f"k{i}", "romaji": "r", "en": f"e{i}"},
                       2.0, [{"m": "a", "t": 0.1}], words=[{"w": f"w{i}"}])
    store.add_line(iid, 2, {"ja": "j2", "kana": "", "romaji": "", "en": ""}, 1.0, [])
    store.set_ready(iid, "T")
    for known in (set(), {1, 4}, {0, 1, 2, 3, 4, 7}):
        p = {"island_id": iid, "lines": None, "known": known}
        assert rs._load_lines(p) == _old_lines(iid, known)
    for idx in (0, 2, 7, 5):  # 5 does not exist
        assert rs._first_line(DEV, {"island_id": iid}, idx) == _old_first(iid, idx)
    assert rs._first_line(DEV, {"island_id": "nope"}, 0) == _old_first("nope", 0)
    assert rs._load_lines({"island_id": "nope", "lines": None}) == []
    assert store.get_line(iid, 3) == store.get_island(iid)["lines"][3]


def test_latest_scores_sql_matches_the_python_filter():
    a, b = _island("voice", 4), _island("voice", 4)
    takes = [(a, 0, 50, True), (a, 0, 70, True), (a, 0, 99, False), (a, 1, None, True),
             (b, 0, 10, False), (b, 1, 40, True), (b, 1, 30, True), (a, 1, 60, True),
             (b, 2, 80, False)]
    for isl, idx, total, whole in takes:
        store.add_take_score(DEV, isl, idx, "ja", {"total": total, "parts": {}}, 1.0, whole)
    store.add_take_score("someone-else", a, 2, "ja", {"total": 1, "parts": {}}, 1.0, True)
    assert rs.latest_scores(DEV) == _old_latest(DEV)
    assert rs.latest_scores(DEV) == {(a, 0): 70, (a, 1): 60, (b, 1): 30}
    assert rs.latest_scores("nobody") == {}


def test_plan_and_available_builds_projects_once_with_the_same_answers(monkeypatch):
    pod, voice = _island("podcast", 6), _island("voice", 5)
    _cards(pod, 4)
    _island("voice", 3)
    store.add_take_score(DEV, voice, 2, "ja", {"total": 10, "parts": {}}, 1.0, True)
    for kw in ({}, {"edit": [(voice, 2), (pod, 3)]}):
        want_plan, want_av = rs.plan(DEV, 5, **kw), rs.available(DEV)
        calls = {"n": 0}
        real = rs._projects

        def counting(*a, **k):
            calls["n"] += 1
            return real(*a, **k)

        monkeypatch.setattr(rs, "_projects", counting)
        got = rs.plan_and_available(DEV, 5, **kw)
        monkeypatch.setattr(rs, "_projects", real)
        assert calls["n"] == 1
        assert got.pop("catalogue") == want_av
        assert got == want_plan
    routed = asyncio.run(review_r.review_session_plan(
        size=5, catalogue=1, authorization=AUTH, x_shadow_device=DEV))
    assert routed.pop("catalogue") == rs.available(DEV) and routed == rs.plan(DEV, 5)
    assert "catalogue" not in asyncio.run(review_r.review_session_plan(
        size=5, authorization=AUTH, x_shadow_device=DEV))
