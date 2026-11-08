"""The one door every line, preview and word render goes through: cache
first, then the provider, with hosted voices checked against the budgets and
silently replaced by the language's free voice when anything says no.
"""

import asyncio
import io
import logging
import wave

import guardrails
import kokoro_tts
import tts_budget
import tts_cache
import tts_registry
from tts_registry import Render

log = logging.getLogger("shadow")

HOSTED_TIMEOUT_S = 30.0


def _scaled(items: list, factor: float) -> list:
    out = []
    for it in items:
        it = dict(it)
        for k in ("start", "end"):
            if k in it:
                it[k] = it[k] * factor
        out.append(it)
    return out


def _at_speed(render: Render, speed: float) -> Render:
    """A 1.0 render stretched to `speed` (pitch kept, timings scaled)."""
    if speed == 1.0:
        return render
    wav = kokoro_tts._stretch_wav(render.wav, speed)
    with wave.open(io.BytesIO(wav), "rb") as w:
        duration = w.getnframes() / w.getframerate()
    factor = 1.0 / speed
    return Render(
        wav=wav, duration=duration, kana=render.kana, voice=render.voice,
        fallback=render.fallback,
        timeline=_scaled(render.timeline, factor),
        phonemes=_scaled(render.phonemes, factor),
        pieces=_scaled(render.pieces, factor),
    )


async def _fallback(text: str, voice: tts_registry.Voice, speed: float, reason: str) -> Render:
    default = tts_registry.default_voice(voice.language)
    log.info("voice %d (%s) unavailable (%s), rendering with %d", voice.id, voice.provider, reason, default)
    out = await render(text, default, "", speed)
    out.fallback = reason
    out.voice = default
    return out


# Identical hosted renders in flight share one provider call.
_inflight: dict[tuple[int, str], asyncio.Future] = {}


class _OverBudget(Exception):
    pass


async def _hosted_call(prov, voice: tts_registry.Voice, text: str) -> Render:
    """One paid provider call. The monthly cap is checked and the spend
    reserved with no await between, so concurrent renders cannot overshoot
    it; a failed call refunds its reservation."""
    hit = await asyncio.to_thread(tts_cache.get, voice.id, text)
    if hit is not None:
        return hit
    if tts_budget.check(prov.name, len(text)):
        raise _OverBudget()
    tts_budget.record(prov.name, len(text))
    try:
        if tts_budget.DEV_FORCE == "provider_down":
            raise RuntimeError("dev: provider down")
        out = await asyncio.wait_for(prov.render(text, voice, 1.0), HOSTED_TIMEOUT_S)
    except BaseException:
        tts_budget.refund(prov.name, len(text))
        raise
    out.voice = voice.id
    out.fallback = ""
    await asyncio.to_thread(tts_cache.put, voice.id, text, out)
    return out


async def _shared_hosted(prov, voice: tts_registry.Voice, text: str) -> Render:
    key = (voice.id, tts_cache.norm(text))
    fut = _inflight.get(key)
    if fut is None:
        fut = asyncio.ensure_future(_hosted_call(prov, voice, text))
        _inflight[key] = fut
        fut.add_done_callback(lambda f, k=key: (_inflight.pop(k, None), f.cancelled() or f.exception()))
    return await asyncio.shield(fut)


async def render(text: str, voice_id: int, device: str = "", speed: float = 1.0) -> Render:
    """Render `text` in `voice_id`. Cached per (voice, text) at 1.0 for every
    user; speed variants are stretched from the cached render unless the
    voice re-renders at speed natively (VOICEVOX). `device` counts a hosted
    line against the user's daily cap; previews and word audio pass "" (they
    have their own caps). A hosted voice that is disabled, over budget, over
    the user's cap, failing or slow comes back in the language's default
    voice with `fallback` set. A failing local default raises."""
    voice = tts_registry.voice(voice_id)
    prov = tts_registry.provider_for(voice_id)
    if voice is None or prov is None:
        raise ValueError(f"unknown voice {voice_id}")
    if voice.native_speed and speed != 1.0:
        return await prov.render(text, voice, speed)
    hit = await asyncio.to_thread(tts_cache.get, voice_id, text)
    if hit is not None:
        return _at_speed(hit, speed)
    if voice.hosted:
        reason = ""
        if not tts_registry.enabled(prov):
            reason = "disabled"
        elif guardrails._off("ai_jobs", "ai"):
            reason = "ai_paused"
        elif tts_budget.check(prov.name, len(text)):
            reason = "budget"
        elif device and not tts_budget.take_user_slot(device):
            reason = "budget"
        if reason:
            return await _fallback(text, voice, speed, reason)
        try:
            out = await _shared_hosted(prov, voice, text)
        except _OverBudget:
            return await _fallback(text, voice, speed, "budget")
        except Exception as exc:
            # Only the type and the adapter's own message: never a body or a key.
            log.warning("%s voice %d failed: %s: %s", prov.name, voice_id,
                        type(exc).__name__, str(exc)[:120])
            return await _fallback(text, voice, speed, "error")
    else:
        out = await prov.render(text, voice, 1.0)
        out.voice = voice_id
        out.fallback = ""
        await asyncio.to_thread(tts_cache.put, voice_id, text, out)
    return _at_speed(out, speed)
