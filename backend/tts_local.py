"""Local engines that need their own venv (BlueTTS, MeloTTS, Nabra) run as
one lazily spawned `tts_worker.py` process at a time under a 3G memory
scope, stopped after SHADOW_TTS_IDLE_S seconds idle. Starting another engine
stops the current one. A start is refused when MemAvailable is under
SHADOW_TTS_MIN_FREE_MB (2500), so a swapped box never loads a second model.
Requests are serialized; each has 60 s.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import wave
from pathlib import Path

import config
import store
import tts_registry
from tts_registry import Render, Voice

log = logging.getLogger("shadow")

BACKEND = Path(__file__).resolve().parent
BAKEOFF = Path.home() / "tts-bakeoff"
MODELS_DIR = Path(os.getenv("SHADOW_TTS_MODELS", str(BAKEOFF / "models"))).expanduser()
PYTHON = {
    "bluetts": Path(os.getenv("SHADOW_TTS_PY_BLUETTS", str(BAKEOFF / ".venv312/bin/python"))).expanduser(),
    "melo": Path(os.getenv("SHADOW_TTS_PY_TORCH", str(BAKEOFF / ".venv/bin/python"))).expanduser(),
    "nabra": Path(os.getenv("SHADOW_TTS_PY_TORCH", str(BAKEOFF / ".venv/bin/python"))).expanduser(),
}
IDLE_S = float(os.getenv("SHADOW_TTS_IDLE_S", "300"))
MIN_FREE_MB = int(os.getenv("SHADOW_TTS_MIN_FREE_MB", "2500"))
# Where the rest of the app's voices sit (VOICEVOX and Kokoro lines measure
# about -21 to -26 LUFS); the peak cap leaves headroom for the 24k resample.
LOUDNESS_LUFS = -23.0
PEAK_DB = -1.5
LOAD_TIMEOUT_S = float(os.getenv("SHADOW_TTS_LOAD_S", "240"))
REQUEST_TIMEOUT_S = 60.0
# How long a request for another engine waits so the current engine can drain
# its queued requests before the worker is killed and reloaded.
HOLD_S = float(os.getenv("SHADOW_TTS_HOLD_S", "20"))
MEMORY_MAX = os.getenv("SHADOW_TTS_MEMORY_MAX", "3G")
SCOPE_PREFIX = "shadow-tts-"


class LocalTtsError(RuntimeError):
    pass


def mem_available_mb() -> int:
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 1 << 30  # unknown: do not block the start


def build_command(engine: str, scope: bool) -> list[str]:
    """The worker command for one engine, under a systemd scope when `scope`
    (same flags as align.build_command). Tests patch this."""
    inner = [
        "env", "OMP_NUM_THREADS=4", "HF_HUB_OFFLINE=1", f"HF_HOME={MODELS_DIR / 'hf'}",
        str(PYTHON[engine]), str(BACKEND / "tts_worker.py"), engine, str(MODELS_DIR),
    ]
    if not scope:
        return inner
    return [
        "systemd-run", "--user", "--scope", "-q", f"--unit={SCOPE_PREFIX}{engine}-{os.getpid()}",
        "--nice=10", "-p", f"MemoryMax={MEMORY_MAX}", "-p", "MemorySwapMax=0", *inner,
    ]


def stop_leftover_scopes(timeout: float = 30) -> None:
    """Stop worker scopes left by an earlier backend process."""
    try:
        subprocess.run(
            ["systemctl", "--user", "stop", f"{SCOPE_PREFIX}*.scope"],
            capture_output=True, text=True, timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        log.warning("could not stop leftover tts scopes: %s", exc)


class _Worker:
    def __init__(self, engine: str, proc: asyncio.subprocess.Process):
        self.engine = engine
        self.proc = proc
        self.last_used = time.monotonic()


_lock = asyncio.Lock()
_worker: _Worker | None = None
_idle_task: asyncio.Task | None = None
_pending: dict[str, int] = {}


def _log_path() -> Path:
    return store.DATA_DIR / "tts-worker.log"


async def _spawn(engine: str, scope: bool, voice: str = "") -> asyncio.subprocess.Process:
    store.DATA_DIR.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "SHADOW_TTS_WARM_VOICE": voice} if voice else None
    with open(_log_path(), "ab") as errlog:
        return await asyncio.create_subprocess_exec(
            *build_command(engine, scope),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=errlog,
            env=env,
        )


async def _read_line(proc: asyncio.subprocess.Process, timeout: float) -> dict:
    try:
        raw = await asyncio.wait_for(proc.stdout.readline(), timeout)
    except asyncio.TimeoutError as exc:
        raise LocalTtsError("worker timed out") from exc
    if not raw:
        raise LocalTtsError("worker exited")
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError as exc:
        raise LocalTtsError("worker sent a bad reply") from exc


async def _stop() -> None:
    global _worker
    w, _worker = _worker, None
    if w is None:
        return
    proc = w.proc
    if proc.returncode is None:
        try:
            if proc.stdin:
                proc.stdin.close()
            proc.terminate()
            await asyncio.wait_for(proc.wait(), 10)
        except (ProcessLookupError, asyncio.TimeoutError, OSError):
            try:
                proc.kill()
            except (ProcessLookupError, OSError):
                pass
    log.info("tts worker %s stopped", w.engine)


async def _start(engine: str, voice: str = "") -> _Worker:
    global _worker
    free = mem_available_mb()
    if free < MIN_FREE_MB:
        raise LocalTtsError(f"low memory ({free} MB free, {MIN_FREE_MB} needed)")
    if _worker is not None and _worker.engine != engine:
        await _stop()
    use_scope = shutil.which("systemd-run") is not None
    proc = await _spawn(engine, use_scope, voice)
    try:
        ready = await _read_line(proc, LOAD_TIMEOUT_S)
    except LocalTtsError:
        if use_scope and proc.returncode == 1:
            # No user bus (a tty-less session): run without the memory cap, as align does.
            log.warning("systemd-run unavailable, running the tts worker without a memory cap")
            proc = await _spawn(engine, False, voice)
            ready = await _read_line(proc, LOAD_TIMEOUT_S)
        else:
            raise
    if not ready.get("ready"):
        raise LocalTtsError(f"{engine} failed to load: {ready.get('error', '')}")
    _worker = _Worker(engine, proc)
    log.info("tts worker %s ready", engine)
    return _worker


async def _idle_stop() -> None:
    while _worker is not None:
        left = IDLE_S - (time.monotonic() - _worker.last_used)
        if left > 0:
            await asyncio.sleep(left)
            continue
        if _lock.locked():
            await asyncio.sleep(0.5)
            continue
        async with _lock:
            if _worker is not None and time.monotonic() - _worker.last_used >= IDLE_S:
                await _stop()
        return


def _schedule_idle_stop() -> None:
    global _idle_task
    if _idle_task is None or _idle_task.done():
        _idle_task = asyncio.create_task(_idle_stop())


def _gain_db(path: Path) -> float:
    """dB to add so `path` sits at LOUDNESS_LUFS, capped to keep the peak under
    PEAK_DB. 0 when ffmpeg cannot measure it (silence, odd file)."""
    r = subprocess.run(
        ["ffmpeg", "-nostats", "-i", str(path), "-af", "loudnorm=print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, timeout=60,
    )
    try:
        m = json.loads(r.stderr[r.stderr.rindex("{"):])
        lufs, peak = float(m["input_i"]), float(m["input_tp"])
    except (ValueError, KeyError):
        return 0.0
    if lufs < -70:
        return 0.0
    return min(LOUDNESS_LUFS - lufs, PEAK_DB - peak)


def _to_slice_rate(path: Path) -> bytes:
    """The worker's wav as 24 kHz mono 16-bit (config.SLICE_RATE), set to the
    loudness the other voices sit at: the local engines come out anywhere from
    -40 to -15 LUFS, so a built island would jump between voices."""
    out = path.with_suffix(".24k.wav")
    try:
        gain = _gain_db(path)
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(path), "-af", f"volume={gain:.2f}dB", "-ar", str(config.SLICE_RATE),
             "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", str(out)],
            capture_output=True, check=True, timeout=60,
        )
        return out.read_bytes()
    except (OSError, subprocess.SubprocessError) as exc:
        raise LocalTtsError(f"could not convert the worker's audio: {exc}") from exc
    finally:
        out.unlink(missing_ok=True)


async def _run_locked(engine: str, text: str, voice_key: str, lang: str) -> bytes:
    """One request with `_lock` held: start or switch the worker, send, read."""
    global _worker
    if _worker is None or _worker.engine != engine or _worker.proc.returncode is not None:
        if _worker is not None:
            await _stop()
        await _start(engine, voice_key)
    w = _worker
    tmpdir = tempfile.mkdtemp(prefix="tts-worker-")
    out = Path(tmpdir) / "line.wav"
    try:
        w.proc.stdin.write(
            (json.dumps({"text": text, "voice": voice_key, "lang": lang, "out": str(out)},
                        ensure_ascii=False) + "\n").encode("utf-8")
        )
        await w.proc.stdin.drain()
        reply = await _read_line(w.proc, REQUEST_TIMEOUT_S)
        if "error" in reply or not out.exists():
            raise LocalTtsError(f"{engine}: {reply.get('error', 'no audio')}")
        wav = await asyncio.to_thread(_to_slice_rate, out)
    except LocalTtsError:
        if w.proc.returncode is not None:
            await _stop()
        raise
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
        w.last_used = time.monotonic()
    return wav


async def request(engine: str, text: str, voice_key: str, lang: str) -> tuple[bytes, float]:
    """One line through the engine's worker, started if needed. Returns
    (24 kHz wav bytes, duration). Raises LocalTtsError."""
    _pending[engine] = _pending.get(engine, 0) + 1
    deadline = time.monotonic() + HOLD_S
    try:
        while True:
            async with _lock:
                cur = _worker
                holding = (
                    cur is not None and cur.engine != engine and cur.proc.returncode is None
                    and _pending.get(cur.engine, 0) > 0 and time.monotonic() < deadline
                )
                if not holding:
                    wav = await _run_locked(engine, text, voice_key, lang)
                    break
            # Requests for the running engine are queued: let them go first.
            await asyncio.sleep(0.05)
    finally:
        _pending[engine] -= 1
    _schedule_idle_stop()
    with wave.open(io.BytesIO(wav), "rb") as src:
        duration = src.getnframes() / src.getframerate()
    return wav, duration


class LocalWorkerProvider:
    hosted = False

    def __init__(self, engine: str, label: str, voices: list[Voice]):
        self.name = engine
        self.label = label
        self._voices = voices

    def enabled(self) -> bool:
        return PYTHON[self.name].exists() and MODELS_DIR.exists()

    def voices(self) -> list[Voice]:
        return list(self._voices)

    async def render(self, text: str, voice: Voice, speed: float = 1.0) -> Render:
        wav, duration = await request(self.name, text, voice.key, voice.language)
        return Render(wav=wav, duration=duration, voice=voice.id)


PROVIDERS = [
    LocalWorkerProvider("bluetts", "BlueTTS", [
        Voice(11001, "bluetts", "de", "Noa", "female", "noa"),
        Voice(11002, "bluetts", "he", "Noa", "female", "noa"),
    ]),
    LocalWorkerProvider("melo", "MeloTTS", [
        Voice(11101, "melo", "ko", "Melo", "female", "KR"),
        Voice(11102, "melo", "zh", "Melo", "female", "ZH"),
    ]),
    LocalWorkerProvider("nabra", "Nabra", [
        Voice(11201, "nabra", "ar", "Nabra", "female", "af_msa"),
    ]),
]

for _p in PROVIDERS:
    tts_registry.register(_p)
