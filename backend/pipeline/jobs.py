"""Scan job state: persisted to status.json so progress survives backend restarts
and can be polled cheaply from the browser without holding anything in memory."""
from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

SCANS_ROOT = Path(__file__).resolve().parent.parent / "scans"
SCANS_ROOT.mkdir(parents=True, exist_ok=True)

# Ordered pipeline steps with the share of overall progress (0-1) each occupies.
# Kept in one place so the runner and the frontend progress bar agree on meaning.
COLMAP_STEPS = [
    ("uploading", 0.03),
    ("masking", 0.05),
    ("feature_extraction", 0.12),
    ("matching", 0.13),
    ("sparse_reconstruction", 0.15),
    ("undistortion", 0.04),
    ("dense_stereo", 0.17),  # GPU: patch_match_stereo. CPU+OpenMVS: InterfaceCOLMAP + DensifyPointCloud.
    ("stereo_fusion", 0.04),  # GPU only -- OpenMVS densifies directly, no separate fusion step.
    ("meshing", 0.10),  # GPU: poisson_mesher. CPU+OpenMVS: ReconstructMesh (+ optional RefineMesh). No GPU/OpenMVS: sparse-point Poisson.
    ("texturing", 0.12),  # CPU+OpenMVS only: TextureMesh bakes real photo texture. Skipped otherwise.
    ("mesh_export", 0.05),
]

MESHROOM_STEPS = [
    ("uploading", 0.03),
    ("masking", 0.05),
    ("meshroom_batch", 0.85),
    ("mesh_export", 0.07),
]

_lock = threading.Lock()


def _scan_dir(scan_id: str) -> Path:
    return SCANS_ROOT / scan_id


def _status_path(scan_id: str) -> Path:
    return _scan_dir(scan_id) / "status.json"


def new_scan_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]


def create_scan(scan_id: str) -> dict:
    d = _scan_dir(scan_id)
    (d / "raw").mkdir(parents=True, exist_ok=True)
    (d / "background").mkdir(parents=True, exist_ok=True)
    (d / "masks").mkdir(parents=True, exist_ok=True)
    status = {
        "id": scan_id,
        "state": "created",  # created -> uploading -> queued -> running -> done | error
        "step": None,
        "step_progress": 0.0,
        "overall_progress": 0.0,
        "message": "Scan created, waiting for photos.",
        "log_tail": [],
        "engine": None,
        "error": None,
        "created_at": time.time(),
        "updated_at": time.time(),
        "num_images": 0,
        "has_background": False,
        "glb_ready": False,
    }
    write_status(scan_id, status)
    return status


def read_status(scan_id: str) -> Optional[dict]:
    p = _status_path(scan_id)
    if not p.exists():
        return None
    with _lock:
        return json.loads(p.read_text())


def write_status(scan_id: str, status: dict) -> None:
    status["updated_at"] = time.time()
    p = _status_path(scan_id)
    tmp = p.with_suffix(".tmp")
    with _lock:
        tmp.write_text(json.dumps(status, indent=2))
        tmp.replace(p)


def update_status(scan_id: str, **kwargs) -> dict:
    status = read_status(scan_id) or {}
    status.update(kwargs)
    write_status(scan_id, status)
    return status


def append_log(scan_id: str, line: str, max_lines: int = 200) -> None:
    status = read_status(scan_id) or {}
    tail = status.get("log_tail", [])
    tail.append(line.rstrip())
    status["log_tail"] = tail[-max_lines:]
    write_status(scan_id, status)


def steps_for_engine(engine: str):
    return COLMAP_STEPS if engine == "colmap" else MESHROOM_STEPS


def set_step(scan_id: str, engine: str, step_name: str, step_progress: float = 0.0, message: str = ""):
    """Compute overall_progress as sum of completed step weights + fraction of current step."""
    steps = steps_for_engine(engine)
    names = [s[0] for s in steps]
    idx = names.index(step_name) if step_name in names else 0
    completed_weight = sum(w for _, w in steps[:idx])
    current_weight = steps[idx][1]
    overall = completed_weight + current_weight * max(0.0, min(1.0, step_progress))
    status = read_status(scan_id) or {}
    status.update(
        {
            "state": "running",
            "engine": engine,
            "step": step_name,
            "step_progress": max(0.0, min(1.0, step_progress)),
            "overall_progress": round(min(0.999, overall), 4),
            "message": message or status.get("message", ""),
        }
    )
    write_status(scan_id, status)


def mark_done(scan_id: str, message: str = "Scan complete."):
    update_status(
        scan_id,
        state="done",
        step="complete",
        step_progress=1.0,
        overall_progress=1.0,
        glb_ready=True,
        message=message,
    )


def mark_error(scan_id: str, error: str):
    update_status(scan_id, state="error", error=error, message=f"Failed: {error}")


def list_scans() -> list[dict]:
    out = []
    for d in sorted(SCANS_ROOT.iterdir(), reverse=True):
        if d.is_dir():
            s = read_status(d.name)
            if s:
                out.append(s)
    return out
