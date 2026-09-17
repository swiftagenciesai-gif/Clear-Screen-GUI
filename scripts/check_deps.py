#!/usr/bin/env python3
"""Checks every system/Python dependency this app needs and prints exact
install commands for whatever is missing. Run this first:

    python3 scripts/check_deps.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

OK = "\033[92mOK\033[0m"
MISSING = "\033[91mMISSING\033[0m"
WARN = "\033[93mWARN\033[0m"


def check(name: str, cmd: list[str], version_hint: str = "") -> bool:
    exe = shutil.which(cmd[0])
    if not exe:
        print(f"  [{MISSING}] {name} ({cmd[0]} not found on PATH)")
        return False
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        text = (out.stdout + out.stderr).strip().splitlines()
        first_line = text[0] if text else "(no version output)"
        print(f"  [{OK}] {name} -> {first_line}")
        return True
    except Exception as e:
        print(f"  [{WARN}] {name} found at {exe} but failed to run: {e}")
        return False


def check_openmvs() -> bool:
    bin_dir = os.environ.get("OPENMVS_BIN_DIR")

    def resolve(name: str) -> str:
        return str(Path(bin_dir) / name) if bin_dir else name

    names = ["InterfaceCOLMAP", "DensifyPointCloud", "ReconstructMesh", "TextureMesh"]
    missing = [n for n in names if not shutil.which(resolve(n))]
    if missing:
        print(f"  [{WARN}] OpenMVS (optional, much better mesh quality on CPU) -- missing: {', '.join(missing)}")
        return False
    print(f"  [{OK}] OpenMVS (optional CPU dense reconstruction + texturing)")
    return True


def main() -> int:
    print("Python:")
    print(f"  [{OK if sys.version_info >= (3, 10) else WARN}] {sys.version.splitlines()[0]}")

    print("\nCore system tools:")
    have_cmake = check("cmake", ["cmake", "--version"])
    have_ffmpeg = check("ffmpeg (optional, for video->frame extraction)", ["ffmpeg", "-version"])

    print("\nPhotogrammetry engine (need at least one):")
    have_colmap = check("COLMAP", ["colmap", "-h"])
    have_meshroom = check("Meshroom (meshroom_batch)", ["meshroom_batch", "--help"])

    print("\nOptional CPU dense reconstruction (big mesh-quality upgrade when there's no GPU):")
    have_openmvs = check_openmvs()

    print("\nPython packages (backend/requirements.txt):")
    pkgs_ok = True
    for mod, pip_name in [
        ("fastapi", "fastapi"),
        ("uvicorn", "uvicorn"),
        ("cv2", "opencv-python-headless"),
        ("numpy", "numpy"),
        ("trimesh", "trimesh"),
        ("PIL", "pillow"),
    ]:
        try:
            __import__(mod)
            print(f"  [{OK}] {pip_name}")
        except ImportError:
            print(f"  [{MISSING}] {pip_name}")
            pkgs_ok = False

    print("\n" + "=" * 70)
    if not (have_colmap or have_meshroom):
        print(
            "No photogrammetry engine found. Install COLMAP (recommended):\n"
            "  Linux (Ubuntu/Debian):  bash scripts/install_colmap.sh\n"
            "  macOS:                  brew install colmap\n"
            "  Windows:                download the prebuilt zip from\n"
            "                          https://github.com/colmap/colmap/releases\n"
            "                          and add its bin/ folder to PATH\n"
            "  Docker (any OS, easiest if the above fails):\n"
            "     docker run --rm -it -v $(pwd):/work colmap/colmap:latest\n"
            "\n"
            "If COLMAP won't build/run on this machine, install Meshroom instead\n"
            "(prebuilt binaries, no compiling required):\n"
            "  https://alicevision.org/#meshroom -> download, unzip, add its\n"
            "  folder to PATH so 'meshroom_batch' resolves.\n"
        )
    else:
        engine = "COLMAP" if have_colmap else "Meshroom"
        print(f"Photogrammetry engine ready: {engine}")

    if have_colmap and not have_openmvs:
        print(
            "\nOpenMVS not found -- on a machine with no CUDA GPU (i.e. any Mac), COLMAP scans\n"
            "will use a lower-detail sparse-point mesh instead of real dense reconstruction.\n"
            "Optional upgrade (CPU-only, no GPU needed): bash scripts/install_openmvs.sh\n"
            "(builds from source, ~20-60 min; see README for details)."
        )

    if not pkgs_ok:
        print("\nInstall missing Python packages with:")
        print("  pip3 install -r backend/requirements.txt")

    if not have_cmake:
        print("\ncmake is only needed if you build COLMAP from source (apt/brew installs skip this).")

    all_good = (have_colmap or have_meshroom) and pkgs_ok
    print("\n" + ("Everything looks ready." if all_good else "Fix the items above, then re-run this script."))
    return 0 if all_good else 1


if __name__ == "__main__":
    raise SystemExit(main())
