"""Dev-only chunked video upload: Sean sends long screen recordings from his
phone through the dev server so they can be cut and analysed. Mounted only when
SHADOW_ENV is not "prod" (see `enabled`). The page itself needs no token; every
API call carries the bearer token the user types into the page.
"""

import json
import os
import secrets
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from dev_review import _require_token, _slug, _tour_file, enabled  # noqa: F401

router = APIRouter()

CHUNK_SIZE = 32 * 1024 * 1024
MAX_SIZE = 8 * 1024**3
DISK_MARGIN = 5 * 1024**3


def _root() -> Path:
    return _tour_file().parent


def _uploads() -> Path:
    d = _root() / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _partdir() -> Path:
    d = _uploads() / ".parts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _check_id(upload_id: str) -> str:
    if len(upload_id) != 32 or any(c not in "0123456789abcdef" for c in upload_id):
        raise HTTPException(404, "unknown upload")
    return upload_id


def _meta_path(upload_id: str) -> Path:
    return _partdir() / f"{_check_id(upload_id)}.json"


def _part_path(upload_id: str) -> Path:
    return _partdir() / f"{_check_id(upload_id)}.part"


def _load(upload_id: str) -> dict:
    p = _meta_path(upload_id)
    if not p.exists():
        raise HTTPException(404, "unknown upload")
    return json.loads(p.read_text(encoding="utf-8"))


def _save(upload_id: str, meta: dict) -> None:
    _meta_path(upload_id).write_text(json.dumps(meta), encoding="utf-8")


def _count(size: int) -> int:
    return max(1, -(-size // CHUNK_SIZE))


def _expected_len(meta: dict, index: int) -> int:
    return min(CHUNK_SIZE, meta["size"] - index * CHUNK_SIZE)


class InitBody(BaseModel):
    name: str = Field(max_length=300)
    size: int


@router.post("/shadow/dev/upload/init")
def init(body: InitBody, authorization: str | None = Header(None)):
    _require_token(authorization)
    if body.size <= 0 or body.size > MAX_SIZE:
        raise HTTPException(413, "size out of range")
    if shutil.disk_usage(_uploads()).free < body.size + DISK_MARGIN:
        raise HTTPException(507, "not enough disk space")
    upload_id = secrets.token_hex(16)
    _save(upload_id, {"name": body.name, "size": body.size, "received": []})
    with _part_path(upload_id).open("wb") as f:
        f.truncate(body.size)
    return {"id": upload_id, "chunk_size": CHUNK_SIZE}


@router.put("/shadow/dev/upload/{upload_id}/chunk/{index}")
async def put_chunk(upload_id: str, index: int, request: Request, authorization: str | None = Header(None)):
    _require_token(authorization)
    meta = _load(upload_id)
    if index < 0 or index >= _count(meta["size"]):
        raise HTTPException(400, "bad chunk index")
    data = await request.body()
    if len(data) != _expected_len(meta, index):
        raise HTTPException(400, "bad chunk length")
    with _part_path(upload_id).open("r+b") as f:
        f.seek(index * CHUNK_SIZE)
        f.write(data)
    meta = _load(upload_id)
    if index not in meta["received"]:
        meta["received"].append(index)
        meta["received"].sort()
        _save(upload_id, meta)
    return {"ok": True, "received": len(meta["received"])}


@router.get("/shadow/dev/upload/{upload_id}")
def status(upload_id: str, authorization: str | None = Header(None)):
    _require_token(authorization)
    meta = _load(upload_id)
    return {"received": meta["received"], "size": meta["size"], "chunk_size": CHUNK_SIZE}


@router.post("/shadow/dev/upload/{upload_id}/complete")
def complete(upload_id: str, authorization: str | None = Header(None)):
    _require_token(authorization)
    meta = _load(upload_id)
    if len(meta["received"]) != _count(meta["size"]):
        raise HTTPException(409, "chunks missing")
    stem, dot, ext = meta["name"].rpartition(".")
    if not dot:
        stem, ext = meta["name"], ""
    ext = _slug(ext) if ext and len(ext) <= 8 else ""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"{stamp}-{_slug(stem)}" + (f".{ext}" if ext else "")
    os.replace(_part_path(upload_id), _uploads() / filename)
    _meta_path(upload_id).unlink(missing_ok=True)
    with (_root() / "uploads.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"upload": filename, "size": meta["size"], "ts": int(time.time())}) + "\n")
    return {"ok": True, "upload": filename}


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload video</title>
<style>
body{margin:0;padding:24px;background:#0b0f14;color:#e8eef5;font:16px/1.4 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 16px}
input,button{width:100%;box-sizing:border-box;font:inherit;padding:14px;margin:0 0 12px;border-radius:12px;border:1px solid #2a3340;background:#141b24;color:inherit}
button{background:#3b82f6;border:0;font-weight:600}
button:disabled{opacity:.5}
.bar{height:14px;background:#141b24;border-radius:7px;overflow:hidden;margin:8px 0}
.fill{height:100%;width:0;background:#3b82f6}
#msg{color:#9fb0c3;min-height:1.4em;word-break:break-all}
</style></head><body>
<h1>Upload a video</h1>
<input id="tok" type="password" placeholder="Token" autocomplete="off">
<input id="file" type="file" accept="video/*">
<button id="go">Upload</button>
<div class="bar"><div class="fill" id="fill"></div></div>
<div id="stat"></div>
<div id="msg"></div>
<script>
const $ = (i) => document.getElementById(i);
const base = location.pathname.replace(/\\/$/, "");
$("tok").value = localStorage.getItem("shadowUploadToken") || "";
// The dashboard link carries the token in the fragment (never sent to a server); keep it and clear the URL.
if (location.hash.startsWith("#t=")) {
  const t = decodeURIComponent(location.hash.slice(3));
  localStorage.setItem("shadowUploadToken", t);
  $("tok").value = t;
  history.replaceState(null, "", location.pathname);
}
const mb = (n) => (n / 1048576).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hdr = {};
async function api(path, opt) {
  const r = await fetch(base + path, { ...opt, headers: { ...hdr, ...(opt && opt.headers) } });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()));
  return r.json();
}
async function retry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (/^4\\d\\d/.test(String(e.message)) || i >= 200) throw e;
      $("msg").textContent = "Connection lost, retrying...";
      await sleep(3000);
    }
  }
}
$("go").onclick = async () => {
  const f = $("file").files[0];
  const token = $("tok").value.trim();
  if (!f || !token) { $("msg").textContent = "Pick a file and enter the token."; return; }
  localStorage.setItem("shadowUploadToken", token);
  hdr = { Authorization: "Bearer " + token };
  $("go").disabled = true;
  try {
    const key = "shadowUpload:" + f.name + ":" + f.size + ":" + f.lastModified;
    let id = localStorage.getItem(key), chunk, got = new Set();
    if (id) {
      try { const s = await api("/" + id); got = new Set(s.received); chunk = s.chunk_size; }
      catch (e) { id = null; }
    }
    if (!id) {
      const i = await api("/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name, size: f.size }) });
      id = i.id; chunk = i.chunk_size; localStorage.setItem(key, id);
    }
    const n = Math.max(1, Math.ceil(f.size / chunk));
    let done = 0;
    for (const k of got) done += Math.min(chunk, f.size - k * chunk);
    const show = () => {
      $("fill").style.width = (100 * done / f.size).toFixed(1) + "%";
      $("stat").textContent = mb(done) + " / " + mb(f.size) + " MB (" + Math.floor(100 * done / f.size) + "%)";
    };
    show();
    for (let k = 0; k < n; k++) {
      if (got.has(k)) continue;
      const part = f.slice(k * chunk, Math.min(f.size, (k + 1) * chunk));
      await retry(() => api("/" + id + "/chunk/" + k, { method: "PUT", body: part }));
      done += part.size; show();
    }
    const r = await retry(() => api("/" + id + "/complete", { method: "POST" }));
    localStorage.removeItem(key);
    $("msg").textContent = "Done. Saved as " + r.upload;
  } catch (e) {
    if (e.message.startsWith("401")) {
      localStorage.removeItem("shadowUploadToken");
      $("tok").value = "";
      $("msg").textContent = "Wrong token, cleared. Open this page from the Upload video button on the dev.sean.build dashboard, it fills the token for you.";
    } else {
      $("msg").textContent = "Failed: " + e.message + ". Tap Upload to resume.";
    }
  }
  $("go").disabled = false;
};
</script></body></html>
"""


@router.get("/shadow/dev/upload", response_class=HTMLResponse)
def page():
    return HTMLResponse(PAGE)
