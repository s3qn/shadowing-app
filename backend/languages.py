"""The learning languages, one table for every backend decision that used to be
an `if language == "ja"` or a `("ja", "es", "en")` copy.

A language is *known* when it has a row here. It is *enabled* for a device when
the gate lists it: `SHADOW_LANGS` (default ja,es,en) is on for everyone,
`SHADOW_LANGS_BETA` (default empty) only for devices whose beta switch is on.
It is *available* when it is known, a voice speaks it and both first-run starter
islands are baked. A route accepts a learning language only when it is enabled
for the device and available; the client gets the same list from /shadow/beta.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

from fastapi import HTTPException

log = logging.getLogger(__name__)

DEFAULT_LANGS = "ja,es,en"


@dataclass(frozen=True)
class Lang:
    code: str
    name_en: str
    # whisper language code
    asr_language: str
    # whisper model key: "default" is the shared model; a language can pin its own
    asr_model: str
    # initial_prompt for a pinned transcription: steers script and spelling
    asr_prompt: str
    rtl: bool
    cjk: bool
    # how the line's reading is made: "kana" (VOICEVOX), "pinyin" and "rr"
    # (libraries at build time), "translit" (the model writes it), None (none)
    reading: str | None
    # how a line splits into tappable words
    segmenter: str  # "mora" | "jieba" | "space"
    # the unit take scoring compares
    score_unit: str  # "mora" | "char" | "syllable" | "word"
    # Kokoro / espeak language code; None for VOICEVOX
    tts_lang: str | None
    # prompt rules for the line generator, written from research/languages/<code>.md
    style: str
    # on for everyone at launch
    launch: bool


READINGS = ("kana", "pinyin", "rr", "translit", None)
SEGMENTERS = ("mora", "jieba", "space")
SCORE_UNITS = ("mora", "char", "syllable", "word")

_ROWS = (
    Lang(
        "ja", "Japanese", "ja", "default", "", False, True, "kana", "mora", "mora", None,
        "Write natural spoken Japanese in the register asked for, in kanji and kana as a "
        "native text would, with no romaji. Write numbers in kanji or kana words, never digits.",
        True,
    ),
    Lang(
        "es", "Spanish", "es", "default", "", False, False, None, "space", "word", "es",
        "",
        True,
    ),
    Lang(
        "en", "English", "en", "default", "", False, False, None, "space", "word", "en-us",
        "",
        True,
    ),
    Lang(
        "fr", "French", "fr", "default",
        "Bonjour, comment allez-vous ? Je m'appelle Marie.",
        False, False, None, "space", "word", "fr-fr",
        "Write natural spoken French in sentence case, keeping accents on capitals (À, É, Ç). "
        "Put a space before ? ! ; and : as French print does. Keep elisions and hyphenated clitics glued to their words (l'homme, est-ce que, "
        "dis-moi) and write numbers as words (soixante-dix, quatre-vingt-trois). Use vous with "
        "strangers and tu between friends, as the situation calls for.",
        False,
    ),
    Lang(
        "pt", "Brazilian Portuguese", "pt", "default",
        "Olá, tudo bem? Hoje vamos falar sobre trabalho.",
        False, False, None, "space", "word", "pt-br",
        "Write natural spoken Brazilian Portuguese with pt-BR spelling and vocabulary (ação, "
        "você, ônibus). Keep every accent and the cedilla, use only closing ? and ! marks, and "
        "keep hyphenated clitics and compounds as one word. Put clitic pronouns before the verb "
        "as in speech (me dá) and write numbers as words with the e between parts (mil e vinte).",
        False,
    ),
    Lang(
        "zh", "Mandarin Chinese", "zh", "default",
        "你好，今天我们聊聊工作。",
        False, True, "pinyin", "jieba", "char", "cmn",
        "Write Simplified Chinese (Mainland standard) with full-width punctuation (。，、？！) and "
        "no spaces between words. Write numbers as Chinese numerals (两个人, 二零二六年), never "
        "Arabic digits. Keep sentences short and spoken, with common vocabulary, and put no "
        "pinyin in the text.",
        False,
    ),
    Lang(
        "ko", "Korean", "ko", "default",
        "안녕하세요. 오늘은 일에 대해 이야기해요.",
        False, False, "rr", "space", "syllable", "ko",
        "Write natural spoken Korean in the polite 해요체 style with standard spacing: particles "
        "and endings attach to their word. Write numbers in Hangul words, native or Sino-Korean "
        "as the counter requires (세 시 십오 분, 스무 살). Put no romanization in the text.",
        False,
    ),
    Lang(
        "de", "German", "de", "default", "", False, False, None, "space", "word", "de",
        "Write natural spoken German with standard orthography: nouns capitalised, ß where the "
        "rule puts it, umlauts never replaced by ae, oe or ue. Use Sie with strangers and du among "
        "friends, as the situation calls for. Write numbers, dates and times as words "
        "(einundzwanzig, am dritten Mai, halb drei).",
        False,
    ),
    Lang(
        "he", "Hebrew", "he", "default", "", True, False, "translit", "space", "word", "he",
        "Write natural spoken Israeli Hebrew without nikud, as everyday text is written. "
        "First-person lines are masculine unless the transcript shows otherwise, and the gender "
        "stays the same across all the lines. Write numbers as words.",
        False,
    ),
    Lang(
        "ar", "Modern Standard Arabic", "ar", "default", "", True, False, "translit", "space",
        "word", "ar",
        "Write Modern Standard Arabic in a spoken, conversational register: short sentences, "
        "common words, greetings and questions as people say them. Vowel the text fully with "
        "tashkeel but write no case endings (pausal style). Use the Arabic comma ، and question "
        "mark ؟, write numbers as words, and never use Arabizi or Latin letters.",
        False,
    ),
)

LANGUAGES: dict[str, Lang] = {row.code: row for row in _ROWS}

# Names for prompts, in place of generate.LANGUAGE_NAMES and align.LANGUAGE_NAMES.
NAMES: dict[str, str] = {code: row.name_en for code, row in LANGUAGES.items()}


def get(code: str) -> Lang | None:
    return LANGUAGES.get(code)


def asr_prompt(code: str) -> str:
    row = LANGUAGES.get(code)
    return row.asr_prompt if row else ""


def asr_model(code: str) -> str:
    row = LANGUAGES.get(code)
    return row.asr_model if row else "default"


def _env_codes(name: str, default: str) -> list[str]:
    """The known codes an env list names, in table order, unknown ones dropped."""
    raw = os.environ.get(name)
    picked = {c.strip() for c in (raw if raw is not None else default).split(",")}
    return [code for code in LANGUAGES if code in picked]


def launch_codes() -> list[str]:
    """Enabled for every device."""
    return _env_codes("SHADOW_LANGS", DEFAULT_LANGS)


def beta_codes() -> list[str]:
    """Enabled only where the beta switch is on."""
    return _env_codes("SHADOW_LANGS_BETA", "")


def enabled(beta_on: bool) -> list[str]:
    """The gate's answer for one device whose beta switch is `beta_on`."""
    picked = set(launch_codes()) | (set(beta_codes()) if beta_on else set())
    return [code for code in LANGUAGES if code in picked]


def enabled_for(device: str) -> list[str]:
    """The gate's answer for a device, with the beta switch looked up only when
    the beta list has anything to add."""
    import access

    return enabled(bool(beta_codes()) and access._beta_on(device))


def available(code: str) -> bool:
    """Known, has a voice and both first-run starter islands are baked."""
    import starter
    import voices

    return (code in LANGUAGES and voices.has_voice(code)
            and starter.has_intro(code, "new") and starter.has_intro(code, "some"))


def available_for(beta_on: bool) -> list[str]:
    return [code for code in enabled(beta_on) if available(code)]


def require_learning(code: str, device: str) -> None:
    """400 language_unavailable unless `code` is enabled for the device and
    available. A launch language never touches the beta table."""
    if code in launch_codes() and available(code):
        return
    if code in beta_codes() and available(code):
        import access

        if access._beta_on(device):
            return
    raise HTTPException(400, {"code": "language_unavailable", "language": code})


def check_startup() -> None:
    """Log the gate and warn about a gated language nothing can serve yet."""
    log.info("languages: launch %s, beta %s", ",".join(launch_codes()), ",".join(beta_codes()) or "-")
    for code in enabled(True):
        if not available(code):
            log.warning("languages: %s is gated on but has no voice or starter island", code)
