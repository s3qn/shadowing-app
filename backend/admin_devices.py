"""Admin device keys: the Ed25519 public keys of the phones an admin account
may run admin actions from, in their own sqlite file (admin_devices.db).

The phone holds the secret and signs a short proof per admin request; the
server keeps only the public key, so a copy of this file forges nothing.
A key turns `approved` through tools/admin-device.py on the server box, or,
until launch, through POST /shadow/admin/device/approve with the passcode in
SHADOW_ADMIN_PASSCODE (only the owner's own pending key; the route is off
while the variable is empty). islands.db is never touched.
"""

import hashlib
import hmac
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

import dbconn

DATA_DIR = Path(os.getenv("SHADOW_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "admin_devices.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS admin_devices (
  key_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  public_key TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  last_seen_at TEXT
);
"""

PROOF_VERSION = "v1"
# A proof is accepted this many seconds either side of the server clock.
MAX_SKEW = 300
STATUSES = ("pending", "approved", "revoked")

# Pending keys one owner may hold at once: a stolen token cannot flood the
# list or grind a key id whose first 8 hex match the one Sean reads out.
MAX_PENDING = 3

_HEX_RE = re.compile(r"^[0-9a-f]+$")
_TS_RE = re.compile(r"^[0-9]{1,12}$")
_local = threading.local()
# nonce -> the proof's ts. One uvicorn worker, so the process-wide dict is
# the whole replay memory; pruned on every verify. verify runs in worker
# threads (asyncio.to_thread), so every read and write of it holds _seen_lock.
_seen: dict[str, int] = {}
_seen_lock = threading.Lock()
# Serialises enrol's count-then-insert so concurrent calls cannot pass the cap.
_enrol_lock = threading.Lock()

# Passcode approval: wrong tries one owner may make per window before 429.
PASSCODE_TRIES = 5
PASSCODE_WINDOW = 15 * 60
# owner -> the times of its wrong tries inside the window. In memory, like _seen.
_wrong: dict[str, list[float]] = {}
_wrong_lock = threading.Lock()


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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def key_id_for(public_key: str) -> str:
    """The first 16 hex of sha256(public key bytes): a key id nobody can
    squat, since it is derived from the key itself."""
    return hashlib.sha256(bytes.fromhex(public_key)).hexdigest()[:16]


def message(key_id: str, ts: str, nonce: str, method: str, path: str, body: bytes) -> bytes:
    """The bytes a proof signs. `path` is the request path without the
    /shadow prefix (`/admin/beta`); `body` is the raw request body (b"" for
    none), signed as its sha256 hex so a proof cannot carry another body.
    The client builds the same string (src/lib/admin-device.ts proofFor)."""
    body_hash = hashlib.sha256(body).hexdigest()
    return "\n".join(
        (PROOF_VERSION, key_id, ts, nonce, method.upper(), path, body_hash)
    ).encode("utf-8")


def _load_public(public_key: str) -> Ed25519PublicKey:
    return Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key))


def enrol(owner: str, key_id: str, public_key: str, name: str) -> str:
    """Register the phone's key for `owner` and return its status.
    Idempotent for the same owner; a key id already held by another owner
    is 409 admin_key_taken; a key that does not parse, or a key id that is
    not derived from it, is 400 bad_key; a new key while the owner already
    has MAX_PENDING pending is 429 admin_pending_cap."""
    public_key = (public_key or "").strip().lower()
    key_id = (key_id or "").strip().lower()
    if len(public_key) != 64 or not _HEX_RE.match(public_key):
        raise HTTPException(400, {"code": "bad_key"})
    try:
        _load_public(public_key)
    except ValueError:
        raise HTTPException(400, {"code": "bad_key"}) from None
    if key_id != key_id_for(public_key):
        raise HTTPException(400, {"code": "bad_key"})
    conn = connect()
    with _enrol_lock:
        row = conn.execute(
            "SELECT owner, status FROM admin_devices WHERE key_id=?", (key_id,)
        ).fetchone()
        if row is not None:
            if row["owner"] != owner:
                raise HTTPException(409, {"code": "admin_key_taken"})
            return row["status"]
        if pending_count(owner) >= MAX_PENDING:
            raise HTTPException(429, {"code": "admin_pending_cap"})
        with conn:
            conn.execute(
                "INSERT INTO admin_devices(key_id, owner, public_key, name, status, created_at)"
                " VALUES(?,?,?,?,?,?)",
                (key_id, owner, public_key, name or "", "pending", _now()),
            )
    return "pending"


def pending_count(owner: str) -> int:
    return connect().execute(
        "SELECT COUNT(*) FROM admin_devices WHERE owner=? AND status='pending'", (owner,)
    ).fetchone()[0]


def get(key_id: str) -> dict | None:
    """One key's row without the public key, or None."""
    row = connect().execute(
        "SELECT key_id, owner, name, status, created_at, approved_at, last_seen_at"
        " FROM admin_devices WHERE key_id=?",
        (key_id,),
    ).fetchone()
    return None if row is None else dict(row)


def status(key_id: str) -> str | None:
    row = connect().execute(
        "SELECT status FROM admin_devices WHERE key_id=?", (key_id,)
    ).fetchone()
    return None if row is None else row["status"]


def _prune(now: int) -> None:
    """Caller holds _seen_lock."""
    for nonce, ts in [(n, t) for n, t in _seen.items() if now - t > MAX_SKEW]:
        del _seen[nonce]


def verify(proof: str, principal: str, method: str, path: str, body: bytes) -> str:
    """The key id behind a valid proof header, else "". Valid means: five
    parts, ts within MAX_SKEW, the key approved and owned by `principal`,
    a nonce not seen before and a signature over this method, path and body.
    The nonce is reserved under the lock before the signature check, so of
    concurrent copies of one proof at most one passes; a bad signature
    gives the reservation back."""
    parts = (proof or "").split(".")
    if len(parts) != 5 or parts[0] != PROOF_VERSION:
        return ""
    _, key_id, ts_s, nonce, sig_hex = parts
    if not (_TS_RE.match(ts_s) and _HEX_RE.match(key_id) and _HEX_RE.match(nonce) and _HEX_RE.match(sig_hex)):
        return ""
    now = int(time.time())
    ts = int(ts_s)
    if abs(now - ts) > MAX_SKEW:
        return ""
    conn = connect()
    row = conn.execute(
        "SELECT owner, public_key, status FROM admin_devices WHERE key_id=?", (key_id,)
    ).fetchone()
    if row is None or row["status"] != "approved" or row["owner"] != principal:
        return ""
    with _seen_lock:
        _prune(now)
        if nonce in _seen:
            return ""
        _seen[nonce] = ts
    try:
        _load_public(row["public_key"]).verify(
            bytes.fromhex(sig_hex), message(key_id, ts_s, nonce, method, path, body)
        )
    except (ValueError, InvalidSignature):
        with _seen_lock:
            _seen.pop(nonce, None)
        return ""
    with conn:
        conn.execute("UPDATE admin_devices SET last_seen_at=? WHERE key_id=?", (_now(), key_id))
    return key_id


def list_all() -> list[dict]:
    return [
        dict(row)
        for row in connect().execute(
            "SELECT key_id, owner, name, status, created_at, approved_at, last_seen_at"
            " FROM admin_devices ORDER BY created_at"
        )
    ]


def approve(key_id: str) -> bool:
    """Turn a key on. True when the row existed."""
    with connect() as conn:
        cur = conn.execute(
            "UPDATE admin_devices SET status='approved', approved_at=? WHERE key_id=?",
            (_now(), key_id),
        )
    return cur.rowcount > 0


def approve_with_passcode(owner: str, key_id: str, passcode: str, expected: str) -> str:
    """Approve `owner`'s own pending key when `passcode` matches `expected`
    and return the new status. 429 admin_passcode_tries after PASSCODE_TRIES
    wrong codes in PASSCODE_WINDOW, 403 bad_passcode for a wrong code, 404
    admin_key_unknown for a key that is missing or another owner's, 409
    admin_key_not_pending for a key already approved or revoked (a revoked
    key stays revoked). The code is checked before the key, so every guess
    costs a try whatever key id it names."""
    now = time.monotonic()
    with _wrong_lock:
        tries = [t for t in _wrong.get(owner, []) if now - t < PASSCODE_WINDOW]
        _wrong[owner] = tries
        if len(tries) >= PASSCODE_TRIES:
            raise HTTPException(429, {"code": "admin_passcode_tries"})
        if not hmac.compare_digest((passcode or "").strip().encode(), expected.encode()):
            tries.append(now)
            raise HTTPException(403, {"code": "bad_passcode"})
    key_id = (key_id or "").strip().lower()
    with connect() as conn:
        row = conn.execute(
            "SELECT owner FROM admin_devices WHERE key_id=?", (key_id,)
        ).fetchone()
        if row is None or row["owner"] != owner:
            raise HTTPException(404, {"code": "admin_key_unknown"})
        cur = conn.execute(
            "UPDATE admin_devices SET status='approved', approved_at=?"
            " WHERE key_id=? AND owner=? AND status='pending'",
            (_now(), key_id, owner),
        )
    if cur.rowcount == 0:
        raise HTTPException(409, {"code": "admin_key_not_pending"})
    return "approved"


def revoke(key_id: str) -> bool:
    """Turn a key off; the script can approve it again later. True when the
    row existed."""
    with connect() as conn:
        cur = conn.execute(
            "UPDATE admin_devices SET status='revoked' WHERE key_id=?", (key_id,)
        )
    return cur.rowcount > 0
