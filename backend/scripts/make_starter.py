"""Build pre-baked phrase templates (backend/starter/phrases/<lang>/<topic>/).

    SHADOW_DATA_DIR=<scratch> python backend/scripts/make_starter.py --lang ja --topic greetings
    SHADOW_DATA_DIR=<scratch> python backend/scripts/make_starter.py --all
    SHADOW_DATA_DIR=<scratch> python backend/scripts/make_starter.py --intro [--lang ja] [--level some]

Synthesises the catalogue's phrases into a scratch island (VOICEVOX for ja,
Kokoro for es and en) through the same path as _build_phrases, then writes
island.json and 0.wav..N.wav from it. Run once per combination and commit the
output; the app never calls this."""

import argparse
import asyncio
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if not os.environ.get("SHADOW_DATA_DIR"):
    sys.exit("set SHADOW_DATA_DIR to a scratch directory")

import generate  # noqa: E402
import main  # noqa: E402
import phrase_catalog  # noqa: E402
import segment  # noqa: E402
import store  # noqa: E402
import voices  # noqa: E402

LANGS = ("ja", "en", "es")

# (text, en gloss, he gloss) for the 3-line first-run island, graded by length.
INTRO: dict[str, list[tuple[str, str, str]]] = {
    "ja": [
        ("こんにちは。", "Hello.", "שלום."),
        ("どこの出身ですか。", "Where are you from?", "מאיפה אתה?"),
        ("明日は友達と一緒に日本語を勉強します。",
         "Tomorrow I will study Japanese with a friend.", "מחר אלמד יפנית עם חבר."),
    ],
    "en": [
        ("Good morning.", "Good morning.", "בוקר טוב."),
        ("Where are you from?", "Where are you from?", "מאיפה אתה?"),
        ("Tomorrow I'm going to study English with a friend.",
         "Tomorrow I'm going to study English with a friend.", "מחר אלמד אנגלית עם חבר."),
    ],
    "es": [
        ("Buenos días.", "Good morning.", "בוקר טוב."),
        ("¿De dónde eres?", "Where are you from?", "מאיפה אתה?"),
        ("Mañana voy a estudiar español con un amigo.",
         "Tomorrow I'm going to study Spanish with a friend.", "מחר אלמד ספרדית עם חבר."),
    ],
}
# The same island for a learner who picked "I know some": longer lines, the
# same title (backend/starter/intro-some/<lang>/).
INTRO_SOME: dict[str, list[tuple[str, str, str]]] = {
    "ja": [
        ("駅までの道を教えてもらえますか。", "Could you tell me the way to the station?",
         "אפשר להסביר לי איך מגיעים לתחנה?"),
        ("週末は友達と映画を見に行く予定です。",
         "This weekend I plan to see a movie with friends.",
         "בסוף השבוע אני מתכנן לראות סרט עם חברים."),
        ("日本に来てから、毎朝近所を散歩するのが習慣になりました。",
         "Since coming to Japan, a morning walk around the neighbourhood has become a habit.",
         "מאז שהגעתי ליפן, טיול בוקר בשכונה נהיה הרגל."),
    ],
    "en": [
        ("Could you tell me the way to the station?",
         "Could you tell me the way to the station?", "אפשר להסביר לי איך מגיעים לתחנה?"),
        ("This weekend I'm planning to see a movie with some friends.",
         "This weekend I'm planning to see a movie with some friends.",
         "בסוף השבוע אני מתכנן לראות סרט עם כמה חברים."),
        ("Since I moved here, a walk around the neighbourhood every morning has become a habit.",
         "Since I moved here, a walk around the neighbourhood every morning has become a habit.",
         "מאז שעברתי לכאן, טיול בשכונה כל בוקר נהיה הרגל."),
    ],
    "es": [
        ("¿Me puede decir cómo llegar a la estación?",
         "Could you tell me how to get to the station?", "אפשר להגיד לי איך מגיעים לתחנה?"),
        ("Este fin de semana pienso ir al cine con unos amigos.",
         "This weekend I'm planning to go to the cinema with some friends.",
         "בסוף השבוע אני מתכנן ללכת לקולנוע עם כמה חברים."),
        ("Desde que me mudé aquí, pasear por el barrio cada mañana se ha vuelto una costumbre.",
         "Since I moved here, a walk around the neighbourhood every morning has become a habit.",
         "מאז שעברתי לכאן, טיול בשכונה כל בוקר נהיה הרגל."),
    ],
}
INTRO_TITLE = {"en": "First steps", "he": "צעדים ראשונים"}
INTRO_LEVELS = ("new", "some")


async def build(lang: str, topic: str) -> None:
    store.init()
    entries = phrase_catalog.phrases(lang, topic)
    texts = [e["text"] for e in entries]
    en = [e.get("en", "") for e in entries]
    he = [e.get("he", "") for e in entries]
    if not all(he):
        he = await asyncio.to_thread(generate.translate_lines, texts, lang, "he")
    speaker = voices.default_speaker(lang)
    island_id = store.create_island("simple", speaker, language=lang, source="phrases")
    lines = [
        {"ja": t, "kana": segment.reading(t) if lang == "ja" else "", "romaji": "", "en": en[i]}
        for i, t in enumerate(texts)
    ]
    made = await main._synthesize_lines(island_id, lines, speaker, lang)
    if made != len(lines):
        sys.exit(f"{lang}/{topic}: only {made} of {len(lines)} lines synthesised")
    island = store.get_island(island_id)
    out = Path(__file__).resolve().parent.parent / "starter" / "phrases" / lang / topic
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, line in enumerate(island["lines"]):
        rows.append({
            "ja": line["ja"], "kana": line["kana"], "romaji": line["romaji"],
            "gloss": {"en": en[i], "he": he[i] if i < len(he) else ""},
            "duration": line["duration"], "timeline": line["timeline"], "words": line["words"],
        })
        shutil.copyfile(store.line_audio_path(island_id, i), out / f"{i}.wav")
    (out / "island.json").write_text(
        json.dumps({"language": lang, "topic": topic, "lines": rows},
                   ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("wrote", out)


async def build_intro(lang: str, level: str = "new") -> None:
    store.init()
    rows_in = (INTRO if level == "new" else INTRO_SOME)[lang]
    folder = "intro" if level == "new" else "intro-some"
    speaker = voices.default_speaker(lang)
    island_id = store.create_island("simple", speaker, language=lang, source="starter")
    lines = [
        {"ja": t, "kana": segment.reading(t) if lang == "ja" else "", "romaji": "", "en": en}
        for t, en, _ in rows_in
    ]
    made = await main._synthesize_lines(island_id, lines, speaker, lang)
    if made != len(lines):
        sys.exit(f"{folder}/{lang}: only {made} of {len(lines)} lines synthesised")
    island = store.get_island(island_id)
    out = Path(__file__).resolve().parent.parent / "starter" / folder / lang
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, line in enumerate(island["lines"]):
        rows.append({
            "ja": line["ja"], "kana": line["kana"], "romaji": line["romaji"],
            "gloss": {"en": rows_in[i][1], "he": rows_in[i][2]},
            "duration": line["duration"], "timeline": line["timeline"], "words": line["words"],
        })
        shutil.copyfile(store.line_audio_path(island_id, i), out / f"{i}.wav")
    (out / "island.json").write_text(
        json.dumps({"language": lang, "title": INTRO_TITLE, "lines": rows},
                   ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("wrote", out)


async def build_all() -> None:
    for lang in LANGS:
        for topic in phrase_catalog.catalog(lang)["topics"]:
            await build(lang, topic["id"])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", choices=LANGS)
    ap.add_argument("--topic")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--intro", action="store_true")
    ap.add_argument("--level", choices=INTRO_LEVELS, default="new")
    a = ap.parse_args()
    if a.intro:
        async def _intro() -> None:
            for lang in ([a.lang] if a.lang else LANGS):
                await build_intro(lang, a.level)
        asyncio.run(_intro())
    elif a.all:
        asyncio.run(build_all())
    elif a.lang and a.topic:
        asyncio.run(build(a.lang, a.topic))
    else:
        ap.error("give --lang and --topic, or --all")
