# Routes for phrases, moved out of main.py.
import asyncio
import logging

from fastapi import APIRouter, BackgroundTasks, Form, Header, HTTPException

import dependencies
import languages
import phrase_catalog
import starter
import store
import voices
import voicevox
from services import build

log = logging.getLogger("shadow")

router = APIRouter()


# --- phrase-islands ---
@router.get("/shadow/phrases/catalog")
def phrases_catalog(language: str, ui: str = "en",
                    authorization: str | None = Header(None),
                    x_shadow_device: str = Header("")) -> dict:
    """The ready-made phrase topics for one learning language."""
    dependencies.require_token(authorization)
    try:
        return phrase_catalog.mark_added(
            phrase_catalog.catalog(language, ui), _added_phrase_topics(x_shadow_device, language))
    except KeyError:
        raise HTTPException(404, f"no phrase catalog for language: {language}")


# --- phrase-catalog-ui ---
def _added_phrase_topics(device: str, language: str) -> set[str]:
    """Topic ids this device already has as a non-failed phrases island.
    An empty header (or none) means nothing is marked."""
    if not isinstance(device, str) or not device:
        return set()
    return {
        i["source_name"]
        for i in store.list_islands(device)
        if i["source"] == "phrases" and i["language"] == language and i["status"] != "failed"
    }


# phrase-search
@router.get("/shadow/phrases/search")
def phrases_search(language: str, ui: str = "en", q: str = "", category: str = "",
                   authorization: str | None = Header(None),
                   x_shadow_device: str = Header("")) -> dict:
    """Catalog topics filtered by a search word and/or a category."""
    dependencies.require_token(authorization)
    try:
        return phrase_catalog.mark_added(
            phrase_catalog.search(language, ui, q, category),
            _added_phrase_topics(x_shadow_device, language))
    except KeyError:
        raise HTTPException(404, f"no phrase catalog for language: {language}")


@router.post("/shadow/phrases/import")
async def import_phrases(
    background: BackgroundTasks,
    topic: str = Form(...),
    speaker: int = Form(voicevox.DEFAULT_SPEAKER),
    language: str = Form("ja"),
    native: str = Form("en"),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Add a catalogue topic as an island. A new island takes a slot from the
    daily create limit (it writes an island and renders audio); a repeat pick
    returns the island that already exists and is free."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    languages.require_learning(language, device)
    if native not in ("he", "en"):
        raise HTTPException(400, {"code": "bad_native"})
    if language == native:
        raise HTTPException(400, {"code": "same_language"})
    if voices.language_for(speaker) != language:
        raise HTTPException(400, {"code": "voice_language_mismatch"})
    try:
        entries = phrase_catalog.phrases(language, topic)
        island_title = phrase_catalog.title(topic, native)
    except KeyError:
        raise HTTPException(404, f"no such phrase topic: {topic}")

    for existing in store.list_islands(device):
        if (
            existing["source"] == "phrases"
            and existing["language"] == language
            and existing["status"] != "failed"
            and existing["source_name"] == topic
        ):
            return {"id": existing["id"], "status": existing["status"]}

    if speaker == voices.default_speaker(language) and starter.has_template(language, topic):
        island_id = await asyncio.to_thread(
            starter.seed_topic, device, language, native, topic, speaker)
        return {"id": island_id, "status": "ready"}

    # Someone already had this topic rendered in this voice for this native
    # language: copy their render. No slot, no synthesis.
    # A copy that fails anyway falls through to a normal build.
    if starter.has_cached(language, topic, speaker, native):
        try:
            island_id = await asyncio.to_thread(
                starter.seed_cached, device, language, topic, speaker, native)
            return {"id": island_id, "status": "ready"}
        except Exception:
            log.exception("phrase cache copy failed for %s/%s", language, topic)

    dependencies._take_build_slot(device, "create", "phrases")
    island_id = store.create_island(
        "simple", speaker, language=language, native=native, source="phrases",
        source_name=topic, device=device,
    )
    background.add_task(
        dependencies._refunding(build._build_phrases, island_id, device, "create", "phrases"),
        island_id, [e["text"] for e in entries],
        [e.get(native, "") for e in entries],
        island_title, speaker, language, native, topic=topic,
    )
    return {"id": island_id, "status": "pending"}
