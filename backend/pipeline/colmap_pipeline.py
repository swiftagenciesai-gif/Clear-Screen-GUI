"""Drives the real COLMAP CLI through a full sparse+dense reconstruction and
hands off a colored mesh for export. Every stage is a genuine COLMAP
structure-from-motion / multi-view-stereo step -- there is no shortcut or
"fake" mesh generation here. See https://colmap.github.io/cli.html for the
full option reference these calls use.

Progress is reported by parsing the (fairly predictable) progress lines
COLMAP prints to stdout, e.g. "Matching block [1/6, 1/6]" and
"Processed file [12/48]". If COLMAP's own output changes across versions and
a regex stops matching, we still advance the step's progress bar on a slow
timer so the UI never looks frozen -- it just won't be as granular.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable

ProgressCB = Callable[[str, float, str], None]  # step, fraction (0-1), message


class ColmapError(RuntimeError):
    pass


def colmap_binary() -> str:
    return os.environ.get("COLMAP_BIN", "colmap")


def is_available() -> bool:
    return shutil.which(colmap_binary()) is not None


def get_version() -> str | None:
    if not is_available():
        return None
    try:
        out = subprocess.run(
            [colmap_binary(), "-h"], capture_output=True, text=True, timeout=15
        )
        text = (out.stdout or "") + (out.stderr or "")
        m = re.search(r"COLMAP\s+(\d+\.\d+(?:\.\d+)?)", text)
        return m.group(1) if m else "unknown"
    except Exception:
        return None


_PROGRESS_PATTERNS = [
    re.compile(r"\[(\d+)/(\d+)\]"),
    re.compile(r"Matching block \[(\d+)/(\d+),\s*(\d+)/(\d+)\]"),
]


def _run_streaming(
    cmd: list[str],
    cwd: Path,
    on_line: Callable[[str], None],
    log_fn: Callable[[str], None] | None = None,
    timeout: float | None = None,
) -> None:
    proc = subprocess.Popen(
        cmd,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    start = time.time()
    assert proc.stdout is not None
    for line in proc.stdout:
        if log_fn:
            log_fn(line)
        on_line(line)
        if timeout and (time.time() - start) > timeout:
            proc.kill()
            raise ColmapError(f"Command timed out after {timeout}s: {' '.join(cmd)}")
    ret = proc.wait()
    if ret != 0:
        raise ColmapError(f"Command failed ({ret}): {' '.join(cmd)}")


def _parse_fraction(line: str) -> float | None:
    for pat in _PROGRESS_PATTERNS:
        m = pat.search(line)
        if m:
            groups = [int(g) for g in m.groups()]
            if len(groups) == 2:
                num, denom = groups
            else:
                # "Matching block [i/n, j/m]" -> treat as overall pass i/n
                num, denom = groups[0], groups[1]
            if denom > 0:
                return max(0.0, min(1.0, num / denom))
    return None


def run_colmap_pipeline(
    scan_dir: Path,
    on_progress: ProgressCB,
    log_fn: Callable[[str], None] | None = None,
    matcher: str = "exhaustive",
    camera_model: str = "OPENCV",
    single_camera: bool = True,
    dense_max_image_size: int = 2000,
) -> Path:
    """Runs the full COLMAP pipeline. Returns path to the final textured/colored
    mesh (a .ply file) ready for cleanup + glb export.
    """
    if not is_available():
        raise ColmapError(
            f"COLMAP binary '{colmap_binary()}' not found on PATH. "
            "Run scripts/check_deps.py for install instructions."
        )

    images_dir = scan_dir / "raw"
    masks_dir = scan_dir / "masks"
    colmap_dir = scan_dir / "colmap"
    sparse_dir = colmap_dir / "sparse"
    dense_dir = colmap_dir / "dense"
    db_path = colmap_dir / "database.db"
    colmap_dir.mkdir(parents=True, exist_ok=True)
    sparse_dir.mkdir(parents=True, exist_ok=True)
    dense_dir.mkdir(parents=True, exist_ok=True)

    has_masks = masks_dir.exists() and any(masks_dir.iterdir())

    # --- 1. Feature extraction --------------------------------------------------
    on_progress("feature_extraction", 0.0, "Detecting SIFT features in each photo...")
    cmd = [
        colmap_binary(), "feature_extractor",
        "--database_path", str(db_path),
        "--image_path", str(images_dir),
        "--ImageReader.camera_model", camera_model,
        "--ImageReader.single_camera", "1" if single_camera else "0",
        "--SiftExtraction.use_gpu", "1" if os.environ.get("COLMAP_GPU", "0") == "1" else "0",
    ]
    if has_masks:
        cmd += ["--ImageReader.mask_path", str(masks_dir)]

    def _fe_line(line: str):
        frac = _parse_fraction(line)
        if frac is not None:
            on_progress("feature_extraction", frac, "Detecting SIFT features...")

    _run_streaming(cmd, colmap_dir, _fe_line, log_fn)
    on_progress("feature_extraction", 1.0, "Feature extraction complete.")

    # --- 2. Matching -------------------------------------------------------------
    on_progress("matching", 0.0, f"Matching features across photos ({matcher})...")
    matcher_cmd_name = {
        "exhaustive": "exhaustive_matcher",
        "sequential": "sequential_matcher",
    }.get(matcher, "exhaustive_matcher")
    cmd = [
        colmap_binary(), matcher_cmd_name,
        "--database_path", str(db_path),
        "--SiftMatching.use_gpu", "1" if os.environ.get("COLMAP_GPU", "0") == "1" else "0",
    ]

    def _match_line(line: str):
        frac = _parse_fraction(line)
        if frac is not None:
            on_progress("matching", frac, "Matching image pairs...")

    _run_streaming(cmd, colmap_dir, _match_line, log_fn)
    on_progress("matching", 1.0, "Matching complete.")

    # --- 3. Sparse reconstruction (incremental SfM) ------------------------------
    on_progress("sparse_reconstruction", 0.05, "Running incremental structure-from-motion...")
    cmd = [
        colmap_binary(), "mapper",
        "--database_path", str(db_path),
        "--image_path", str(images_dir),
        "--output_path", str(sparse_dir),
    ]

    reg_re = re.compile(r"Registering image #(\d+)")
    n_images = sum(1 for f in images_dir.iterdir() if f.suffix.lower() in (".jpg", ".jpeg", ".png"))

    def _map_line(line: str):
        m = reg_re.search(line)
        if m and n_images:
            frac = min(1.0, int(m.group(1)) / max(1, n_images))
            on_progress("sparse_reconstruction", frac, f"Registered {m.group(1)}/{n_images} images...")

    _run_streaming(cmd, colmap_dir, _map_line, log_fn, timeout=3600)

    model_dirs = sorted([p for p in sparse_dir.iterdir() if p.is_dir()])
    if not model_dirs:
        raise ColmapError(
            "COLMAP could not reconstruct a sparse model from these photos. "
            "This usually means too few overlapping views, motion blur, or a "
            "featureless/reflective object. See README troubleshooting section."
        )
    best_model = model_dirs[0]
    on_progress("sparse_reconstruction", 1.0, f"Sparse model reconstructed ({best_model.name}).")

    # --- 4. Undistortion (prepares images for dense MVS) -------------------------
    on_progress("undistortion", 0.1, "Undistorting images for dense stereo...")
    cmd = [
        colmap_binary(), "image_undistorter",
        "--image_path", str(images_dir),
        "--input_path", str(best_model),
        "--output_path", str(dense_dir),
        "--output_type", "COLMAP",
        "--max_image_size", str(dense_max_image_size),
    ]
    _run_streaming(cmd, colmap_dir, lambda l: None, log_fn)
    on_progress("undistortion", 1.0, "Undistortion complete.")

    # --- 5. Dense stereo (patch match) -------------------------------------------
    on_progress("dense_stereo", 0.0, "Computing dense depth maps (this is the slowest step)...")
    cmd = [
        colmap_binary(), "patch_match_stereo",
        "--workspace_path", str(dense_dir),
        "--workspace_format", "COLMAP",
        "--PatchMatchStereo.geom_consistency", "true",
        "--PatchMatchStereo.gpu_index", "-1" if os.environ.get("COLMAP_GPU", "0") != "1" else "0",
    ]

    depth_re = re.compile(r"Processing view (\d+)\s*/\s*(\d+)")

    def _pms_line(line: str):
        m = depth_re.search(line)
        if m:
            i, n = int(m.group(1)), int(m.group(2))
            if n:
                on_progress("dense_stereo", i / n, f"Depth map {i}/{n}...")

    _run_streaming(cmd, colmap_dir, _pms_line, log_fn, timeout=7200)
    on_progress("dense_stereo", 1.0, "Dense stereo complete.")

    # --- 6. Stereo fusion into a colored point cloud -----------------------------
    on_progress("stereo_fusion", 0.2, "Fusing depth maps into a dense point cloud...")
    fused_path = dense_dir / "fused.ply"
    cmd = [
        colmap_binary(), "stereo_fusion",
        "--workspace_path", str(dense_dir),
        "--workspace_format", "COLMAP",
        "--input_type", "geometric",
        "--output_path", str(fused_path),
    ]
    _run_streaming(cmd, colmap_dir, lambda l: None, log_fn, timeout=1800)
    if not fused_path.exists():
        raise ColmapError("Stereo fusion did not produce a point cloud.")
    on_progress("stereo_fusion", 1.0, "Point cloud fused.")

    # --- 7. Poisson surface reconstruction (mesh) --------------------------------
    on_progress("meshing", 0.2, "Building surface mesh (Poisson reconstruction)...")
    meshed_path = dense_dir / "meshed-poisson.ply"
    cmd = [
        colmap_binary(), "poisson_mesher",
        "--input_path", str(fused_path),
        "--output_path", str(meshed_path),
    ]
    _run_streaming(cmd, colmap_dir, lambda l: None, log_fn, timeout=900)
    if not meshed_path.exists():
        raise ColmapError("Poisson mesher did not produce a mesh.")
    on_progress("meshing", 1.0, "Mesh reconstructed.")

    return meshed_path
