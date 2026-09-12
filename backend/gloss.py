"""Dictionary lookup for one tapped word.

The word arrives as it appears in the line (起きます, 行って、). janome gives
the base form (起きる, 行く) and JMdict, through jamdict's offline SQLite build,
gives English senses. Results are cached in memory for the life of the process.
Never raises: an unknown word comes back with found=False.
"""

import logging
import threading

import segment
from voicevox import to_hiragana

log = logging.getLogger(__name__)

_JAM = None
_LOCK = threading.Lock()
_CACHE: dict[str, dict] = {}
_SKIP_TOP = ("記号", "補助記号", "助動詞")
MAX_ENTRIES = 3
MAX_SENSES = 3
_STRIP = "、。！？!?…「」『』（）() "

# Particles are grammar, not vocabulary: JMdict would return は as "feather".
PARTICLES = {
    "は": "topic marker (as for …)",
    "が": "subject marker",
    "を": "object marker",
    "に": "to / at / in (direction, time, place, target)",
    "へ": "to, toward (direction)",
    "で": "at / in (place of action); by means of",
    "と": "and; with; quotation marker",
    "の": "of; possessive; noun link",
    "も": "also, too",
    "か": "question marker; or",
    "から": "from; because",
    "まで": "until, up to",
    "より": "than; from",
    "ね": "sentence ending: seeking agreement (right?)",
    "よ": "sentence ending: emphasis, telling",
    "な": "sentence ending: emphasis; do not (with verb)",
    "て": "connects verbs / clauses (and then)",
    "や": "and (non-exhaustive list)",
    "など": "and so on, etc.",
    "って": "casual quotation / topic marker",
    "けど": "but, although",
    "し": "and also (listing reasons)",
    "ので": "because, so",
    "のに": "although, even though",
    "ば": "if (conditional)",
    "たら": "if, when (conditional)",
}


def _jam():
    global _JAM
    with _LOCK:
        if _JAM is None:
            from jamdict import Jamdict

            _JAM = Jamdict()
    return _JAM


def _headword(word: str) -> tuple[str, str]:
    """(base form, hiragana reading of the whole word)."""
    base, reading = "", ""
    for tok in segment._tokenizer().tokenize(word):
        top = tok.part_of_speech.split(",")[0]
        if tok.reading != "*":
            reading += tok.reading
        elif top not in _SKIP_TOP:
            reading += tok.surface
        if not base and top not in _SKIP_TOP:
            base = tok.base_form if tok.base_form != "*" else tok.surface
    return base or word.strip("、。！？"), to_hiragana(reading)


def _exact(entries, form: str) -> list:
    return [e for e in entries
            if any(k.text == form for k in e.kanji_forms) or any(k.text == form for k in e.kana_forms)]


def gloss(word: str) -> dict:
    word = (word or "").strip()
    if not word:
        return {"word": word, "base": "", "reading": "", "entries": [], "found": False}
    cached = _CACHE.get(word)
    if cached is not None:
        return cached
    base, reading = "", ""
    try:
        base, reading = _headword(word)
        clean = word.strip(_STRIP)
        if clean in PARTICLES:
            out = {
                "word": word, "base": clean, "reading": to_hiragana(clean),
                "entries": [{"kanji": [], "kana": [clean],
                             "senses": [{"pos": ["particle"], "glosses": [PARTICLES[clean]]}]}],
                "found": True,
            }
            _CACHE[word] = out
            return out
        # The whole word first (十時 is "ten o'clock"), then the base form of
        # its first content token (起きます → 起きる).
        ordered: list = []
        for form in dict.fromkeys([clean, base]):
            if not form:
                continue
            result = _jam().lookup(form)
            exact = _exact(result.entries, form)
            if exact:
                ordered = exact + [e for e in result.entries if e not in exact]
                base = form
                break
            if not ordered:
                ordered = list(result.entries)
        entries = []
        for e in ordered[:MAX_ENTRIES]:
            entries.append(
                {
                    "kanji": [k.text for k in e.kanji_forms][:2],
                    "kana": [k.text for k in e.kana_forms][:2],
                    "senses": [
                        {"pos": list(s.pos)[:2], "glosses": [g.text for g in s.gloss][:4]}
                        for s in e.senses[:MAX_SENSES]
                    ],
                }
            )
        out = {"word": word, "base": base, "reading": reading, "entries": entries, "found": bool(entries)}
    except Exception:
        log.exception("gloss failed for %r", word)
        out = {"word": word, "base": base, "reading": reading, "entries": [], "found": False}
    _CACHE[word] = out
    return out
