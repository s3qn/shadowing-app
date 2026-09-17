"""Tests for the env and release fields on health(). Importing main starts
nothing (see test_span.py), so these need no TestClient and no network."""

import main


def test_health_defaults_when_env_vars_unset(monkeypatch):
    monkeypatch.delenv("SHADOW_ENV", raising=False)
    monkeypatch.delenv("SHADOW_RELEASE", raising=False)
    result = main.health()
    assert result["env"] == "dev"
    assert result["release"] == ""


def test_health_echoes_env_vars_when_set(monkeypatch):
    monkeypatch.setenv("SHADOW_ENV", "prod")
    monkeypatch.setenv("SHADOW_RELEASE", "abc1234")
    result = main.health()
    assert result["env"] == "prod"
    assert result["release"] == "abc1234"
