# Routes for create, moved out of main.py.
import asyncio
import math
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, File, Form, Header, HTTPException, UploadFile

import config
import dependencies
import dev_review
import generate
import languages
import store
import voicevox
import voices
import media as media_io
from services import build

router = APIRouter()


@router.post("/shadow/islands")
async def create_island(
    background: BackgroundTasks,
    audio: UploadFile = File(...),
    complexity: str = Form("simple"),
    register: str = Form("polite"),
    language: str = Form("ja"),
    native: str = Form("en"),
    speaker: int = Form(voicevox.DEFAULT_SPEAKER),
    count: int = Form(8),
    topic: int = Form(0),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if complexity not in generate.COMPLEXITY_RULES:
        raise HTTPException(400, {"code": "bad_complexity"})
    if register not in generate.REGISTER_RULES:
        raise HTTPException(400, {"code": "bad_register"})
    languages.require_learning(language, device)
    if native not in ("he", "en"):
        raise HTTPException(400, {"code": "bad_native"})
    if language == native:
        raise HTTPException(400, {"code": "same_language"})
    if voices.language_for(speaker) != language:
        raise HTTPException(400, {"code": "voice_language_mismatch"})

    raw = await audio.read()
    if not raw:
        raise HTTPException(400, {"code": "empty_upload"})
    if len(raw) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, {"code": "recording_too_large"})

    dependencies._take_build_slot(device, "create", "create")
    island_id = store.create_island(
        complexity, speaker, register, language, native=native, device=device,
        **({"source": "phrases", "source_name": "voice-topic"} if topic else {}),
    )
    suffix = Path(audio.filename or "rec.m4a").suffix or ".m4a"
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"island-{island_id}-"))
    src = tmp_dir / f"input{suffix}"
    src.write_bytes(raw)

    wav = store.AUDIO_DIR / island_id / "source.wav"
    if not media_io._to_wav(src, wav):
        shutil.rmtree(tmp_dir, ignore_errors=True)
        store.set_failed(island_id, "That audio file could not be decoded.", "audio_undecodable")
        dependencies._refund_build_slot(device, "create", "create")
        raise HTTPException(400, {"code": "audio_undecodable"})
    shutil.rmtree(tmp_dir, ignore_errors=True)

    background.add_task(
        dependencies._refunding(build._build_island, island_id, device, "create", "create"), island_id, wav, complexity, speaker, count, register, language, native,
        bool(topic),
    )
    return {"id": island_id, "status": "pending"}


@router.post("/shadow/islands/import")
async def create_import_island(
    background: BackgroundTasks,
    audio: UploadFile = File(...),
    subtitles: UploadFile | None = File(None),
    title: str = Form(""),
    speaker: int = Form(voicevox.DEFAULT_SPEAKER),
    language: str = Form("ja"),
    native: str = Form("en"),
    start_min: float = Form(0),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Import an audio file (plus an optional .srt) as an island that plays
    the original audio, sliced per line."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    languages.require_learning(language, device)
    if native not in ("he", "en"):
        raise HTTPException(400, {"code": "bad_native"})
    if language == native:
        raise HTTPException(400, {"code": "same_language"})
    if voices.language_for(speaker) != language:
        raise HTTPException(400, {"code": "voice_language_mismatch"})
    if not math.isfinite(start_min) or start_min < 0:
        raise HTTPException(400, "start_min must be a finite number >= 0")

    tmp_dir = Path(tempfile.mkdtemp(prefix="import-"))
    suffix = Path(audio.filename or "audio").suffix or ".bin"
    media = tmp_dir / f"media{suffix}"
    try:
        size = await asyncio.to_thread(media_io._stream_upload, audio, media, config.IMPORT_MAX_BYTES)
    except HTTPException:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    if size == 0:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(400, "empty upload")

    srt_text = None
    if subtitles is not None:
        srt_raw = await subtitles.read()
        if srt_raw:
            srt_path = tmp_dir / "subs.srt"
            srt_path.write_bytes(srt_raw[:config.SRT_MAX_BYTES])
            srt_text = await asyncio.to_thread(media_io._read_srt, srt_path)

    island_title = title.strip() or Path(audio.filename or "import").stem
    try:
        dependencies._take_build_slot(device, "create", "import")
    except HTTPException:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    island_id = store.create_island(
        "simple", speaker, language=language, native=native, source="import",
        source_name=audio.filename or "import", device=device,
    )
    store.start_build(island_id)
    background.add_task(
        dependencies._refunding(build._build_import, island_id, device, "create", "import"), island_id, media, srt_text, island_title, float(start_min) * 60.0,
        tmp_dir, language, native,
    )
    return {"id": island_id, "status": "pending"}


@router.post("/shadow/islands/{island_id}/regenerate")
async def regenerate(
    island_id: str,
    background: BackgroundTasks,
    complexity: str = Form("complex"),
    count: int = Form(8),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Rebuild an island's lines at the other complexity, reusing the recording
    that is already on disk so the learner does not have to speak again."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if complexity not in generate.COMPLEXITY_RULES:
        raise HTTPException(400, {"code": "bad_complexity"})
    island = await asyncio.to_thread(dependencies._own_island, island_id, device)
    if island["source"] == "phrases":
        raise HTTPException(409, "a phrase island has no recording to rewrite from")
    if island["source"] != "voice":
        raise HTTPException(409, "regenerate is only for a recorded island")

    wav = store.AUDIO_DIR / island_id / "source.wav"
    if not wav.exists():
        raise HTTPException(409, "the original recording is gone")

    dependencies._take_build_slot(device, "rework", "regenerate")
    store.clear_lines(island_id)
    with store.connect() as conn:
        conn.execute(
            "UPDATE islands SET complexity=?, status='working', stage='writing', error=''"
            " WHERE id=?",
            (complexity, island_id),
        )
    background.add_task(
        dependencies._refunding(build._build_island, island_id, device, "rework", "regenerate"),
        island_id, wav, complexity, island["speaker"], count,
        island.get("register", "polite"), island.get("language", "ja"), island.get("native", "en"),
        transcript=island.get("transcript") or "",
    )
    return {"id": island_id, "status": "working", "complexity": complexity}


@router.post("/shadow/islands/{island_id}/revoice")
async def revoice(
    island_id: str,
    background: BackgroundTasks,
    speaker: int = Form(...),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """Re-render an island's existing lines in another voice. Keeps the text,
    so there is no transcription or generation: a few seconds of synthesis."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    island = await asyncio.to_thread(dependencies._own_island, island_id, device)
    if island["status"] != "ready":
        raise HTTPException(409, "the island is still being built")
    if island["source"] != "voice":
        raise HTTPException(409, "revoice is only for a recorded island")
    lines = [
        {"ja": l["ja"], "kana": l["kana"], "romaji": l["romaji"], "en": l["en"]}
        for l in island["lines"]
    ]
    if not lines:
        raise HTTPException(409, "the island has no lines to re-voice")
    if voices.language_for(speaker) != island.get("language", "ja"):
        raise HTTPException(400, {"code": "voice_language_mismatch"})

    dependencies._take_build_slot(device, "rework")
    store.set_speaker(island_id, speaker)
    store.set_stage(island_id, "speaking")
    # Lines are replaced one at a time as they render (INSERT OR REPLACE), so
    # an interruption leaves a mix of voices rather than an empty island.
    background.add_task(build._revoice, island_id, lines, speaker, island["title"], island.get("language", "ja"))
    return {"id": island_id, "status": "working", "speaker": speaker}


@router.post("/shadow/say")
async def create_say(
    background: BackgroundTasks,
    audio: UploadFile = File(...),
    language: str = Form("ja"),
    native: str = Form("he"),
    speaker: int = Form(voicevox.DEFAULT_SPEAKER),
    register: str = Form("polite"),
    dev_transcript: str = Form(""),
    authorization: str | None = Header(None),
    x_shadow_device: str = Header(""),
) -> dict:
    """One sentence said in `native`, built into a 1-line (or few-line)
    voice island in `language`. `dev_transcript` stands in for whisper
    outside prod only. The client polls GET /shadow/islands/{id}."""
    dependencies.require_token(authorization)
    device = dependencies._require_device(x_shadow_device)
    if register not in generate.REGISTER_RULES:
        raise HTTPException(400, {"code": "bad_register"})
    languages.require_learning(language, device)
    if native not in ("he", "en"):
        raise HTTPException(400, {"code": "bad_native"})
    if language == native:
        raise HTTPException(400, {"code": "same_language"})
    if voices.language_for(speaker) != language:
        raise HTTPException(400, {"code": "voice_language_mismatch"})

    raw = await audio.read()
    if not raw:
        raise HTTPException(400, {"code": "empty_upload"})
    if len(raw) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, {"code": "recording_too_large"})
    transcript = dev_transcript.strip() if dev_review.enabled() else ""

    dependencies._take_say_slot(device)
    island_id = store.create_island(
        "simple", speaker, register, language, native=native, device=device,
        source="voice", source_name="say",
    )
    suffix = Path(audio.filename or "rec.m4a").suffix or ".m4a"
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"say-{island_id}-"))
    src = tmp_dir / f"input{suffix}"
    src.write_bytes(raw)

    wav = store.AUDIO_DIR / island_id / "source.wav"
    if not media_io._to_wav(src, wav):
        shutil.rmtree(tmp_dir, ignore_errors=True)
        store.set_failed(island_id, "That audio file could not be decoded.", "audio_undecodable")
        dependencies._refund_build_slot(device, "say", "")
        raise HTTPException(400, {"code": "audio_undecodable"})
    shutil.rmtree(tmp_dir, ignore_errors=True)

    background.add_task(
        dependencies._refunding(build._build_say, island_id, device, "say", ""),
        island_id, wav, speaker, register, language, native, transcript,
    )
    return {"id": island_id, "status": "pending"}
