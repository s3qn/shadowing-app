"""Device-bound admin: the admin routes through TestClient with sign-in on,
the enrol route, the proof check in DeviceGuard and the admin_devices store.
The `_proof` helper here mirrors what the client signs (src/lib/admin-device.ts)."""

import argparse
import asyncio
import importlib.util
import json
import secrets
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import HTTPException
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

import accounts
import access
import admin_devices
import beta
import config
import dependencies
import main
import middleware
import store

from test_accounts import _token, key  # noqa: F401  (key is a fixture)

SUB = "11111111-2222-4333-8444-555555555555"
PRINCIPAL = accounts.principal(SUB)
OTHER_SUB = "66666666-7777-4888-8999-000000000000"
OTHER = accounts.principal(OTHER_SUB)
DEVICE = "00000000-0000-4000-8000-0000000000ad"
AUTH = {"Authorization": f"Bearer {config.SHADOW_TOKEN}"}
LIST = "/shadow/admin/beta"
ENROL = "/shadow/admin/device"

client = TestClient(main.app)


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setattr(middleware, "REQUIRE_SIGNIN", True)
    monkeypatch.setattr(access, "ADMIN_USERS", frozenset({PRINCIPAL, DEVICE}))
    monkeypatch.setattr(dependencies, "OWNER_DEVICE", "")
    monkeypatch.setattr(dependencies, "OWNER_ALIASES", frozenset())
    store.init()
    beta.init()
    admin_devices.init()
    admin_devices._seen.clear()
    with admin_devices.connect() as conn:
        conn.execute("DELETE FROM admin_devices")
    yield
    beta.delete_owner(PRINCIPAL)
    beta.delete_owner(OTHER)


class _Phone:
    """One phone's key, the way the client makes it: a 32-byte secret, the
    raw public key as hex and the key id derived from it."""

    def __init__(self):
        self.secret = Ed25519PrivateKey.generate()
        self.public = self.secret.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
        self.key_id = admin_devices.key_id_for(self.public)

    def proof(
        self, method: str, path: str, ts: int | None = None, nonce: str | None = None, body: bytes = b"",
    ) -> str:
        ts_s = str(int(time.time()) if ts is None else ts)
        nonce = nonce or secrets.token_hex(16)
        sig = self.secret.sign(admin_devices.message(self.key_id, ts_s, nonce, method, path, body)).hex()
        return f"v1.{self.key_id}.{ts_s}.{nonce}.{sig}"

    def body(self, name: str = "Test phone") -> dict:
        return {"key_id": self.key_id, "public_key": self.public, "name": name}


def _hdr(key, sub=SUB, proof: str | None = None, **extra) -> dict:
    h = {**AUTH, "X-Shadow-User": _token(key, sub=sub), **extra}
    if proof:
        h["X-Shadow-Proof"] = proof
    return h


def _approved(key) -> _Phone:
    phone = _Phone()
    assert client.post(ENROL, json=phone.body(), headers=_hdr(key)).json() == {"status": "pending"}
    assert admin_devices.approve(phone.key_id)
    return phone


def test_listed_user_without_proof_is_admin_device(key):
    r = client.get(LIST, headers=_hdr(key))
    assert r.status_code == 403 and r.json() == {"detail": {"code": "admin_device"}}


def test_enrol_is_pending_and_idempotent(key):
    phone = _Phone()
    assert client.post(ENROL, json=phone.body(), headers=_hdr(key)).json() == {"status": "pending"}
    assert client.post(ENROL, json=phone.body(), headers=_hdr(key)).json() == {"status": "pending"}
    rows = admin_devices.list_all()
    assert len(rows) == 1 and rows[0]["owner"] == PRINCIPAL and rows[0]["name"] == "Test phone"
    # Still pending, so the list stays closed.
    assert client.get(LIST, headers=_hdr(key, proof=phone.proof("GET", "/admin/beta"))).status_code == 403


def test_enrol_same_key_other_owner_is_409(key):
    phone = _Phone()
    client.post(ENROL, json=phone.body(), headers=_hdr(key))
    access.ADMIN_USERS = frozenset({PRINCIPAL, OTHER})
    r = client.post(ENROL, json=phone.body(), headers=_hdr(key, sub=OTHER_SUB))
    assert r.status_code == 409 and r.json()["detail"] == {"code": "admin_key_taken"}
    assert admin_devices.list_all()[0]["owner"] == PRINCIPAL


def test_enrol_bad_key_id_or_key_is_400(key):
    phone = _Phone()
    wrong = {**phone.body(), "key_id": "0" * 16}
    r = client.post(ENROL, json=wrong, headers=_hdr(key))
    assert r.status_code == 400 and r.json()["detail"] == {"code": "bad_key"}
    junk = {**phone.body(), "public_key": "zz" * 32}
    assert client.post(ENROL, json=junk, headers=_hdr(key)).status_code == 400
    short = {**phone.body(), "public_key": "ab" * 8}
    assert client.post(ENROL, json=short, headers=_hdr(key)).status_code == 400
    assert admin_devices.list_all() == []


def _put(key, phone: _Phone, payload: dict, signed: bytes | None = None):
    """PUT the list with these exact body bytes, the proof signed over
    `signed` (default: the same bytes)."""
    raw = json.dumps(payload).encode()
    proof = phone.proof("PUT", "/admin/beta", body=raw if signed is None else signed)
    return client.put(LIST, content=raw, headers=_hdr(key, proof=proof, **{"Content-Type": "application/json"}))


def test_approved_key_opens_list_and_set(key):
    phone = _approved(key)
    r = client.get(LIST, headers=_hdr(key, proof=phone.proof("GET", "/admin/beta")))
    assert r.status_code == 200 and any(p["me"] for p in r.json()["people"])
    assert r.json()["device"] == "approved"
    r = _put(key, phone, {"owner": OTHER, "enabled": True})
    assert r.status_code == 200 and beta.is_enabled(OTHER)
    assert admin_devices.list_all()[0]["last_seen_at"]


def test_proof_is_bound_to_the_body(key):
    phone = _approved(key)
    signed = json.dumps({"owner": PRINCIPAL, "enabled": False}).encode()
    r = _put(key, phone, {"owner": OTHER, "enabled": True}, signed=signed)
    assert r.status_code == 403 and r.json()["detail"] == {"code": "admin_device"}
    assert not beta.is_enabled(OTHER)
    # A GET signed over a non-empty body is refused too: no body hashes as sha256("").
    r = client.get(LIST, headers=_hdr(key, proof=phone.proof("GET", "/admin/beta", body=b"x")))
    assert r.status_code == 403


def test_device_principal_list_reports_no_device(monkeypatch):
    monkeypatch.setattr(middleware, "REQUIRE_SIGNIN", False)
    r = client.get(LIST, headers={**AUTH, "X-Shadow-Device": DEVICE})
    assert r.status_code == 200 and r.json()["device"] is None


def test_buffer_body_replays_every_message():
    sent = [
        {"type": "http.request", "body": b"ab", "more_body": True},
        {"type": "http.request", "body": b"cd", "more_body": False},
        {"type": "http.disconnect"},
    ]
    queue = list(sent)

    async def receive():
        return queue.pop(0)

    async def run():
        body, replay = await middleware._buffer_body(receive)
        return body, [await replay() for _ in sent]

    body, seen = asyncio.run(run())
    assert body == b"abcd" and seen == sent


def test_buffer_body_over_the_cap_is_unchecked_but_replayed(monkeypatch):
    monkeypatch.setattr(middleware, "PROOF_BODY_MAX", 3)
    sent = [
        {"type": "http.request", "body": b"ab", "more_body": True},
        {"type": "http.request", "body": b"cd", "more_body": True},
        {"type": "http.request", "body": b"ef", "more_body": False},
    ]
    queue = list(sent)

    async def receive():
        return queue.pop(0)

    async def run():
        body, replay = await middleware._buffer_body(receive)
        return body, [await replay() for _ in sent]

    body, seen = asyncio.run(run())
    assert body is None and seen == sent


def test_replayed_proof_is_403(key):
    phone = _approved(key)
    proof = phone.proof("GET", "/admin/beta")
    assert client.get(LIST, headers=_hdr(key, proof=proof)).status_code == 200
    r = client.get(LIST, headers=_hdr(key, proof=proof))
    assert r.status_code == 403 and r.json()["detail"] == {"code": "admin_device"}


def test_stale_proof_is_403(key):
    phone = _approved(key)
    old = phone.proof("GET", "/admin/beta", ts=int(time.time()) - 400)
    assert client.get(LIST, headers=_hdr(key, proof=old)).status_code == 403
    future = phone.proof("GET", "/admin/beta", ts=int(time.time()) + 400)
    assert client.get(LIST, headers=_hdr(key, proof=future)).status_code == 403


def test_proof_is_bound_to_method_and_path(key):
    phone = _approved(key)
    # Signed for another route, sent to the list.
    wrong_path = phone.proof("GET", "/admin/device")
    assert client.get(LIST, headers=_hdr(key, proof=wrong_path)).status_code == 403
    # Signed for GET, sent with PUT.
    raw = json.dumps({"owner": OTHER, "enabled": True}).encode()
    wrong_method = phone.proof("GET", "/admin/beta", body=raw)
    r = client.put(
        LIST, content=raw, headers=_hdr(key, proof=wrong_method, **{"Content-Type": "application/json"}),
    )
    assert r.status_code == 403 and not beta.is_enabled(OTHER)


def test_malformed_proofs_are_403(key):
    phone = _approved(key)
    good = phone.proof("GET", "/admin/beta")
    _, kid, _ts, nonce, sig = good.split(".")
    too_long = f"v1.{kid}.{'0' * 13}.{nonce}.{sig}"
    for bad in (
        "", "v1", good.replace("v1.", "v0.", 1), good + ".x", good[:-4] + "0000", "v1.x.y.z.w", too_long,
    ):
        assert client.get(LIST, headers=_hdr(key, proof=bad)).status_code == 403, bad


def test_superscript_ts_is_rejected_not_a_crash():
    # str.isdigit() is True for '²' and int('²') raises: the regex keeps it a plain "".
    assert admin_devices.verify("v1.ab.12².ab.ab", PRINCIPAL, "GET", "/admin/beta", b"") == ""


def test_concurrent_copies_of_one_proof_pass_once():
    phone = _Phone()
    admin_devices.enrol(PRINCIPAL, phone.key_id, phone.public, "Phone")
    admin_devices.approve(phone.key_id)
    threads = 8
    for _ in range(40):
        proof = phone.proof("GET", "/admin/beta")
        gate = threading.Barrier(threads)

        def attempt(_i):
            gate.wait()
            return admin_devices.verify(proof, PRINCIPAL, "GET", "/admin/beta", b"")

        with ThreadPoolExecutor(threads) as pool:
            results = list(pool.map(attempt, range(threads)))
        assert sum(1 for r in results if r) == 1, results


def test_concurrent_verify_and_prune_do_not_raise():
    phone = _Phone()
    admin_devices.enrol(PRINCIPAL, phone.key_id, phone.public, "Phone")
    admin_devices.approve(phone.key_id)
    old = int(time.time()) - 1000
    for i in range(2000):
        admin_devices._seen[f"stale{i}"] = old
    threads = 8
    gate = threading.Barrier(threads)

    def attempt(_i):
        gate.wait()
        return [
            admin_devices.verify(phone.proof("GET", "/admin/beta"), PRINCIPAL, "GET", "/admin/beta", b"")
            for _ in range(20)
        ]

    with ThreadPoolExecutor(threads) as pool:
        results = [r for batch in pool.map(attempt, range(threads)) for r in batch]
    assert all(results) and len(results) == threads * 20


def test_bad_signature_gives_the_nonce_back():
    phone = _Phone()
    admin_devices.enrol(PRINCIPAL, phone.key_id, phone.public, "Phone")
    admin_devices.approve(phone.key_id)
    good = phone.proof("GET", "/admin/beta")
    forged = good[:-4] + ("0000" if not good.endswith("0000") else "1111")
    assert admin_devices.verify(forged, PRINCIPAL, "GET", "/admin/beta", b"") == ""
    assert admin_devices.verify(good, PRINCIPAL, "GET", "/admin/beta", b"") == phone.key_id


def test_pending_keys_are_capped_per_owner(key):
    phones = [_Phone() for _ in range(admin_devices.MAX_PENDING)]
    for phone in phones:
        assert client.post(ENROL, json=phone.body(), headers=_hdr(key)).json() == {"status": "pending"}
    extra = _Phone()
    r = client.post(ENROL, json=extra.body(), headers=_hdr(key))
    assert r.status_code == 429 and r.json()["detail"] == {"code": "admin_pending_cap"}
    assert len(admin_devices.list_all()) == admin_devices.MAX_PENDING
    # Re-sending a key already held still answers its status.
    assert client.post(ENROL, json=phones[0].body(), headers=_hdr(key)).json() == {"status": "pending"}
    # Revoking one frees a slot; another owner has its own cap.
    admin_devices.revoke(phones[0].key_id)
    assert client.post(ENROL, json=extra.body(), headers=_hdr(key)).json() == {"status": "pending"}
    access.ADMIN_USERS = frozenset({PRINCIPAL, OTHER})
    assert client.post(ENROL, json=_Phone().body(), headers=_hdr(key, sub=OTHER_SUB)).json() == {"status": "pending"}


def test_concurrent_enrols_do_not_pass_the_cap():
    phones = [_Phone() for _ in range(8)]
    gate = threading.Barrier(len(phones))

    def attempt(phone):
        gate.wait()
        try:
            return admin_devices.enrol(PRINCIPAL, phone.key_id, phone.public, "Phone")
        except HTTPException as exc:
            return exc.status_code

    with ThreadPoolExecutor(len(phones)) as pool:
        results = list(pool.map(attempt, phones))
    assert results.count("pending") == admin_devices.MAX_PENDING
    assert admin_devices.pending_count(PRINCIPAL) == admin_devices.MAX_PENDING


def _tool():
    spec = importlib.util.spec_from_file_location(
        "admin_device_tool", Path(__file__).resolve().parents[2] / "tools" / "admin-device.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_tool_approve_prints_the_row_and_refuses_two_pending(capsys):
    tool = _tool()
    first, second = _Phone(), _Phone()
    admin_devices.enrol(PRINCIPAL, first.key_id, first.public, "Sean phone")
    assert tool.cmd_approve(argparse.Namespace(key_id=first.key_id, force=False)) == 0
    out = capsys.readouterr().out
    assert first.key_id in out and PRINCIPAL in out and "Sean phone" in out and "created " in out
    assert admin_devices.status(first.key_id) == "approved"

    third = _Phone()
    admin_devices.enrol(PRINCIPAL, second.key_id, second.public, "Phone two")
    admin_devices.enrol(PRINCIPAL, third.key_id, third.public, "Phone three")
    assert tool.cmd_approve(argparse.Namespace(key_id=second.key_id, force=False)) == 1
    assert "2 pending" in capsys.readouterr().err
    assert admin_devices.status(second.key_id) == "pending"
    assert tool.cmd_approve(argparse.Namespace(key_id=second.key_id, force=True)) == 0
    assert admin_devices.status(second.key_id) == "approved"
    assert tool.cmd_approve(argparse.Namespace(key_id="0" * 16, force=False)) == 1


def test_tool_proof_signs_the_body(tmp_path, capsys):
    tool = _tool()
    file = tmp_path / "k.json"
    assert tool.cmd_keygen(argparse.Namespace(file=str(file))) == 0
    k = json.loads(file.read_text())
    admin_devices.enrol(PRINCIPAL, k["key_id"], k["public"], "curl")
    admin_devices.approve(k["key_id"])
    capsys.readouterr()
    raw = '{"owner":"x","enabled":true}'
    assert tool.cmd_proof(argparse.Namespace(file=str(file), method="put", path="/admin/beta", body=raw)) == 0
    proof = capsys.readouterr().out.strip()
    assert admin_devices.verify(proof, PRINCIPAL, "PUT", "/admin/beta", raw.encode()) == k["key_id"]


def test_client_sent_admin_key_header_is_stripped(key):
    phone = _approved(key)
    r = client.get(LIST, headers=_hdr(key, **{"X-Shadow-Admin-Key": phone.key_id}))
    assert r.status_code == 403 and r.json()["detail"] == {"code": "admin_device"}


def test_proof_from_another_owner_is_403(key):
    phone = _approved(key)
    access.ADMIN_USERS = frozenset({PRINCIPAL, OTHER})
    r = client.get(LIST, headers=_hdr(key, sub=OTHER_SUB, proof=phone.proof("GET", "/admin/beta")))
    assert r.status_code == 403 and r.json()["detail"] == {"code": "admin_device"}


def test_not_listed_user_is_not_admin_and_cannot_enrol(key):
    phone = _Phone()
    r = client.post(ENROL, json=phone.body(), headers=_hdr(key, sub=OTHER_SUB))
    assert r.status_code == 403 and r.json()["detail"] == {"code": "not_admin"}
    r = client.get(LIST, headers=_hdr(key, sub=OTHER_SUB, proof=phone.proof("GET", "/admin/beta")))
    assert r.status_code == 403 and r.json()["detail"] == {"code": "not_admin"}
    assert admin_devices.list_all() == []


def test_revoke_closes_the_next_call(key):
    phone = _approved(key)
    assert client.get(LIST, headers=_hdr(key, proof=phone.proof("GET", "/admin/beta"))).status_code == 200
    assert admin_devices.revoke(phone.key_id)
    assert client.get(LIST, headers=_hdr(key, proof=phone.proof("GET", "/admin/beta"))).status_code == 403
    assert client.post(ENROL, json=phone.body(), headers=_hdr(key)).json() == {"status": "revoked"}
    assert admin_devices.approve(phone.key_id)
    assert client.get(LIST, headers=_hdr(key, proof=phone.proof("GET", "/admin/beta"))).status_code == 200


def test_bare_device_principal_needs_no_proof(monkeypatch):
    monkeypatch.setattr(middleware, "REQUIRE_SIGNIN", False)
    r = client.get(LIST, headers={**AUTH, "X-Shadow-Device": DEVICE})
    assert r.status_code == 200
    r = client.get(LIST, headers={**AUTH, "X-Shadow-Device": str(uuid.uuid4())})
    assert r.status_code == 403 and r.json()["detail"] == {"code": "not_admin"}


def test_require_admin_coerces_a_non_str_key():
    access._require_admin(DEVICE, object())
    with pytest.raises(Exception) as exc:
        access._require_admin(PRINCIPAL, object())
    assert exc.value.detail == {"code": "admin_device"}


def test_store_round_trip_in_its_own_file():
    assert admin_devices.DB_PATH.name == "admin_devices.db"
    assert admin_devices.DB_PATH != store.DB_PATH
    phone = _Phone()
    assert admin_devices.enrol(PRINCIPAL, phone.key_id, phone.public, "Phone") == "pending"
    assert admin_devices.status(phone.key_id) == "pending"
    assert admin_devices.approve(phone.key_id) and admin_devices.status(phone.key_id) == "approved"
    row = admin_devices.list_all()[0]
    assert row["approved_at"] and row["last_seen_at"] is None
    assert admin_devices.revoke(phone.key_id) and admin_devices.status(phone.key_id) == "revoked"
    assert not admin_devices.approve("not-a-key") and admin_devices.status("not-a-key") is None


def test_verify_prunes_old_nonces():
    phone = _Phone()
    admin_devices.enrol(PRINCIPAL, phone.key_id, phone.public, "Phone")
    admin_devices.approve(phone.key_id)
    admin_devices._seen["stale"] = int(time.time()) - 1000
    assert admin_devices.verify(phone.proof("GET", "/admin/beta"), PRINCIPAL, "GET", "/admin/beta", b"") == phone.key_id
    assert "stale" not in admin_devices._seen and len(admin_devices._seen) == 1


APPROVE = "/shadow/admin/device/approve"
CODE = "123456"


@pytest.fixture
def passcode(monkeypatch):
    monkeypatch.setattr(config, "ADMIN_PASSCODE", CODE)
    admin_devices._wrong.clear()
    yield
    admin_devices._wrong.clear()


def _pending(key, sub=SUB) -> _Phone:
    phone = _Phone()
    assert client.post(ENROL, json=phone.body(), headers=_hdr(key, sub=sub)).json() == {"status": "pending"}
    return phone


def _approve(key, key_id: str, code: str = CODE, sub=SUB):
    return client.post(APPROVE, json={"key_id": key_id, "passcode": code}, headers=_hdr(key, sub=sub))


def test_passcode_approves_own_pending_key(key, passcode):
    phone = _pending(key)
    r = _approve(key, phone.key_id)
    assert r.status_code == 200 and r.json() == {"status": "approved"}
    assert admin_devices.status(phone.key_id) == "approved"
    # The approved key now opens the list.
    assert client.get(LIST, headers=_hdr(key, proof=phone.proof("GET", "/admin/beta"))).status_code == 200


def test_wrong_passcode_is_403_and_stays_pending(key, passcode):
    phone = _pending(key)
    r = _approve(key, phone.key_id, code="654321")
    assert r.status_code == 403 and r.json()["detail"] == {"code": "bad_passcode"}
    assert admin_devices.status(phone.key_id) == "pending"


def test_passcode_cannot_approve_another_owners_key(key, passcode):
    phone = _pending(key)
    access.ADMIN_USERS = frozenset({PRINCIPAL, OTHER})
    r = _approve(key, phone.key_id, sub=OTHER_SUB)
    assert r.status_code == 404 and r.json()["detail"] == {"code": "admin_key_unknown"}
    assert admin_devices.status(phone.key_id) == "pending"


def test_passcode_never_reapproves_a_revoked_key(key, passcode):
    phone = _pending(key)
    admin_devices.revoke(phone.key_id)
    r = _approve(key, phone.key_id)
    assert r.status_code == 409 and r.json()["detail"] == {"code": "admin_key_not_pending"}
    assert admin_devices.status(phone.key_id) == "revoked"


def test_passcode_route_is_404_when_unset(key, monkeypatch):
    phone = _pending(key)
    for off in ("", None):
        monkeypatch.setattr(config, "ADMIN_PASSCODE", off)
        assert _approve(key, phone.key_id, code="").status_code == 404
        assert _approve(key, phone.key_id).status_code == 404
    assert admin_devices.status(phone.key_id) == "pending"


def test_passcode_wrong_tries_are_capped_per_owner(key, passcode):
    phone = _pending(key)
    for _ in range(admin_devices.PASSCODE_TRIES):
        assert _approve(key, phone.key_id, code="000000").status_code == 403
    # Even the right code is refused once the owner is out of tries.
    r = _approve(key, phone.key_id)
    assert r.status_code == 429 and r.json()["detail"] == {"code": "admin_passcode_tries"}
    assert admin_devices.status(phone.key_id) == "pending"
    # Another owner keeps its own tries.
    access.ADMIN_USERS = frozenset({PRINCIPAL, OTHER})
    other = _pending(key, sub=OTHER_SUB)
    assert _approve(key, other.key_id, sub=OTHER_SUB).json() == {"status": "approved"}
    # The window passes: the first owner may try again.
    admin_devices._wrong[PRINCIPAL] = [t - admin_devices.PASSCODE_WINDOW for t in admin_devices._wrong[PRINCIPAL]]
    assert _approve(key, phone.key_id).json() == {"status": "approved"}


def test_passcode_route_refuses_a_user_not_listed(key, passcode):
    phone = _pending(key)
    access.ADMIN_USERS = frozenset({DEVICE})
    r = _approve(key, phone.key_id)
    assert r.status_code == 403 and r.json()["detail"] == {"code": "not_admin"}
    assert admin_devices.status(phone.key_id) == "pending"
