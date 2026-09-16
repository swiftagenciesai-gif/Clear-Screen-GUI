"""Fallback reconstruction engine using AliceVision Meshroom's batch CLI
(`meshroom_batch`) when COLMAP is unavailable or fails to build on this
machine. Meshroom runs its own full photogrammetry graph (feature
extraction -> matching -> structure-from-motion -> depth maps -> meshing ->
texturing), it is not a lower-quality approximation, just a different real
SfM/MVS engine with a heavier install (AliceVision + Qt).

Reference: https://github.com/alicevision/meshroom (command line usage docs).
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Callable

ProgressCB = Callable[[str, float, str], None]

# Meshroom's default pipeline graph nodes, in execution order, used only to
# turn "which node is running" into a rough progress fraction.
_NODE_ORDER = [
    "CameraInit",
    "FeatureExtraction",
    "ImageMatching",
    "FeatureMatching",
    "StructureFromMotion",
    "PrepareDenseScene",
    "DepthMap",
    "DepthMapFilter",
    "Meshing",
    "MeshFiltering",
    "Texturing",
]


class MeshroomError(RuntimeError):
    pass


def meshroom_binary() -> str:
    return os.environ.get("MESHROOM_BATCH_BIN", "meshroom_batch")


def is_available() -> bool:
    return shutil.which(meshroom_binary()) is not None


def get_version() -> str | None:
    if not is_available():
        return None
    try:
        out = subprocess.run(
            [meshroom_binary(), "--help"], capture_output=True, text=True, timeout=15
        )
        return "available" if out.returncode in (0, 1) else None
    except Exception:
        return None


_node_re = re.compile(r"\b(" + "|".join(_NODE_ORDER) + r")\b")


def run_meshroom_pipeline(
    scan_dir: Path,
    on_progress: ProgressCB,
    log_fn: Callable[[str], None] | None = None,
) -> Path:
    if not is_available():
        raise MeshroomError(
            f"'{meshroom_binary()}' not found on PATH. Install Meshroom "
            "(https://alicevision.org/#meshroom) or use the COLMAP engine instead."
        )

    images_dir = scan_dir / "raw"
    output_dir = scan_dir / "meshroom_output"
    cache_dir = scan_dir / "meshroom_cache"
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        meshroom_binary(),
        "--input", str(images_dir),
        "--output", str(output_dir),
        "--cache", str(cache_dir),
    ]

    on_progress("meshroom_batch", 0.0, "Starting Meshroom photogrammetry graph...")
    proc = subprocess.Popen(
        cmd, cwd=str(scan_dir), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1,
    )
    assert proc.stdout is not None
    last_idx = 0
    for line in proc.stdout:
        if log_fn:
            log_fn(line)
        m = _node_re.search(line)
        if m:
            idx = _NODE_ORDER.index(m.group(1))
            last_idx = max(last_idx, idx)
            frac = last_idx / (len(_NODE_ORDER) - 1)
            on_progress("meshroom_batch", frac, f"Running {m.group(1)}...")
    ret = proc.wait()
    if ret != 0:
        raise MeshroomError(f"meshroom_batch exited with code {ret}. Check logs for details.")

    on_progress("meshroom_batch", 1.0, "Meshroom graph complete.")

    # Meshroom's Texturing node writes texturedMesh.obj (with .mtl + textures)
    # somewhere under output_dir; walk for it since the exact path includes a
    # per-node cache UID that isn't predictable ahead of time.
    candidates = list(output_dir.rglob("texturedMesh.obj"))
    if not candidates:
        candidates = list(cache_dir.rglob("texturedMesh.obj"))
    if not candidates:
        raise MeshroomError("Meshroom finished but no texturedMesh.obj was found in the output.")
    return candidates[0]
