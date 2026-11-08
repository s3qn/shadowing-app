"""support-packs: the verify route grants once per transaction, refunds take
back only what is left, the admin card counts sandbox apart, the notification
hook is public and 401 on garbage, the push carries pack, price and handle
only, and the real verifier with the committed Apple roots rejects junk.

Apple's signed data is faked at `iap._decode_transaction` and
`iap._decode_notification`; two tests at the end run the real verifier."""

import asyncio
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import access
import admin_devices
import config
import dependencies
import energy
import iap
import main
import middleware
import store
import store_energy
import user_profile
from routers import iap as iap_r

from test_accounts import _token, key  # noqa: F401  (key is a fixture)
from test_admin_device import _Phone

AUTH = f"Bearer {config.SHADOW_TOKEN}"
HDR = {"Authorization": AUTH}
P300 = "build.sean.echotail.energy300"
P1000 = "build.sean.echotail.energy1000"
VERIFY = "/shadow/iap/verify"
NOTIFY = "/shadow/iap/notifications"
ADMIN = "/shadow/admin/purchases"

client = TestClient(main.app)


@pytest.fixture(autouse=True)
def _dbs(monkeypatch, tmp_path):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "DB_PATH", tmp_path / "islands.db")
    monkeypatch.setattr(iap, "DB_PATH", tmp_path / "purchases.db")
    monkeypatch.setattr(iap, "_push_thread", None)
    monkeypatch.setattr(dependencies, "OWNER_DEVICE", "")
    monkeypatch.setattr(dependencies, "OWNER_ALIASES", frozenset())
    store.init()
    user_profile.init()
    iap.init()


@pytest.fixture
def pushes(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(iap, "_push", seen.append)
    return seen


@pytest.fixture
def fake(monkeypatch):
    """Signed payloads become plain dicts: `fake.tx(...)` returns a token the
    fake decoder maps to that transaction; `fake.note(...)` the same for a
    notification."""
    txs: dict[str, dict] = {}
    notes: dict[str, dict] = {}

    class Fake:
        def tx(self, product=P300, txid=None, original=None, env="Sandbox", when=None) -> str:
            txid = txid or f"tx{uuid.uuid4().hex[:10]}"
            token = f"jws-{txid}-{uuid.uuid4().hex[:4]}"
            txs[token] = {
                "transactionId": txid,
                "originalTransactionId": original or txid,
                "productId": product,
                "purchaseDate": int((when if when is not None else time.time()) * 1000),
                "environment": env,
            }
            return token

        def note(self, kind: str, token: str | None, env="Sandbox", subtype=None,
                 uid: str | None = None, signed_ms: int | None = None) -> str:
            payload = f"note-{uuid.uuid4().hex[:8]}"
            notes[payload] = {
                "type": kind, "subtype": subtype, "environment": env,
                "transaction": txs[token] if token else None,
                "uuid": uid if uid is not None else str(uuid.uuid4()),
                "signed_ms": signed_ms if signed_ms is not None else int(time.time() * 1000),
            }
            return payload

    def decode_tx(jws):
        if jws not in txs:
            raise iap.BadJws("fake")
        return dict(txs[jws])

    def decode_note(signed):
        if signed not in notes:
            raise iap.BadJws("fake")
        return dict(notes[signed])

    monkeypatch.setattr(iap, "_decode_transaction", decode_tx)
    monkeypatch.setattr(iap, "_decode_notification", decode_note)
    return Fake()


def _dev() -> str:
    return f"user_{uuid.uuid4().hex}"


def _verify(dev: str, jws: str):
    return asyncio.run(iap_r.iap_verify(iap_r.VerifyBody(jws=jws), authorization=AUTH, x_shadow_device=dev))


def _left(dev: str) -> int:
    return store_energy.energy_balances(dev, energy.DAILY_UNITS)[1]


def _join_push():
    if iap._push_thread is not None:
        iap._push_thread.join(timeout=5)


def _spend_from_grant(dev: str, units: int) -> None:
    code, _, _ = store_energy.energy_spend(dev, "create", units, 0, 10**9, 10**9)
    assert code == "ok"


# --- verify ---


def test_grant_once_per_transaction_and_original(fake, pushes):
    dev = _dev()
    jws = fake.tx(P300, txid="t1")
    out = _verify(dev, jws)
    assert out["granted"] == 300 and out["duplicate"] is False
    assert out["energy"]["granted_left"] == 300
    assert _left(dev) == 300
    # The same transaction again: nothing more.
    again = _verify(dev, jws)
    assert again["granted"] == 0 and again["duplicate"] is True
    assert _left(dev) == 300
    # A new transaction id under the same original id is the same purchase.
    other = fake.tx(P300, txid="t1b", original="t1")
    out = _verify(dev, other)
    assert out["granted"] == 0 and out["duplicate"] is True
    assert _left(dev) == 300
    # The row keeps what the admin card needs and nothing about the device beyond the principal.
    row = iap.connect().execute("SELECT * FROM purchases").fetchone()
    assert row["principal"] == dev and row["amount"] == 300 and row["usd_cents"] == 199
    assert row["environment"] == "Sandbox" and row["refunded_at"] is None


def test_another_principal_cannot_claim_the_same_jws(fake, pushes):
    a, b = _dev(), _dev()
    jws = fake.tx(P1000)
    assert _verify(a, jws)["granted"] == 1000
    out = _verify(b, jws)
    assert out["granted"] == 0 and out["duplicate"] is True
    assert _left(b) == 0


def test_unknown_product_is_400(fake, pushes):
    with pytest.raises(HTTPException) as exc:
        _verify(_dev(), fake.tx("build.sean.echotail.energy9"))
    assert exc.value.status_code == 400 and exc.value.detail == {"code": "unknown_product"}
    assert iap.connect().execute("SELECT COUNT(*) FROM purchases").fetchone()[0] == 0


def test_bad_jws_is_400(fake, pushes):
    with pytest.raises(HTTPException) as exc:
        _verify(_dev(), "not-a-jws")
    assert exc.value.status_code == 400 and exc.value.detail == {"code": "bad_jws"}


def test_xcode_environment_is_refused(fake, pushes):
    with pytest.raises(HTTPException) as exc:
        _verify(_dev(), fake.tx(P300, env="Xcode"))
    assert exc.value.detail == {"code": "bad_jws"}


def test_missing_certs_is_503(monkeypatch, pushes):
    def unavailable(_jws):
        raise iap.Unavailable("no certs")

    monkeypatch.setattr(iap, "_decode_transaction", unavailable)
    with pytest.raises(HTTPException) as exc:
        _verify(_dev(), "x")
    assert exc.value.status_code == 503 and exc.value.detail == {"code": "iap_unavailable"}


def _granted_at(txid: str):
    return iap.connect().execute(
        "SELECT granted_at FROM purchases WHERE transaction_id=?", (txid,)).fetchone()["granted_at"]


def test_failed_grant_leaves_the_row_unmarked_and_the_retry_grants_once(fake, pushes, monkeypatch):
    real = store_energy.energy_add_grant

    def boom(*a, **k):
        raise RuntimeError("db locked")

    monkeypatch.setattr(store_energy, "energy_add_grant", boom)
    dev = _dev()
    jws = fake.tx(P300, txid="f1")
    with pytest.raises(RuntimeError):
        _verify(dev, jws)
    assert _granted_at("f1") is None and _left(dev) == 0
    # StoreKit redelivers the unfinished transaction: now it grants, once.
    monkeypatch.setattr(store_energy, "energy_add_grant", real)
    assert _verify(dev, jws)["granted"] == 300
    assert _granted_at("f1") and _left(dev) == 300
    assert _verify(dev, jws)["duplicate"] is True and _left(dev) == 300


def test_crash_after_grant_before_mark_is_not_paid_twice(fake, pushes):
    dev = _dev()
    jws = fake.tx(P300, txid="c1")
    # The row and the grant landed, the process died before marking the row.
    with iap.connect() as conn:
        conn.execute(
            "INSERT INTO purchases(transaction_id, original_transaction_id, principal, username,"
            " product_id, amount, usd_cents, environment, purchased_at, created_at)"
            " VALUES('c1','c1',?,'',?,300,199,'Sandbox','x','x')", (dev, P300))
    store_energy.energy_add_grant(dev, "", 300, note=f"iap:{P300}:c1", granted_by="appstore")
    out = _verify(dev, jws)
    assert out["granted"] == 300 and out["duplicate"] is False
    assert _granted_at("c1") and _left(dev) == 300


def test_racing_duplicate_finishes_only_with_a_real_grant(fake, pushes, monkeypatch):
    # The first copy's grant fails while a second copy waits on the lock:
    # the second does the grant itself and reports it, the first raises.
    real = store_energy.energy_add_grant
    calls = []
    gate = threading.Event()

    def flaky(*a, **k):
        calls.append(1)
        if len(calls) == 1:
            gate.wait(timeout=5)
            raise RuntimeError("db locked")
        return real(*a, **k)

    monkeypatch.setattr(store_energy, "energy_add_grant", flaky)
    dev = _dev()
    jws = fake.tx(P300, txid="d1")
    results: dict[str, object] = {}

    def run(name):
        try:
            results[name] = iap.verify(dev, jws)
        except RuntimeError as exc:
            results[name] = exc

    first = threading.Thread(target=run, args=("first",))
    first.start()
    while not calls:
        time.sleep(0.01)
    second = threading.Thread(target=run, args=("second",))
    second.start()
    time.sleep(0.05)
    gate.set()
    first.join()
    second.join()
    assert isinstance(results["first"], RuntimeError)
    assert results["second"] == (300, False, None)
    assert _left(dev) == 300 and len(calls) == 2


def _prod_sandbox(monkeypatch):
    monkeypatch.setattr(iap, "ENV", "Production")


def test_prod_sandbox_grants_one_a_day_to_a_non_admin(fake, pushes, monkeypatch):
    _prod_sandbox(monkeypatch)
    dev = _dev()
    assert _verify(dev, fake.tx(P300))["granted"] == 300
    out = _verify(dev, fake.tx(P1000, txid="s2"))
    assert out["granted"] == 0 and out["duplicate"] is False and out["code"] == "sandbox_limit"
    assert _left(dev) == 300
    row = iap.connect().execute("SELECT granted_at, granted_units FROM purchases WHERE transaction_id='s2'").fetchone()
    assert row["granted_at"] and row["granted_units"] == 0
    # Recorded once: the same JWS again is a plain duplicate, never a late grant.
    assert _verify(dev, fake.tx(P1000, txid="s2b", original="s2"))["duplicate"] is True
    # Another account still gets its one; Production purchases are never capped.
    assert _verify(_dev(), fake.tx(P300))["granted"] == 300
    assert _verify(dev, fake.tx(P300, env="Production"))["granted"] == 300
    # Yesterday's sandbox grant does not count against today.
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(timespec="seconds")
    with iap.connect() as conn:
        conn.execute("UPDATE purchases SET granted_at=? WHERE principal=?", (yesterday, dev))
    assert _verify(dev, fake.tx(P300))["granted"] == 300
    # Sandbox stays out of the money.
    s = iap.summary()
    assert s["net_cents"] == iap._net(199) and s["sandbox"] == 4


def test_prod_sandbox_is_unlimited_for_admins(fake, pushes, monkeypatch):
    _prod_sandbox(monkeypatch)
    admin = _dev()
    monkeypatch.setattr(access, "ADMIN_USERS", frozenset({admin}))
    for _ in range(3):
        assert _verify(admin, fake.tx(P300))["granted"] == 300
    assert _left(admin) == 900


def test_refund_of_a_zero_sandbox_grant_takes_nothing(fake, pushes, monkeypatch):
    _prod_sandbox(monkeypatch)
    dev = _dev()
    _verify(dev, fake.tx(P300))
    capped = fake.tx(P300)
    _verify(dev, capped)
    _notify(fake.note("REFUND", capped))
    assert _left(dev) == 300


def test_verify_route_through_http(fake, pushes):
    dev = str(uuid.uuid4())  # a raw device id: DeviceGuard refuses a user_ principal in the header
    r = client.post(VERIFY, json={"jws": fake.tx(P300)}, headers={**HDR, "X-Shadow-Device": dev})
    assert r.status_code == 200 and r.json()["granted"] == 300
    r = client.post(VERIFY, json={"jws": "x"}, headers={**HDR, "X-Shadow-Device": dev})
    assert r.status_code == 400 and r.json()["detail"] == {"code": "bad_jws"}
    assert client.post(VERIFY, json={"jws": "x"}).status_code == 401


# --- push ---


def test_push_text_carries_pack_price_and_handle_only(fake, pushes):
    dev = _dev()
    user_profile.set_username(dev, f"cat_{uuid.uuid4().hex[:6]}")
    handle = user_profile.get_username(dev)
    _verify(dev, fake.tx(P1000, env="Sandbox"))
    _join_push()
    assert pushes == [f"⚡ +1,000 pack, $4.99, @{handle} (sandbox)"]
    other = _dev()
    _verify(other, fake.tx(P300, env="Production"))
    _join_push()
    assert pushes[-1] == "⚡ +300 pack, $1.99, no handle"
    assert other not in pushes[-1]


def test_real_push_posts_to_ntfy_topic_and_discord(monkeypatch, tmp_path):
    topic = tmp_path / "topic"
    topic.write_text("secret-topic\n")
    monkeypatch.setattr(iap, "NTFY_TOPIC_FILE", topic)
    monkeypatch.setenv("SHADOW_DISCORD_WEBHOOK", "https://discord.test/hook")
    calls = []

    def fake_open(req, timeout=None):
        calls.append((req.full_url, dict(req.header_items()), req.data, timeout))

        class R:
            def read(self):
                return b""
        return R()

    monkeypatch.setattr(iap.urllib.request, "urlopen", fake_open)
    import suggest
    monkeypatch.setattr(suggest.urllib.request, "urlopen", fake_open)
    iap._push("⚡ +300 pack, $1.99, no handle")
    assert calls[0][0] == "https://ntfy.sh/secret-topic"
    assert calls[0][1]["Title"] == "Energy pack" and calls[0][1]["Tags"] == "zap" and calls[0][3] == 5
    assert calls[0][2] == "⚡ +300 pack, $1.99, no handle".encode()
    assert calls[1][0] == "https://discord.test/hook"
    assert b"\\u26a1 +300 pack, $1.99, no handle" in calls[1][2] or "⚡ +300 pack".encode() in calls[1][2]


def test_push_without_topic_file_is_quiet(monkeypatch, tmp_path):
    monkeypatch.setattr(iap, "NTFY_TOPIC_FILE", tmp_path / "missing")
    monkeypatch.delenv("SHADOW_DISCORD_WEBHOOK", raising=False)
    called = []
    monkeypatch.setattr(iap.urllib.request, "urlopen", lambda *a, **k: called.append(a))
    iap._push("x")
    assert called == []


# --- refunds ---


def _notify(payload: str):
    return client.post(NOTIFY, json={"signedPayload": payload})


def test_refund_takes_back_only_what_is_left(fake, pushes):
    dev = _dev()
    jws = fake.tx(P300, txid="r1")
    _verify(dev, jws)
    _spend_from_grant(dev, 120)
    assert _left(dev) == 180
    r = _notify(fake.note("REFUND", jws))
    assert r.status_code == 200 and r.json() == {"ok": True, "type": "REFUND"}
    assert _left(dev) == 0
    row = iap.connect().execute("SELECT refunded_at, refund_units FROM purchases WHERE transaction_id='r1'").fetchone()
    assert row["refunded_at"] and row["refund_units"] == 180
    # Ledger rows net to zero, never below: no debt against the next pack.
    assert _verify(dev, fake.tx(P300, txid="r2"))["granted"] == 300
    assert _left(dev) == 300
    # A second REFUND for the same transaction is a no-op.
    assert _notify(fake.note("REFUND", jws)).status_code == 200
    assert _left(dev) == 300


def test_refund_of_a_fully_spent_pack_takes_nothing(fake, pushes):
    dev = _dev()
    jws = fake.tx(P300)
    _verify(dev, jws)
    _spend_from_grant(dev, 300)
    _notify(fake.note("REFUND", jws))
    assert _left(dev) == 0
    row = iap.connect().execute("SELECT refund_units, refunded_at FROM purchases").fetchone()
    assert row["refund_units"] == 0 and row["refunded_at"]


def test_refund_reversed_regrants_the_taken_units(fake, pushes):
    dev = _dev()
    jws = fake.tx(P1000)
    _verify(dev, jws)
    _spend_from_grant(dev, 400)
    _notify(fake.note("REFUND", jws))
    assert _left(dev) == 0
    _notify(fake.note("REFUND_REVERSED", jws))
    assert _left(dev) == 600
    row = iap.connect().execute("SELECT refund_units, refunded_at FROM purchases").fetchone()
    assert row["refund_units"] == 0 and row["refunded_at"] is None
    # Reversing twice does nothing more.
    _notify(fake.note("REFUND_REVERSED", jws))
    assert _left(dev) == 600


def test_refund_retried_after_its_reversal_takes_nothing(fake, pushes):
    dev = _dev()
    jws = fake.tx(P300)
    _verify(dev, jws)
    refund = fake.note("REFUND", jws, uid="u-refund", signed_ms=1000)
    _notify(refund)
    assert _left(dev) == 0
    _notify(fake.note("REFUND_REVERSED", jws, signed_ms=2000))
    assert _left(dev) == 300
    # Apple redelivers the same REFUND (same notificationUUID): applied once.
    assert _notify(refund).status_code == 200
    assert _left(dev) == 300
    # A copy under another UUID but signed before the reversal is stale.
    _notify(fake.note("REFUND", jws, signed_ms=1500))
    assert _left(dev) == 300
    # A genuine second refund, signed later, still takes the units back.
    _notify(fake.note("REFUND", jws, signed_ms=3000))
    assert _left(dev) == 0


def test_refund_arriving_after_its_reversal_is_ignored(fake, pushes):
    dev = _dev()
    jws = fake.tx(P300)
    _verify(dev, jws)
    _notify(fake.note("REFUND_REVERSED", jws, signed_ms=2000))
    _notify(fake.note("REFUND", jws, signed_ms=1000))
    assert _left(dev) == 300
    row = iap.connect().execute("SELECT refunded_at FROM purchases").fetchone()
    assert row["refunded_at"] is None


def test_refund_for_an_unknown_transaction_is_ignored(fake, pushes):
    dev = _dev()
    _verify(dev, fake.tx(P300))
    stranger = fake.tx(P300)  # never verified here
    assert _notify(fake.note("REFUND", stranger)).status_code == 200
    assert _left(dev) == 300


def test_other_notification_types_are_logged_and_200(fake, pushes):
    assert _notify(fake.note("TEST", None)).json() == {"ok": True, "type": "TEST"}
    assert _notify(fake.note("CONSUMPTION_REQUEST", fake.tx(P300))).status_code == 200


def test_refund_concurrent_copies_take_once(fake, pushes):
    dev = _dev()
    jws = fake.tx(P300)
    _verify(dev, jws)
    note = fake.note("REFUND", jws)
    threads = [threading.Thread(target=lambda: iap.handle_notification(note)) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert _left(dev) == 0
    grants = store.connect().execute(
        "SELECT COUNT(*) FROM energy_grants WHERE target_device=? AND amount<0", (dev,)
    ).fetchone()[0]
    assert grants == 1


# --- notifications route ---


def test_notifications_route_is_public_and_401_on_garbage():
    r = client.post(NOTIFY, json={"signedPayload": "x"})
    assert r.status_code == 401 and r.json()["detail"] == {"code": "bad_jws"}
    assert client.post(NOTIFY, content=b"not json").status_code == 401
    assert client.post(NOTIFY, json={"other": 1}).status_code == 401
    big = client.post(NOTIFY, content=b"x" * (iap_r.NOTIFICATION_BODY_MAX + 1), headers={"Content-Type": "application/json"})
    assert big.status_code == 413


# --- admin ---


def test_summary_counts_sandbox_apart_and_skips_refunds(fake, pushes):
    dev = _dev()
    _verify(dev, fake.tx(P300, env="Production"))
    _verify(dev, fake.tx(P1000, env="Production"))
    refunded = fake.tx(P1000, env="Production")
    _verify(dev, refunded)
    _notify(fake.note("REFUND", refunded, env="Production"))
    _verify(dev, fake.tx(P300, env="Sandbox"))
    old = fake.tx(P300, env="Production", when=time.time() - 10 * 86400)
    _verify(dev, old)
    s = iap.summary()
    assert s["today"] == 2 and s["week"] == 2 and s["total"] == 3 and s["sandbox"] == 1
    assert s["net_cents"] == round(199 * 0.85) * 2 + round(499 * 0.85)
    by = {p["product_id"]: p for p in s["packs"]}
    assert set(by) == set(iap.PACKS)
    assert by[P300] == {"product_id": P300, "amount": 300, "count": 2, "net_cents": round(199 * 0.85) * 2}
    assert by[P1000]["count"] == 1 and by["build.sean.echotail.energy2500"]["count"] == 0


def test_summary_on_nothing_is_zeros():
    s = iap.summary()
    assert s["today"] == s["week"] == s["total"] == s["net_cents"] == s["sandbox"] == 0
    assert [p["count"] for p in s["packs"]] == [0, 0, 0]


SUB = "11111111-2222-4333-8444-555555555555"
OTHER_SUB = "66666666-7777-4888-8999-000000000000"
DEVICE = "00000000-0000-4000-8000-0000000000ad"


@pytest.fixture
def signed_in(monkeypatch):
    import accounts
    principal = accounts.principal(SUB)
    monkeypatch.setattr(middleware, "REQUIRE_SIGNIN", True)
    monkeypatch.setattr(access, "ADMIN_USERS", frozenset({principal}))
    admin_devices.init()
    with admin_devices.connect() as conn:
        conn.execute("DELETE FROM admin_devices")
    admin_devices._seen.clear()
    return principal


def _user_hdr(key, sub=SUB, proof=None):
    h = {**HDR, "X-Shadow-User": _token(key, sub=sub)}
    if proof:
        h["X-Shadow-Proof"] = proof
    return h


def test_admin_purchases_403_for_non_admin_and_for_admin_without_phone(key, signed_in):
    r = client.get(ADMIN, headers=_user_hdr(key, sub=OTHER_SUB))
    assert r.status_code == 403 and r.json()["detail"] == {"code": "not_admin"}
    r = client.get(ADMIN, headers=_user_hdr(key))
    assert r.status_code == 403 and r.json()["detail"] == {"code": "admin_device"}


def test_admin_purchases_opens_with_an_approved_phone(key, signed_in):
    phone = _Phone()
    admin_devices.enrol(signed_in, phone.key_id, phone.public, "Phone")
    admin_devices.approve(phone.key_id)
    r = client.get(ADMIN, headers=_user_hdr(key, proof=phone.proof("GET", "/admin/purchases")))
    assert r.status_code == 200
    assert r.json()["total"] == 0 and len(r.json()["packs"]) == 3


def test_admin_purchases_owner_device_without_signin(monkeypatch):
    monkeypatch.setattr(middleware, "REQUIRE_SIGNIN", False)
    monkeypatch.setattr(dependencies, "OWNER_DEVICE", DEVICE)
    r = client.get(ADMIN, headers={**HDR, "X-Shadow-Device": DEVICE})
    assert r.status_code == 200 and r.json()["sandbox"] == 0
    stranger = "00000000-0000-4000-8000-0000000000ae"
    assert client.get(ADMIN, headers={**HDR, "X-Shadow-Device": stranger}).status_code == 403


# --- the real verifier ---


def test_real_verifier_rejects_garbage_jws(pushes):
    verifiers = iap._load_verifiers()
    assert len(verifiers) >= 1
    with pytest.raises(HTTPException) as exc:
        _verify(_dev(), "eyJhbGciOiJFUzI1NiJ9.e30.c2ln")
    assert exc.value.status_code == 400 and exc.value.detail == {"code": "bad_jws"}
    with pytest.raises(HTTPException) as exc:
        _verify(_dev(), "x")
    assert exc.value.detail == {"code": "bad_jws"}


def test_real_verifier_rejects_garbage_notification():
    r = client.post(NOTIFY, json={"signedPayload": "eyJhbGciOiJFUzI1NiJ9.e30.c2ln"})
    assert r.status_code == 401


def test_committed_root_certs_parse():
    from cryptography import x509

    for name in iap.CERT_FILES:
        cert = x509.load_der_x509_certificate((iap.CERTS_DIR / name).read_bytes())
        assert "Apple" in cert.subject.rfc4514_string()


def test_missing_cert_file_is_unavailable(monkeypatch, tmp_path):
    monkeypatch.setattr(iap, "_verifiers", None)
    monkeypatch.setattr(iap, "CERTS_DIR", tmp_path)
    with pytest.raises(HTTPException) as exc:
        _verify(_dev(), "x")
    assert exc.value.status_code == 503
    monkeypatch.undo()
    iap._verifiers = None
