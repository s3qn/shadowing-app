"""GET /shadow/app/latest and tools/set-latest-build.py. Uses the conftest data dir."""
import importlib.util
import json
from pathlib import Path

import pytest

import app_version
import main
import store

TOOL = Path(__file__).resolve().parents[2] / "tools" / "set-latest-build.py"
APK = "https://expo.dev/artifacts/eas/abc.apk"


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    return tmp_path


def _write(d, text):
    (d / "latest-build.json").write_text(text)


def test_missing_file_fails_open():
    assert main.app_latest() == {"ios": None, "android": None}


def test_valid_file_is_served(data_dir):
    body = {"ios": {"build": 23, "url": "itms-beta://x"}, "android": {"build": 22, "url": APK}}
    _write(data_dir, json.dumps(body))
    assert main.app_latest() == body


def test_one_bad_platform_only_nulls_that_one(data_dir):
    _write(data_dir, json.dumps({"ios": {"build": 0, "url": "u"}, "android": {"build": 5, "url": APK}}))
    assert app_version.latest() == {"ios": None, "android": {"build": 5, "url": APK}}
    _write(data_dir, json.dumps({"ios": {"build": "23", "url": "u"}, "android": {"build": 5, "url": ""}}))
    assert app_version.latest() == {"ios": None, "android": None}


def test_broken_json_fails_open(data_dir):
    _write(data_dir, "{nope")
    assert app_version.latest() == {"ios": None, "android": None}
    _write(data_dir, "[1]")
    assert app_version.latest() == {"ios": None, "android": None}


def _tool(argv, monkeypatch):
    spec = importlib.util.spec_from_file_location("set_latest_build", TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr("sys.argv", ["set-latest-build.py", *argv])
    return mod.main()


def test_set_latest_build_merges_platforms(data_dir, monkeypatch):
    assert _tool(["--data-dir", str(data_dir), "--android", "22", "--url", APK], monkeypatch) == 0
    assert _tool(["--data-dir", str(data_dir), "--ios", "23"], monkeypatch) == 0
    got = app_version.latest()
    assert got["android"] == {"build": 22, "url": APK}
    assert got["ios"]["build"] == 23 and got["ios"]["url"].startswith("itms-beta://")


def test_set_latest_build_rejects_non_artifact_url(data_dir, monkeypatch):
    with pytest.raises(SystemExit):
        _tool(["--data-dir", str(data_dir), "--android", "22", "--url", "http://evil"], monkeypatch)
