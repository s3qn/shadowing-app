"""Spend caps for hosted voices: one monthly row per provider in sqlite and
the per-user daily line cap in `dependencies.DAILY_CAPS["hosted_tts"]`. Caps
come from the environment, 0 means none. `DEV_FORCE` is the dev switch the
simulate route flips ("budget_out", "provider_down", "hosted_off" or "").
"""

import logging
import os
import threading

from fastapi import HTTPException

import dependencies
import store
import suggest

log = logging.getLogger("shadow")

DEV_FORCE: str = ""

_DEFAULT_CHARS = {"inworld": 50000, "elevenlabs": 8000}
_DEFAULT_REQUESTS = {"gemini": 150}
WARN_LEVEL = 0.8

_warned: set[tuple[str, str]] = set()
_warn_lock = threading.Lock()


def monthly_chars(provider: str) -> int:
    return int(os.getenv(f"SHADOW_TTS_MONTHLY_CHARS_{provider.upper()}",
                         str(_DEFAULT_CHARS.get(provider, 0))))


def monthly_requests(provider: str) -> int:
    return int(os.getenv(f"SHADOW_TTS_MONTHLY_REQUESTS_{provider.upper()}",
                         str(_DEFAULT_REQUESTS.get(provider, 0))))


def _month() -> str:
    return store._now()[:7]


def spent(provider: str, month: str | None = None) -> tuple[int, int]:
    """(chars, requests) recorded for a provider this month."""
    row = store.connect().execute(
        "SELECT chars, requests FROM tts_spend WHERE provider=? AND month=?",
        (provider, month or _month()),
    ).fetchone()
    return (row[0], row[1]) if row else (0, 0)


def check(provider: str, chars: int) -> str:
    """"" when a render of `chars` characters fits this month's caps,
    "budget" when it would cross one (or the dev switch says so)."""
    if DEV_FORCE == "budget_out":
        return "budget"
    cap_chars = monthly_chars(provider)
    cap_requests = monthly_requests(provider)
    if not cap_chars and not cap_requests:
        return ""
    used_chars, used_requests = spent(provider)
    if cap_chars and used_chars + chars > cap_chars:
        return "budget"
    if cap_requests and used_requests + 1 > cap_requests:
        return "budget"
    return ""


def record(provider: str, chars: int) -> None:
    month = _month()
    conn = store.connect()
    with conn:
        conn.execute(
            "INSERT INTO tts_spend (provider, month, chars, requests) VALUES (?, ?, ?, 1)"
            " ON CONFLICT(provider, month) DO UPDATE SET"
            " chars = chars + excluded.chars, requests = requests + 1",
            (provider, month, chars),
        )
    _warn_threshold(provider, month)


def refund(provider: str, chars: int) -> None:
    """Undo one `record` when the render it reserved for failed."""
    conn = store.connect()
    with conn:
        conn.execute(
            "UPDATE tts_spend SET chars = MAX(0, chars - ?), requests = MAX(0, requests - 1)"
            " WHERE provider=? AND month=?",
            (chars, provider, _month()),
        )


def _warn_threshold(provider: str, month: str) -> None:
    """One log line and one Discord line the first time a provider crosses
    WARN_LEVEL of either cap in a month. In-memory, so a restart may repeat
    it once."""
    used_chars, used_requests = spent(provider, month)
    cap_chars = monthly_chars(provider)
    cap_requests = monthly_requests(provider)
    frac = max(
        used_chars / cap_chars if cap_chars else 0.0,
        used_requests / cap_requests if cap_requests else 0.0,
    )
    if frac < WARN_LEVEL:
        return
    with _warn_lock:
        if (provider, month) in _warned:
            return
        _warned.add((provider, month))
    text = (f"TTS spend: {provider} at {round(frac * 100)}% of this month's cap"
            f" ({used_chars} chars, {used_requests} requests)")
    log.warning(text)
    threading.Thread(target=suggest._relay_to_discord, args=(text,),
                     kwargs={"prefix": ""}, daemon=True).start()


def take_user_slot(device: str) -> bool:
    """One hosted line against the device's daily cap. False when the cap is
    reached (the caller falls back to the free voice); the owner is exempt
    as everywhere."""
    try:
        dependencies._take_use_slot(device, "hosted_tts")
    except HTTPException as exc:
        if exc.status_code == 429:
            return False
        raise
    return True
