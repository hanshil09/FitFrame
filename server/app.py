"""FastAPI server: receives manual pages, runs extraction, serves the web app.
Run: .venv/bin/python server/app.py  (listens on 0.0.0.0:8765 so a phone on the same Wi-Fi can reach it)."""
import hashlib
import json
import os
import ssl
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import certifi  # noqa: E402
from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

import pipeline  # noqa: E402
from providers import make_provider  # noqa: E402
from kits import router as kits_router  # noqa: E402

JOBS_DIR = ROOT / "server" / "jobs"
CACHE_DIR = JOBS_DIR / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
VOTES = int(os.environ.get("VOTES", "1"))   # 3 doubles accuracy checks but triples calls; free tier is 20 calls/day/model

app = FastAPI(title="Scan-to-3D assembly")
jobs: dict[str, dict] = {}


@app.middleware("http")
async def no_stale_app(request, call_next):
    # Always revalidate app files so a phone never runs an old main.js after an update
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _run_job(job_id: str, files: list[tuple[str, bytes]], digest: str):
    job = jobs[job_id]
    jdir = JOBS_DIR / job_id

    def log(msg):
        job["log"].append({"t": round(time.time() - job["started"], 1), "msg": msg})

    try:
        cached = CACHE_DIR / f"{digest}.json"
        if cached.exists():
            log("Same manual scanned before; using the cached plan")
            plan = json.loads(cached.read_text())
            pages = pipeline.prepare_pages(files)
        else:
            provider = make_provider()
            log(f"Model: {provider.name} / {provider.model}")
            plan, pages = pipeline.run(provider, files, log, votes=VOTES)
            plan["usage"] = {"provider": provider.name, "model": provider.model, "calls": provider.calls,
                             "tokens_in": provider.tokens_in, "tokens_out": provider.tokens_out}
            log(f"{provider.calls} model calls, {provider.tokens_in} tokens in, {provider.tokens_out} out")
            cached.write_text(json.dumps(plan, indent=2))
        for i, png in enumerate(pages):
            (jdir / f"page-{i + 1}.png").write_bytes(png)
        (jdir / "plan.json").write_text(json.dumps(plan, indent=2))
        job["plan"] = plan
        job["status"] = "done"
    except Exception as e:  # report the failure to the client instead of hanging
        traceback.print_exc()
        job["status"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"


@app.post("/api/jobs")
async def create_job(files: list[UploadFile] = File(...), fresh: bool = False):
    payload = [(f.filename or "page", await f.read()) for f in files]
    if not payload or not any(data for _, data in payload):
        raise HTTPException(400, "no files")
    h = hashlib.sha256()
    for name, data in payload:
        h.update(data)
    h.update(pipeline.VERSION.encode())
    digest = h.hexdigest()[:16]
    if fresh:
        (CACHE_DIR / f"{digest}.json").unlink(missing_ok=True)
    job_id = uuid.uuid4().hex[:10]
    (JOBS_DIR / job_id).mkdir(parents=True)
    jobs[job_id] = {"id": job_id, "status": "running", "log": [], "plan": None, "started": time.time()}
    threading.Thread(target=_run_job, args=(job_id, payload, digest), daemon=True).start()
    return {"id": job_id}


@app.post("/api/sample")
async def sample_job(fresh: bool = False):
    """Runs the bundled RTA-0097M chair manual (handy on a phone with no PDF at hand)."""
    data = (ROOT / "samples" / "rta-0097m.pdf").read_bytes()
    digest = hashlib.sha256(data + pipeline.VERSION.encode()).hexdigest()[:16]
    if fresh:
        (CACHE_DIR / f"{digest}.json").unlink(missing_ok=True)
    job_id = uuid.uuid4().hex[:10]
    (JOBS_DIR / job_id).mkdir(parents=True)
    jobs[job_id] = {"id": job_id, "status": "running", "log": [], "plan": None, "started": time.time()}
    threading.Thread(target=_run_job, args=(job_id, [("rta-0097m.pdf", data)], digest), daemon=True).start()
    return {"id": job_id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "unknown job")
    return JSONResponse({k: v for k, v in job.items() if k != "started"})


@app.get("/api/jobs/{job_id}/pages/{n}.png")
def page_image(job_id: str, n: int):
    p = JOBS_DIR / job_id / f"page-{n}.png"
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/png")


@app.get("/api/health")
def health():
    return {"ok": True, "provider": os.environ.get("MODEL_PROVIDER", "gemini"), "model": os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")}


@app.get("/api/assets")
def list_assets():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_PUBLISHABLE_KEY")
    if not url or not key:
        raise HTTPException(503, "Supabase catalog is not configured.")
    request = Request(
        f"{url}/rest/v1/furniture_assets?select=*&order=name,id&limit=100",
        headers={"apikey": key, "Accept": "application/json"},
    )
    try:
        # python.org builds on macOS ship without system CA certs, so use certifi's bundle
        with urlopen(request, timeout=8, context=ssl.create_default_context(cafile=certifi.where())) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404:
            raise HTTPException(503, "Run supabase/catalog.sql to create the furniture asset catalog.") from error
        raise HTTPException(502, "Supabase could not read the furniture asset catalog.") from error
    except (URLError, TimeoutError, ValueError) as error:
        raise HTTPException(502, "Supabase could not read the furniture asset catalog.") from error


app.include_router(kits_router)
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8765")))
