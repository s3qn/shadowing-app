#!/usr/bin/env python3
"""Finish a TestFlight release with the App Store Connect API (no browser).

Usage:
  asc-testflight.py [--dry-run] status [--build N]
  asc-testflight.py [--dry-run] wait --build N [--timeout 3600]
  asc-testflight.py [--dry-run] add --build N --group Beta
  asc-testflight.py [--dry-run] submit-review --build N
  asc-testflight.py [--dry-run] release --build N --group Beta
  asc-testflight.py [--dry-run] publish --build N   (only after Sean accepts; never part of release)

Auth: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH from the environment, else from
~/.config/kageneko/env (KEY=VALUE lines). Needs PyJWT and cryptography
(system python3 has them; else: python3 -m venv ~/.local/share/asc-venv &&
~/.local/share/asc-venv/bin/pip install pyjwt cryptography). Secrets are never printed.
Exit codes: 0 ok, 1 failure or timeout, 2 missing credentials.
"""
import argparse, json, os, sys, time, urllib.error, urllib.request

APP_ID = "6822075334"  # ascAppId in eas.json
BASE = "https://api.appstoreconnect.apple.com"
ENV_FILE = os.path.expanduser("~/.config/kageneko/env")
NO_KEY = ("No App Store Connect API key. Create one: Users and Access > Integrations > Keys, "
          "role App Manager; save AuthKey_XXXX.p8 to ~/.config/kageneko/asc/ and set "
          "ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH in ~/.config/kageneko/env")
DRY = False
_token = None


def die(msg, code=1):
    print("error: " + msg, file=sys.stderr)
    sys.exit(code)


def load_env():
    vals = {}
    if os.path.exists(ENV_FILE):
        for line in open(ENV_FILE):
            line = line.strip()
            if line.startswith("export "):
                line = line[7:]
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip("'\"")
    return {k: os.environ.get(k) or vals.get(k) for k in ("ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_PATH")}


def token():
    global _token
    if _token and _token[1] > time.time() + 60:
        return _token[0]
    c = load_env()
    if not all(c.values()):
        die(NO_KEY, 2)
    path = os.path.expanduser(c["ASC_KEY_PATH"])
    if not os.path.isfile(path):
        die("ASC_KEY_PATH does not point to a file. " + NO_KEY, 2)
    try:
        import jwt
    except ImportError:
        die("PyJWT/cryptography missing: pip install pyjwt cryptography (in ~/.local/share/asc-venv)", 2)
    exp = int(time.time()) + 15 * 60
    tok = jwt.encode({"iss": c["ASC_ISSUER_ID"], "exp": exp, "aud": "appstoreconnect-v1"},
                     open(path).read(), algorithm="ES256", headers={"kid": c["ASC_KEY_ID"], "typ": "JWT"})
    _token = (tok, exp)
    return tok


def api(method, path, body=None):
    url = path if path.startswith("http") else BASE + path
    if DRY:
        print(f"[dry-run] {method} {url}" + (f" {json.dumps(body)}" if body else ""))
        return None
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            errs = json.loads(e.read()).get("errors", [])
            detail = "; ".join(f"{x.get('title')}: {x.get('detail')}" for x in errs)
        except Exception:
            detail = ""
        die(f"{method} {path} -> HTTP {e.code} {detail}")


def builds():
    q = f"/v1/builds?filter[app]={APP_ID}&sort=-uploadedDate&limit=20&include=preReleaseVersion,betaGroups"
    d = api("GET", q)
    if d is None:
        return []
    inc = {(i["type"], i["id"]): i for i in d.get("included", [])}
    out = []
    for b in d["data"]:
        rel = b["relationships"]
        pv = (rel.get("preReleaseVersion", {}).get("data") or {})
        pvi = inc.get(("preReleaseVersions", pv.get("id")), {})
        groups = [inc[("betaGroups", g["id"])]["attributes"]["name"]
                  for g in rel.get("betaGroups", {}).get("data", []) if ("betaGroups", g["id"]) in inc]
        out.append({"id": b["id"], "build": b["attributes"]["version"],
                    "version": pvi.get("attributes", {}).get("version", "?"),
                    "state": b["attributes"]["processingState"], "groups": groups})
    return out


def review_state(build_id):
    d = api("GET", f"/v1/builds/{build_id}/betaAppReviewSubmission")
    if d is None:
        return "?"
    data = d.get("data")
    return data["attributes"]["betaReviewState"] if data else "NOT_SUBMITTED"


def find(n):
    bs = builds()
    if DRY:
        return {"id": "<BUILD_ID>", "build": str(n), "state": "VALID", "groups": [], "version": "?"}
    for b in bs:
        if b["build"] == str(n):
            return b
    die(f"build {n} not found in the latest 20 builds (not uploaded or still being ingested)")


def cmd_status(a):
    bs = [find(a.build)] if a.build else builds()
    for b in bs:
        print(f"{b['version']} ({b['build']})  processing={b['state']}  review={review_state(b['id'])}  "
              f"groups={','.join(b['groups']) or '-'}")


def cmd_wait(a):
    end = time.time() + a.timeout
    while True:
        if DRY:
            find(a.build)
            return
        try:
            b = find(a.build)
            print(f"build {a.build}: {b['state']}", flush=True)
            if b["state"] == "VALID":
                return
            if b["state"] in ("FAILED", "INVALID"):
                die(f"build {a.build} processing ended as {b['state']}")
        except SystemExit:
            if time.time() > end:
                raise
            print(f"build {a.build}: not listed yet", flush=True)
        if time.time() > end:
            die(f"timed out waiting for build {a.build}")
        time.sleep(30)


def cmd_add(a):
    b = find(a.build)
    gs = api("GET", f"/v1/apps/{APP_ID}/betaGroups?limit=200")
    gid = "<GROUP_ID>"
    if gs is not None:
        m = [g for g in gs["data"] if g["attributes"]["name"] == a.group]
        if not m:
            die(f"beta group '{a.group}' not found; have: {', '.join(g['attributes']['name'] for g in gs['data'])}")
        gid = m[0]["id"]
    if a.group in b["groups"]:
        print(f"build {a.build} already in '{a.group}'")
        return
    api("POST", f"/v1/betaGroups/{gid}/relationships/builds", {"data": [{"type": "builds", "id": b["id"]}]})
    print(f"added build {a.build} to '{a.group}'")


def cmd_submit(a):
    b = find(a.build)
    st = review_state(b["id"])
    if st in ("WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED"):
        print(f"build {a.build} review already {st}")
        return
    api("POST", "/v1/betaAppReviewSubmissions",
        {"data": {"type": "betaAppReviewSubmissions",
                  "relationships": {"build": {"data": {"type": "builds", "id": b["id"]}}}}})
    print(f"submitted build {a.build} for beta review")


def cmd_release(a):
    cmd_wait(a)
    cmd_add(a)
    cmd_submit(a)
    cmd_status(a)


def cmd_publish(a):
    """Tell clients on older builds to update. Writes only the backend data dir file."""
    import subprocess
    tool = os.path.join(os.path.dirname(os.path.abspath(__file__)), "set-latest-build.py")
    cmd = [sys.executable, tool, "--ios", str(a.build)]
    if DRY:
        print("[dry-run] " + " ".join(cmd))
        return
    if subprocess.run(cmd).returncode:
        die("set-latest-build.py failed")


def main():
    global DRY
    p = argparse.ArgumentParser(description="TestFlight release via the App Store Connect API")
    p.add_argument("--dry-run", action="store_true", help="print the HTTP calls without sending")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (("status", cmd_status), ("wait", cmd_wait), ("add", cmd_add),
                     ("submit-review", cmd_submit), ("release", cmd_release),
                     ("publish", cmd_publish)):
        s = sub.add_parser(name)
        s.add_argument("--dry-run", action="store_true")
        s.add_argument("--build", type=int, required=name != "status")
        if name == "wait" or name == "release":
            s.add_argument("--timeout", type=int, default=3600)
        if name in ("add", "release"):
            s.add_argument("--group", default="Beta")
        s.set_defaults(fn=fn)
    a = p.parse_args()
    DRY = a.dry_run or "--dry-run" in sys.argv
    if not hasattr(a, "timeout"):
        a.timeout = 3600
    a.fn(a)


if __name__ == "__main__":
    main()
