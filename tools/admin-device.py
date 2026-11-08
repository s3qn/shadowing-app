#!/usr/bin/env python3
"""Admin device keys, from the server box. Besides this tool only POST
/shadow/admin/device/approve approves a key, and only the caller's own
pending key with SHADOW_ADMIN_PASSCODE (off while that is empty).

Reads the data dir the backend uses (--data-dir, else SHADOW_DATA_DIR, else
backend/data); pass the prod dir to act on prod, after a backup.

    backend/.venv/bin/python tools/admin-device.py list
    backend/.venv/bin/python tools/admin-device.py approve <key_id> [--force]
    backend/.venv/bin/python tools/admin-device.py revoke <key_id>
    backend/.venv/bin/python tools/admin-device.py beta @handle on     # break-glass beta switch
    backend/.venv/bin/python tools/admin-device.py keygen k.json       # dev: a key file for curl
    backend/.venv/bin/python tools/admin-device.py proof k.json GET /admin/beta
    backend/.venv/bin/python tools/admin-device.py proof k.json PUT /admin/beta '{"owner":"...","enabled":true}'

`list` prints each key with its owner id and @handle, so the main session
can set SHADOW_ADMIN_USERS with Sean's OK. `proof` prints the value for an
`X-Shadow-Proof` header, which curl sends next to the user token.
"""

import argparse
import json
import os
import secrets
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))


def _set_data_dir(arg: str | None) -> None:
    """The backend modules resolve SHADOW_DATA_DIR at import, so it is set
    here before any of them loads."""
    path = arg or os.environ.get("SHADOW_DATA_DIR") or str(BACKEND / "data")
    os.environ["SHADOW_DATA_DIR"] = str(Path(path).expanduser().resolve())


def cmd_list(args) -> int:
    import admin_devices
    import user_profile

    rows = admin_devices.list_all()
    if not rows:
        print("no admin device keys")
        return 0
    handles = user_profile.usernames([r["owner"] for r in rows])
    for r in rows:
        handle = handles.get(r["owner"])
        print(
            f"{r['key_id']}  {r['status']:<8}  {r['owner']}  "
            f"{'@' + handle if handle else '-'}  {r['name'] or '-'}  "
            f"created {r['created_at'][:19]}  seen {(r['last_seen_at'] or '-')[:19]}"
        )
    return 0


def cmd_approve(args) -> int:
    """Prints the whole row first so the full id, owner and time can be
    checked against the phone, not only the 8 hex it shows. Refuses while
    the owner has more than one pending key (someone else may be enrolling
    with that account) unless --force."""
    import admin_devices

    row = admin_devices.get(args.key_id)
    if row is None:
        print(f"no key {args.key_id}", file=sys.stderr)
        return 1
    print(
        f"key {row['key_id']}  owner {row['owner']}  name {row['name'] or '-'}  "
        f"created {row['created_at'][:19]}  status {row['status']}"
    )
    pending = admin_devices.pending_count(row["owner"])
    if pending > 1 and not args.force:
        print(
            f"owner {row['owner']} has {pending} pending keys; check them with `list`,"
            " revoke the ones that are not the phone, or pass --force",
            file=sys.stderr,
        )
        return 1
    admin_devices.approve(args.key_id)
    print(f"approved {args.key_id}")
    return 0


def cmd_revoke(args) -> int:
    import admin_devices

    if not admin_devices.revoke(args.key_id):
        print(f"no key {args.key_id}", file=sys.stderr)
        return 1
    print(f"revoked {args.key_id}")
    return 0


def cmd_beta(args) -> int:
    import beta
    import user_profile

    who = args.who
    owner = who
    if who.startswith("@"):
        row = user_profile.lookup(who[1:])
        if row is None:
            print(f"no user {who}", file=sys.stderr)
            return 1
        owner = row["owner"]
    enabled = args.state == "on"
    beta.set_flag(owner, enabled, "tools")
    print(f"beta {'on' if enabled else 'off'} for {owner}")
    return 0


def cmd_keygen(args) -> int:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import (
        Encoding, NoEncryption, PrivateFormat, PublicFormat,
    )

    import admin_devices

    private = Ed25519PrivateKey.generate()
    secret = private.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()).hex()
    public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
    key = {"secret": secret, "public": public, "key_id": admin_devices.key_id_for(public)}
    Path(args.file).write_text(json.dumps(key, indent=1) + "\n")
    print(f"key_id {key['key_id']} written to {args.file}")
    return 0


def cmd_proof(args) -> int:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    import admin_devices

    key = json.loads(Path(args.file).read_text())
    private = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(key["secret"]))
    ts = str(int(time.time()))
    nonce = secrets.token_hex(16)
    method = args.method.upper()
    # The exact bytes curl sends with --data, or none.
    body = (args.body or "").encode("utf-8")
    sig = private.sign(admin_devices.message(key["key_id"], ts, nonce, method, args.path, body)).hex()
    print(f"{admin_devices.PROOF_VERSION}.{key['key_id']}.{ts}.{nonce}.{sig}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="admin device keys, server side")
    parser.add_argument("--data-dir", help="backend data dir (default SHADOW_DATA_DIR or backend/data)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="every key with owner, @handle and status").set_defaults(fn=cmd_list)
    p = sub.add_parser("approve", help="turn a pending or revoked key on")
    p.add_argument("key_id")
    p.add_argument("--force", action="store_true", help="approve although the owner has several pending keys")
    p.set_defaults(fn=cmd_approve)
    p = sub.add_parser("revoke", help="turn a key off")
    p.add_argument("key_id")
    p.set_defaults(fn=cmd_revoke)
    p = sub.add_parser("beta", help="break-glass beta switch for @handle or owner id")
    p.add_argument("who")
    p.add_argument("state", choices=("on", "off"))
    p.set_defaults(fn=cmd_beta)
    p = sub.add_parser("keygen", help="dev: write a key file")
    p.add_argument("file")
    p.set_defaults(fn=cmd_keygen)
    p = sub.add_parser("proof", help="dev: print an X-Shadow-Proof value for METHOD PATH")
    p.add_argument("file")
    p.add_argument("method")
    p.add_argument("path", help="route path without /shadow, e.g. /admin/beta")
    p.add_argument("body", nargs="?", default="", help="the exact body curl sends with --data, if any")
    p.set_defaults(fn=cmd_proof)
    args = parser.parse_args()
    _set_data_dir(args.data_dir)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
