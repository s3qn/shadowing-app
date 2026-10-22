"""One seam for structured LLM calls: a prompt in, checked JSON out.

The backend is picked by SHADOW_LLM at call time: `cli` (default) runs the
local claude CLI through generate._run_cli, `off` answers None (tests, and the
Tester's failure case), `api` is the later drop-in and raises until it exists.
Every call writes one log line, which is the cost ledger today; the API
backend extends it with tokens.
"""

import logging
import os
import time
from typing import Any

import generate

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = 90.0


def backend() -> str:
    return os.getenv("SHADOW_LLM", "cli") or "cli"


_TYPES = {
    "object": dict, "array": list, "string": str, "integer": int,
    "number": (int, float), "boolean": bool,
}


def matches(value: Any, schema: dict) -> bool:
    """A tiny schema check: `type`, `properties`, `required`, `items`.
    Anything the schema does not mention is allowed."""
    kind = schema.get("type")
    if kind is not None:
        expected = _TYPES.get(kind)
        if expected is None:
            return False
        if isinstance(value, bool) and kind in ("integer", "number"):
            return False
        if not isinstance(value, expected):
            return False
    if kind == "object":
        props = schema.get("properties") or {}
        for key in schema.get("required") or ():
            if key not in value:
                return False
        for key, sub in props.items():
            if key in value and not matches(value[key], sub):
                return False
    if kind == "array":
        items = schema.get("items")
        if items is not None and not all(matches(v, items) for v in value):
            return False
    return True


def complete(prompt: str, schema: dict, *, tag: str, timeout: float = DEFAULT_TIMEOUT_S) -> Any | None:
    """The model's JSON reply to `prompt`, or None when the backend is off, the
    call failed, the reply was not JSON or it does not match `schema`."""
    name = backend()
    t0 = time.monotonic()
    value: Any = None
    out_chars = 0
    if name == "off":
        value = None
    elif name == "api":
        raise NotImplementedError("SHADOW_LLM=api is not wired yet")
    else:
        raw = generate._run_cli(prompt, tag, timeout)
        out_chars = len(raw or "")
        value = generate._extract_json(raw) if raw else None
    if value is not None and not matches(value, schema):
        log.warning("llm %s: reply does not match the schema", tag)
        value = None
    log.info("llm %s: backend=%s wall=%.1fs in=%d chars out=%d chars ok=%s",
             tag, name, time.monotonic() - t0, len(prompt), out_chars, value is not None)
    return value
