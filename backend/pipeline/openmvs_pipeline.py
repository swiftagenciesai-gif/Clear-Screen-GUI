"""Optional CPU-capable dense reconstruction + photo-texturing via OpenMVS,
used as a substantially higher-quality alternative to plain sparse-point
Poisson meshing when no CUDA GPU is available for COLMAP's own dense stereo
(patch_match_stereo, which has no CPU code path at all).

Entirely optional: if OpenMVS isn't installed, colmap_pipeline.py falls back
to the sparse-only path automatically. See scripts/install_openmvs.sh and the
README's OpenMVS section for setup -- there's no Homebrew formula for it, so
it has to be built from source.

Every flag used below was confirmed against OpenMVS's own source
(apps/<Tool>/<Tool>.cpp on the cdcseacave/openMVS GitHub repo) rather than
guessed by analogy -- COLMAP's CLI already burned us once for exactly that
mistake (see colmap_pipeline.py's git history: --SiftExtraction.max_image_size
and --SiftMatching.guided_matching were both real-looking, standard-sounding
COLMAP options that didn't actually exist on the installed build and broke
the pipeline outright). In particular, --cuda-device is deliberately never
passed here: it's only compiled in on CUDA-enabled builds (guarded by
`#ifdef _USE_CUDA` in OpenMVS's own source), and our own install script
always builds with -DOpenMVS_USE_CUDA=OFF, so the flag wouldn't exist on our
binaries and passing it would fail exactly like the COLMAP mistakes did. A
non-CUDA build runs CPU-only automatically, with no flag needed at all.

Because exact output filenames from these tools depend on internal string
concatenation we can't fully pin down without running them, every step
double-checks its documented default output name and falls back to globbing
the working directory for the newest matching file -- so a naming quirk in
some OpenMVS version degrades to "can't find the output" (a clear error we
catch and fall back from) rather than silently grabbing the wrong file.
"""
from __future__ import annotations

import math
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable

ProgressCB = Callable[[str, float, str], None]


class OpenMVSError(RuntimeError):
    pass


_BINARIES = ["InterfaceCOLMAP", "DensifyPointCloud", "ReconstructMesh", "TextureMesh"]


def _bin_dir() -> str | None:
    return os.environ.get("OPENMVS_BIN_DIR")


def binary(name: str) -> str:
    d = _bin_dir()
    return str(Path(d) / name) if d else name


def is_available() -> bool:
    return all(shutil.which(binary(name)) for name in _BINARIES)


def _run(
    cmd: list[str],
    cwd: Path,
    log_fn: Callable[[str], None] | None,
    on_idle: Callable[[float], None] | None = None,
    idle_interval: float = 2.0,
    timeout: float | None = None,
) -> None:
    proc = subprocess.Popen(
        cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    start = time.time()
    stop_event = threading.Event()
    ticker = None
    if on_idle:
        def _tick():
            while not stop_event.wait(idle_interval):
                on_idle(time.time() - start)
        ticker = threading.Thread(target=_tick, daemon=True)
        ticker.start()
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if log_fn:
                log_fn(line)
            if timeout and (time.time() - start) > timeout:
                proc.kill()
                raise OpenMVSError(f"Command timed out after {timeout}s: {' '.join(cmd)}")
        ret = proc.wait()
    finally:
        stop_event.set()
        if ticker:
            ticker.join(timeout=1)
    if ret != 0:
        raise OpenMVSError(f"Command failed ({ret}): {' '.join(cmd)}")


def _newest_match(directory: Path, patterns: list[str], since: float) -> Path | None:
    candidates: list[Path] = []
    for pat in patterns:
        candidates.extend(directory.glob(pat))
    candidates = [p for p in candidates if p.is_file() and p.stat().st_mtime >= since - 2]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _idle_progress(on_progress: ProgressCB, step: str, tau: float, label: str, cap: float = 0.92):
    """Since we haven't verified these tools' own progress-line formats
    against real output (unlike COLMAP's, which the user's actual runs have
    confirmed), don't guess a regex -- advance the bar on an exponential
    decay curve instead, so it keeps moving and never looks frozen without
    risking a parse that silently never matches."""
    def _cb(elapsed: float):
        frac = min(cap, 1 - math.exp(-elapsed / tau))
        on_progress(step, frac, f"{label} ({int(elapsed)}s elapsed)...")
    return _cb


def run_dense_pipeline(
    dense_dir: Path,
    on_progress: ProgressCB,
    log_fn: Callable[[str], None] | None = None,
    refine: bool = False,
) -> Path:
    """Runs InterfaceCOLMAP -> DensifyPointCloud -> ReconstructMesh ->
    [RefineMesh] -> TextureMesh against a COLMAP `image_undistorter`
    workspace (dense_dir must already contain images/ and sparse/ in COLMAP
    format -- the caller is responsible for running image_undistorter
    first). Returns the path to the final textured .obj mesh.
    """
    if not is_available():
        raise OpenMVSError("OpenMVS binaries not found on PATH (or OPENMVS_BIN_DIR).")

    def log(line: str):
        if log_fn:
            log_fn(line)

    # --- InterfaceCOLMAP: COLMAP undistorted workspace -> OpenMVS scene ---
    on_progress("dense_stereo", 0.0, "Converting COLMAP workspace to an OpenMVS scene...")
    cmd = [binary("InterfaceCOLMAP"), "-w", str(dense_dir), "-i", str(dense_dir), "-o", "scene.mvs"]
    _run(cmd, dense_dir, log, timeout=600)
    scene_mvs = dense_dir / "scene.mvs"
    if not scene_mvs.exists():
        raise OpenMVSError("InterfaceCOLMAP did not produce scene.mvs.")
    on_progress("dense_stereo", 0.1, "OpenMVS scene ready.")

    # --- DensifyPointCloud: real dense multi-view stereo, CPU-only --------
    # Unlike the other tools here, DensifyPointCloud's --gpu-device flag is
    # compiled in whenever EITHER CUDA or Metal support is enabled (verified
    # from its actual source), and CMake auto-enables Metal on every macOS
    # build regardless of any option we pass -- so on any Mac following our
    # install script, this flag exists and defaults to "-1" (try the best
    # available GPU automatically, which would mean Metal here). We force
    # CPU explicitly instead of silently inheriting that: Metal support is
    # new to this codebase and unverified for our purposes, so a predictable
    # CPU run is the safer default for now. (RefineMesh's equivalent flag,
    # by contrast, is gated on CUDA alone -- never pass it there, or it'll
    # be an unrecognized option on this exact build.)
    on_progress("dense_stereo", 0.15, "Computing a dense point cloud (CPU multi-view stereo -- the slowest step)...")
    t0 = time.time()
    cmd = [binary("DensifyPointCloud"), "scene.mvs", "-w", str(dense_dir), "--gpu-device", "-2"]
    _run(
        cmd, dense_dir, log,
        on_idle=_idle_progress(on_progress, "dense_stereo", tau=90, label="Still computing the dense point cloud"),
        timeout=7200,
    )
    dense_mvs = dense_dir / "scene_dense.mvs"
    if not dense_mvs.exists():
        dense_mvs = _newest_match(dense_dir, ["*_dense.mvs"], t0)
    if not dense_mvs:
        raise OpenMVSError("DensifyPointCloud did not produce a dense point cloud.")
    on_progress("dense_stereo", 1.0, "Dense point cloud complete.")

    # --- ReconstructMesh: Delaunay-based surface from the dense cloud -----
    on_progress("stereo_fusion", 1.0, "Skipped -- OpenMVS densifies directly, no separate fusion step needed.")
    on_progress("meshing", 0.0, "Reconstructing the surface mesh from the dense point cloud...")
    t0 = time.time()
    # --archive-type 2 (compressed binary): ReconstructMesh's own source only
    # writes the companion _mesh.mvs scene file when the requested archive type
    # differs from the scene's already-loaded format (verified directly from
    # apps/ReconstructMesh/ReconstructMesh.cpp) -- since our input scene is
    # already OpenMVS's default interface archive, it would otherwise skip
    # writing the .mvs entirely and leave only a bare .ply, which we can't feed
    # to TextureMesh.
    cmd = [
        binary("ReconstructMesh"), dense_mvs.name, "-w", str(dense_dir),
        "--target-face-num", "150000", "--archive-type", "2",
    ]
    _run(
        cmd, dense_dir, log,
        on_idle=_idle_progress(on_progress, "meshing", tau=45, label="Still reconstructing the surface mesh", cap=0.9),
        timeout=3600,
    )
    mesh_mvs = dense_dir / f"{dense_mvs.stem}_mesh.mvs"
    if not mesh_mvs.exists():
        mesh_mvs = _newest_match(dense_dir, ["*_mesh.mvs"], t0)
    if not mesh_mvs:
        raise OpenMVSError("ReconstructMesh did not produce a mesh.")
    on_progress("meshing", 0.6, "Surface mesh reconstructed.")

    texture_input = mesh_mvs
    if refine:
        on_progress("meshing", 0.7, "Refining mesh geometry against the source photos (this can be slow)...")
        t0 = time.time()
        # Same --archive-type fix as ReconstructMesh above: RefineMesh.cpp has
        # the identical skip-the-.mvs-save condition when the archive type
        # matches the already-loaded scene's format.
        cmd = [binary("RefineMesh"), mesh_mvs.name, "-w", str(dense_dir), "--archive-type", "2"]
        try:
            _run(
                cmd, dense_dir, log,
                on_idle=_idle_progress(on_progress, "meshing", tau=90, label="Still refining the mesh", cap=0.98),
                timeout=7200,
            )
            refined = dense_dir / f"{mesh_mvs.stem}_refine.mvs"
            if not refined.exists():
                refined = _newest_match(dense_dir, ["*_refine.mvs"], t0)
            if refined:
                texture_input = refined
            else:
                log("RefineMesh ran but its output couldn't be found; continuing with the unrefined mesh.\n")
        except OpenMVSError as exc:
            log(f"RefineMesh failed ({exc}), continuing with the unrefined mesh.\n")
    on_progress("meshing", 1.0, "Surface mesh ready.")

    # --- TextureMesh: bakes real photographic texture onto the mesh -------
    on_progress("texturing", 0.0, "Projecting photo texture onto the mesh...")
    t0 = time.time()
    cmd = [binary("TextureMesh"), texture_input.name, "-w", str(dense_dir), "--export-type", "obj"]
    _run(
        cmd, dense_dir, log,
        on_idle=_idle_progress(on_progress, "texturing", tau=45, label="Still projecting texture"),
        timeout=3600,
    )
    textured_obj = _newest_match(dense_dir, ["*.obj"], t0)
    if not textured_obj:
        raise OpenMVSError("TextureMesh did not produce a textured .obj mesh.")
    on_progress("texturing", 1.0, "Texturing complete.")

    return textured_obj
