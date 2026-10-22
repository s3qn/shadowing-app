"""caption_timing: the even-spread signature, the backfill (dry run by
default) and the scorer that measures the trim against exact word times."""

import caption_timing
import segment
import store

DEV = "dev-caption-timing"

store.init()


def _youtube_island(texts, durations, words=None):
    island_id = store.create_island("simple", 3, language="ja", source="youtube",
                                    source_name="abc", device=DEV)
    store.add_video(island_id, "abc", 0.0, "t", "")
    for i, (text, duration) in enumerate(zip(texts, durations)):
        w = words[i] if words and words[i] is not None else segment.align_pieces(text, [], duration)
        store.add_line(island_id, i, {"ja": text}, duration, [], w, offset=1.0 + i * 2.2)
    store.set_ready(island_id, "t")
    return island_id


def _line_words(island_id):
    return [ln["words"] for ln in store.get_island(island_id)["lines"]]


def test_is_even_matches_the_even_spread_and_not_a_trimmed_line():
    text = "今日は学校に行きます。"
    even = segment.align_pieces(text, [], 2.0)
    assert caption_timing.is_even(text, 2.0, even)
    trimmed = segment.align_pieces(text, [], 2.0, speech_end=1.2)
    assert not caption_timing.is_even(text, 2.0, trimmed)
    assert not caption_timing.is_even(text, 2.0, [])


def test_backfill_dry_run_reports_and_writes_nothing():
    texts = ["こんにちは", "元気ですか", "ありがとうございます"]
    hand = [{"text": texts[2], "start": 0.0, "end": 1.5, "pos": "other", "ruby": []}]
    island_id = _youtube_island(texts, [2.0, 2.0, 2.0], words=[None, None, hand])
    before = _line_words(island_id)

    report = caption_timing.backfill(apply=False, island=island_id)

    assert report["flagged"] == 2 and report["written"] == 0
    (isl,) = report["islands"]
    assert isl["id"] == island_id and isl["flagged"] == 2 and isl["rate"] == 6.0
    assert isl["trimmed_s"] > 0 and 0 < isl["silence_share"] < 1
    assert _line_words(island_id) == before


def test_backfill_apply_rewrites_even_lines_once():
    texts = ["こんにちは", "元気ですか", "ありがとうございます"]
    hand = [{"text": texts[2], "start": 0.0, "end": 1.5, "pos": "other", "ruby": []}]
    island_id = _youtube_island(texts, [2.0, 2.0, 2.0], words=[None, None, hand])

    report = caption_timing.backfill(apply=True, island=island_id)
    assert report["flagged"] == 2 and report["written"] == 2
    words = _line_words(island_id)
    assert words[0][-1]["end"] < 2.0 and words[1][-1]["end"] < 2.0
    assert words[0][0]["start"] == 0.0
    assert words[2] == hand

    again = caption_timing.backfill(apply=True, island=island_id)
    assert again["flagged"] == 0 and again["written"] == 0
    assert _line_words(island_id) == words


def _voice_island():
    island_id = store.create_island("simple", 3, language="ja", source="voice", device=DEV)
    lines = [
        ("今日は学校に行きます。", 2.0, [("今日", 0.0, 0.333), ("は", 0.333, 0.5), ("学校", 0.5, 1.167),
                                   ("に", 1.167, 1.333), ("行きます。", 1.333, 2.0)]),
        ("明日は雨が降るそうです。", 2.167, [("明日", 0.0, 0.5), ("は", 0.5, 0.667), ("雨", 0.667, 1.0),
                                       ("が", 1.0, 1.167), ("降る", 1.167, 1.5), ("そうです。", 1.5, 2.167)]),
        ("駅まで歩いて十分くらいです。", 2.833, [("駅", 0.0, 0.333), ("まで", 0.333, 0.667),
                                         ("歩いて", 0.667, 1.333), ("十分", 1.333, 2.0),
                                         ("くらいです。", 2.0, 2.833)]),
    ]
    for i, (text, duration, spans) in enumerate(lines):
        words = [{"text": t, "start": s, "end": e, "pos": "other", "ruby": []} for t, s, e in spans]
        timeline = [{"text": "x", "start": 0.0, "end": duration}]
        store.add_line(island_id, i, {"ja": text}, duration, timeline, words)
    store.set_ready(island_id, "voice")
    return island_id


def test_backfill_skips_islands_that_are_not_youtube():
    island_id = _voice_island()
    report = caption_timing.backfill(apply=False, island=island_id)
    assert report["islands"] == [] and report["flagged"] == 0


def test_score_after_beats_before_on_exact_words():
    island_id = _voice_island()

    result = caption_timing.score(seed=1, island=island_id)

    (isl,) = result["islands"]
    assert isl["id"] == island_id and isl["lines"] == 3
    total = result["total"]
    assert total["lines"] == 3
    assert total["after"]["overlap"] >= total["before"]["overlap"]
    assert total["after"]["mean_err"] <= total["before"]["mean_err"]
    assert total["after"]["p90_err"] <= total["before"]["p90_err"]
    assert total["after"]["overlap"] > total["before"]["overlap"]
    assert "overlap" in caption_timing.format_score(result)


# --- yt-precise -----------------------------------------------------------------

def _exact_island(texts, durations):
    """A ja island with exact word times (the even spread stands in for the
    VOICEVOX timeline) and a non-youtube source, which the scorers read."""
    island_id = store.create_island("simple", 3, language="ja", device=DEV)
    for i, (text, duration) in enumerate(zip(texts, durations)):
        words = segment.align_pieces(text, [], duration)
        store.add_line(island_id, i, {"ja": text}, duration, [{"t": 0}], words)
    store.set_ready(island_id, "v")
    return island_id


def test_score_transfer_after_beats_before():
    texts = ["今日は東京の天気を見ていきましょう。", "朝はよく晴れています。", "午後からは雲が広がる見込みです。",
             "傘を持って出かけてください。", "明日も晴れるでしょう。", "気温は二十度くらいです。",
             "風は弱いです。", "それでは、また明日。", "おはようございます。", "放送を始めます。",
             "よろしくお願いします。", "さようなら。"]
    island_id = _exact_island(texts * 2, [3.0, 2.0, 2.8, 2.4, 2.0, 2.2, 1.5, 2.0, 1.8, 1.6, 1.9, 1.3] * 2)
    result = caption_timing.score_transfer(seed=1, island=island_id)
    (row,) = result["islands"]
    before, after = row["before"], row["after"]
    assert before["lines"] >= 10 and after["lines"] >= 10
    for key in ("mean", "p90", "max"):
        assert after[key] < before[key], (key, before, after)
    assert after["within"] > before["within"]
    assert after["within"] >= 0.9
    assert "total" in caption_timing.format_score_transfer(result)
