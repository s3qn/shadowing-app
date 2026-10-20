"""Pre-baked phrase topics, seeded from committed templates.

backend/starter/phrases/<lang>/<topic>/island.json holds the topic's lines and
0.wav..N.wav their audio (made once by scripts/make_starter.py). Seeding copies
them into a normal phrases island, so the first run opens with no synthesis
wait."""

import hashlib
import json
import shutil
import uuid
from pathlib import Path

import phrase_catalog
import store
import voices

TEMPLATE_DIR = Path(__file__).resolve().parent / "starter" / "phrases"
INTRO_DIR = Path(__file__).resolve().parent / "starter" / "intro"
INTRO_SOME_DIR = Path(__file__).resolve().parent / "starter" / "intro-some"
# The level pick on Let's start: "new" seeds intro, "some" seeds intro-some.
INTRO_LEVELS = ("new", "some")


def has_template(language: str, topic: str) -> bool:
    """True when a baked template exists. The topic is checked against the
    catalogue first, so no unchecked text reaches the path."""
    try:
        phrase_catalog.phrases(language, topic)
    except KeyError:
        return False
    return (TEMPLATE_DIR / language / topic / "island.json").is_file()


def _seed(src: Path, template: dict, device: str, language: str, native: str,
          speaker: int, source: str, source_name: str, title: str) -> str:
    """Create a ready island from a template directory."""
    island_id = store.create_island(
        "simple", speaker, language=language, native=native,
        source=source, source_name=source_name, device=device,
    )
    try:
        for idx, line in enumerate(template["lines"]):
            store.add_line(
                island_id, idx,
                {**line, "en": line["gloss"].get(native) or line["gloss"].get("en", "")},
                line["duration"], line["timeline"], line["words"],
            )
            shutil.copyfile(src / f"{idx}.wav", store.line_audio_path(island_id, idx))
    except Exception:
        # A failed island is skipped by the repeat-pick check, so the next
        # pick builds afresh instead of returning this half copy.
        store.set_failed(island_id, "The phrase copy failed.")
        raise
    store.set_ready(island_id, title)
    return island_id


def seed_topic(device: str, language: str, native: str, topic: str, speaker: int) -> str:
    """Create a ready phrases island for `topic` from its template."""
    src = TEMPLATE_DIR / language / topic
    template = json.loads((src / "island.json").read_text(encoding="utf-8"))
    # The catalogue's own gloss wins over the one baked into the template.
    for line, entry in zip(template["lines"], phrase_catalog.phrases(language, topic)):
        if entry.get(native):
            line["gloss"] = {**line["gloss"], native: entry[native]}
    return _seed(src, template, device, language, native, speaker,
                 "phrases", topic, phrase_catalog.title(topic, native))


# --- shared phrase renders ---
# A catalogue topic is the same text for everyone, so once one person has had
# it voiced in a given speaker and native language the result is kept under
# DATA_DIR/phrase-cache in the template shape above, and the next pick copies
# it (same path as a baked template). Resolved at call time so tests can
# repoint store.DATA_DIR.

# Bump when the saved shape or the timing maths changes: old renders then sit
# under another key and are never served again.
CACHE_FORMAT = 1


def cache_dir(language: str, topic: str, speaker: int, native: str) -> Path:
    """The render's directory. The key carries a short hash of the topic's
    texts, so a catalogue edit invalidates old renders. Raises KeyError for a
    topic not in the catalogue."""
    texts = "\n".join(e["text"] for e in phrase_catalog.phrases(language, topic))
    digest = hashlib.sha1(texts.encode("utf-8")).hexdigest()[:10]
    return (store.DATA_DIR / "phrase-cache" / language / topic
            / f"{speaker}-{native}-v{CACHE_FORMAT}-{digest}")


def has_cached(language: str, topic: str, speaker: int, native: str) -> bool:
    """True when a complete shared render exists: its island.json reads, has
    one line per catalogue phrase, and every N.wav is on disk. The catalogue
    check runs first, so no unchecked text reaches the path."""
    try:
        src = cache_dir(language, topic, speaker, native)
        count = len(json.loads((src / "island.json").read_text(encoding="utf-8"))["lines"])
    except (KeyError, OSError, ValueError, TypeError):
        return False
    return (count == len(phrase_catalog.phrases(language, topic))
            and all((src / f"{idx}.wav").is_file() for idx in range(count)))


def seed_cached(device: str, language: str, topic: str, speaker: int, native: str) -> str:
    """Create a ready phrases island from the shared render. Call has_cached
    first; a copy that still fails marks its island failed and raises."""
    src = cache_dir(language, topic, speaker, native)
    template = json.loads((src / "island.json").read_text(encoding="utf-8"))
    return _seed(src, template, device, language, native, speaker,
                 "phrases", topic, phrase_catalog.title(topic, native))


def save_cache(island_id: str, language: str, topic: str, speaker: int, native: str) -> None:
    """Keep a finished phrases island as the shared render for its key, only
    when it is complete: one voiced line per catalogue phrase, each with a
    native gloss. Each save writes its own temp directory and renames it into
    place, so two builds of one key never touch each other's files and a
    reader never sees a half-written cache. A render that already exists
    wins."""
    if has_cached(language, topic, speaker, native):
        return
    texts = [e["text"] for e in phrase_catalog.phrases(language, topic)]
    island = store.get_island(island_id)
    if not island or island["status"] != "ready":
        return
    by_idx = {line["idx"]: line for line in island["lines"]}
    if sorted(by_idx) != list(range(len(texts))):
        return
    if not all(by_idx[idx]["en"] for idx in by_idx):
        return
    dst = cache_dir(language, topic, speaker, native)
    tmp = dst.with_name(f".{dst.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.mkdir(parents=True)
        lines = []
        for idx in range(len(texts)):
            line = by_idx[idx]
            shutil.copyfile(store.line_audio_path(island_id, idx), tmp / f"{idx}.wav")
            lines.append({
                "ja": line["ja"], "kana": line["kana"], "romaji": line["romaji"],
                "gloss": {native: line["en"]},
                "duration": line["duration"], "timeline": line["timeline"],
                "words": line["words"],
            })
        (tmp / "island.json").write_text(
            json.dumps({"language": language, "topic": topic, "lines": lines},
                       ensure_ascii=False),
            encoding="utf-8",
        )
        # rename fails when dst is already a non-empty directory: another
        # build of the same key landed first, and theirs is as good.
        tmp.rename(dst)
    except OSError:
        if not has_cached(language, topic, speaker, native):
            raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def intro_name(level: str) -> str:
    """The starter island's source_name for a level pick."""
    return "intro" if level == "new" else "intro-some"


def _intro_dir(level: str) -> Path:
    return INTRO_DIR if level == "new" else INTRO_SOME_DIR


def has_intro(language: str, level: str = "new") -> bool:
    """True when the 3-line first-run starter island is baked for `language`
    at `level`."""
    return (language in ("ja", "en", "es") and level in INTRO_LEVELS
            and (_intro_dir(level) / language / "island.json").is_file())


def seed_intro(device: str, language: str, native: str, level: str = "new") -> str:
    """Create the first-run starter island from the template for `level`."""
    src = _intro_dir(level) / language
    template = json.loads((src / "island.json").read_text(encoding="utf-8"))
    title = template["title"].get(native) or template["title"]["en"]
    return _seed(src, template, device, language, native, voices.default_speaker(language),
                 "starter", intro_name(level), title)


def intro_is_current(island_id: str, language: str, level: str = "new") -> bool:
    """True when the island's line texts match the baked template now. An
    island seeded by an older build differs, and the starter route replaces
    it so changed templates reach devices that already have one."""
    template = json.loads(
        (_intro_dir(level) / language / "island.json").read_text(encoding="utf-8"))
    island = store.get_island(island_id)
    if not island:
        return False
    return [l["ja"] for l in island["lines"]] == [l["ja"] for l in template["lines"]]
