"""Top-level orchestrator: picks an engine (COLMAP by default, Meshroom as a
documented fallback), runs it in a background thread, updates status.json as
it goes, and exports the final .glb. Kept separate from app.py so the FastAPI
layer stays thin and this can be unit-tested / run standalone if needed.
"""
from __future__ import annotations

import traceback
from pathlib import Path

from . import colmap_pipeline, jobs, masks, mesh_export, meshroom_pipeline


def pick_engine(preferred: str = "auto") -> str:
    if preferred == "colmap":
        return "colmap"
    if preferred == "meshroom":
        return "meshroom"
    if colmap_pipeline.is_available():
        return "colmap"
    if meshroom_pipeline.is_available():
        return "meshroom"
    return "colmap"  # will raise a clear error explaining how to install it


def process_scan(scan_id: str, engine_preference: str = "auto") -> None:
    scan_dir = jobs.SCANS_ROOT / scan_id
    raw_dir = scan_dir / "raw"
    bg_dir = scan_dir / "background"
    masks_dir = scan_dir / "masks"

    engine = pick_engine(engine_preference)

    try:
        jobs.set_step(scan_id, engine, "masking", 0.0, "Building foreground masks from background plate...")
        bg_candidates = sorted(bg_dir.glob("*"))
        bg_path = bg_candidates[0] if bg_candidates else None
        n_masks = masks.build_masks(raw_dir, bg_path, masks_dir)
        jobs.append_log(scan_id, f"Built {n_masks} masks (background plate {'found' if bg_path else 'missing'}).")
        jobs.set_step(scan_id, engine, "masking", 1.0, "Masking complete.")

        def on_progress(step: str, frac: float, message: str):
            jobs.set_step(scan_id, engine, step, frac, message)

        def log_fn(line: str):
            if line.strip():
                jobs.append_log(scan_id, line)

        if engine == "colmap":
            raw_mesh_path = colmap_pipeline.run_colmap_pipeline(scan_dir, on_progress, log_fn)
        else:
            raw_mesh_path = meshroom_pipeline.run_meshroom_pipeline(scan_dir, on_progress, log_fn)

        jobs.set_step(scan_id, engine, "mesh_export", 0.2, "Cleaning mesh and exporting to .glb...")
        glb_path = scan_dir / "model.glb"
        mesh_export.mesh_to_glb(raw_mesh_path, glb_path)
        jobs.set_step(scan_id, engine, "mesh_export", 1.0, "Export complete.")

        jobs.mark_done(scan_id, "Scan complete -- model.glb is ready.")

    except Exception as exc:  # noqa: BLE001 - want to persist any failure to status.json
        jobs.append_log(scan_id, f"ERROR: {exc}\n{traceback.format_exc()}")
        jobs.mark_error(scan_id, str(exc))
