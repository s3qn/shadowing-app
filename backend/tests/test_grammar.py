import json
import sqlite3

import generate
import grammar

SENTINEL = "SENTINEL_EXAMPLE_TEXT"


def _anki(decks, notes):
    """In-memory Anki-shaped db. notes: (flds list, deck id)."""
    c = sqlite3.connect(":memory:")
    c.execute("CREATE TABLE col(decks TEXT)")
    c.execute("CREATE TABLE notes(id INTEGER, mid INTEGER, tags TEXT, flds TEXT)")
    c.execute("CREATE TABLE cards(nid INTEGER, did INTEGER)")
    c.execute("INSERT INTO col VALUES(?)", (json.dumps({str(k): {"name": v} for k, v in decks.items()}),))
    for i, (flds, did) in enumerate(notes, 1):
        c.execute("INSERT INTO notes VALUES(?,?,?,?)", (i, 1, "", "\x1f".join(flds)))
        c.execute("INSERT INTO cards VALUES(?,?)", (i, did))
    return c


def _nk_note(pattern, conn="V + x", extra=SENTINEL):
    f = [""] * 20
    f[0], f[1], f[2], f[4], f[5] = pattern, extra, conn, extra, extra
    return f


def _nk(pattern, level="N5", conn=""):
    return {"pattern": pattern, "connection": conn, "level": level}


def _dojg(pattern, volume="Basic"):
    return {"pattern": pattern, "volume": volume}


def _by_id(rows):
    return {r["id"]: r for r in rows}


def test_schema_has_only_the_eight_columns(tmp_path):
    rows = grammar.points_from_decks([_nk("<h2>〜ながら</h2>")], [_dojg("あげる (1)")])
    path = tmp_path / "g.db"
    grammar.build(str(path), rows)
    db = sqlite3.connect(path)
    cols = [r[1] for r in db.execute("PRAGMA table_info(points)")]
    assert cols == ["id", "pattern", "reading", "level", "level_guess", "connection", "meaning_short", "source"]
    for word in ("example", "usage", "explanation", "equivalent", "例文", "意味", "備考"):
        assert word not in grammar.SCHEMA


def test_readers_never_return_other_fields():
    decks = {1: "文法::2. N5"}
    nk = _anki(decks, [(_nk_note("<h2>〜ながら</h2>"), 1)])
    rows = list(grammar.nk_rows(nk))
    assert all(set(r) == {"pattern", "connection", "level"} for r in rows)
    assert SENTINEL not in json.dumps(rows, ensure_ascii=False)
    assert rows[0]["level"] == "N5"
    f = [""] * 40
    f[0], f[1], f[2], f[3], f[8], f[10] = "あげる (1)", SENTINEL, SENTINEL, "Basic", SENTINEL, SENTINEL
    dj = _anki({1: "DoJG"}, [(f, 1)])
    drows = list(grammar.dojg_rows(dj))
    assert all(set(r) == {"pattern", "volume"} for r in drows)
    assert SENTINEL not in json.dumps(drows, ensure_ascii=False)
    assert drows[0]["volume"] == "Basic"


def test_nk_level_from_deck_name():
    decks = {1: "文法::1. JLPTに出ない？文型", 2: "文法::6. N1"}
    nk = _anki(decks, [(_nk_note("A"), 1), (_nk_note("B"), 2)])
    assert [r["level"] for r in grammar.nk_rows(nk)] == ["", "N1"]


def test_merge_rules():
    nk = [
        _nk("～すぎです", "N4"),
        _nk("終わる", "N3", "V + x"),
        _nk("「〜てから」と「〜あとで」の違い"),
        _nk("〜によって（誤用）"),
        _nk("〜向けに / 類似文型「〜向き」との違い", "N2"),
        _nk("AながらB", "N4"),
        _nk("〜だけ", "N3"),
        _nk("〜だけ", "N5"),
        _nk("〜方（かた）", "N4"),
    ]
    dojg = [_dojg("過ぎる・すぎる (1)"), _dojg("終わる・おわる (2)"), _dojg("だけで(は)なく～(も)", "Advanced")]
    got = _by_id(grammar.points_from_decks(nk, dojg))
    assert "すぎです" in got and "過ぎる" in got
    assert got["すぎです"]["source"] == "nk"
    o = got["終わる"]
    assert (o["source"], o["level"], o["level_guess"], o["reading"], o["connection"]) == ("nk+dojg", "N3", 0, "おわる", "V + x")
    d = got["だけで(は)なく(も)"]
    assert (d["level"], d["level_guess"], d["source"]) == ("N1", 1, "dojg")
    assert got["向けに"]["pattern"] == "〜向けに"
    assert "ながら" in got
    assert got["だけ"]["level"] == "N5" and got["だけ"]["source"] == "nk"
    assert got["方"]["reading"] == "かた" and got["方"]["pattern"] == "〜方"
    assert not any("違い" in k or "誤用" in k or "によって" == k for k in got)
    assert len(got) == len({r["id"] for r in got.values()})


def _db(tmp_path, monkeypatch):
    rows = grammar.points_from_decks(
        [_nk("AながらB", "N5"), _nk("〜たり", "N5"), _nk("〜てから", "N4")], []
    )
    path = tmp_path / "grammar.db"
    grammar.build(str(path), rows)
    monkeypatch.setattr(grammar, "DB_PATH", path)
    return rows


def test_readers(tmp_path, monkeypatch):
    _db(tmp_path, monkeypatch)
    lv = grammar.levels()
    assert [x["level"] for x in lv] == ["N5", "N4"]
    assert lv[0]["count"] == 2
    assert [p["id"] for p in grammar.list_points("N5")] == sorted(p["id"] for p in grammar.list_points("N5"))
    assert grammar.get("ながら")["pattern"] == "AながらB"
    assert grammar.get("nope") is None
    assert "ながら" in {p["id"] for p in grammar.search("なが")}
    assert grammar.match("ながら")["id"] == "ながら"
    assert grammar.match("〜ながら。")["id"] == "ながら"
    assert grammar.match("phrases for the gym") is None
    assert grammar.match("") is None


def test_match_by_reading(tmp_path, monkeypatch):
    rows = grammar.points_from_decks([_nk("終わる", "N5")], [_dojg("終わる・おわる")])
    path = tmp_path / "grammar.db"
    grammar.build(str(path), rows)
    monkeypatch.setattr(grammar, "DB_PATH", path)
    assert grammar.match("おわる")["id"] == "終わる"


def test_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(grammar, "DB_PATH", tmp_path / "none.db")
    assert grammar.levels() == []
    assert grammar.list_points("N5") == []
    assert grammar.get("x") is None
    assert grammar.search("x") == []
    assert grammar.match("x") is None


def test_meanings(monkeypatch):
    rows = grammar.points_from_decks([_nk("AながらB"), _nk("〜たり")], [])
    monkeypatch.setattr(generate, "_run_cli", lambda prompt, tag: json.dumps(["while doing", "doing things"]))
    assert grammar.add_meanings(rows) == 2
    assert {r["meaning_short"] for r in rows} == {"while doing", "doing things"}
    rows2 = grammar.points_from_decks([_nk("AながらB"), _nk("〜たり")], [])
    monkeypatch.setattr(generate, "_run_cli", lambda prompt, tag: json.dumps(["only one"]))
    assert grammar.add_meanings(rows2) == 0
    assert all(r["meaning_short"] == "" for r in rows2)
