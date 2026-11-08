"""support-packs: three consumable ⚡ packs bought through Apple, verified on
the server and paid into the energy grant balance.

A purchase reaches us as the StoreKit 2 JWS the phone holds. We check its
x5c chain offline against Apple's committed root certificates (certs/), its
bundle id and its environment, and grant once per transaction id. No App
Store Server API key and no shared secret are involved. Refunds arrive as
App Store Server Notifications V2 on a public route and take back only what
is left of the pack (Sean, Q2: the balance stops at 0, no debt).

Rows live in purchases.db next to admin_devices.db; islands.db keeps the
grants and gets no schema change. `_decode_transaction`, `_decode_notification`
and `_push` are the seams the tests replace.
"""

import json
import logging
import os
import sqlite3
import threading
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException

import access
import dbconn
import energy
import store_energy
import suggest
import user_profile

log = logging.getLogger("shadow.iap")

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "purchases.db"
CERTS_DIR = Path(__file__).parent / "certs"
CERT_FILES = ("AppleRootCA-G3.cer", "AppleRootCA-G2.cer", "AppleIncRootCertificate.cer")

BUNDLE_ID = "build.sean.echotail"
APP_APPLE_ID = 6822075334

# The same table as src/constants/iap.ts. Amount is ⚡, price in US cents.
PACKS = {
    "build.sean.echotail.energy300": {"amount": 300, "usd_cents": 199},
    "build.sean.echotail.energy1000": {"amount": 1000, "usd_cents": 499},
    "build.sean.echotail.energy2500": {"amount": 2500, "usd_cents": 999},
}
# Apple keeps 15% under the Small Business Program.
NET_SHARE = 0.85

# Dev verifies Sandbox only; prod tries Production first, then Sandbox, since
# TestFlight and App Review purchases are sandbox transactions.
ENV = os.getenv("SHADOW_IAP_ENV") or ("Production" if os.getenv("SHADOW_ENV") == "prod" else "Sandbox")
NTFY_TOPIC_FILE = Path(os.getenv("SHADOW_NTFY_TOPIC_FILE") or Path.home() / ".config/ntfy/sean-topic").expanduser()

SCHEMA = """
CREATE TABLE IF NOT EXISTS purchases (
  transaction_id TEXT PRIMARY KEY,
  original_transaction_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  username TEXT,
  product_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  usd_cents INTEGER NOT NULL,
  environment TEXT NOT NULL,
  purchased_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  refunded_at TEXT,
  refund_units INTEGER NOT NULL DEFAULT 0,
  granted_at TEXT,
  granted_units INTEGER NOT NULL DEFAULT 0,
  event_ms INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS purchases_original ON purchases(original_transaction_id);
CREATE TABLE IF NOT EXISTS notifications (
  uuid TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""

# In prod a Sandbox transaction is a TestFlight or App Review purchase that
# nobody paid for. Admins get every one; anyone else gets this many granted
# per UTC day (so App Review's test purchase still works) and the rest are
# recorded with 0 ⚡ and code sandbox_limit. Sean can change the number.
SANDBOX_DAILY_GRANTS = 1

_local = threading.local()
# Serialises a refund's read-then-grant: Apple retries notifications, and two
# copies of one REFUND must not both take the units back.
_refund_lock = threading.Lock()
# Serialises a purchase's grant-then-mark, so a racing duplicate either
# finishes the grant itself or sees it done, never reports a grant that failed.
_grant_lock = threading.Lock()
_verifier_lock = threading.Lock()
_verifiers: list | None = None
# The last push thread, kept so a test can join it.
_push_thread: threading.Thread | None = None


class BadJws(Exception):
    """The signed data did not verify: chain, signature, bundle, environment."""


class Unavailable(Exception):
    """No verifier: a root certificate file is missing or unreadable."""


def _setup(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def connect() -> sqlite3.Connection:
    return dbconn.thread_conn(
        _local, DB_PATH, "journal_mode = WAL", "busy_timeout = 5000", setup=_setup, mkdir=True,
    )


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
    try:
        _load_verifiers()
    except Unavailable as exc:
        log.warning("iap: %s; /shadow/iap/verify answers 503 until the certs are in place", exc)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _iso_ms(ms: int | None) -> str:
    if not ms:
        return _now()
    return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat(timespec="seconds")


# --- verification ---


def _load_verifiers() -> list:
    """One SignedDataVerifier per environment to try, built once. Raises
    Unavailable when a root certificate is missing: a missing cert must
    never turn into a silent grant."""
    global _verifiers
    with _verifier_lock:
        if _verifiers is not None:
            return _verifiers
        from appstoreserverlibrary.models.Environment import Environment
        from appstoreserverlibrary.signed_data_verifier import SignedDataVerifier

        roots = []
        for name in CERT_FILES:
            path = CERTS_DIR / name
            try:
                roots.append(path.read_bytes())
            except OSError as exc:
                raise Unavailable(f"missing Apple root certificate {path}") from exc
        envs = [Environment.PRODUCTION, Environment.SANDBOX] if ENV == "Production" else [Environment.SANDBOX]
        _verifiers = [
            SignedDataVerifier(roots, False, env, BUNDLE_ID, APP_APPLE_ID) for env in envs
        ]
        return _verifiers


def _try_each(decode) -> object:
    """Runs `decode(verifier)` against each environment's verifier and returns
    the first result; every verifier failing is BadJws."""
    from appstoreserverlibrary.signed_data_verifier import VerificationException

    last: Exception | None = None
    for verifier in _load_verifiers():
        try:
            return decode(verifier)
        except VerificationException as exc:
            last = exc
        except Exception as exc:  # a malformed payload the library did not wrap
            last = exc
    raise BadJws(str(last)) from last


def _tx_dict(tx) -> dict:
    env = tx.environment.value if tx.environment is not None else (tx.rawEnvironment or "")
    return {
        "transactionId": tx.transactionId,
        "originalTransactionId": tx.originalTransactionId or tx.transactionId,
        "productId": tx.productId,
        "purchaseDate": tx.purchaseDate,
        "environment": env,
    }


def _decode_transaction(jws: str) -> dict:
    """The verified fields of a signed transaction. Raises BadJws or
    Unavailable. Tests replace this with a dict-returning fake."""
    if not isinstance(jws, str) or not jws:
        raise BadJws("empty")
    return _tx_dict(_try_each(lambda v: v.verify_and_decode_signed_transaction(jws)))


def _decode_notification(signed_payload: str) -> dict:
    """A verified notification as `{type, subtype, environment, transaction}`,
    the inner signedTransactionInfo decoded by the same verifier (None when
    the notification carries none). Raises BadJws or Unavailable."""
    if not isinstance(signed_payload, str) or not signed_payload:
        raise BadJws("empty")

    def decode(verifier):
        note = verifier.verify_and_decode_notification(signed_payload)
        tx = None
        env = ""
        if note.data is not None:
            env = note.data.environment.value if note.data.environment is not None else (note.data.rawEnvironment or "")
            if note.data.signedTransactionInfo:
                tx = _tx_dict(verifier.verify_and_decode_signed_transaction(note.data.signedTransactionInfo))
        kind = note.notificationType.value if note.notificationType is not None else (note.rawNotificationType or "")
        subtype = note.subtype.value if note.subtype is not None else (note.rawSubtype or None)
        return {
            "type": kind, "subtype": subtype, "environment": env, "transaction": tx,
            "uuid": note.notificationUUID or "", "signed_ms": note.signedDate or 0,
        }

    return _try_each(decode)


# --- purchases ---


def _handle(principal: str) -> str:
    return user_profile.get_username(principal) or ""


def _sandbox_units(conn: sqlite3.Connection, principal: str, amount: int) -> tuple[int, str | None]:
    """What a Sandbox purchase grants in prod: see SANDBOX_DAILY_GRANTS."""
    if ENV != "Production" or access._is_admin(principal):
        return amount, None
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    n = conn.execute(
        "SELECT COUNT(*) FROM purchases WHERE principal=? AND environment='Sandbox'"
        " AND granted_units>0 AND substr(granted_at,1,10)=?",
        (principal, today),
    ).fetchone()[0]
    return (amount, None) if n < SANDBOX_DAILY_GRANTS else (0, "sandbox_limit")


def verify(principal: str, jws: str) -> tuple[int, bool, str | None]:
    """Checks the JWS, records the transaction once and grants its pack.
    Returns (granted, duplicate, code): a transaction id or original id
    already granted grants nothing and reports duplicate; code is
    sandbox_limit when a prod Sandbox purchase was recorded with 0 ⚡. 400
    bad_jws when the signature, chain, bundle or environment fail; 400
    unknown_product for a product outside PACKS; 503 iap_unavailable when the
    certs are missing. The row is written first and marked granted only after
    the grant, so a failed grant re-raises with the row unmarked: the phone
    keeps the transaction unfinished, StoreKit redelivers it, and the retry
    (or a racing duplicate) finishes the grant once, checked by its note."""
    try:
        tx = _decode_transaction(jws)
    except Unavailable:
        raise HTTPException(503, {"code": "iap_unavailable"}) from None
    except BadJws:
        raise HTTPException(400, {"code": "bad_jws"}) from None
    env = tx.get("environment") or ""
    if env not in ("Production", "Sandbox"):
        raise HTTPException(400, {"code": "bad_jws"})
    product = tx.get("productId") or ""
    pack = PACKS.get(product)
    if pack is None:
        raise HTTPException(400, {"code": "unknown_product"})
    txid = str(tx.get("transactionId") or "")
    original = str(tx.get("originalTransactionId") or txid)
    if not txid:
        raise HTTPException(400, {"code": "bad_jws"})
    username = _handle(principal)
    conn = connect()
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO purchases(transaction_id, original_transaction_id, principal,"
            " username, product_id, amount, usd_cents, environment, purchased_at, created_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (
                txid, original, principal, username, product, pack["amount"], pack["usd_cents"],
                env, _iso_ms(tx.get("purchaseDate")), _now(),
            ),
        )
    with _grant_lock:
        row = conn.execute(
            "SELECT * FROM purchases WHERE transaction_id=? OR original_transaction_id=? LIMIT 1",
            (txid, original),
        ).fetchone()
        if row is None or row["granted_at"] is not None or row["principal"] != principal:
            log.info("iap: duplicate transaction %s for %s", txid, principal)
            return 0, True, None
        units, code = int(row["amount"]), None
        if row["environment"] == "Sandbox":
            units, code = _sandbox_units(conn, principal, units)
        note = f"iap:{row['product_id']}:{row['transaction_id']}"
        if units > 0 and not store_energy.energy_grant_noted(principal, note):
            store_energy.energy_add_grant(principal, username, units, note=note, granted_by="appstore")
        with conn:
            conn.execute(
                "UPDATE purchases SET granted_at=?, granted_units=? WHERE transaction_id=?",
                (_now(), units, row["transaction_id"]),
            )
    if code:
        log.info("iap: %s %s for %s recorded with 0 ⚡", code, row["transaction_id"], principal)
        return 0, False, code
    log.info("iap: +%d ⚡ %s to %s (%s)", units, product, principal, env)
    _push_async(_push_text(pack, username, env))
    return units, False, None


def _push_text(pack: dict, username: str, env: str) -> str:
    who = f"@{username}" if username else "no handle"
    text = f"⚡ +{pack['amount']:,} pack, ${pack['usd_cents'] / 100:.2f}, {who}"
    if env == "Sandbox":
        text += " (sandbox)"
    return text


def _push(text: str) -> None:
    """One phone push to Sean through ntfy (the topic notify-sean.sh reads),
    then the Discord webhook when one is set. Pack, price and handle only."""
    try:
        topic = NTFY_TOPIC_FILE.read_text().strip()
    except OSError:
        topic = ""
    if topic:
        try:
            req = urllib.request.Request(
                f"https://ntfy.sh/{topic}",
                data=text.encode("utf-8"),
                headers={"Title": "Energy pack", "Tags": "zap"},
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            log.warning("iap: could not push to ntfy", exc_info=True)
    suggest._relay_to_discord(text, prefix="")


def _push_async(text: str) -> None:
    global _push_thread
    _push_thread = threading.Thread(target=lambda: _push(text), daemon=True)
    _push_thread.start()


# --- notifications ---


def _row_for(tx: dict) -> sqlite3.Row | None:
    conn = connect()
    txid = str(tx.get("transactionId") or "")
    original = str(tx.get("originalTransactionId") or "")
    return conn.execute(
        "SELECT * FROM purchases WHERE transaction_id=? OR original_transaction_id=? LIMIT 1",
        (txid, original or txid),
    ).fetchone()


def handle_notification(signed_payload: str) -> str:
    """Applies one App Store Server Notification V2 and returns its type.
    REFUND takes back min(pack, granted_left) once per transaction;
    REFUND_REVERSED gives those units back. Everything else (TEST,
    CONSUMPTION_REQUEST, ...) is logged. Each notificationUUID is applied
    once (Apple retries until it gets a 200), and a REFUND or
    REFUND_REVERSED signed before the last one applied to its purchase is
    stale and skipped, so a late REFUND cannot take the units again after
    its reversal. Raises BadJws or Unavailable."""
    note = _decode_notification(signed_payload)
    kind = note.get("type") or ""
    tx = note.get("transaction")
    uid = str(note.get("uuid") or "")
    signed_ms = int(note.get("signed_ms") or 0)
    with _refund_lock:
        conn = connect()
        if uid and conn.execute("SELECT 1 FROM notifications WHERE uuid=?", (uid,)).fetchone():
            log.info("iap: notification %s %s already applied", kind, uid)
            return kind
        if kind == "REFUND" and tx:
            _refund(tx, signed_ms)
        elif kind == "REFUND_REVERSED" and tx:
            _refund_reversed(tx, signed_ms)
        else:
            log.info("iap: notification %s%s", kind, f" {note['subtype']}" if note.get("subtype") else "")
        if uid:
            with conn:
                conn.execute(
                    "INSERT OR IGNORE INTO notifications(uuid, type, created_at) VALUES(?,?,?)",
                    (uid, kind, _now()),
                )
    return kind


def _stale(row: sqlite3.Row, signed_ms: int) -> bool:
    return bool(signed_ms) and signed_ms < int(row["event_ms"] or 0)


def _refund(tx: dict, signed_ms: int = 0) -> None:
    """Runs under _refund_lock. Takes back at most what the pack granted."""
    row = _row_for(tx)
    if row is None or row["refunded_at"] is not None or _stale(row, signed_ms):
        why = "unknown" if row is None else "already refunded" if row["refunded_at"] else "stale"
        log.info("iap: refund for %s ignored (%s)", tx.get("transactionId"), why)
        return
    _, left = store_energy.energy_balances(row["principal"], energy.DAILY_UNITS)
    take = min(int(row["granted_units"]), max(0, left))
    if take > 0:
        store_energy.energy_add_grant(
            row["principal"], row["username"] or "", -take,
            note=f"iap-refund:{row['product_id']}:{row['transaction_id']}", granted_by="appstore-refund",
        )
    with connect() as conn:
        conn.execute(
            "UPDATE purchases SET refunded_at=?, refund_units=?, event_ms=MAX(event_ms, ?) WHERE transaction_id=?",
            (_now(), take, signed_ms, row["transaction_id"]),
        )
    log.info("iap: refund %s took back %d of %d ⚡ from %s", row["transaction_id"], take, row["granted_units"], row["principal"])


def _refund_reversed(tx: dict, signed_ms: int = 0) -> None:
    """Runs under _refund_lock. A reversal that arrives before its refund
    still records its time, so the late refund is then stale."""
    row = _row_for(tx)
    if row is None or _stale(row, signed_ms):
        return
    if row["refunded_at"] is None:
        with connect() as conn:
            conn.execute(
                "UPDATE purchases SET event_ms=MAX(event_ms, ?) WHERE transaction_id=?",
                (signed_ms, row["transaction_id"]),
            )
        return
    units = int(row["refund_units"])
    if units > 0:
        store_energy.energy_add_grant(
            row["principal"], row["username"] or "", units,
            note=f"iap-refund-reversed:{row['product_id']}:{row['transaction_id']}", granted_by="appstore",
        )
    with connect() as conn:
        conn.execute(
            "UPDATE purchases SET refunded_at=NULL, refund_units=0, event_ms=MAX(event_ms, ?) WHERE transaction_id=?",
            (signed_ms, row["transaction_id"]),
        )
    log.info("iap: refund reversed on %s, %d ⚡ back to %s", row["transaction_id"], units, row["principal"])


# --- admin ---


def _net(usd_cents: int) -> int:
    return round(usd_cents * NET_SHARE)


def summary() -> dict:
    """The admin card: counts and net cents over production rows that were
    not refunded; sandbox rows are counted apart and never in the money.
    Today and week follow Apple's purchase time in UTC days."""
    conn = connect()
    rows = conn.execute(
        "SELECT product_id, usd_cents, environment, purchased_at FROM purchases WHERE refunded_at IS NULL"
    ).fetchall()
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    week_start = (datetime.now(timezone.utc) - timedelta(days=6)).strftime("%Y-%m-%d")
    out = {"today": 0, "week": 0, "total": 0, "net_cents": 0, "sandbox": 0}
    per = {pid: {"product_id": pid, "amount": p["amount"], "count": 0, "net_cents": 0} for pid, p in PACKS.items()}
    for r in rows:
        if r["environment"] == "Sandbox":
            out["sandbox"] += 1
            continue
        day = r["purchased_at"][:10]
        out["total"] += 1
        out["net_cents"] += _net(r["usd_cents"])
        if day == today:
            out["today"] += 1
        if day >= week_start:
            out["week"] += 1
        pack = per.get(r["product_id"])
        if pack is not None:
            pack["count"] += 1
            pack["net_cents"] += _net(r["usd_cents"])
    out["packs"] = list(per.values())
    return out
