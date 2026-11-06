# Routes for podcasts, moved out of main.py.
import logging
import math
import tempfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Form, Header, HTTPException

import dependencies
import podcast
import podcast_catalog
import store
import voicevox
import voices
from services import build

router = APIRouter()
log = logging.getLogger("shadow")


@router.get("/shadow/podcasts/episodes")
async def podcast_episodes(url: str, authorization: str | None = Header(None)) -> dict:
    """List a podcast feed's episodes so one can be handed to the importer."""
    dependencies.require_token(authorization)
    try:
        await podcast.check_url(url)
    except ValueError:
        raise HTTPException(400, "that url could not be used")
    try:
        xml = await podcast.fetch(url, None, podcast.FEED_MAX_BYTES)
    except podcast.PodcastError as exc:
        log.warning("feed fetch failed: %s", exc)
        raise HTTPException(502, "that feed could not be fetched")
    return podcast.parse_feed(xml)


@router.post("/shadow/podcasts/import")
async def import_podcast_episode(
    background: BackgroundTasks,
    audio_url: str = Form(...),
    title: str = Form(""),
    start_min: float = Form(0),
    speaker: int = Form(voicevox.DEFAULT_SPEAKER),
    language: str = Form("ja"),
    native: str = Form("en"),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Download a podcast episode by URL and import it the same way an
    uploaded file is imported."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if language not in ("ja", "es", "en"):
        raise HTTPException(400, "language must be 'ja', 'es' or 'en'")
    if native not in ("he", "en"):
        raise HTTPException(400, "native must be 'he' or 'en'")
    if language == native:
        raise HTTPException(400, "the learning language must differ from the native one")
    if voices.language_for(speaker) != language:
        raise HTTPException(400, "that voice does not speak the chosen language")
    if not math.isfinite(start_min) or start_min < 0:
        raise HTTPException(400, "start_min must be a finite number >= 0")
    try:
        await podcast.check_url(audio_url)
    except ValueError:
        raise HTTPException(400, "that url could not be used")

    island_title = title.strip() or "Podcast episode"
    dependencies._take_build_slot(device, "create", "import")
    tmp_dir = Path(tempfile.mkdtemp(prefix="podcast-"))
    island_id = store.create_island(
        "simple", speaker, language=language, native=native, source="podcast", source_name=title,
        device=device,
    )
    store.start_build(island_id)
    background.add_task(
        dependencies._refunding(build._build_podcast, island_id, device, "create", "import"), island_id, audio_url, island_title, float(start_min) * 60.0, tmp_dir,
        language, native,
    )
    return {"id": island_id, "status": "pending"}


@router.get("/shadow/podcasts/catalog")
def podcasts_catalog(language: str, ui: str = "en",
                     authorization: str | None = Header(None)) -> dict:
    """The hand-picked, editorial podcast catalog for one learning language,
    written in the interface language `ui` (a separate setting: Hebrew
    section copy can sit over Japanese shows)."""
    dependencies.require_token(authorization)
    try:
        return podcast_catalog.catalog(language, ui)
    except KeyError:
        raise HTTPException(404, f"no podcast catalog for language: {language}")


@router.get("/shadow/podcasts/search")
async def podcasts_search(q: str, language: str,
                          authorization: str | None = Header(None),
                          x_shadow_device: str = Header("")) -> dict:
    """Resolve a pasted link or a plain query to a list of shows."""
    dependencies.require_token(authorization)
    dependencies._take_use_slot(dependencies._require_device(x_shadow_device), "podcast_search")
    try:
        results = await podcast_catalog.search(q, language)
    except (podcast.PodcastError, ValueError) as exc:
        log.warning("podcast search failed: %s", exc)
        if "open.spotify.com" in q:
            raise HTTPException(
                400, "Spotify shows can't be imported, only their public RSS feed."
            )
        raise HTTPException(400, "that feed could not be fetched")
    return {"results": results}
