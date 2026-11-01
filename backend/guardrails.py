"""ai-guardrails: daily AI-build budgets and kill switches.

Budgets count rows in the `builds` table (kinds create and rework), so a cache
hit, which never takes a build slot, is free, and the UTC day resets them.
Switches live in an admin file Sean edits on the server, re-read when its
mtime changes, so flipping one needs no restart:

    echo '{"ai_jobs": false}' > ~/shadow-prod/data/admin.json

Keys: signups, ai_jobs, imports. A missing file or key means on; false, 0,
"false", "off", "no" and "0" mean off. A file that
does not parse keeps the last good values (fail open, never crash). The env
var SHADOW_KILL=signups,ai,imports is a second way to turn the same switches
off, read on every call.
"""

import json
import logging
import os
from pathlib import Path
from typing import Callable

from fastapi import HTTPException

import energy
import store

log = logging.getLogger("shadow.guardrails")

USER_AI_BUILDS = int(os.getenv("SHADOW_USER_AI_BUILDS", "5"))
GLOBAL_AI_BUILDS = int(os.getenv("SHADOW_GLOBAL_AI_BUILDS", "100"))
BUILD_KINDS = ("create", "rework")

# Per-device daily caps for the AI calls that have no route-level slot of their
# own (counted in `builds`, owner exempt).
EXTRA_CAPS = {
    "catch_meaning": int(os.getenv("SHADOW_DAILY_CATCH_MEANING", "200")),
    "repair": int(os.getenv("SHADOW_DAILY_REPAIR", "20")),
}

_cache: dict = {"path": None, "mtime": None, "values": {}}
_owner_check: Callable[[str], bool] = lambda device: False


def set_owner_check(fn: Callable[[str], bool]) -> None:
    """main registers its `_is_owner` here so catch.py can charge without
    importing main."""
    global _owner_check
    _owner_check = fn


def admin_path() -> Path:
    env = os.getenv("SHADOW_ADMIN_FILE")
    return Path(env) if env else store.DATA_DIR / "admin.json"


def load_switches() -> dict:
    """The admin file as a dict, re-read only when its mtime changes."""
    path = admin_path()
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        _cache.update(path=str(path), mtime=None, values={})
        return {}
    if _cache["path"] == str(path) and _cache["mtime"] == mtime:
        return _cache["values"]
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise ValueError("not an object")
    except (OSError, ValueError) as exc:
        log.warning("guardrails: %s is unreadable (%s), keeping the last values", path, exc)
        _cache.update(path=str(path), mtime=mtime)
        return _cache["values"] if _cache["path"] == str(path) else {}
    _cache.update(path=str(path), mtime=mtime, values=data)
    return data


# Values an admin file may use for "off": JSON false, 0, or these words.
_OFF_WORDS = {"false", "off", "no", "0"}


def _is_off_value(value: object) -> bool:
    if value is False:
        return True
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value == 0
    return isinstance(value, str) and value.strip().lower() in _OFF_WORDS


def _off(name: str, env_name: str) -> bool:
    if _is_off_value(load_switches().get(name)):
        return True
    return env_name in {s.strip() for s in os.getenv("SHADOW_KILL", "").split(",")}


def check_switch(kind: str, imports: bool = False) -> None:
    """503 when ai_jobs is off, or imports is off and `imports` is set."""
    if imports and _off("imports", "imports"):
        log.warning("guardrails: blocked %s (imports paused)", kind)
        raise HTTPException(503, {"code": "imports_paused"})
    if _off("ai_jobs", "ai"):
        log.warning("guardrails: blocked %s (ai paused)", kind)
        raise HTTPException(503, {"code": "ai_paused"})


def check_budget(device: str) -> None:
    """429 when the device or the whole server used its daily AI builds."""
    used = store.count_builds_today_kinds(device, BUILD_KINDS)
    if used >= USER_AI_BUILDS:
        log.warning("guardrails: %s over the daily budget (%d)", device, used)
        raise HTTPException(
            429, {"code": "daily_budget", "limit": USER_AI_BUILDS, "refill_at": energy.refill_at()}
        )
    total = store.count_builds_all_today(BUILD_KINDS)
    if total >= GLOBAL_AI_BUILDS:
        log.warning("guardrails: global AI build budget reached (%d)", total)
        raise HTTPException(
            429, {"code": "global_budget", "limit": GLOBAL_AI_BUILDS, "refill_at": energy.refill_at()}
        )


def check_signup(principal: str, known: bool) -> None:
    """403 for a principal the backend has never seen while signups are off."""
    if known or not _off("signups", "signups"):
        return
    log.warning("guardrails: blocked new user %s (signups paused)", principal)
    raise HTTPException(403, {"code": "signups_paused"})


def check_ai_call(device: str, kind: str) -> None:
    """The switch and the per-device daily cap of `take_ai_call`, with no
    write, for a caller that must win a claim before it logs the slot."""
    check_switch(kind)
    limit = EXTRA_CAPS[kind]
    if store.count_builds_today(device, kind) >= limit:
        raise HTTPException(429, {"code": "daily_limit", "limit": limit, "kind": kind})


def take_ai_call(device: str, kind: str, charge: str = "") -> None:
    """A slot for an AI call with no route slot of its own (catch meanings,
    repair): switch, per-device daily cap, energy, then the log row. Owner
    exempt."""
    if _owner_check(device):
        return
    check_ai_call(device, kind)
    if charge:
        energy.charge(device, charge, False)
    store.log_build(device, kind)
