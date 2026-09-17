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
import copy
import hashlib
import json
import logging
import math
import os
import secrets
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from dotenv import load_dotenv
from pydantic import BaseModel

# Before the local imports: store, voicevox and transcribe read their settings
# from the environment at import time.
load_dotenv()

import cues
import explain
import export
import generate
import gloss as glossary
import podcast
import schedule
import segment
import store
import suggest
import transcribe
import voicevox

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
log = logging.getLogger("shadow")

SHADOW_TOKEN = os.getenv("SHADOW_TOKEN", "")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
IMPORT_MAX_BYTES = 300 * 1024 * 1024
IMPORT_MAX_SECONDS = 1800  # 30 minutes: how much of an import an island keeps
SRT_MAX_BYTES = 2 * 1024 * 1024
SLICE_RATE = 24000  # aec.SR: VOICEVOX's rate, which the take cleaner and slicer assume

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
    schedule.init()
    log.info("store ready at %s", store.DB_PATH)
    # Background work dies with the process. Anything still marked as working
    # was interrupted, and must not sit in that state forever.
    for island in store.list_islands():
        if island["status"] in ("pending", "working"):
            if island["source"] != "voice":
                # An import or podcast build has no partial-progress state
                # worth keeping: the source media is a temp file that is
                # already gone, so it cannot resume or be regenerated.
                store.set_failed(island["id"], "Import was interrupted. Delete it and import again.")
                log.warning("island %s (%s) was interrupted; marked failed", island["id"], island["source"])
            elif island["line_count"] > 0:
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


JAPANESE_TAGS = ("jpn", "ja")


def pick_audio_stream(probe: dict) -> int | None:
    """The ffprobe stream index of the audio track to import, from ffprobe's
    parsed `-of json` output. Dual-audio releases often put an English dub
    first, so the first audio stream tagged `jpn` or `ja` wins; with no such
    tag, the first audio stream. None when there is no audio stream."""
    audio = [s for s in probe.get("streams", []) if s.get("codec_type") == "audio"]
    for stream in audio:
        language = str((stream.get("tags") or {}).get("language", "")).lower()
        if language in JAPANESE_TAGS:
            return int(stream["index"])
    return int(audio[0]["index"]) if audio else None


def _probe_streams(path: Path) -> dict:
    """ffprobe's stream list for a media file as parsed JSON, {} on failure.
    Blocking; callers use asyncio.to_thread."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "stream=index,codec_type:stream_tags=language",
                "-of", "json", str(path),
            ],
            capture_output=True,
            check=True,
            timeout=60,
            text=True,
        )
        return json.loads(result.stdout)
    except Exception:
        log.exception("ffprobe streams failed for %s", path)
        return {}


def _unique_tmp(dst: Path) -> Path:
    """A tmp path beside dst that no other call shares, so two ffmpeg runs
    for the same target never write into one file."""
    return dst.with_name(f".{dst.stem}.{secrets.token_hex(6)}.tmp")


def _extract_audio(src: Path, dst: Path, stream: int, start_s: float = 0.0,
                   max_s: float | None = None) -> bool:
    """Pull audio stream `stream` (an ffprobe index, see pick_audio_stream)
    out of an imported file, as 24kHz mono 16-bit PCM: VOICEVOX's rate, which
    aec.SR and the take cleaner already assume. `start_s` and `max_s` trim
    the source in the same ffmpeg call, which is how the 30-minute import
    cap and a `start_min` offset are applied. Blocking; callers use
    asyncio.to_thread."""
    tmp = dst.with_suffix(".tmp")
    cmd = ["ffmpeg", "-y"]
    if start_s > 0:
        cmd += ["-ss", f"{start_s:.3f}"]
    cmd += ["-i", str(src)]
    if max_s is not None:
        cmd += ["-t", f"{max_s:.3f}"]
    cmd += [
        "-map", f"0:{stream}", "-ac", "1", "-ar", str(SLICE_RATE), "-c:a", "pcm_s16le",
        "-f", "wav", str(tmp),
    ]
    try:
        subprocess.run(cmd, capture_output=True, check=True, timeout=1200)
        if not tmp.exists():
            return False
        os.replace(tmp, dst)
        return dst.exists()
    except Exception:
        log.exception("ffmpeg extract failed for %s", src)
        tmp.unlink(missing_ok=True)
        return False


def _slice(src: Path, dst: Path, start: float, end: float) -> bool:
    """Cut one line's audio out of source.wav. `-ss` before `-i` on a wav is
    sample-accurate. Blocking; callers use asyncio.to_thread."""
    tmp = dst.with_suffix(".tmp")
    try:
        subprocess.run(
            [
                "ffmpeg", "-y",
                "-ss", f"{start:.3f}", "-i", str(src),
                "-t", f"{end - start:.3f}", "-c:a", "pcm_s16le",
                "-f", "wav", str(tmp),
            ],
            capture_output=True,
            check=True,
            timeout=120,
        )
        if not tmp.exists():
            return False
        os.replace(tmp, dst)
        return dst.exists()
    except Exception:
        log.exception("ffmpeg slice failed for %s [%.3f, %.3f)", src, start, end)
        tmp.unlink(missing_ok=True)
        return False


def _stretch(src: Path, dst: Path, speed: float) -> bool:
    """Slow (or speed up) a slice of imported audio with rubberband, pitch
    preserved. Output length is 1/speed of the input, which is what the
    client's w.start / speed assumes. Blocking; callers use asyncio.to_thread.

    Two requests for the same line and speed can both miss the cache and get
    here at once. Each writes its own tmp file and swaps it in with
    os.replace, so both finish with a whole file at dst and neither can
    read, move or delete the other's half-written output."""
    tmp = _unique_tmp(dst)
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(src),
                "-filter:a", f"rubberband=tempo={speed}",
                "-c:a", "pcm_s16le",
                "-f", "wav", str(tmp),
            ],
            capture_output=True,
            check=True,
            timeout=120,
        )
        if not tmp.exists():
            return False
        os.replace(tmp, dst)
        return dst.exists()
    except Exception:
        log.exception("ffmpeg stretch failed for %s at %s", src, speed)
        tmp.unlink(missing_ok=True)
        return False


def _probe_duration(path: Path) -> float:
    """The duration of an audio file in seconds, 0.0 on failure."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True,
            check=True,
            timeout=30,
            text=True,
        )
        return float(result.stdout.strip())
    except Exception:
        log.exception("ffprobe failed for %s", path)
        return 0.0


def _read_srt(path: Path) -> str:
    """Japanese subtitle files show up as utf-8-sig or, less often, Shift-JIS
    (cp932). Falls back to utf-8 with replacement rather than raising, so a
    stranger encoding imports as garbage text instead of failing the import."""
    raw = path.read_bytes()[:SRT_MAX_BYTES]
    for encoding in ("utf-8-sig", "cp932"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _stream_upload(upload: UploadFile, dst: Path, max_bytes: int) -> int:
    """Copy an UploadFile to disk in chunks, so a large import is never held
    whole in memory. Raises HTTPException(413) past `max_bytes`. Blocking;
    callers use asyncio.to_thread."""
    size = 0
    with open(dst, "wb") as out:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                raise HTTPException(413, "that file is too large to import")
            out.write(chunk)
    return size


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
    # An export built from the old lines no longer matches this island's
    # content, so it must not be served again under the same cache key.
    export.clear_exports(island_id)
    # A take was cleaned against the line that used to be at this index. A
    # regenerate or revoice replaces that line, so the old take (and its
    # cleaned copy) no longer matches anything and would be misleading.
    shutil.rmtree(store.TAKES_DIR / island_id, ignore_errors=True)
    return done


async def _build_island(island_id: str, audio_path: Path, complexity: str,
                        speaker: int, count: int, register: str = "polite") -> None:
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
            generate.generate_lines, text, complexity, count, language, register
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
    register: str = Form("polite"),
    language: str = Form("ja"),
    speaker: int = Form(voicevox.DEFAULT_SPEAKER),
    count: int = Form(8),
    authorization: str | None = Header(None),
) -> dict:
    require_token(authorization)
    if complexity not in generate.COMPLEXITY_RULES:
        raise HTTPException(400, "complexity must be 'simple' or 'complex'")
    if register not in generate.REGISTER_RULES:
        raise HTTPException(400, "register must be 'polite' or 'casual'")
    if language not in ("ja", "es", "en"):
        raise HTTPException(400, "language must be 'ja', 'es' or 'en'")

    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "empty upload")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "recording too large")

    island_id = store.create_island(complexity, speaker, register, language)
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

    background.add_task(_build_island, island_id, wav, complexity, speaker, count, register)
    return {"id": island_id, "status": "pending"}


async def _build_from_cues(island_id: str, source_wav: Path, cue_list: list[dict],
                           title: str, total: float) -> None:
    """The shared tail of the import pipeline: slice one wav per cue out of
    source_wav, give each line its reading and word timings, and mark the
    island ready. `total` is source_wav's duration, the same value the words
    were attached with (cues.attach_words), so every attached word lies
    inside its line's slice. `made` may be less than len(cue_list) when a
    slice fails, so lines stay contiguously indexed from 0."""
    store.set_stage(island_id, "slicing")
    made = 0
    with_words = 0
    ja_texts: list[str] = []
    for i, cue in enumerate(cue_list):
        start, end = cues.slice_bounds(cue_list, i, total)
        target = store.line_audio_path(island_id, made)
        ok = await asyncio.to_thread(_slice, source_wav, target, start, end)
        if not ok:
            continue
        duration = round(end - start, 3)
        pieces = [
            {"text": w["text"], "start": w["start"] - start, "end": w["end"] - start}
            for w in cue.get("words", [])
        ]
        words = await asyncio.to_thread(segment.align_pieces, cue["text"], pieces, duration)
        line = {"ja": cue["text"], "kana": segment.reading(cue["text"]), "romaji": "", "en": ""}
        store.add_line(island_id, made, line, duration, [], words, offset=start)
        if cue.get("words"):
            with_words += 1
        ja_texts.append(cue["text"])
        made += 1
    if made == 0:
        store.set_failed(island_id, "No line could be cut from that audio.")
        return
    store.set_ready(island_id, title)
    log.info(
        "island %s ready: %d lines, %d with whisper words (%d fell back to a steady pace)",
        island_id, made, with_words, made - with_words,
    )

    # The island is already ready, so a translation error only costs the
    # English. It must never reach _build_import's handler, which would mark
    # the island failed.
    try:
        for batch_start in range(0, len(ja_texts), generate.TRANSLATE_BATCH):
            batch = ja_texts[batch_start:batch_start + generate.TRANSLATE_BATCH]
            translations = await asyncio.to_thread(generate.translate_lines, batch)
            for offset, en in enumerate(translations):
                if en:
                    store.set_en(island_id, batch_start + offset, en)
            log.info(
                "island %s translated lines %d..%d (%d ok)",
                island_id, batch_start, batch_start + len(batch), len(translations),
            )
    except Exception:
        log.exception("island %s: translation stopped early, the island stays ready", island_id)


async def _build_import(island_id: str, media: Path, srt_text: str | None,
                        title: str, start_s: float, tmp_dir: Path | None = None) -> None:
    """The import pipeline, run in the background so the upload returns at
    once: pull the audio out (trimmed to the 30-minute cap from `start_s`),
    run whisper once over the whole clip for word timings, get cues from the
    .srt if one was given (whisper's own segments otherwise), then slice."""
    try:
        store.set_stage(island_id, "extracting")
        probe = await asyncio.to_thread(_probe_streams, media)
        if not probe.get("streams"):
            store.set_failed(island_id, "That media file could not be decoded.")
            return
        stream = pick_audio_stream(probe)
        if stream is None:
            store.set_failed(island_id, "That media file has no audio track.")
            return
        source_total = await asyncio.to_thread(_probe_duration, media)
        if source_total > 0 and start_s >= source_total:
            store.set_failed(
                island_id,
                f"The start time ({start_s / 60.0:.0f} min) is past the end of the media"
                f" ({source_total / 60.0:.0f} min).",
            )
            return
        wav = store.AUDIO_DIR / island_id / "source.wav"
        ok = await asyncio.to_thread(
            _extract_audio, media, wav, stream, start_s, IMPORT_MAX_SECONDS
        )
        if not ok:
            store.set_failed(island_id, "That media file could not be decoded.")
            return
        total = await asyncio.to_thread(_probe_duration, wav)
        if total <= 0:
            store.set_failed(island_id, "That media file could not be decoded.")
            return

        # A suffix whenever the island does not cover the source from its
        # very start to its very end, so the range is never a silent surprise.
        trimmed = start_s > 0 or (source_total > 0 and source_total - start_s > total + 0.5)
        if trimmed:
            start_min, end_min = start_s / 60.0, (start_s + total) / 60.0
            title = f"{title} ({start_min:.0f}–{end_min:.0f} min)"

        store.set_stage(island_id, "transcribing")
        result = await asyncio.to_thread(transcribe.transcribe, wav, "ja", True, True)
        if not result.get("ok"):
            store.set_failed(
                island_id,
                "Whisper could not transcribe that audio, so the lines would have no word"
                " timings. Check the backend log, then delete this island and import again.",
            )
            return
        if not result["words"]:
            log.warning(
                "island %s: whisper heard no words in %s; every line falls back to a steady pace",
                island_id, wav,
            )

        if srt_text:
            cue_list = cues.parse_srt(srt_text)
            cue_list = cues.window(cue_list, start_s, total)
            if not cue_list:
                store.set_failed(island_id, "No subtitle lines fall inside that time range.")
                return
            cue_list = cues.attach_words(cue_list, result["words"], total)
        else:
            seg_cues = [
                {"start": s["start"], "end": s["end"], "text": s["text"], "words": s["words"]}
                for s in result["segments"]
                if s["text"]
            ]
            cue_list = cues.split_long(seg_cues, max_seconds=8.0)
            if not cue_list:
                store.set_failed(island_id, "Nothing could be transcribed from that audio.")
                return

        await _build_from_cues(island_id, wav, cue_list, title, total)
    except Exception as exc:
        log.exception("import %s failed", island_id)
        store.set_failed(island_id, str(exc))
    finally:
        if tmp_dir is not None:
            shutil.rmtree(tmp_dir, ignore_errors=True)


@app.post("/shadow/islands/import")
async def create_import_island(
    background: BackgroundTasks,
    audio: UploadFile = File(...),
    subtitles: UploadFile | None = File(None),
    title: str = Form(""),
    speaker: int = Form(voicevox.DEFAULT_SPEAKER),
    language: str = Form("ja"),
    start_min: float = Form(0),
    authorization: str | None = Header(None),
) -> dict:
    """Import an audio file (plus an optional .srt) as an island that plays
    the original audio, sliced per line."""
    require_token(authorization)
    if language != "ja":
        raise HTTPException(400, "imports are Japanese only for now")
    if not math.isfinite(start_min) or start_min < 0:
        raise HTTPException(400, "start_min must be a finite number >= 0")

    tmp_dir = Path(tempfile.mkdtemp(prefix="import-"))
    suffix = Path(audio.filename or "audio").suffix or ".bin"
    media = tmp_dir / f"media{suffix}"
    try:
        size = await asyncio.to_thread(_stream_upload, audio, media, IMPORT_MAX_BYTES)
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
            srt_path.write_bytes(srt_raw[:SRT_MAX_BYTES])
            srt_text = await asyncio.to_thread(_read_srt, srt_path)

    island_title = title.strip() or Path(audio.filename or "import").stem
    island_id = store.create_island(
        "simple", speaker, language=language, source="import",
        source_name=audio.filename or "import",
    )
    background.add_task(
        _build_import, island_id, media, srt_text, island_title, float(start_min) * 60.0, tmp_dir,
    )
    return {"id": island_id, "status": "pending"}


@app.get("/shadow/podcasts/episodes")
async def podcast_episodes(url: str, authorization: str | None = Header(None)) -> dict:
    """List a podcast feed's episodes so one can be handed to the importer."""
    require_token(authorization)
    try:
        await podcast.check_url(url)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    try:
        xml = await podcast.fetch(url, None, podcast.FEED_MAX_BYTES)
    except podcast.PodcastError as exc:
        raise HTTPException(502, str(exc))
    return podcast.parse_feed(xml)


async def _build_podcast(island_id: str, audio_url: str, title: str, start_s: float,
                         tmp_dir: Path) -> None:
    """Download the episode audio into `tmp_dir`, then hand off to the same
    pipeline a file import uses. `_build_import` owns `tmp_dir` once it takes
    over; this only cleans up itself if the download never gets that far."""
    try:
        store.set_stage(island_id, "downloading")
        media = tmp_dir / "episode"
        await podcast.fetch(audio_url, media, IMPORT_MAX_BYTES)
    except podcast.PodcastError:
        store.set_failed(island_id, "The episode could not be downloaded.")
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return
    except Exception as exc:
        log.exception("podcast download %s failed", island_id)
        store.set_failed(island_id, str(exc))
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return
    await _build_import(island_id, media, None, title, start_s, tmp_dir)


@app.post("/shadow/podcasts/import")
async def import_podcast_episode(
    background: BackgroundTasks,
    audio_url: str = Form(...),
    title: str = Form(""),
    start_min: float = Form(0),
    speaker: int = Form(voicevox.DEFAULT_SPEAKER),
    language: str = Form("ja"),
    authorization: str | None = Header(None),
) -> dict:
    """Download a podcast episode by URL and import it the same way an
    uploaded file is imported."""
    require_token(authorization)
    if language != "ja":
        raise HTTPException(400, "imports are Japanese only for now")
    if not math.isfinite(start_min) or start_min < 0:
        raise HTTPException(400, "start_min must be a finite number >= 0")
    try:
        await podcast.check_url(audio_url)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    tmp_dir = Path(tempfile.mkdtemp(prefix="podcast-"))
    island_title = title.strip() or "Podcast episode"
    island_id = store.create_island(
        "simple", speaker, language=language, source="podcast", source_name=title,
    )
    background.add_task(
        _build_podcast, island_id, audio_url, island_title, float(start_min) * 60.0, tmp_dir,
    )
    return {"id": island_id, "status": "pending"}


@app.get("/shadow/islands")
def list_islands(authorization: str | None = Header(None)) -> list[dict]:
    require_token(authorization)
    return store.list_islands()


# Old islands get their word timings, furigana and pitch marks on first read
# rather than through a migration. Timings and ruby are local (janome) and
# fill every line in one read. Accent needs one VOICEVOX audio_query per
# line (no synthesis, about 50ms), so it is capped per read and an island
# with hundreds of lines fills over a few opens.
ACCENT_FILL_PER_READ = 16


def _fill_words(island_id: str, lines: list[dict]) -> None:
    """Word timings and ruby for lines stored before either existed. Blocking
    (janome), so the route runs it in a thread. Writes only when something
    was added, so a second read of the same island writes nothing, and only
    over the words it read, so a line replaced meanwhile is left alone."""
    for line in lines:
        before = copy.deepcopy(line["words"])
        if not line["words"] and line["timeline"]:
            line["words"] = segment.align(line["ja"], line["timeline"])
            # A whole-line fallback is not worth persisting; a later read may
            # do better once whatever failed is fixed.
            if not segment.is_fallback(line["ja"], line["words"]):
                store.set_words(island_id, line["idx"], line["words"], expected=before)
        elif segment.ensure_ruby(line["words"], line["timeline"]):
            store.set_words(island_id, line["idx"], line["words"], expected=before)


async def _fill_accent(island: dict) -> None:
    """`high` per mora for timelines stored before pitch marks existed, from
    a fresh audio_query of the same text. At most ACCENT_FILL_PER_READ engine
    calls, each with a short timeout; the first failure ends the pass (no
    marks this time, tried again next read). A line whose moras do not line
    up with the fresh query is stored with None so it is never asked again.
    Empty timelines have nothing to fill and are skipped. Writes only over
    the timeline it read."""
    calls = 0
    for line in island["lines"]:
        if not voicevox.needs_accent(line["timeline"]):
            continue
        if calls >= ACCENT_FILL_PER_READ:
            break
        calls += 1
        try:
            query = await voicevox.audio_query(
                line["ja"], island["speaker"], timeout=voicevox.BACKFILL_TIMEOUT_S
            )
        except Exception:
            log.warning("accent backfill: VOICEVOX unreachable or slow for %s", island["id"])
            break
        filled = voicevox.backfill_accent(line["timeline"], query)
        if filled is None:
            log.warning("accent backfill: moras differ for %s line %d", island["id"], line["idx"])
            filled = [{**m, "high": None} for m in line["timeline"]]
        if store.set_timeline(island["id"], line["idx"], filled, expected=line["timeline"]):
            line["timeline"] = filled


@app.get("/shadow/islands/{island_id}")
async def get_island(island_id: str, authorization: str | None = Header(None)) -> dict:
    require_token(authorization)
    island = await asyncio.to_thread(store.get_island, island_id)
    if island is None:
        raise HTTPException(404, "no such island")
    # A re-voice or regenerate rewrites lines while the phone polls this
    # route, so backfill only a settled island.
    if island["status"] == "ready":
        await asyncio.to_thread(_fill_words, island_id, island["lines"])
        await _fill_accent(island)
    return island


SPEED_MIN, SPEED_MAX = 0.5, 1.5


def _variant(idx: int, speed: float, span: tuple[int, int] | None) -> str:
    """Stem of a cached render: the speed and, for a phrase, its span in
    ms. `speed` is already rounded to 0.05."""
    stem = f"{idx}@{speed:.2f}"
    return f"{stem}~{span[0]}-{span[1]}" if span else stem


def _span(start: int, end: int) -> tuple[int, int] | None:
    """The (start, end) ms pair a route was asked for, or None for the whole
    line. Both default to -1; any other negative value, giving one without
    the other, or an empty or backwards span, is a client error."""
    if start < -1 or end < -1:
        raise HTTPException(400, "start and end must be milliseconds, or -1 for the whole line")
    if start < 0 and end < 0:
        return None
    if start < 0 or end <= start:
        raise HTTPException(400, "start and end must be milliseconds with start < end")
    return (start, end)


# One shared calibration profile for the phone's speaker-to-mic path (see the
# take-bleed plan). It is not scoped to an island: the room and the phone are
# what it models, not any one recording.
TAKE_PROFILE = "default"


def _write_atomic(path: Path, data: bytes) -> None:
    """Write `data` to `path` via a temp file and rename, so a reader never
    sees a partial write. The tmp name carries a random suffix so two
    concurrent writers targeting the same `path` (two requests racing to
    render the same line) never share, and clobber, one tmp file. Blocking
    IO, meant to run in a thread."""
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _cached_transform(src: Path, dest: Path, transform) -> None:
    """If `dest` is not already on disk, read `src`, run the CPU-only
    `transform` over its bytes and atomically write the result to `dest`.
    Used for both the phrase slice and the pause pad: a stat, a read, the
    transform and a write-plus-rename, all blocking, so callers run this
    with asyncio.to_thread instead of on the event loop, matching every
    other route in this file that touches disk or does real work."""
    if dest.exists():
        return
    _write_atomic(dest, transform(src.read_bytes()))


async def _resolve_line_audio(island: dict, idx: int, speed: float,
                               span: tuple[int, int] | None = None) -> Path:
    """Path to a line's rendered wav at the given speed, rendering and caching
    it first if it is not already on disk. Shared by the line audio route and
    the take cleaner, which needs the exact reference the phone played: the
    whole line, or (`span` set) the phrase that was looping when the take was
    recorded."""
    speed = round(min(SPEED_MAX, max(SPEED_MIN, speed)) * 20) / 20
    path = store.line_audio_path(island["id"], idx)
    if speed != 1.0:
        path = path.with_name(f"{idx}@{speed:.2f}.wav")
        if not await asyncio.to_thread(path.exists):
            line = next((l for l in island.get("lines", []) if l["idx"] == idx), None)
            if line is None:
                raise HTTPException(404, "no such line")
            if island["source"] != "voice":
                # Imported islands play the source recording, not VOICEVOX:
                # slow it down (pitch preserved) instead of re-synthesizing.
                base = store.line_audio_path(island["id"], idx)
                if not await asyncio.to_thread(base.exists):
                    raise HTTPException(404, "no audio for that line")
                ok = await asyncio.to_thread(_stretch, base, path, speed)
                if not ok:
                    raise HTTPException(502, "could not change the playback speed")
            else:
                try:
                    wav, _, _, _ = await voicevox.speak(line["ja"], island["speaker"], speed)
                except voicevox.VoicevoxError as exc:
                    raise HTTPException(502, str(exc)) from exc
                await asyncio.to_thread(_write_atomic, path, wav)
    if span:
        sliced = path.with_name(_variant(idx, speed, span) + ".wav")
        try:
            await asyncio.to_thread(
                _cached_transform, path, sliced, lambda b: voicevox.slice_wav(b, *span)
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        path = sliced
    return path


# The longest silence the line audio route appends: the player's longest Pause.
PAD_MAX_MS = 10000


def _clamp_pad(pad: int) -> int:
    return max(0, min(PAD_MAX_MS, pad))


@app.get("/shadow/islands/{island_id}/lines/{idx}/audio")
async def line_audio(island_id: str, idx: int, token: str = "", speed: float = 1.0,
                     pad: int = 0, start: int = -1, end: int = -1,
                     authorization: str | None = Header(None)) -> FileResponse:
    """One line's wav. With `speed` other than 1, the line is re-synthesized
    at that speedScale (rounded to 0.05) and cached beside the original, so
    slow playback is natural speech rather than a stretched recording. With
    `pad` above 0, `pad` ms of silence is appended, cached beside the render,
    so the player can loop natively with the breath baked in rather than
    timing it in JS. With `start` and `end` both given, in milliseconds of
    the rendered audio, only that span (a phrase loop) is sliced out and
    served, cached beside the render the same way."""
    # Audio is fetched by the player, which cannot always set a header, so a
    # token query parameter is accepted here as well as the usual header.
    _token_or_header(token, authorization)
    island = await asyncio.to_thread(store.get_island, island_id)
    if island is None:
        raise HTTPException(404, "no such island")
    span = _span(start, end)
    path = await _resolve_line_audio(island, idx, speed, span)
    if not await asyncio.to_thread(path.exists):
        raise HTTPException(404, "no audio for that line")
    pad = _clamp_pad(pad)
    if pad > 0:
        speed_r = round(min(SPEED_MAX, max(SPEED_MIN, speed)) * 20) / 20
        # The "@" is what the stale sweep in _synthesize_lines (line 210) keys
        # on, so a padded file is removed along with the render it came from.
        padded = path.with_name(f"{_variant(idx, speed_r, span)}+{pad}.wav")
        await asyncio.to_thread(_cached_transform, path, padded, lambda b: voicevox.pad_wav(b, pad))
        path = padded
    return FileResponse(path, media_type="audio/wav")


# Per island and cache key. Entries are tiny and keys are bounded by what one
# user exports, so they are never evicted.
_export_locks: dict[str, asyncio.Lock] = {}


@app.get("/shadow/islands/{island_id}/export")
async def export_island(island_id: str, speed: float = 1.0, repeats: int = 2,
                        gap: int = 2000, token: str = "",
                        authorization: str | None = Header(None)) -> FileResponse:
    """The island as one m4a file for listening outside the app: each line
    played `repeats` times with `gap` ms of silence after every play, at
    `speed`, in the island's voice. Built once per distinct content and
    parameters and kept on disk under a content hash; dropped whenever the
    island is re-voiced or regenerated."""
    _token_or_header(token, authorization)
    island = await asyncio.to_thread(store.get_island, island_id)
    if island is None:
        raise HTTPException(404, "no such island")
    if island["status"] != "ready":
        raise HTTPException(409, "the island is still being built")
    if not island["lines"]:
        raise HTTPException(409, "the island has no lines")

    spec = export.normalise(speed, repeats, gap)
    key = export.cache_key(island, spec)
    path = export.export_path(island["id"], key)
    if not path.exists():
        # One build per key at a time. A second request for the same key waits
        # here and then finds the file the first one wrote.
        async with _export_locks.setdefault(f"{island['id']}/{key}", asyncio.Lock()):
            if not path.exists():
                wavs = []
                for line in island["lines"]:
                    p = await _resolve_line_audio(island, line["idx"], spec.speed)
                    if not p.exists():
                        raise HTTPException(409, f"line {line['idx'] + 1} has no audio")
                    wavs.append(p.read_bytes())
                try:
                    await asyncio.to_thread(
                        export.build, wavs, spec, path, island["title"] or "Island"
                    )
                except export.ExportError as exc:
                    log.error("export %s/%s failed: %s", island["id"], key, exc)
                    raise HTTPException(500, "could not build the audio file") from exc

    return FileResponse(
        path,
        media_type="audio/mp4",
        filename=export.file_name(island["title"], spec.speed),
        headers={"Cache-Control": "no-store"},
    )


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


def _run_clean(src: Path, ref_path: Path, profile, island_id: str, idx: int,
               line: dict, speed: float, span: tuple[int, int] | None,
               lag_ms: int, line_start_ms: int) -> dict:
    """Take the played line back out of a take, store both versions, score
    the take's timing against the line's words, and analyse mora length and
    pitch accent. Blocking, for the same reasons as _run_calibration."""
    import aec
    import take_analysis
    import take_score

    ref_audio = aec.decode(ref_path)
    mic = aec.decode(src)
    result = aec.clean(ref_audio, mic, profile)

    raw_path, clean_path = store.take_paths(island_id, idx)
    aec.encode(raw_path, mic)
    if result.cleaned:
        aec.encode(clean_path, result.output)
    else:
        # This line may have had a cleanable take before. Leaving that file
        # behind would let /take/clean serve the previous take's audio as if
        # it belonged to the one just uploaded.
        clean_path.unlink(missing_ok=True)

    if result.cleaned:
        anchor_ms, anchor = result.delay_ms, "echo"
    elif line_start_ms >= 0:
        anchor_ms, anchor = float(line_start_ms), "clock"
    else:
        anchor_ms, anchor = None, None
    take_for_score = result.output if result.cleaned else mic
    try:
        score = take_score.score_take(
            ref_audio, take_for_score, aec.SR, line["words"], speed, span,
            anchor_ms, lag_ms, anchor,
        )
    except Exception:
        log.exception("take scoring failed island=%s idx=%d", island_id, idx)
        n = len(line["words"])
        score = {
            "words": ["none"] * n,
            "offsetsMs": [None] * n,
            "behindMs": None,
            "anchor": anchor,
            "note": "Could not score the take",
        }

    try:
        analysis = take_analysis.analyse(
            ref_audio, take_for_score, aec.SR, line.get("timeline") or [],
            speed, span, anchor_ms, result.cleaned, result.erle_db,
        )
    except Exception:
        log.exception("take analysis failed island=%s idx=%d", island_id, idx)
        analysis = {
            "note": "Could not analyse the take",
            "aligned": None,
            "coverage": 0.0,
            "moras": [],
            "curve": {"line": [], "take": []},
        }

    return {
        "cleaned": result.cleaned,
        "erleDb": _round(result.erle_db),
        "delayMs": _round(result.delay_ms),
        "driftSamples": result.drift_samples,
        "frozenBlocks": result.frozen_blocks,
        "note": result.note,
        "score": score,
        "analysis": analysis,
    }


@app.post("/shadow/islands/{island_id}/lines/{idx}/take")
async def upload_take(
    island_id: str,
    idx: int,
    take: UploadFile = File(...),
    speed: float = Form(1.0),
    calibrate: str = Form("0"),
    start: int = Form(-1),
    end: int = Form(-1),
    lag: int = Form(0),
    line_start: int = Form(-1),
    authorization: str | None = Header(None),
) -> dict:
    """Clean a shadow take against the line that was playing while it was
    recorded, or (calibrate=1) learn the phone's speaker-to-mic path from a
    silent recording of that same line. A take recorded over a phrase carries
    `start`/`end` so it is cleaned against that same phrase, not the whole
    line. `lag` (the phone's Lag setting, ms) and `line_start` (ms from the
    start of the recording to the line's first audio, for takes with no
    echo to find the anchor in) feed the take's timing score; both are
    ignored for a calibration upload.

    A take uploaded before the phone has a stored profile is kept as
    recorded and scored on `line_start` rather than refused: with headphones
    there is nothing to clean, and Speak-with-headset is now the common
    first upload on a new phone. Calibration still learns the speaker-to-mic
    path for anyone who later shadows over the speaker. See aec.py for how
    the path is learned and applied."""
    require_token(authorization)
    began_at = time.monotonic()
    is_calibration = calibrate == "1"

    island = await asyncio.to_thread(store.get_island, island_id)
    if island is None:
        raise HTTPException(404, "no such island")
    line = next((l for l in island["lines"] if l["idx"] == idx), None)
    if line is None:
        raise HTTPException(404, "no such line")
    span = _span(start, end)
    # The same rounding _resolve_line_audio applies before it renders, so the
    # score's word windows use the speed the reference audio was actually
    # played at rather than the raw value the client sent.
    render_speed = round(min(SPEED_MAX, max(SPEED_MIN, speed)) * 20) / 20

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
        ref_path = await _resolve_line_audio(island, idx, speed, span)

        # ffmpeg and the filter are seconds of blocking CPU. On the event loop
        # they would stall every other request for the duration, including the
        # island list the phone polls while it waits for this one.
        if is_calibration:
            response = await asyncio.to_thread(_run_calibration, src, ref_path)
        else:
            lag_ms = max(0, min(5000, lag))
            response = await asyncio.to_thread(
                _run_clean, src, ref_path, profile, island_id, idx,
                line, render_speed, span, lag_ms, line_start,
            )
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        log.info(
            "take island=%s idx=%d calibrate=%s took %.2fs",
            island_id, idx, is_calibration, time.monotonic() - began_at,
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
    island = await asyncio.to_thread(store.get_island, island_id)
    if island is None:
        raise HTTPException(404, "no such island")
    if island["source"] != "voice":
        raise HTTPException(409, "regenerate is only for a recorded island")

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
        _build_island, island_id, wav, complexity, island["speaker"], count,
        island.get("register", "polite"),
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
    if island["source"] != "voice":
        raise HTTPException(409, "revoice is only for a recorded island")
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


@app.get("/shadow/explain-word")
async def explain_word(word: str, sentence_ja: str, sentence_en: str = "",
                       authorization: str | None = Header(None)) -> dict:
    """How one word functions in one particular sentence. Cached in sqlite,
    keyed on (word, sentence_ja), since the same word in the same sentence
    always gets the same answer."""
    require_token(authorization)
    cached = await asyncio.to_thread(store.get_word_context, word, sentence_ja)
    if cached is not None:
        return {"context": cached}
    context = await asyncio.to_thread(explain.word_context, word, sentence_ja, sentence_en)
    if context:
        await asyncio.to_thread(store.set_word_context, word, sentence_ja, context)
    return {"context": context}


class ExplainChatBody(BaseModel):
    sentence_ja: str
    sentence_en: str = ""
    marked: list[str] = []
    question: str
    history: list[dict] = []


@app.post("/shadow/explain-chat")
async def explain_chat(body: ExplainChatBody,
                       authorization: str | None = Header(None)) -> dict:
    """One turn about a sentence, structured as {"vocab", "grammar",
    "summary"} (any of the three may be absent). The thread itself lives in
    the client's own state, not persisted here. The opening turn of a thread
    (no history yet) is cached in sqlite as JSON, keyed on (sentence, marked
    words, question): that is the Explain sheet's fixed question re-run on
    the same selection, and it always gets the same answer. A follow-up turn
    carries history and is never cached, since it depends on the thread so
    far."""
    require_token(authorization)
    if not body.history:
        cached = await asyncio.to_thread(
            store.get_explain_answer, body.sentence_ja, body.marked, body.question
        )
        if cached is not None:
            try:
                return json.loads(cached)
            except json.JSONDecodeError:
                # A row sqlite cannot parse back is no better than no row:
                # fall through to a fresh answer, which overwrites it below.
                log.warning("explain cache row is not valid JSON, treating as a miss")
    raw = await asyncio.to_thread(
        explain.chat_answer, body.sentence_ja, body.sentence_en, body.marked,
        body.question, body.history,
    )
    answer = explain.parse_explain_answer(raw, body.sentence_ja)
    if answer and not body.history:
        await asyncio.to_thread(
            store.set_explain_answer, body.sentence_ja, body.marked, body.question,
            json.dumps(answer, ensure_ascii=False),
        )
    return answer


@app.delete("/shadow/islands/{island_id}")
def delete_island(island_id: str, authorization: str | None = Header(None)) -> dict:
    require_token(authorization)
    store.delete_island(island_id)
    return {"ok": True}


@app.patch("/shadow/islands/{island_id}/title")
def rename_island(
    island_id: str,
    title: str = Form(...),
    authorization: str | None = Header(None),
) -> dict:
    require_token(authorization)
    if store.get_island(island_id) is None:
        raise HTTPException(404, "island not found")
    title = title.strip() or "Untitled island"
    store.set_title(island_id, title)
    return {"id": island_id, "title": title}
