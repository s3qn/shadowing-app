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
import secrets
import shutil
import subprocess
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import generate
import store
import transcribe
import voicevox

load_dotenv()

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
log = logging.getLogger("shadow")

SHADOW_TOKEN = os.getenv("SHADOW_TOKEN", "")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

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


def require_token(authorization: str | None) -> None:
    """Reject anything without the bearer token. Fails closed: an unset
    SHADOW_TOKEN refuses every request rather than opening the service up."""
    if not SHADOW_TOKEN:
        raise HTTPException(503, "SHADOW_TOKEN is not configured")
    prefix = "Bearer "
    if not authorization or not authorization.startswith(prefix):
        raise HTTPException(401, "missing bearer token")
    if not secrets.compare_digest(authorization[len(prefix):], SHADOW_TOKEN):
        raise HTTPException(401, "bad token")


@app.on_event("startup")
def _startup() -> None:
    store.init()
    log.info("store ready at %s", store.DB_PATH)


@app.get("/health")
@app.get("/shadow/health")
def health() -> dict:
    return {"ok": True, "service": "shadow"}


@app.get("/shadow/speakers")
async def speakers(authorization: str | None = Header(None)) -> list[dict]:
    require_token(authorization)
    try:
        raw = await voicevox.list_speakers()
    except Exception as exc:
        raise HTTPException(502, f"VOICEVOX unreachable: {exc}") from exc
    return [
        {
            "name": s["name"],
            "styles": [{"id": st["id"], "name": st["name"]} for st in s["styles"]],
        }
        for s in raw
    ]


def _to_wav(src: Path, dst: Path) -> bool:
    """Normalise whatever the phone recorded to 16kHz mono wav for whisper."""
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src), "-ac", "1", "-ar", "16000", str(dst)],
            capture_output=True,
            check=True,
            timeout=120,
        )
        return dst.exists()
    except Exception:
        log.exception("ffmpeg failed for %s", src)
        return False


async def _synthesize_lines(island_id: str, lines: list[dict], speaker: int) -> int:
    """Render every line to its own wav. Returns how many succeeded."""
    done = 0
    for idx, line in enumerate(lines):
        try:
            wav, timeline, duration, _ = await voicevox.speak(line["ja"], speaker)
        except voicevox.VoicevoxError:
            log.exception("synthesis failed for line %d of %s", idx, island_id)
            continue
        store.line_audio_path(island_id, idx).write_bytes(wav)
        store.add_line(island_id, idx, line, duration, timeline)
        done += 1
    return done


async def _build_island(island_id: str, audio_path: Path, complexity: str,
                        speaker: int, count: int) -> None:
    """The whole pipeline, run in the background so the upload returns at once."""
    try:
        store.set_stage(island_id, "transcribing")
        result = await asyncio.to_thread(transcribe.transcribe, audio_path)
        text = result.get("text", "")
        if not text:
            store.set_failed(island_id, "Nothing could be transcribed from that recording.")
            return
        store.set_transcript(island_id, text)
        log.info("island %s transcript: %d chars", island_id, len(text))

        store.set_stage(island_id, "writing")
        generated = await asyncio.to_thread(
            generate.generate_lines, text, complexity, count
        )
        lines = generated.get("lines") or []
        if not lines:
            store.set_failed(island_id, "No Japanese lines could be generated.")
            return

        store.set_stage(island_id, "speaking")
        made = await _synthesize_lines(island_id, lines, speaker)
        if made == 0:
            store.set_failed(island_id, "The voice engine produced no audio.")
            return

        title = generated.get("title") or text[:40]
        store.set_ready(island_id, title)
        log.info("island %s ready: %d lines", island_id, made)
    except Exception as exc:
        log.exception("island %s failed", island_id)
        store.set_failed(island_id, str(exc))


@app.post("/shadow/islands")
async def create_island(
    background: BackgroundTasks,
    audio: UploadFile = File(...),
    complexity: str = Form("simple"),
    speaker: int = Form(voicevox.DEFAULT_SPEAKER),
    count: int = Form(8),
    authorization: str | None = Header(None),
) -> dict:
    require_token(authorization)
    if complexity not in generate.COMPLEXITY_RULES:
        raise HTTPException(400, "complexity must be 'simple' or 'complex'")

    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "empty upload")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "recording too large")

    island_id = store.create_island(complexity, speaker)
    suffix = Path(audio.filename or "rec.m4a").suffix or ".m4a"
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"island-{island_id}-"))
    src = tmp_dir / f"input{suffix}"
    src.write_bytes(raw)

    wav = store.AUDIO_DIR / island_id / "source.wav"
    if not _to_wav(src, wav):
        shutil.rmtree(tmp_dir, ignore_errors=True)
        store.set_failed(island_id, "That audio file could not be decoded.")
        raise HTTPException(400, "could not decode the uploaded audio")
    shutil.rmtree(tmp_dir, ignore_errors=True)

    background.add_task(_build_island, island_id, wav, complexity, speaker, count)
    return {"id": island_id, "status": "pending"}


@app.get("/shadow/islands")
def list_islands(authorization: str | None = Header(None)) -> list[dict]:
    require_token(authorization)
    return store.list_islands()


@app.get("/shadow/islands/{island_id}")
def get_island(island_id: str, authorization: str | None = Header(None)) -> dict:
    require_token(authorization)
    island = store.get_island(island_id)
    if island is None:
        raise HTTPException(404, "no such island")
    return island


@app.get("/shadow/islands/{island_id}/lines/{idx}/audio")
def line_audio(island_id: str, idx: int, token: str = "",
               authorization: str | None = Header(None)) -> FileResponse:
    # Audio is fetched by the player, which cannot always set a header, so a
    # token query parameter is accepted here as well as the usual header.
    if token:
        require_token(f"Bearer {token}")
    else:
        require_token(authorization)
    path = store.line_audio_path(island_id, idx)
    if not path.exists():
        raise HTTPException(404, "no audio for that line")
    return FileResponse(path, media_type="audio/wav")


@app.post("/shadow/islands/{island_id}/regenerate")
async def regenerate(
    island_id: str,
    background: BackgroundTasks,
    complexity: str = Form("complex"),
    count: int = Form(8),
    authorization: str | None = Header(None),
) -> dict:
    """Rebuild an island's lines at the other complexity, reusing the recording
    that is already on disk so the learner does not have to speak again."""
    require_token(authorization)
    if complexity not in generate.COMPLEXITY_RULES:
        raise HTTPException(400, "complexity must be 'simple' or 'complex'")
    island = store.get_island(island_id)
    if island is None:
        raise HTTPException(404, "no such island")

    wav = store.AUDIO_DIR / island_id / "source.wav"
    if not wav.exists():
        raise HTTPException(409, "the original recording is gone")

    store.clear_lines(island_id)
    with store.connect() as conn:
        conn.execute(
            "UPDATE islands SET complexity=?, status='working', stage='writing', error=''"
            " WHERE id=?",
            (complexity, island_id),
        )
    background.add_task(
        _build_island, island_id, wav, complexity, island["speaker"], count
    )
    return {"id": island_id, "status": "working", "complexity": complexity}


@app.delete("/shadow/islands/{island_id}")
def delete_island(island_id: str, authorization: str | None = Header(None)) -> dict:
    require_token(authorization)
    store.delete_island(island_id)
    return {"ok": True}
