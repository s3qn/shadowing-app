"""llm.py: routing, the API backend through a fake client, the cost ledger,
the monthly cap and the owner spend route. No network, no `anthropic` import:
the fake client stands in for `llm._client()`."""

import importlib
import logging
import subprocess
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

import llm
import main
import dependencies
import store
import store_llm
import suggest

client = TestClient(main.app)
OWNER = str(uuid.uuid4())
STRANGER = str(uuid.uuid4())


def _head(device: str) -> dict:
    return {"Authorization": "Bearer test-token", "X-Shadow-Device": device}


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    store.init()
    with store.connect() as conn:
        conn.execute("DELETE FROM llm_calls")
    monkeypatch.setenv("SHADOW_LLM", "api")
    monkeypatch.setattr(llm, "_warned", set())
    monkeypatch.setattr(llm, "_client_instance", None)
    monkeypatch.setattr(llm, "_warned_no_key", False)
    monkeypatch.setattr(llm, "MONTHLY_USD", 30.0)
    monkeypatch.setattr(llm, "DAILY_USD", 5.0)
    monkeypatch.setattr(llm, "_pause_check", lambda: False)
    monkeypatch.setattr(suggest, "_relay_to_discord", lambda *a, **k: None)


class Block:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class Usage:
    def __init__(self, input_tokens, output_tokens):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class Reply:
    def __init__(self, content, tokens_in, tokens_out, stop_reason="end_turn"):
        self.content = content
        self.usage = Usage(tokens_in, tokens_out)
        self.stop_reason = stop_reason


def text_reply(text, tokens_in=1000, tokens_out=500):
    return Reply([Block(type="text", text=text)], tokens_in, tokens_out)


class FakeClient:
    """`messages.create(**kw)` records kw and answers the queued replies, the
    last one forever. `error` raises instead."""

    def __init__(self, *replies, error=None):
        self.calls = []
        self._replies = list(replies)
        self._error = error
        self.messages = self

    def create(self, **kw):
        self.calls.append(kw)
        if self._error is not None:
            raise self._error
        return self._replies.pop(0) if len(self._replies) > 1 else self._replies[0]


def use(monkeypatch, fake):
    monkeypatch.setattr(llm, "_client", lambda: fake)
    return fake


def rows():
    with store.connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM llm_calls ORDER BY id").fetchall()]


# ---- API backend ----

REPAIR_LIKE = {
    "type": "array",
    "items": {"type": "object", "properties": {"n": {"type": "integer"}, "text": {"type": "string"},
                                               "why": {"type": "string"}}, "required": ["n", "text"]},
}


@pytest.mark.parametrize("tag", ["repair", "catch-meanings"])
def test_api_strict_schema_rides_structured_outputs(monkeypatch, tag):
    """Sonnet 5.5 refuses forced tool_choice, so no request carries tools:
    a fully specified schema goes in output_config, closed and wrapped."""
    fake = use(monkeypatch, FakeClient(text_reply('{"value": [{"n": 1, "text": "直した"}]}')))
    assert llm.complete("prompt text", REPAIR_LIKE, tag=tag) == [{"n": 1, "text": "直した"}]
    kw = fake.calls[0]
    assert "tools" not in kw and "tool_choice" not in kw
    fmt = kw["output_config"]["format"]
    assert fmt["type"] == "json_schema"
    inner = fmt["schema"]["properties"]["value"]["items"]
    assert fmt["schema"]["additionalProperties"] is False and inner["additionalProperties"] is False
    assert inner["required"] == ["n", "text"]
    assert kw["model"] == llm.model_for(tag)
    assert kw["messages"] == [{"role": "user", "content": "prompt text"}]


@pytest.mark.parametrize("tag", ["generate", "pick"])
def test_api_loose_schema_reads_the_prompted_json(monkeypatch, tag):
    """A schema too loose to constrain (no properties, no items) sends no
    output_config and reads the raw JSON the prompt asks for, on both tiers."""
    fake = use(monkeypatch, FakeClient(text_reply('Here:\n{"lines": [{"ja": "猫"}], "title": "t"}')))
    schema = {"type": "object", "required": ["lines"]}
    assert llm.complete("p", schema, tag=tag) == {"lines": [{"ja": "猫"}], "title": "t"}
    kw = fake.calls[0]
    assert "output_config" not in kw and "tools" not in kw and "tool_choice" not in kw
    assert kw["model"] == llm.model_for(tag)
    assert kw["max_tokens"] == llm.MAX_TOKENS.get(tag, llm.DEFAULT_MAX_TOKENS)


def test_api_unreadable_reply_is_retried_once_and_both_billed(monkeypatch):
    fake = use(monkeypatch, FakeClient(text_reply("sorry, no JSON"), text_reply('{"lines": []}')))
    assert llm.complete("p", {"type": "object", "required": ["lines"]}, tag="generate") == {"lines": []}
    assert len(fake.calls) == 2
    assert fake.calls[1]["messages"][0]["content"].startswith("p\n\nYour previous reply")
    assert [r["ok"] for r in rows()] == [0, 1]


def test_api_retry_stops_after_one_and_skips_a_cut_reply(monkeypatch):
    fake = use(monkeypatch, FakeClient(text_reply("still prose")))
    assert llm.complete("p", {"type": "array"}, tag="pick") is None
    assert len(fake.calls) == 2
    fake = use(monkeypatch, FakeClient(Reply([Block(type="text", text='[{"a"')], 10, 3072, "max_tokens")))
    assert llm.complete("p", {"type": "array"}, tag="translate_lines") is None
    assert len(fake.calls) == 1


def test_api_wrong_shape_is_none_but_billed(monkeypatch):
    use(monkeypatch, FakeClient(text_reply("[1, 2]")))
    assert llm.complete("p", {"type": "object", "required": ["lines"]}, tag="generate") is None
    got = rows()
    assert len(got) == 2  # the one retry
    assert all(r["ok"] == 0 and r["input_tokens"] == 1000 and r["output_tokens"] == 500 for r in got)


def test_api_text_mode_sends_no_tools(monkeypatch):
    fake = use(monkeypatch, FakeClient(text_reply("  a gloss \n")))
    assert llm.complete("p", {"type": "string"}, tag="word_context") == "a gloss"
    kw = fake.calls[0]
    assert "tools" not in kw and "tool_choice" not in kw and "output_config" not in kw
    assert kw["max_tokens"] == 512


def test_api_raising_client_is_none_with_an_ok0_row(monkeypatch, caplog):
    use(monkeypatch, FakeClient(error=RuntimeError("boom")))
    with caplog.at_level(logging.WARNING, logger="llm"):
        assert llm.complete("secret prompt", {"type": "array"}, tag="pick") is None
    assert "API call failed: RuntimeError: boom" in caplog.text
    assert "secret prompt" not in caplog.text
    (row,) = rows()
    assert (row["ok"], row["input_tokens"], row["output_tokens"], row["usd"]) == (0, 0, 0, 0)


def test_cost_row_has_tag_model_ref_and_usd(monkeypatch):
    use(monkeypatch, FakeClient(text_reply("g", 1000, 500)))
    assert llm.complete("p", {"type": "string"}, tag="word_context", ref="vid1") == "g"
    (row,) = rows()
    assert row["tag"] == "word_context" and row["model"] == llm.TIERS["haiku"]
    assert row["ref"] == "vid1" and row["ok"] == 1
    assert row["usd"] == pytest.approx(0.00035)
    summary = store_llm.llm_spend_summary()
    assert summary["calls"] == 1 and summary["month_usd"] == pytest.approx(0.00035)
    assert summary["by_tag"]["word_context"]["calls"] == 1
    assert llm.cost_usd("some-unknown-model", 1000, 500) == pytest.approx(0.007)


def test_timeout_books_a_conservative_estimate(monkeypatch):
    class APITimeoutError(Exception):
        pass

    use(monkeypatch, FakeClient(error=APITimeoutError("Request timed out.")))
    prompt = "x" * 3000
    assert llm.complete(prompt, {"type": "array"}, tag="pick") is None
    (row,) = rows()
    assert row["ok"] == 0
    assert row["input_tokens"] == 1501 and row["output_tokens"] == llm.MAX_TOKENS["pick"]
    assert row["usd"] == pytest.approx(llm.cost_usd(llm.TIERS["haiku"], 1501, llm.MAX_TOKENS["pick"]))


def test_sdk_retries_default_to_one(monkeypatch):
    monkeypatch.delenv("SHADOW_LLM_RETRIES", raising=False)
    monkeypatch.setattr(llm, "_api_key", lambda: "sk-test")
    built = {}

    class FakeAnthropic:
        def __init__(self, **kw):
            built.update(kw)

    import anthropic
    monkeypatch.setattr(anthropic, "Anthropic", FakeAnthropic)
    llm._client()
    assert built["max_retries"] == 1


def test_pause_check_stops_every_call(monkeypatch, caplog):
    fake = use(monkeypatch, FakeClient(text_reply("g")))
    llm.set_pause_check(lambda: True)
    with caplog.at_level(logging.WARNING, logger="llm"):
        assert llm.complete("p", {"type": "string"}, tag="word_context") is None
    assert "paused" in caplog.text and fake.calls == [] and rows() == []


def test_ai_jobs_switch_pauses_background_calls(monkeypatch, tmp_path):
    """main registers the admin file's ai_jobs switch as the pause hook, so
    a repair batch or a catch refill stops with it."""
    import guardrails

    admin = tmp_path / "admin.json"
    monkeypatch.setenv("SHADOW_ADMIN_FILE", str(admin))
    monkeypatch.setattr(llm, "_pause_check", dependencies._ai_paused)
    fake = use(monkeypatch, FakeClient(text_reply("g")))
    assert llm.complete("p", {"type": "string"}, tag="repair") == "g"
    admin.write_text('{"ai_jobs": false}')
    guardrails._cache.update(path=None, mtime=None, values={})
    assert llm.complete("p", {"type": "string"}, tag="repair") is None
    assert len(fake.calls) == 1


# ---- daily cap ----

def test_daily_cap_refuses_and_yesterday_does_not_count(monkeypatch, caplog):
    monkeypatch.setattr(llm, "DAILY_USD", 0.5)
    now = datetime.now(timezone.utc)
    yesterday = now - __import__("datetime").timedelta(days=1)
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO llm_calls (tag, model, input_tokens, output_tokens, usd, ok, ref, created_at)"
            " VALUES ('generate', 'm', 1, 1, 3.0, 1, '', ?)",
            (yesterday.isoformat(timespec="seconds"),),
        )
    fake = use(monkeypatch, FakeClient(text_reply("g")))
    assert llm.complete("p", {"type": "string"}, tag="word_context") == "g"
    store_llm.log_llm_call("generate", "m", 0, 0, 0.6, True, "")
    assert store_llm.llm_spent_today() == pytest.approx(0.6 + llm.cost_usd(llm.TIERS["haiku"], 1000, 500))
    with caplog.at_level(logging.WARNING, logger="llm"):
        assert llm.complete("p", {"type": "string"}, tag="word_context") is None
    assert "daily cap reached" in caplog.text and len(fake.calls) == 1


# ---- monthly cap ----

def test_cap_refuses_before_the_call_and_cached_path_still_answers(monkeypatch, caplog):
    monkeypatch.setattr(llm, "MONTHLY_USD", 0.01)
    store_llm.log_llm_call("generate", "m", 0, 0, 0.02, True, "")
    fake = use(monkeypatch, FakeClient(text_reply("fresh")))
    with caplog.at_level(logging.WARNING, logger="llm"):
        assert llm.complete("p", {"type": "string"}, tag="word_context") is None
    assert "monthly cap reached" in caplog.text
    assert fake.calls == []
    # The word route reads its cache before the seam, so a cached gloss
    # answers at the cap without reaching explain or the API.
    store.set_word_context("猫", "猫が好き", "cat")

    def not_reached(*a, **k):
        raise AssertionError("word_context reached the model at the cap")

    monkeypatch.setattr(main.explain, "word_context", not_reached)
    r = client.get("/shadow/explain-word", params={"word": "猫", "sentence_ja": "猫が好き"},
                   headers=_head(STRANGER))
    assert r.status_code == 200 and r.json() == {"context": "cat"}


def test_cap_warnings_fire_once_per_level(monkeypatch, caplog):
    monkeypatch.setattr(llm, "MONTHLY_USD", 0.0019)
    relayed = []
    monkeypatch.setattr(suggest, "_relay_to_discord", lambda text, prefix="": relayed.append(text))
    use(monkeypatch, FakeClient(text_reply("g", 0, 1000)))  # 0.0005 per call on haiku
    with caplog.at_level(logging.WARNING, logger="llm"):
        for _ in range(4):
            assert llm.complete("p", {"type": "string"}, tag="word_context") == "g"
        assert llm.complete("p", {"type": "string"}, tag="word_context") is None
    assert caplog.text.count("50% of this month's cap") == 1
    assert caplog.text.count("90% of this month's cap") == 1
    assert "monthly cap reached" in caplog.text
    import time
    for _ in range(50):
        if len(relayed) == 2:
            break
        time.sleep(0.01)
    assert len(relayed) == 2


def test_last_month_rows_do_not_count():
    now = datetime.now(timezone.utc)
    last = (now.replace(day=1) - __import__("datetime").timedelta(days=1)).replace(day=1)
    with store.connect() as conn:
        conn.execute(
            "INSERT INTO llm_calls (tag, model, input_tokens, output_tokens, usd, ok, ref, created_at)"
            " VALUES ('generate', 'm', 1, 1, 5.0, 1, '', ?)",
            (last.isoformat(timespec="seconds"),),
        )
    store_llm.log_llm_call("pick", "m", 1, 1, 0.25, True, "")
    assert store_llm.llm_spent_month() == pytest.approx(0.25)
    assert store_llm.llm_spend_summary()["calls"] == 1


# ---- routing ----

def test_routing_defaults_and_overrides(monkeypatch):
    assert llm.model_for("generate") == llm.TIERS["sonnet"]
    assert llm.model_for("repair") == llm.TIERS["sonnet"]
    assert llm.model_for("word_context") == llm.TIERS["haiku"]
    assert llm.model_for("catch-meanings") == llm.TIERS["haiku"]
    assert llm.model_for("never-heard-of-it") == llm.TIERS["sonnet"]
    monkeypatch.setenv("SHADOW_LLM_ROUTE_REPAIR", "haiku")
    assert llm.model_for("repair") == llm.TIERS["haiku"]
    monkeypatch.setenv("SHADOW_LLM_ROUTE_CATCH_MEANINGS", "claude-pinned-id")
    assert llm.model_for("catch-meanings") == "claude-pinned-id"


def test_haiku_tier_env_override(monkeypatch):
    monkeypatch.setenv("SHADOW_LLM_HAIKU", "claude-haiku-test")
    try:
        importlib.reload(llm)
        assert llm.model_for("pick") == "claude-haiku-test"
        assert llm.model_for("generate") == "claude-sonnet-5-5"
    finally:
        monkeypatch.delenv("SHADOW_LLM_HAIKU")
        importlib.reload(llm)
    assert llm.model_for("pick") == "claude-haiku-5-5"


# ---- key handling ----

def test_missing_key_is_none_with_one_warning(monkeypatch, caplog):
    monkeypatch.setattr(llm, "_api_key", lambda: None)
    with caplog.at_level(logging.WARNING, logger="llm"):
        assert llm.complete("p", {"type": "array"}, tag="pick") is None
        assert llm.complete("p", {"type": "array"}, tag="pick") is None
    assert caplog.text.count("no ANTHROPIC_API_KEY or CLAUDE_API_KEY") == 1
    assert rows() == []


def test_api_key_resolution_order(monkeypatch, tmp_path):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("CLAUDE_API_KEY", raising=False)
    monkeypatch.setenv("SHADOW_ENV", "prod")  # never read backend/.env here
    key_file = tmp_path / "env"
    monkeypatch.setenv("SHADOW_LLM_KEY_FILE", str(key_file))
    assert llm._api_key() is None
    key_file.write_text("# comment\nexport CLAUDE_API_KEY='sk-from-file'\nOTHER=1\n")
    assert llm._api_key() == "sk-from-file"
    monkeypatch.setenv("CLAUDE_API_KEY", "sk-claude-env")
    assert llm._api_key() == "sk-claude-env"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-anthropic-env")
    assert llm._api_key() == "sk-anthropic-env"


# ---- CLI backend ----

class Proc:
    def __init__(self, stdout):
        self.returncode = 0
        self.stdout = stdout
        self.stderr = ""


def test_run_cli_strips_keys_and_routes_the_model(monkeypatch):
    monkeypatch.setenv("SHADOW_LLM", "cli")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-shell")
    monkeypatch.setenv("CLAUDE_API_KEY", "sk-shell-2")
    seen = []

    def fake_run(argv, **kw):
        seen.append((argv, kw))
        return Proc('note\n{"a": 1}\n' if "--safe-mode" in argv else "  plain gloss \n")

    monkeypatch.setattr(subprocess, "run", fake_run)
    assert llm.complete("p", {"type": "object"}, tag="word_context") == {"a": 1}
    argv, kw = seen[0]
    assert argv[argv.index("--model") + 1] == llm.TIERS["haiku"]
    assert "--safe-mode" in argv and argv[argv.index("--effort") + 1] == "low"
    assert "ANTHROPIC_API_KEY" not in kw["env"] and "CLAUDE_API_KEY" not in kw["env"]
    assert kw["env"]["MAX_THINKING_TOKENS"] == "0"
    assert kw["input"] == "p" and kw["timeout"] == llm.DEFAULT_TIMEOUT_S
    assert llm.complete("p", {"type": "string"}, tag="generate", timeout=7) == "plain gloss"
    argv, kw = seen[1]
    assert argv[argv.index("--model") + 1] == llm.TIERS["sonnet"]
    assert "--safe-mode" not in argv and "--effort" not in argv
    assert "MAX_THINKING_TOKENS" not in kw["env"] and kw["timeout"] == 7
    assert rows() == []  # the CLI backend writes no cost rows


# ---- owner spend route ----

def test_spend_route_is_owner_only(monkeypatch):
    monkeypatch.setattr(dependencies, "OWNER_DEVICE", OWNER)
    assert client.get("/shadow/llm/spend", headers=_head(STRANGER)).status_code == 403
    store_llm.log_llm_call("repair", llm.TIERS["sonnet"], 100, 50, 0.001, True, "vid9")
    r = client.get("/shadow/llm/spend", headers=_head(OWNER))
    assert r.status_code == 200
    body = r.json()
    assert body["backend"] == "api" and body["cap_usd"] == 30.0
    assert body["calls"] == 1 and body["month_usd"] == pytest.approx(0.001)
    assert body["by_tag"] == {"repair": {"calls": 1, "usd": 0.001}}


# ---- the callers never shell out on their own ----

def test_no_caller_module_runs_a_subprocess():
    import inspect

    import catch
    import explain
    import generate
    import grammar
    import repair

    for module in (generate, explain, catch, grammar, repair):
        assert "subprocess" not in inspect.getsource(module), module.__name__
