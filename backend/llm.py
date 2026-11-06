"""One seam for every LLM call: a prompt in, a checked reply out.

The backend is picked by SHADOW_LLM at call time: `cli` (default, Sean's dev
box) runs the local claude CLI, `api` calls the Anthropic API with the
account key, `off` answers None (tests, and the Tester's failure case).
Every tag routes to a tier through ROUTES (env-overridable), both backends
use the same model id. The API backend writes one `llm_calls` row per call
(tokens and USD) and refuses calls once the month's spend reaches
SHADOW_LLM_MONTHLY_USD or the UTC day's reaches SHADOW_LLM_DAILY_USD; the CLI
backend writes no row, its log line stays. A registered pause check (the
ai_jobs kill switch) stops every call, background jobs included.

The key is read once, from the environment or a mode-600 env file, and is
never logged, printed, stored or copied into os.environ.
"""

import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable

import store
import store_llm
import suggest

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = 90.0
DEFAULT_MAX_TOKENS = 4096

# --- routing ---
TIERS = {
    "haiku": os.getenv("SHADOW_LLM_HAIKU", "claude-haiku-5-5"),
    "sonnet": os.getenv("SHADOW_LLM_SONNET", "claude-sonnet-5-5"),
}
ROUTES = {
    "generate": "sonnet", "repair": "sonnet",
    "translate_lines": "haiku", "expand_topic": "haiku", "pick": "haiku",
    "catch-meanings": "haiku", "grammar_meanings": "haiku",
    "word_context": "haiku", "chat_answer": "haiku", "repair-golden": "haiku",
    "say": "sonnet",
}
# Output tokens cost five times input, so every tag gets the smallest ceiling
# its longest reply fits under. A truncated reply fails the schema and answers
# None, so a ceiling here must stay above the real maximum, never near it.
MAX_TOKENS = {
    "word_context": 512,
    # One said sentence, at most 8 phrases or 6 story beats with readings.
    "say": 1024,
    "expand_topic": 1024, "pick": 1024,
    # 40 long Hebrew lines run past 4000 tokens; the ceiling is not billed.
    "translate_lines": 8192, "catch-meanings": 2048, "chat_answer": 2048,
}
# USD per million tokens, (input, output), from platform.claude.com/docs
# pricing on 2026-10-25. An unknown model id bills at the Sonnet row, so a
# typo in an override never under-counts.
PRICES = {
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0),
}
MONTHLY_USD = float(os.getenv("SHADOW_LLM_MONTHLY_USD", "30"))
DAILY_USD = float(os.getenv("SHADOW_LLM_DAILY_USD", "5"))
WARN_LEVELS = (0.5, 0.9)

for _retired in ("SHADOW_MODEL", "SHADOW_EXPLAIN_MODEL"):
    if os.getenv(_retired):
        log.warning("%s is retired and ignored; use SHADOW_LLM_SONNET, SHADOW_LLM_HAIKU"
                    " or SHADOW_LLM_ROUTE_<TAG>", _retired)


def backend() -> str:
    return os.getenv("SHADOW_LLM", "cli") or "cli"


def _route_env(tag: str) -> str:
    key = "SHADOW_LLM_ROUTE_" + tag.upper().replace("-", "_").replace(" ", "_")
    return (os.getenv(key) or "").strip()


def _tier_for(tag: str) -> str:
    """The tier name for `tag`, or a bare model id when the env override is
    one. Unknown tags ride Sonnet."""
    return _route_env(tag) or ROUTES.get(tag, "sonnet")


def model_for(tag: str) -> str:
    """SHADOW_LLM_ROUTE_<TAG> (a tier name or a model id) wins, then ROUTES,
    then Sonnet."""
    tier = _tier_for(tag)
    return TIERS.get(tier, tier)


def _is_fast(tag: str) -> bool:
    """True when the tag resolves to the Haiku tier: the CLI then runs with
    explain's cheap flags."""
    return model_for(tag) == TIERS["haiku"]


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    price_in, price_out = PRICES.get(model, PRICES["claude-sonnet-5-5"])
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000


# --- schema check ---
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


def _is_text(schema: dict) -> bool:
    return schema.get("type") == "string"


def _extract_json(text: str) -> Any:
    """Pull the first JSON value out of the CLI's stdout.

    The model is told to emit raw JSON, but a stray fence or a leading
    sentence should not lose the whole island.
    """
    if not text:
        return None
    decoder = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch not in "{[":
            continue
        try:
            value, _ = decoder.raw_decode(text[i:])
            return value
        except ValueError:
            continue
    return None


# --- CLI backend (Sean's dev box only) ---
CLI_BINARY = "claude"
CLI_DISALLOWED_TOOLS = "Bash,Read,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task,Glob,Grep"
# Keys the CLI must never see: a key in Sean's shell would bill his CLI
# session to the API.
_KEY_NAMES = ("ANTHROPIC_API_KEY", "CLAUDE_API_KEY")


def _cli_argv(model: str, fast: bool) -> list[str]:
    """argv for the CLI call. No shell, and the prompt never appears here.
    `fast` adds the flags the word tap always ran with."""
    argv = [
        CLI_BINARY,
        "--print",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--model", model,
        "--disallowed-tools", CLI_DISALLOWED_TOOLS,
        "--tools", "",
    ]
    if fast:
        argv += ["--safe-mode", "--effort", "low"]
    return argv


def _cli_env(fast: bool) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in _KEY_NAMES}
    if fast:
        env["MAX_THINKING_TOKENS"] = "0"
    return env


def _run_cli(prompt: str, tag: str, timeout: float = DEFAULT_TIMEOUT_S) -> str | None:
    """Run the CLI once with the model routed for `tag`. Returns stdout, or
    None on any failure (logged)."""
    fast = _is_fast(tag)
    try:
        proc = subprocess.run(
            _cli_argv(model_for(tag), fast),
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=_cli_env(fast),
        )
    except FileNotFoundError:
        log.warning("%s: `%s` not found on PATH", tag, CLI_BINARY)
        return None
    except subprocess.TimeoutExpired:
        log.warning("%s: CLI timed out after %ss", tag, timeout)
        return None
    if proc.returncode != 0:
        log.warning("%s: CLI exited %s: %s", tag, proc.returncode, (proc.stderr or "")[:400])
        return None
    return proc.stdout or ""


# --- API backend ---
_client_instance: Any = None
_client_lock = threading.Lock()
_warned_no_key = False


def _read_env_file(path: Path) -> dict[str, str]:
    """KEY=value lines of an env file (optional `export `, quotes stripped),
    like tools/asc-testflight.py. Missing or unreadable: empty."""
    vals: dict[str, str] = {}
    try:
        text = path.read_text()
    except OSError:
        return vals
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip().strip("'\"")
    return vals


def _api_key() -> str | None:
    """ANTHROPIC_API_KEY, then CLAUDE_API_KEY (how Sean stored it), from the
    environment, then SHADOW_LLM_KEY_FILE (default ~/.config/kageneko/env),
    then, outside prod, backend/.env and the repo root .env (a worktree's
    is a symlink to the main checkout's). The value goes to the client
    constructor only, never to a log."""
    for name in _KEY_NAMES:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    files = [Path(os.getenv("SHADOW_LLM_KEY_FILE") or "~/.config/kageneko/env").expanduser()]
    if os.getenv("SHADOW_ENV", "dev") != "prod":
        backend_dir = Path(__file__).resolve().parent
        files += [backend_dir / ".env", backend_dir.parent / ".env"]
    for path in files:
        vals = _read_env_file(path)
        for name in _KEY_NAMES:
            if vals.get(name):
                return vals[name]
    return None


def _client() -> Any:
    """The module's Anthropic client, built on first use. None (with one
    warning per process) when no key resolves."""
    global _client_instance, _warned_no_key
    if _client_instance is not None:
        return _client_instance
    with _client_lock:
        if _client_instance is not None:
            return _client_instance
        key = _api_key()
        if not key:
            if not _warned_no_key:
                log.warning("llm: SHADOW_LLM=api but no ANTHROPIC_API_KEY or CLAUDE_API_KEY"
                            " resolves; every call answers None")
                _warned_no_key = True
            return None
        import anthropic  # lazy: the CLI and off backends never need it

        _client_instance = anthropic.Anthropic(
            api_key=key, max_retries=int(os.getenv("SHADOW_LLM_RETRIES", "1")),
        )
        return _client_instance


_SCALARS = ("string", "integer", "number", "boolean")


def _strict(schema: dict) -> dict | None:
    """The schema in the form structured outputs accept (every object closed
    with additionalProperties false), or None when it is too loose to
    constrain: an object without properties or an array without items would
    otherwise be forced empty."""
    kind = schema.get("type")
    if kind in _SCALARS:
        return {"type": kind}
    if kind == "array":
        items = schema.get("items")
        sub = _strict(items) if isinstance(items, dict) else None
        return None if sub is None else {"type": "array", "items": sub}
    if kind == "object":
        props = schema.get("properties") or {}
        if not props:
            return None
        subs = {key: _strict(val) for key, val in props.items()}
        if any(v is None for v in subs.values()):
            return None
        return {
            "type": "object", "properties": subs,
            "required": [k for k in schema.get("required") or () if k in props],
            "additionalProperties": False,
        }
    return None


def _output_format(schema: dict) -> tuple[dict | None, bool]:
    """(output_config for the request or None, whether the reply comes back
    wrapped as {"value": ...}). A strict schema rides structured outputs,
    which every current Haiku and Sonnet support; a top level that is not an
    object is wrapped under "value". A loose schema gets None and relies on
    the prompt's own raw JSON instruction, read like the CLI's stdout."""
    strict = _strict(schema)
    if strict is None:
        return None, False
    wrapped = strict["type"] != "object"
    if wrapped:
        strict = {"type": "object", "properties": {"value": strict},
                  "required": ["value"], "additionalProperties": False}
    return {"format": {"type": "json_schema", "schema": strict}}, wrapped


# Appended on the one retry after a reply that was not the JSON asked for.
RETRY_SUFFIX = ("\n\nYour previous reply could not be read. Reply with the raw JSON value only:"
                " no prose, no markdown fence, starting with { or [.")


def _estimated_tokens(prompt: str, max_tokens: int) -> tuple[int, int]:
    """A timed-out call may still be billed, so it is booked high: two
    characters per input token and the whole output ceiling."""
    return len(prompt) // 2 + 1, max_tokens


def _call_api(prompt: str, schema: dict, model: str, tag: str,
              timeout: float) -> tuple[Any, int, int, str]:
    """One API call: (value or None, input_tokens, output_tokens, status).
    status is "ok", "error" (raised, tokens 0), "timeout" (tokens estimated
    by _estimated_tokens), "unreadable" (a reply that is not the JSON asked
    for, worth one retry) or "cut" (stopped at max_tokens or refused, not
    worth a retry). Any exception is logged by type and message, never with
    the key or the prompt."""
    client = _client()
    if client is None:
        return None, 0, 0, "error"
    max_tokens = MAX_TOKENS.get(tag, DEFAULT_MAX_TOKENS)
    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
        "timeout": timeout,
    }
    text_mode = _is_text(schema)
    wrapped = False
    if not text_mode:
        output_config, wrapped = _output_format(schema)
        if output_config is not None:
            kwargs["output_config"] = output_config
    try:
        reply = client.messages.create(**kwargs)
    except Exception as exc:  # noqa: BLE001  the SDK's error family is wide; None is the contract
        log.warning("llm %s: API call failed: %s: %s", tag, type(exc).__name__, str(exc)[:300])
        if "Timeout" in type(exc).__name__:
            tokens_in, tokens_out = _estimated_tokens(prompt, max_tokens)
            return None, tokens_in, tokens_out, "timeout"
        return None, 0, 0, "error"
    usage = getattr(reply, "usage", None)
    tokens_in = int(getattr(usage, "input_tokens", 0) or 0)
    tokens_out = int(getattr(usage, "output_tokens", 0) or 0)
    stop = getattr(reply, "stop_reason", None)
    text = "".join(
        getattr(block, "text", "") or "" for block in getattr(reply, "content", None) or ()
        if getattr(block, "type", None) == "text"
    ).strip()
    value: Any = None
    if text_mode:
        value = text or None
    elif text:
        value = _extract_json(text)
        if wrapped:
            value = value.get("value") if isinstance(value, dict) else None
    if value is not None:
        return value, tokens_in, tokens_out, "ok"
    if stop in ("max_tokens", "refusal"):
        log.warning("llm %s: API reply stopped at %s", tag, stop)
        return None, tokens_in, tokens_out, "cut"
    log.warning("llm %s: API reply carried no %s", tag, "text" if text_mode else "JSON")
    return None, tokens_in, tokens_out, "unreadable"


# --- spend caps and the pause hook ---
_warned: set[tuple[str, float]] = set()
_warn_lock = threading.Lock()
_pause_check: Callable[[], bool] = lambda: False


def set_pause_check(fn: Callable[[], bool]) -> None:
    """main registers the ai_jobs kill switch here, so a flip stops queued
    and background calls (repair, translation, catch refills) too, not only
    the routes that check it."""
    global _pause_check
    _pause_check = fn


def _paused() -> bool:
    try:
        return bool(_pause_check())
    except Exception:  # noqa: BLE001  a broken check must not take the seam down
        log.exception("llm: pause check failed")
        return False


def _cap_reached(tag: str) -> float | None:
    """This month's spend, or None (logged) when the monthly or the daily
    cap refuses the call."""
    spent = store_llm.llm_spent_month()
    if spent >= MONTHLY_USD:
        log.warning("llm %s: monthly cap reached ($%.2f of $%.2f), call refused",
                    tag, spent, MONTHLY_USD)
        return None
    today = store_llm.llm_spent_today()
    if today >= DAILY_USD:
        log.warning("llm %s: daily cap reached ($%.2f of $%.2f), call refused",
                    tag, today, DAILY_USD)
        return None
    return spent


def _month() -> str:
    return store._now()[:7]


def _warn_thresholds(spent_after: float) -> None:
    """One warning plus one Discord line the first time this month's spend
    crosses each WARN_LEVELS fraction. In-memory, so a restart may repeat
    each once."""
    if MONTHLY_USD <= 0:
        return
    frac = spent_after / MONTHLY_USD
    month = _month()
    for level in WARN_LEVELS:
        if frac < level:
            continue
        with _warn_lock:
            if (month, level) in _warned:
                continue
            _warned.add((month, level))
        text = (f"LLM spend: {round(level * 100)}% of this month's cap used"
                f" (${spent_after:.2f} of ${MONTHLY_USD:.2f})")
        log.warning(text)
        threading.Thread(target=suggest._relay_to_discord, args=(text,),
                         kwargs={"prefix": ""}, daemon=True).start()


def complete(prompt: str, schema: dict, *, tag: str, timeout: float = DEFAULT_TIMEOUT_S,
             ref: str = "") -> Any | None:
    """The model's reply to `prompt`, checked against `schema`, or None when
    the backend is off, AI jobs are paused, a cap is reached, the call
    failed, the reply was not JSON or it does not match (an unreadable reply
    is asked once more). `{"type": "string"}` asks for plain text.
    `ref` is the island or video id written on the cost row. Never raises."""
    name = backend()
    model = model_for(tag)
    t0 = time.monotonic()
    value: Any = None
    out_chars = 0
    tokens_in = tokens_out = 0
    usd = 0.0
    if name == "off":
        value = None
    elif _paused():
        log.warning("llm %s: AI jobs are paused, call refused", tag)
        return None
    elif name == "api":
        if _client() is None:
            return None
        # One retry, only for a reply that came back but could not be read.
        for attempt in range(2):
            spent = _cap_reached(tag)
            if spent is None:
                return None
            ask = prompt if attempt == 0 else prompt + RETRY_SUFFIX
            value, tokens_in, tokens_out, status = _call_api(ask, schema, model, tag, timeout)
            if value is not None and not matches(value, schema):
                log.warning("llm %s: reply does not match the schema", tag)
                value, status = None, "unreadable"
            call_usd = cost_usd(model, tokens_in, tokens_out)
            usd += call_usd
            store_llm.log_llm_call(tag, model, tokens_in, tokens_out, call_usd, value is not None, ref)
            _warn_thresholds(spent + call_usd)
            if status != "unreadable" or _is_text(schema):
                break
        out_chars = len(json.dumps(value, ensure_ascii=False)) if value is not None else 0
    else:
        raw = _run_cli(prompt, tag, timeout)
        out_chars = len(raw or "")
        if raw:
            value = (raw.strip() or None) if _is_text(schema) else _extract_json(raw)
        if value is not None and not matches(value, schema):
            log.warning("llm %s: reply does not match the schema", tag)
            value = None
    log.info("llm %s: backend=%s model=%s wall=%.1fs in=%d chars out=%d chars"
             " tokens=%d/%d usd=%.4f ok=%s",
             tag, name, model, time.monotonic() - t0, len(prompt), out_chars,
             tokens_in, tokens_out, usd, value is not None)
    return value
