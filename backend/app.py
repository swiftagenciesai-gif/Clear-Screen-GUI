"""FastAPI backend for the 3D scanning + gesture control app.

Run with:  uvicorn app:app --reload --port 8000
(see README.md at the repo root for full setup instructions)
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from pipeline import colmap_pipeline, jobs, meshroom_pipeline, runner

APP_ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = APP_ROOT.parent / "frontend"

app = FastAPI(title="3D Scan + Gesture Control")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
_ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def _validate_image(upload: UploadFile) -> str:
    ext = Path(upload.filename or "").suffix.lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported file type: {upload.filename}")
    return ext


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "colmap_available": colmap_pipeline.is_available(),
        "colmap_version": colmap_pipeline.get_version(),
        "meshroom_available": meshroom_pipeline.is_available(),
    }


@app.post("/api/scans")
def create_scan():
    scan_id = jobs.new_scan_id()
    status = jobs.create_scan(scan_id)
    return status


@app.get("/api/scans")
def list_scans():
    return jobs.list_scans()


@app.get("/api/scans/{scan_id}/status")
def get_status(scan_id: str):
    status = jobs.read_status(scan_id)
    if status is None:
        raise HTTPException(404, "Scan not found")
    return status


@app.post("/api/scans/{scan_id}/background")
async def upload_background(scan_id: str, file: UploadFile = File(...)):
    status = jobs.read_status(scan_id)
    if status is None:
        raise HTTPException(404, "Scan not found")
    ext = _validate_image(file)
    scan_dir = jobs.SCANS_ROOT / scan_id
    bg_dir = scan_dir / "background"
    bg_dir.mkdir(parents=True, exist_ok=True)
    # Only one background plate makes sense; replace any previous upload.
    for old in bg_dir.glob("*"):
        old.unlink()
    dest = bg_dir / f"background{ext}"
    data = await file.read()
    dest.write_bytes(data)
    jobs.update_status(scan_id, has_background=True, message="Background plate captured.")
    return {"ok": True}


@app.post("/api/scans/{scan_id}/photos")
async def upload_photos(scan_id: str, file: UploadFile = File(...)):
    status = jobs.read_status(scan_id)
    if status is None:
        raise HTTPException(404, "Scan not found")
    ext = _validate_image(file)
    scan_dir = jobs.SCANS_ROOT / scan_id
    raw_dir = scan_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    existing = len(list(raw_dir.glob("*")))
    dest = raw_dir / f"frame_{existing:04d}{ext}"
    data = await file.read()
    dest.write_bytes(data)
    n = existing + 1
    jobs.update_status(
        scan_id,
        state="uploading",
        num_images=n,
        message=f"Received {n} photos.",
    )
    return {"ok": True, "num_images": n}


@app.post("/api/scans/{scan_id}/process")
def start_processing(scan_id: str, engine: str = "auto"):
    status = jobs.read_status(scan_id)
    if status is None:
        raise HTTPException(404, "Scan not found")
    if status["state"] == "running":
        raise HTTPException(409, "Scan is already processing")
    scan_dir = jobs.SCANS_ROOT / scan_id
    n_images = len(list((scan_dir / "raw").glob("*")))
    if n_images < 8:
        raise HTTPException(
            400,
            f"Only {n_images} photos uploaded. Capture at least ~24 turntable "
            "shots (8 is an absolute technical floor) for a usable reconstruction.",
        )

    jobs.update_status(scan_id, state="queued", message="Queued for processing.")
    thread = threading.Thread(
        target=runner.process_scan, args=(scan_id, engine), daemon=True
    )
    thread.start()
    return {"ok": True, "engine": runner.pick_engine(engine)}


@app.get("/api/scans/{scan_id}/model.glb")
def get_model(scan_id: str):
    scan_dir = jobs.SCANS_ROOT / scan_id
    glb_path = scan_dir / "model.glb"
    if not glb_path.exists():
        raise HTTPException(404, "Model not ready yet")
    return FileResponse(str(glb_path), media_type="model/gltf-binary", filename=f"{scan_id}.glb")


@app.delete("/api/scans/{scan_id}")
def delete_scan(scan_id: str):
    import shutil

    scan_dir = jobs.SCANS_ROOT / scan_id
    if not scan_dir.exists():
        raise HTTPException(404, "Scan not found")
    shutil.rmtree(scan_dir)
    return {"ok": True}


# Serve the frontend (capture UI + viewer) directly from the same server so
# there's a single "run this one command" story with no separate dev server
# or CORS setup required for normal use.
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
