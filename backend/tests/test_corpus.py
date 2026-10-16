import corpus


def _row(lang, text, en, sid):
    return {"lang": lang, "text": text, "en": en, "tatoeba_id": sid, "en_id": sid + 1000,
            "username": "u", "en_username": "e"}


ROWS = [
    _row("ja", "ジムに行きます。", "I go to the gym.", 1),
    _row("ja", "筋トレは楽しいです。", "Weight training is fun.", 2),
    _row("ja", "私は毎日ジムで運動をして健康的な生活を送るように心がけています。", "I exercise at the gym daily to stay healthy.", 3),
    _row("ja", "寿司が好きです。", "I like sushi.", 4),
    _row("es", "Voy al gimnasio todos los días.", "I go to the gyms every day.", 5),
    _row("es", "El baño está ocupado.", "The bathroom is busy.", 6),
    _row("es", "Me gusta la comida mexicana.", "I like Mexican food.", 7),
    _row("es", "Voy al gimnasio hoy.", "I go to the gyms every day.", 8),
    _row("es", "Hoy voy al gimnasio con mis amigos de la universidad cada semana.", "I go to the gym with college friends weekly.", 9),
]


def _fixture(tmp_path, monkeypatch, rows=ROWS):
    path = tmp_path / "tatoeba.db"
    corpus.build(str(path), rows)
    monkeypatch.setattr(corpus, "DB_PATH", path)
    return path


def test_english_prefix_hit(tmp_path, monkeypatch):
    _fixture(tmp_path, monkeypatch)
    got = corpus.search("es", ["gym"], "simple")
    assert got and all("gimnasio" in r["text"] for r in got)


def test_spanish_diacritics_insensitive(tmp_path, monkeypatch):
    _fixture(tmp_path, monkeypatch)
    got = corpus.search("es", ["bano"], "simple")
    assert [r["id"] for r in got] == [6]


def test_japanese_keyword_via_tokenizer(tmp_path, monkeypatch):
    _fixture(tmp_path, monkeypatch)
    got = corpus.search("ja", ["ジム", "筋トレ"], "simple")
    assert {r["id"] for r in got} == {1, 2}


def test_level_cap_and_dedupe(tmp_path, monkeypatch):
    _fixture(tmp_path, monkeypatch)
    simple = corpus.search("ja", ["gym", "ジム"], "simple")
    assert 3 not in {r["id"] for r in simple}
    assert 3 in {r["id"] for r in corpus.search("ja", ["gym"], "complex")}
    es = corpus.search("es", ["gym"], "complex")
    assert len({r["en"] for r in es}) == len(es)
    assert 9 in {r["id"] for r in es}
    assert 9 not in {r["id"] for r in corpus.search("es", ["gym"], "simple")}


def test_limit(tmp_path, monkeypatch):
    texts = ["Voy al gimnasio los lunes.", "El gimnasio cierra tarde.", "Mi hermana odia el gimnasio nuevo.",
             "Pagamos mucho por el gimnasio.", "Cerca del gimnasio hay un parque grande.", "Ayer vi a Pedro en el gimnasio."]
    rows = [_row("es", t, f"Gym {i}.", i) for i, t in enumerate(texts)]
    _fixture(tmp_path, monkeypatch, rows)
    assert len(corpus.search("es", ["gimnasio"], "simple", limit=3)) == 3


def test_hostile_keywords(tmp_path, monkeypatch):
    _fixture(tmp_path, monkeypatch)
    for kw in ['"', "*", "OR", "(", 'a" OR "b', "NEAR(", "gym*)"]:
        assert isinstance(corpus.search("es", [kw], "simple"), list)
    assert corpus.search("es", ["", "x"], "simple") == []


def test_missing_db(tmp_path, monkeypatch):
    monkeypatch.setattr(corpus, "DB_PATH", tmp_path / "none.db")
    assert corpus.search("ja", ["gym"], "simple") == []
    assert corpus.search("en", ["gym"], "simple") == []
    assert corpus.status() is None


def test_status(tmp_path, monkeypatch):
    _fixture(tmp_path, monkeypatch)
    s = corpus.status()
    assert s["count_ja"] == "4" and s["count_es"] == "5"


def test_pairs_from_exports():
    sentences = [
        (1, "spa", "Voy al gimnasio.", "ana"),
        (2, "spa", "Hola", "bob"),  # one word, dropped
        (3, "spa", "Mira https://x.com ahora mismo", "c"),  # URL
        (4, "spa", "Quiero un café, por favor.", "d"),
        (5, "spa", "Sin traducción aquí.", "e"),
    ]
    links = [(1, 11), (1, 12), (1, 13), (1, 14), (1, 15), (2, 16), (4, 20), (3, 21)]
    en = [
        (11, "eng", "I go to the gym.", "x"), (12, "eng", "I am going to the gym.", "x"),
        (13, "eng", "I head to the gym.", "x"), (14, "eng", "Gym time.", "x"),
        (15, "eng", "Off to the gym.", "x"), (16, "eng", "Hello there.", "x"),
        (20, "eng", "I want a coffee, please.", "y"), (21, "eng", "Look now.", "z"),
        (99, "eng", "Unlinked sentence here.", "q"),
    ]
    out = list(corpus.pairs_from_exports("es", sentences, links, en))
    by_src = {}
    for r in out:
        by_src.setdefault(r["tatoeba_id"], []).append(r["en_id"])
    assert by_src == {1: [11, 12, 13], 4: [20]}
    assert out[0]["username"] == "ana" and out[0]["en_username"] == "x"
    ja = list(corpus.pairs_from_exports("ja", [(1, "jpn", "ジム", "u"), (2, "jpn", "ジムに行きます。", "u")],
                                        [(1, 5), (2, 5)], [(5, "eng", "I go to the gym.", "x")]))
    assert [r["tatoeba_id"] for r in ja] == [2]


def test_near_twin_seeds_deduped(tmp_path, monkeypatch):
    rows = [
        _row("ja", "彼は毎日ジムに行っている。", "He goes to the gym daily.", 1),
        _row("ja", "彼は毎日ジムに行っていた。", "He went to the gym daily.", 2),
        _row("ja", "ジムは駅の近くです。", "The gym is near the station.", 3),
    ]
    _fixture(tmp_path, monkeypatch, rows)
    got = corpus.search("ja", ["ジム"], "complex")
    assert len(got) == 2 and 3 in {r["id"] for r in got}


def test_stopword_keywords_dropped():
    assert corpus._fts_query("es", ["the", "de", "La"]) == ""
    assert corpus._fts_query("ja", ["の", "は"]) == ""
    assert corpus._fts_query("es", ["the", "gym"]) == '"gym"*'
