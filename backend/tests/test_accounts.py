"""Tests for signed-in accounts: JWT verification, the DeviceGuard user path,
per-user scoping, and account deletion. No network: the JWKS is generated
locally and accounts._fetch_jwks is monkeypatched."""

import time
import uuid

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from fastapi.testclient import TestClient

import accounts
import main
import schedule
import store

KID = "test-kid-1"
AUTH = {"Authorization": f"Bearer {main.SHADOW_TOKEN}"}
client = TestClient(main.app)


@pytest.fixture(autouse=True)
def _init_db():
    store.init()
    schedule.init()


def _keypair():
    return ec.generate_private_key(ec.SECP256R1())


def _jwk(private, kid=KID) -> dict:
    jwk = jwt.algorithms.ECAlgorithm.to_jwk(private.public_key(), as_dict=True)
    jwk["kid"] = kid
    return jwk


class _Key:
    """A signing key plus its JWKS fetch counter."""

    def __init__(self, private, calls):
        self.private = private
        self.calls = calls


@pytest.fixture
def key(monkeypatch):
    private = _keypair()
    calls = {"n": 0}

    def fetch():
        calls["n"] += 1
        return {"keys": [_jwk(private)]}

    monkeypatch.setattr(accounts, "_fetch_jwks", fetch)
    monkeypatch.setitem(accounts._cache, "keys", {})
    monkeypatch.setitem(accounts._cache, "fetched_at", 0.0)
    monkeypatch.setitem(accounts._cache, "failed_at", 0.0)
    return _Key(private, calls)


def _token(private, sub=None, kid=KID, **overrides) -> str:
    claims = {
        "sub": sub or str(uuid.uuid4()),
        "aud": accounts.AUDIENCE,
        "iss": accounts.ISSUER,
        "exp": int(time.time()) + 3600,
    }
    claims.update(overrides)
    private = getattr(private, "private", private)
    return jwt.encode(claims, private, algorithm="ES256", headers={"kid": kid})


def test_verify_returns_sub(key):
    sub = str(uuid.uuid4())
    assert accounts.verify(_token(key, sub=sub)) == sub


def test_verify_rejects_expired(key):
    with pytest.raises(accounts.BadToken):
        accounts.verify(_token(key, exp=int(time.time()) - 10))


def test_verify_rejects_wrong_audience(key):
    with pytest.raises(accounts.BadToken):
        accounts.verify(_token(key, aud="anon"))


def test_verify_rejects_wrong_issuer(key):
    with pytest.raises(accounts.BadToken):
        accounts.verify(_token(key, iss="https://evil.example/auth/v1"))


def test_verify_rejects_other_signing_key(key):
    with pytest.raises(accounts.BadToken):
        accounts.verify(_token(_keypair()))


def test_verify_rejects_missing_exp(key):
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "aud": accounts.AUDIENCE, "iss": accounts.ISSUER},
        key.private, algorithm="ES256", headers={"kid": KID},
    )
    with pytest.raises(accounts.BadToken):
        accounts.verify(token)


def test_verify_rejects_garbage_and_alg_none(key):
    with pytest.raises(accounts.BadToken):
        accounts.verify("garbage")
    unsigned = jwt.encode({"sub": "x"}, None, algorithm="none", headers={"kid": KID})
    with pytest.raises(accounts.BadToken):
        accounts.verify(unsigned)


def test_unknown_kid_is_rejected_and_refetch_is_throttled(key):
    accounts.verify(_token(key))
    assert key.calls["n"] == 1
    stray = _token(key, kid="rotated")
    with pytest.raises(accounts.BadToken):
        accounts.verify(stray)
    assert key.calls["n"] == 1  # within a minute: no refetch
    accounts._cache["fetched_at"] -= accounts.REFETCH_MIN_INTERVAL + 1
    with pytest.raises(accounts.BadToken):
        accounts.verify(stray)
    assert key.calls["n"] == 2


def test_jwks_fetched_once_across_two_verifies(key):
    accounts.verify(_token(key))
    accounts.verify(_token(key))
    assert key.calls["n"] == 1


def test_jwks_fetch_failure_is_not_retried_for_a_while(key, monkeypatch):
    calls = {"n": 0}

    def down():
        calls["n"] += 1
        raise httpx.ConnectError("down")

    monkeypatch.setattr(accounts, "_fetch_jwks", down)
    for _ in range(3):
        with pytest.raises(accounts.BadToken):
            accounts.verify(_token(key))
    assert calls["n"] == 1
    accounts._cache["failed_at"] -= accounts.JWKS_FAIL_BACKOFF + 1
    with pytest.raises(accounts.BadToken):
        accounts.verify(_token(key))
    assert calls["n"] == 2


def test_access_log_redacts_user_and_token_query_values():
    import logging

    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 0, '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:1", "GET", "/shadow/islands/x/lines/0/audio?token=secret&device=abc&user=eyJ.a.b&v=3", "1.1", 200),
        None,
    )
    assert main.RedactAccessLog().filter(record) is True
    line = record.getMessage()
    assert "secret" not in line and "eyJ.a.b" not in line
    assert "token=REDACTED" in line and "user=REDACTED" in line
    assert "device=abc" in line and "v=3" in line


def test_access_log_filter_is_installed():
    import logging

    filters = logging.getLogger("uvicorn.access").filters
    assert any(isinstance(f, main.RedactAccessLog) for f in filters)


# --- through the ASGI app ---


def _list(headers=None, params=None):
    return client.get("/shadow/islands", headers={**AUTH, **(headers or {})}, params=params)


def test_user_header_lists_only_that_users_islands(key):
    sub = str(uuid.uuid4())
    mine = store.create_island("simple", 3, device=accounts.principal(sub))
    other = store.create_island("simple", 3, device="a" * 12)
    r = _list({"X-Shadow-User": _token(key, sub=sub)})
    assert r.status_code == 200
    ids = {i["id"] for i in r.json()}
    assert mine in ids and other not in ids


def test_user_query_form_works(key):
    sub = str(uuid.uuid4())
    mine = store.create_island("simple", 3, device=accounts.principal(sub))
    r = _list(params={"user": _token(key, sub=sub)})
    assert r.status_code == 200
    assert mine in {i["id"] for i in r.json()}


def test_user_token_overrides_a_device_header(key):
    sub = str(uuid.uuid4())
    dev = uuid.uuid4().hex
    on_device = store.create_island("simple", 3, device=dev)
    r = _list({"X-Shadow-User": _token(key, sub=sub), "X-Shadow-Device": dev})
    assert on_device not in {i["id"] for i in r.json()}


def test_forged_user_device_header_is_401():
    sub = str(uuid.uuid4())
    assert _list({"X-Shadow-Device": f"user_{sub}"}).status_code == 401


def test_forged_user_device_query_is_401():
    sub = str(uuid.uuid4())
    assert _list(params={"device": f"user_{sub}"}).status_code == 401


def test_forged_user_device_with_a_valid_token_is_still_401(key):
    sub = str(uuid.uuid4())
    r = _list({"X-Shadow-User": _token(key, sub=sub), "X-Shadow-Device": f"user_{sub}"})
    assert r.status_code == 401


@pytest.mark.parametrize("make", [
    lambda k: _token(k, exp=int(time.time()) - 10),
    lambda k: _token(k, aud="anon"),
    lambda k: _token(_keypair()),
    lambda k: "garbage",
])
def test_bad_user_token_is_401_and_never_falls_back_to_device(key, make):
    dev = uuid.uuid4().hex
    r = _list({"X-Shadow-User": make(key), "X-Shadow-Device": dev})
    assert r.status_code == 401
    r = _list(params={"user": make(key), "device": dev})
    assert r.status_code == 401


def test_no_user_and_no_device_is_401():
    assert _list().status_code == 401


def test_legacy_device_request_is_unchanged():
    dev = uuid.uuid4().hex
    mine = store.create_island("simple", 3, device=dev)
    r = _list({"X-Shadow-Device": dev})
    assert r.status_code == 200
    assert mine in {i["id"] for i in r.json()}
    r = _list(params={"device": dev})
    assert r.status_code == 200


def test_build_slot_counts_per_user(monkeypatch):
    monkeypatch.setattr(main, "DAILY_CREATES", 1)
    a = accounts.principal(str(uuid.uuid4()))
    b = accounts.principal(str(uuid.uuid4()))
    main._take_build_slot(a, "create")
    main._take_build_slot(b, "create")
    with pytest.raises(HTTPException) as exc:
        main._take_build_slot(a, "create")
    assert exc.value.status_code == 429


# --- delete account ---


def _delete(headers):
    return client.delete("/shadow/account", headers={**AUTH, **headers})


def test_delete_without_service_key_is_503_and_keeps_islands(key, monkeypatch):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    sub = str(uuid.uuid4())
    iid = store.create_island("simple", 3, device=accounts.principal(sub))
    r = _delete({"X-Shadow-User": _token(key, sub=sub)})
    assert r.status_code == 503
    assert r.json()["detail"] == {"code": "account_delete_unavailable"}
    assert store.get_island(iid) is not None


def test_delete_erases_only_this_user(key, monkeypatch):
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    deleted = []
    monkeypatch.setattr(accounts, "delete_auth_user", deleted.append)
    sub, other_sub = str(uuid.uuid4()), str(uuid.uuid4())
    mine = store.create_island("simple", 3, device=accounts.principal(sub))
    theirs = store.create_island("simple", 3, device=accounts.principal(other_sub))
    store.log_build(accounts.principal(sub), "create")
    r = _delete({"X-Shadow-User": _token(key, sub=sub)})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert deleted == [sub]
    assert store.get_island(mine) is None
    assert store.get_island(theirs) is not None
    assert store.count_builds_today(accounts.principal(sub), "create") == 0


def test_delete_with_only_a_device_header_is_401(monkeypatch):
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    assert _delete({"X-Shadow-Device": uuid.uuid4().hex}).status_code == 401


class _Resp:
    def __init__(self, code):
        self.status_code = code


@pytest.mark.parametrize("code,ok", [(200, True), (204, True), (404, True), (500, False)])
def test_delete_auth_user_calls_supabase(monkeypatch, code, ok):
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-key")
    seen = {}

    def fake_delete(url, headers, timeout):
        seen.update(url=url, headers=headers)
        return _Resp(code)

    monkeypatch.setattr(httpx, "delete", fake_delete)
    if ok:
        accounts.delete_auth_user("abc")
    else:
        with pytest.raises(HTTPException) as exc:
            accounts.delete_auth_user("abc")
        assert exc.value.status_code == 502
    assert seen["url"] == f"{accounts.SUPABASE_URL}/auth/v1/admin/users/abc"
    assert seen["headers"] == {"apikey": "service-key", "Authorization": "Bearer service-key"}
