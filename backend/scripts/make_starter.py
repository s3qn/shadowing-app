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
import lang_text  # noqa: E402
import languages  # noqa: E402
import phrase_catalog  # noqa: E402
import segment  # noqa: E402
import store  # noqa: E402
import voices  # noqa: E402
# aliased: the `build` coroutine below would shadow the module
from services import build as build_svc  # noqa: E402

LANGS = tuple(languages.LANGUAGES)

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
    # lang-core: fr, pt (Brazilian) and zh (Simplified), same three moments.
    "fr": [
        ("Bonjour.", "Hello.", "שלום."),
        # No space before the question mark: the whitespace tokenizer would
        # make it a zero-length word.
        ("D'où venez-vous?", "Where are you from?", "מאיפה אתה?"),
        ("Demain, je vais étudier le français avec un ami.",
         "Tomorrow I'm going to study French with a friend.", "מחר אלמד צרפתית עם חבר."),
    ],
    "pt": [
        ("Bom dia.", "Good morning.", "בוקר טוב."),
        ("De onde você é?", "Where are you from?", "מאיפה אתה?"),
        ("Amanhã eu vou estudar português com um amigo.",
         "Tomorrow I'm going to study Portuguese with a friend.", "מחר אלמד פורטוגזית עם חבר."),
    ],
    "zh": [
        ("你好。", "Hello.", "שלום."),
        ("你是哪里人？", "Where are you from?", "מאיפה אתה?"),
        ("明天我要和朋友一起学中文。",
         "Tomorrow I'm going to study Chinese with a friend.", "מחר אלמד סינית עם חבר."),
    ],
    # ko (haeyo-che), de (du), he (spoken) and ar (MSA), same three moments.
    "ko": [
        ("안녕하세요.", "Hello.", "שלום."),
        ("어디에서 오셨어요?", "Where are you from?", "מאיפה אתה?"),
        ("내일 친구와 같이 한국어를 공부할 거예요.",
         "Tomorrow I'm going to study Korean with a friend.", "מחר אלמד קוריאנית עם חבר."),
    ],
    "de": [
        ("Hallo.", "Hello.", "שלום."),
        ("Woher kommst du?", "Where are you from?", "מאיפה אתה?"),
        ("Morgen lerne ich mit einem Freund Deutsch.",
         "Tomorrow I'm going to study German with a friend.", "מחר אלמד גרמנית עם חבר."),
    ],
    "he": [
        ("שלום.", "Hello.", "שלום."),
        ("מאיפה אתה?", "Where are you from?", "מאיפה אתה?"),
        ("מחר אני לומד עברית עם חבר.",
         "Tomorrow I'm going to study Hebrew with a friend.", "מחר אלמד עברית עם חבר."),
    ],
    "ar": [
        ("مرحبا.", "Hello.", "שלום."),
        ("من أين أنت؟", "Where are you from?", "מאיפה אתה?"),
        ("غدا سأدرس اللغة العربية مع صديق.",
         "Tomorrow I'm going to study Arabic with a friend.", "מחר אלמד ערבית עם חבר."),
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
    "fr": [
        ("Pourriez-vous m'indiquer le chemin de la gare?",
         "Could you tell me the way to the station?", "אפשר להסביר לי איך מגיעים לתחנה?"),
        ("Ce week-end, je compte aller au cinéma avec des amis.",
         "This weekend I'm planning to go to the cinema with some friends.",
         "בסוף השבוע אני מתכנן ללכת לקולנוע עם כמה חברים."),
        ("Depuis que j'ai emménagé ici, me promener dans le quartier chaque matin "
         "est devenu une habitude.",
         "Since I moved here, a walk around the neighbourhood every morning has become a habit.",
         "מאז שעברתי לכאן, טיול בשכונה כל בוקר נהיה הרגל."),
    ],
    "pt": [
        ("Você pode me dizer como chegar à estação?",
         "Could you tell me how to get to the station?", "אפשר להגיד לי איך מגיעים לתחנה?"),
        ("Neste fim de semana, eu pretendo ir ao cinema com alguns amigos.",
         "This weekend I'm planning to go to the cinema with some friends.",
         "בסוף השבוע אני מתכנן ללכת לקולנוע עם כמה חברים."),
        ("Desde que me mudei para cá, passear pelo bairro toda manhã virou um hábito.",
         "Since I moved here, a walk around the neighbourhood every morning has become a habit.",
         "מאז שעברתי לכאן, טיול בשכונה כל בוקר נהיה הרגל."),
    ],
    "zh": [
        ("请问，去车站怎么走？",
         "Excuse me, how do I get to the station?", "סליחה, איך מגיעים לתחנה?"),
        ("这个周末我打算和几个朋友一起去看电影。",
         "This weekend I plan to go and see a movie with a few friends.",
         "בסוף השבוע אני מתכנן ללכת לראות סרט עם כמה חברים."),
        ("搬到这里以后，每天早上在附近散步成了我的习惯。",
         "Since moving here, a walk around the neighbourhood every morning has become my habit.",
         "מאז שעברתי לכאן, טיול בשכונה כל בוקר נהיה הרגל."),
    ],
    "ko": [
        ("역으로 가는 길을 알려 주시겠어요?",
         "Could you tell me the way to the station?", "אפשר להסביר לי איך מגיעים לתחנה?"),
        ("이번 주말에 친구들과 영화를 보러 갈 계획이에요.",
         "This weekend I plan to go and see a movie with friends.",
         "בסוף השבוע אני מתכנן ללכת לראות סרט עם חברים."),
        ("여기로 이사 온 뒤로 매일 아침 동네를 산책하는 게 습관이 되었어요.",
         "Since moving here, a walk around the neighbourhood every morning has become a habit.",
         "מאז שעברתי לכאן, טיול בשכונה כל בוקר נהיה הרגל."),
    ],
    "de": [
        ("Kannst du mir bitte den Weg zum Bahnhof zeigen?",
         "Could you show me the way to the station?", "אפשר להראות לי את הדרך לתחנה?"),
        ("Dieses Wochenende will ich mit ein paar Freunden ins Kino gehen.",
         "This weekend I want to go to the cinema with a few friends.",
         "בסוף השבוע אני רוצה ללכת לקולנוע עם כמה חברים."),
        ("Seit ich hierher gezogen bin, ist ein Spaziergang durch die Nachbarschaft jeden Morgen zur Gewohnheit geworden.",
         "Since I moved here, a walk around the neighbourhood every morning has become a habit.",
         "מאז שעברתי לכאן, טיול בשכונה כל בוקר נהיה הרגל."),
    ],
    "he": [
        ("אפשר להסביר לי איך מגיעים לתחנה?",
         "Could you tell me how to get to the station?", "אפשר להסביר לי איך מגיעים לתחנה?"),
        ("בסוף השבוע אני מתכנן ללכת לסרט עם כמה חברים.",
         "This weekend I'm planning to go to a movie with some friends.",
         "בסוף השבוע אני מתכנן ללכת לסרט עם כמה חברים."),
        ("מאז שעברתי לכאן, טיול בשכונה כל בוקר נהיה הרגל.",
         "Since I moved here, a walk around the neighbourhood every morning has become a habit.",
         "מאז שעברתי לכאן, טיול בשכונה כל בוקר נהיה הרגל."),
    ],
    "ar": [
        ("هل يمكنك أن تدلني على الطريق إلى المحطة؟",
         "Could you show me the way to the station?", "אפשר להראות לי את הדרך לתחנה?"),
        ("أنوي في نهاية هذا الأسبوع أن أذهب إلى السينما مع بعض الأصدقاء.",
         "This weekend I plan to go to the cinema with some friends.",
         "בסוף השבוע אני מתכנן ללכת לקולנוע עם כמה חברים."),
        ("منذ أن انتقلت إلى هنا أصبح التمشي في الحي كل صباح عادة لدي.",
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
    made = await build_svc._synthesize_lines(island_id, lines, speaker, lang)
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
        {"ja": t, "kana": segment.reading(t) if lang == "ja" else "",
         "romaji": "" if lang == "ja" else lang_text.reading(t, lang), "en": en}
        for t, en, _ in rows_in
    ]
    made = await build_svc._synthesize_lines(island_id, lines, speaker, lang)
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
