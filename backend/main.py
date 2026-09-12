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
import hashlib
import logging
import os
import secrets
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from dotenv import load_dotenv

# Before the local imports: store, voicevox and transcribe read their settings
# from the environment at import time.
load_dotenv()

import generate
import gloss as glossary
import segment
import store
import transcribe
import voicevox

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
    # Background work dies with the process. Anything still marked as working
    # was interrupted, and must not sit in that state forever.
    for island in store.list_islands():
        if island["status"] in ("pending", "working"):
            if island["line_count"] > 0:
                store.set_ready(island["id"], island["title"] or "Untitled island")
                log.warning("island %s was interrupted; kept its %d lines", island["id"], island["line_count"])
            else:
                store.set_failed(island["id"], "Building was interrupted. Regenerate to try again.")
                log.warning("island %s was interrupted with no lines", island["id"])


@app.get("/health")
@app.get("/shadow/health")
def health() -> dict:
    return {"ok": True, "service": "shadow"}


PREVIEW_TEXT = "はじめまして。今日はいい天気ですね。"
PREVIEW_DIR = store.DATA_DIR / "previews"


def _token_or_header(token: str, authorization: str | None) -> None:
    """Media routes are fetched by players and Image views that cannot set a
    header, so the token is accepted as a query parameter there as well."""
    if token:
        require_token(f"Bearer {token}")
    else:
        require_token(authorization)


@app.get("/shadow/speakers")
async def speakers(authorization: str | None = Header(None)) -> list[dict]:
    """Every VOICEVOX speaker with its styles, icon URLs and credit policy."""
    require_token(authorization)
    try:
        raw = await voicevox.list_speakers()
        out = []
        for s in raw:
            info = await voicevox.speaker_info(s["speaker_uuid"])
            out.append(
                {
                    "uuid": s["speaker_uuid"],
                    "name": s["name"],
                    "policy": info.get("policy", ""),
                    "styles": [
                        {
                            "id": st["id"],
                            "name": st["name"],
                            "icon": f"/shadow/speakers/{s['speaker_uuid']}/icon/{st['id']}",
                        }
                        for st in s["styles"]
                    ],
                }
            )
    except Exception as exc:
        raise HTTPException(502, f"VOICEVOX unreachable: {exc}") from exc
    return out


@app.get("/shadow/speakers/{speaker_uuid}/icon/{style_id}")
async def speaker_icon(speaker_uuid: str, style_id: int, token: str = "",
                       authorization: str | None = Header(None)) -> Response:
    _token_or_header(token, authorization)
    try:
        info = await voicevox.speaker_info(speaker_uuid)
        style = next((st for st in info["style_infos"] if st["id"] == style_id), None)
        if style is None:
            raise HTTPException(404, "no such style")
        png = await voicevox.fetch_resource(style["icon"])
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"VOICEVOX unreachable: {exc}") from exc
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


@app.get("/shadow/voices/{style_id}/preview")
async def voice_preview(style_id: int, token: str = "",
                        authorization: str | None = Header(None)) -> FileResponse:
    """The same sentence in any voice, rendered once and kept on disk."""
    _token_or_header(token, authorization)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    path = PREVIEW_DIR / f"{style_id}.wav"
    if not path.exists():
        try:
            wav, _, _, _ = await voicevox.speak(PREVIEW_TEXT, style_id)
        except voicevox.VoicevoxError as exc:
            raise HTTPException(502, str(exc)) from exc
        path.write_bytes(wav)
    return FileResponse(path, media_type="audio/wav")


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
        # Write beside the target and swap, so a player streaming the old file
        # never reads a half-written one.
        target = store.line_audio_path(island_id, idx)
        tmp = target.with_suffix(".tmp")
        tmp.write_bytes(wav)
        os.replace(tmp, target)
        words = await asyncio.to_thread(segment.align, line["ja"], timeline)
        store.add_line(island_id, idx, line, duration, timeline, words)
        done += 1
    # A re-voice or regenerate with fewer lines must not leave old wavs behind.
    for stale in (store.AUDIO_DIR / island_id).glob("*.wav"):
        base = stale.stem.split("@")[0]
        if base.isdigit() and (int(base) >= len(lines) or "@" in stale.stem):
            stale.unlink(missing_ok=True)
    # A take was cleaned against the line that used to be at this index. A
    # regenerate or revoice replaces that line, so the old take (and its
    # cleaned copy) no longer matches anything and would be misleading.
    shutil.rmtree(store.TAKES_DIR / island_id, ignore_errors=True)
    return done


async def _build_island(island_id: str, audio_path: Path, complexity: str,
                        speaker: int, count: int) -> None:
    """The whole pipeline, run in the background so the upload returns at once."""
    try:
        store.set_stage(island_id, "transcribing")
        result = await asyncio.to_thread(transcribe.transcribe, audio_path)
        text = result.get("text", "")
        language = result.get("language", "")
        if not text:
            store.set_failed(island_id, "Nothing could be transcribed from that recording.")
            return
        store.set_transcript(island_id, text)
        log.info("island %s transcript: %d chars, language=%s", island_id, len(text), language)

        store.set_stage(island_id, "writing")
        generated = await asyncio.to_thread(
            generate.generate_lines, text, complexity, count, language
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
    # Islands built before word timings existed get them on first read.
    for line in island["lines"]:
        if not line["words"] and line["timeline"]:
            line["words"] = segment.align(line["ja"], line["timeline"])
            # A whole-line fallback is not worth persisting; a later read may
            # do better once whatever failed is fixed.
            if not segment.is_fallback(line["ja"], line["words"]):
                store.set_words(island_id, line["idx"], line["words"])
    return island


SPEED_MIN, SPEED_MAX = 0.5, 1.5

# One shared calibration profile for the phone's speaker-to-mic path (see the
# take-bleed plan). It is not scoped to an island: the room and the phone are
# what it models, not any one recording.
TAKE_PROFILE = "default"


async def _resolve_line_audio(island: dict, idx: int, speed: float) -> Path:
    """Path to a line's rendered wav at the given speed, rendering and caching
    it first if it is not already on disk. Shared by the line audio route and
    the take cleaner, which needs the exact reference the phone played."""
    speed = round(min(SPEED_MAX, max(SPEED_MIN, speed)) * 20) / 20
    path = store.line_audio_path(island["id"], idx)
    if speed != 1.0:
        path = path.with_name(f"{idx}@{speed:.2f}.wav")
        if not path.exists():
            line = next((l for l in island.get("lines", []) if l["idx"] == idx), None)
            if line is None:
                raise HTTPException(404, "no such line")
            try:
                wav, _, _, _ = await voicevox.speak(line["ja"], island["speaker"], speed)
            except voicevox.VoicevoxError as exc:
                raise HTTPException(502, str(exc)) from exc
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(wav)
            os.replace(tmp, path)
    return path


@app.get("/shadow/islands/{island_id}/lines/{idx}/audio")
async def line_audio(island_id: str, idx: int, token: str = "", speed: float = 1.0,
                     authorization: str | None = Header(None)) -> FileResponse:
    """One line's wav. With `speed` other than 1, the line is re-synthesized
    at that speedScale (rounded to 0.05) and cached beside the original, so
    slow playback is natural speech rather than a stretched recording."""
    # Audio is fetched by the player, which cannot always set a header, so a
    # token query parameter is accepted here as well as the usual header.
    _token_or_header(token, authorization)
    island = store.get_island(island_id)
    if island is None:
        raise HTTPException(404, "no such island")
    path = await _resolve_line_audio(island, idx, speed)
    if not path.exists():
        raise HTTPException(404, "no audio for that line")
    return FileResponse(path, media_type="audio/wav")


def _round(value: float | None, places: int = 1) -> float | None:
    return None if value is None else round(float(value), places)


def _run_calibration(src: Path, ref_path: Path) -> dict:
    """Learn the phone's speaker-to-mic path from a silent recording and store
    it. Blocking: two ffmpeg decodes and several passes of the filter, so it
    is called in a thread."""
    import aec

    profile = aec.calibrate(aec.decode(ref_path), aec.decode(src))
    aec.save_profile(TAKE_PROFILE, profile)
    return {
        "cleaned": True,
        "erleDb": _round(profile.erle_db),
        "delayMs": _round(profile.delay * 1000.0 / aec.SR),
        "driftSamples": None,
        "frozenBlocks": None,
        "note": "Speaker profile saved",
    }


def _run_clean(src: Path, ref_path: Path, profile, island_id: str, idx: int) -> dict:
    """Take the played line back out of a take and store both versions.
    Blocking, for the same reasons as _run_calibration."""
    import aec

    mic = aec.decode(src)
    result = aec.clean(aec.decode(ref_path), mic, profile)

    raw_path, clean_path = store.take_paths(island_id, idx)
    aec.encode(raw_path, mic)
    if result.cleaned:
        aec.encode(clean_path, result.output)
    else:
        # This line may have had a cleanable take before. Leaving that file
        # behind would let /take/clean serve the previous take's audio as if
        # it belonged to the one just uploaded.
        clean_path.unlink(missing_ok=True)

    return {
        "cleaned": result.cleaned,
        "erleDb": _round(result.erle_db),
        "delayMs": _round(result.delay_ms),
        "driftSamples": result.drift_samples,
        "frozenBlocks": result.frozen_blocks,
        "note": result.note,
    }


@app.post("/shadow/islands/{island_id}/lines/{idx}/take")
async def upload_take(
    island_id: str,
    idx: int,
    take: UploadFile = File(...),
    speed: float = Form(1.0),
    calibrate: str = Form("0"),
    authorization: str | None = Header(None),
) -> dict:
    """Clean a shadow take against the line that was playing while it was
    recorded, or (calibrate=1) learn the phone's speaker-to-mic path from a
    silent recording of that same line.

    Calibration has to happen once per phone before any take can be cleaned,
    which is why a take without a stored profile is refused with a 409 rather
    than quietly kept as recorded: the difference matters to the caller. See
    aec.py for how the path is learned and applied."""
    require_token(authorization)
    start = time.monotonic()
    is_calibration = calibrate == "1"

    island = store.get_island(island_id)
    if island is None:
        raise HTTPException(404, "no such island")
    line = next((l for l in island["lines"] if l["idx"] == idx), None)
    if line is None:
        raise HTTPException(404, "no such line")

    try:
        # Imported lazily so the app still starts if this module is broken
        # or, since it is being written in parallel, does not exist yet.
        import aec
    except Exception as exc:
        log.exception("aec module unavailable")
        raise HTTPException(503, "the take cleaner is not available") from exc

    profile = None
    if not is_calibration:
        profile = aec.load_profile(TAKE_PROFILE)
        if profile is None:
            raise HTTPException(409, "calibrate first")

    raw = await take.read()
    if not raw:
        raise HTTPException(400, "empty upload")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "take too large")

    tmp_dir = Path(tempfile.mkdtemp(prefix=f"take-{island_id}-{idx}-"))
    try:
        suffix = Path(take.filename or "take.wav").suffix or ".wav"
        src = tmp_dir / f"upload{suffix}"
        src.write_bytes(raw)
        ref_path = await _resolve_line_audio(island, idx, speed)

        # ffmpeg and the filter are seconds of blocking CPU. On the event loop
        # they would stall every other request for the duration, including the
        # island list the phone polls while it waits for this one.
        if is_calibration:
            response = await asyncio.to_thread(_run_calibration, src, ref_path)
        else:
            response = await asyncio.to_thread(
                _run_clean, src, ref_path, profile, island_id, idx
            )
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        log.info(
            "take island=%s idx=%d calibrate=%s took %.2fs",
            island_id, idx, is_calibration, time.monotonic() - start,
        )
    return response


@app.get("/shadow/islands/{island_id}/lines/{idx}/take/clean")
async def take_clean(island_id: str, idx: int, token: str = "", v: str = "",
                     authorization: str | None = Header(None)) -> FileResponse:
    """The cleaned copy of a take. `v` is the take's recordedAt, accepted so
    the player's cache key changes with each new take; the file is served
    with no-store regardless, since the same URL can point at a different
    take between calls."""
    _token_or_header(token, authorization)
    _, clean_path = store.take_paths(island_id, idx)
    if not clean_path.exists():
        raise HTTPException(404, "no cleaned take for that line")
    return FileResponse(
        clean_path, media_type="audio/wav", headers={"Cache-Control": "no-store"}
    )


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


async def _revoice(island_id: str, lines: list[dict], speaker: int, title: str) -> None:
    try:
        made = await _synthesize_lines(island_id, lines, speaker)
        if made == 0:
            store.set_failed(island_id, "The voice engine produced no audio.")
            return
        store.set_ready(island_id, title)
    except Exception as exc:
        log.exception("revoice %s failed", island_id)
        store.set_failed(island_id, str(exc))


@app.post("/shadow/islands/{island_id}/revoice")
async def revoice(
    island_id: str,
    background: BackgroundTasks,
    speaker: int = Form(...),
    authorization: str | None = Header(None),
) -> dict:
    """Re-render an island's existing lines in another voice. Keeps the text,
    so there is no transcription or generation: a few seconds of synthesis."""
    require_token(authorization)
    island = store.get_island(island_id)
    if island is None:
        raise HTTPException(404, "no such island")
    if island["status"] != "ready":
        raise HTTPException(409, "the island is still being built")
    lines = [
        {"ja": l["ja"], "kana": l["kana"], "romaji": l["romaji"], "en": l["en"]}
        for l in island["lines"]
    ]
    if not lines:
        raise HTTPException(409, "the island has no lines to re-voice")

    store.set_speaker(island_id, speaker)
    store.set_stage(island_id, "speaking")
    # Lines are replaced one at a time as they render (INSERT OR REPLACE), so
    # an interruption leaves a mix of voices rather than an empty island.
    background.add_task(_revoice, island_id, lines, speaker, island["title"])
    return {"id": island_id, "status": "working", "speaker": speaker}


WORD_STRIP = "、。！？!?…「」『』（）() "


@app.get("/shadow/word-audio")
async def word_audio(text: str, speaker: int = voicevox.DEFAULT_SPEAKER, token: str = "",
                     authorization: str | None = Header(None)) -> FileResponse:
    """One word rendered on its own, so hearing it again is a complete,
    natural utterance rather than a slice cut out of the line. Cached per
    voice and text."""
    _token_or_header(token, authorization)
    clean = text.strip(WORD_STRIP)
    if not clean:
        raise HTTPException(400, "empty word")
    folder = store.DATA_DIR / "words" / str(speaker)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{hashlib.sha1(clean.encode()).hexdigest()[:16]}.wav"
    if not path.exists():
        try:
            wav, _, _, _ = await voicevox.speak(clean, speaker)
        except voicevox.VoicevoxError as exc:
            raise HTTPException(502, str(exc)) from exc
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(wav)
        os.replace(tmp, path)
    return FileResponse(path, media_type="audio/wav")


@app.get("/shadow/gloss")
async def word_gloss(word: str, authorization: str | None = Header(None)) -> dict:
    """Base form, reading and dictionary senses for one word from a line."""
    require_token(authorization)
    return await asyncio.to_thread(glossary.gloss, word)


@app.delete("/shadow/islands/{island_id}")
def delete_island(island_id: str, authorization: str | None = Header(None)) -> dict:
    require_token(authorization)
    store.delete_island(island_id)
    return {"ok": True}
