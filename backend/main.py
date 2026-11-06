"""Shadowing app backend: language islands.

One island is a recording the learner made about their own life, plus everything
derived from it: an English transcript, Japanese sentences that say the same
things, and a synthesized voice for each sentence with a mora-level timeline the
player highlights against.

Routes are prefixed /shadow because cloudflared forwards the matched path
through unchanged, the same way the instagram_scan service owns /scan. A bare
/health is also served so local checks do not need the prefix.

Bind to 127.0.0.1 only. This machine has a public IP with no NAT, and the tunnel
is the intended way in.
"""

import asyncio
import logging
import os
import sys
import threading
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from dotenv import load_dotenv

# Before the local imports: store, voicevox and transcribe read their settings
# from the environment at import time.
load_dotenv()

import corpus  # voice-topic
import dev_review
import dev_transcripts
import dev_upload
import energy
import grammar
import explain
import generate
import guardrails  # --- ai-guardrails ---
import gloss as glossary
import app_version
import kokoro_tts
import latin
import podcast
import podcast_catalog
import progression
import beta
import user_profile
import schedule
import segment
import starter
import store
import suggest
import feedback
import catch
import transcribe
import voicevox
import voices

# --- sign-in ---
import dependencies
import middleware

# Router modules. voices, grammar, youtube, align and repair share a name with
# a top-level module main.py already uses, so those five are bound with an
# _r suffix instead of shadowing the module.
from routers import create, islands, takes, words, podcasts, account, phrases, progress, review, admin
from routers import voices as voices_r
from routers import grammar as grammar_r
from routers import youtube as youtube_r
from routers import align as align_r
from routers import repair as repair_r
from services import captions

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
log = logging.getLogger("shadow")


logging.getLogger("uvicorn.access").addFilter(middleware.RedactAccessLog())

app = FastAPI(title="Shadowing Islands", version="0.1.0")

# The Expo client is served from an ngrok origin that changes every session, and
# every route is already behind a bearer token, so an origin allowlist would add
# maintenance without adding protection.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(schedule.router)
app.include_router(suggest.router)
app.include_router(feedback.router)
# catch-the-word
app.include_router(catch.router)
if dev_review.enabled():
    app.include_router(dev_review.router)
if dev_upload.enabled():
    app.include_router(dev_upload.router)
# anchor: dev_transcripts router
if dev_transcripts.enabled():
    app.include_router(dev_transcripts.router)
app.include_router(voices_r.router)
app.include_router(create.router)
app.include_router(islands.router)
app.include_router(takes.router)
app.include_router(words.router)
app.include_router(podcasts.router)
app.include_router(account.router)
app.include_router(phrases.router)
app.include_router(grammar_r.router)
app.include_router(youtube_r.router)
app.include_router(align_r.router)
app.include_router(progress.router)
app.include_router(review.router)
app.include_router(repair_r.router)
app.include_router(admin.router)


@app.on_event("startup")
def _startup() -> None:
    store.init()
    schedule.init()
    progression.init()
    user_profile.init()
    beta.init()
    review_deck.init()
    catch.init()
    dependencies._claim_owner()
    log.info("store ready at %s", store.DB_PATH)
    # Background work dies with the process. Anything still marked as working
    # was interrupted, and must not sit in that state forever.
    for island in store.list_islands():
        if island["status"] in ("pending", "working"):
            if island["source"] != "voice":
                # An import or podcast build has no partial-progress state
                # worth keeping: the source media is a temp file that is
                # already gone, so it cannot resume or be regenerated.
                store.set_failed(
                    island["id"],
                    "Import was interrupted. Delete it and import again.",
                    "import_interrupted",
                )
                log.warning("island %s (%s) was interrupted; marked failed", island["id"], island["source"])
            elif island["line_count"] > 0:
                store.set_ready(island["id"], island["title"] or "Untitled island")
                log.warning("island %s was interrupted; kept its %d lines", island["id"], island["line_count"])
            else:
                store.set_failed(
                    island["id"],
                    "Building was interrupted. Regenerate to try again.",
                    "build_interrupted",
                )
                log.warning("island %s was interrupted with no lines", island["id"])
    if _kokoro_warm_up_wanted():
        threading.Thread(target=kokoro_tts.warm_up, name="kokoro-warm-up", daemon=True).start()
    if _whisper_warm_up_wanted():
        # The first take of a session otherwise waits ~8s for the model load.
        threading.Thread(target=transcribe.warm_up, name="whisper-warm-up", daemon=True).start()


def _whisper_warm_up_wanted() -> bool:
    """Opt-in: only SHADOW_WHISPER_WARM=1 loads the medium model at startup
    (about 1.5GB RSS). Always off under pytest or SHADOW_ENV=test."""
    if os.getenv("SHADOW_WHISPER_WARM", "").strip() != "1":
        return False
    return os.getenv("SHADOW_ENV") != "test" and "pytest" not in sys.modules


def _kokoro_warm_up_wanted() -> bool:
    """SHADOW_KOKORO_WARMUP=1 or 0 forces the startup model load on or off.
    Unset, it loads only when an English or Spanish island already exists,
    so a Japanese-only setup never pays for Kokoro."""
    flag = os.getenv("SHADOW_KOKORO_WARMUP", "").strip()
    if flag:
        return flag == "1"
    return any(island.get("language", "ja") != "ja" for island in store.list_islands())


@app.get("/shadow/app/latest")
def app_latest() -> dict:
    """Newest published build per platform, public like health. Fails open."""
    return app_version.latest()


@app.get("/health")
@app.get("/shadow/health")
def health() -> dict:
    return {
        "ok": True,
        "service": "shadow",
        "env": os.getenv("SHADOW_ENV", "dev"),
        "release": os.getenv("SHADOW_RELEASE", ""),
        "kokoro_timings": kokoro_tts.has_timings(),
    }


import llm as _llm  # noqa: E402

_llm.set_pause_check(dependencies._ai_paused)


# --- privacy-pages ---
_STATIC_DIR = Path(__file__).parent / "static"
_HOME_HTML = (_STATIC_DIR / "index.html").read_bytes()
_PRIVACY_HTML = (_STATIC_DIR / "privacy.html").read_bytes()


@app.get("/shadow/")
@app.get("/shadow")
def home_page() -> Response:
    return Response(_HOME_HTML, media_type="text/html; charset=utf-8")


@app.get("/shadow/privacy")
def privacy_page() -> Response:
    return Response(_PRIVACY_HTML, media_type="text/html; charset=utf-8")


app.add_middleware(middleware.DeviceGuard)
app.add_middleware(middleware.SecurityHeaders)


# --- youtube-shadowing ---
import youtube  # noqa: E402
import repair  # noqa: E402  youtube-asr-context-repair


# --- bl36-align ---
import align  # noqa: E402


@app.on_event("startup")
async def _align_startup() -> None:
    # A worker from the previous process may still hold 3G: stop it before requeueing.
    await asyncio.to_thread(align.stop_leftover_scopes)
    align_r._align_recover()
    captions._repair_recover()  # youtube-asr-context-repair
    asyncio.create_task(align_r._align_consumer())
# --- end bl36-align ---


# --- review-deck ---
import review_deck  # noqa: E402



