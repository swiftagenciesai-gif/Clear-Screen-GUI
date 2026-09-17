#!/usr/bin/env bash
# Installs COLMAP on Ubuntu/Debian. COLMAP is not always in the default apt
# repos with a recent enough version, so this tries the packaged build first
# (fast, CPU-only) and tells you how to build from source if you need CUDA
# support for GPU-accelerated dense stereo.
#
# Usage: bash scripts/install_colmap.sh
set -euo pipefail

if ! command -v apt-get &>/dev/null; then
  echo "This script targets Ubuntu/Debian (apt-get). For other platforms:"
  echo "  macOS:   brew install colmap"
  echo "  Windows: download a prebuilt release from"
  echo "           https://github.com/colmap/colmap/releases"
  echo "  Any OS:  docker pull colmap/colmap:latest"
  exit 1
fi

echo "==> Updating apt and installing COLMAP + runtime dependencies..."
sudo apt-get update -y
if sudo apt-get install -y colmap; then
  echo "==> Installed COLMAP from apt."
else
  cat <<'EOF'

apt does not have a 'colmap' package on this system. Building from source:

  sudo apt-get install -y \
    git cmake ninja-build build-essential libboost-program-options-dev \
    libboost-filesystem-dev libboost-graph-dev libboost-system-dev \
    libeigen3-dev libflann-dev libfreeimage-dev libmetis-dev \
    libgoogle-glog-dev libgtest-dev libsqlite3-dev libglew-dev \
    qtbase5-dev libqt5opengl5-dev libcgal-dev libceres-dev

  git clone https://github.com/colmap/colmap.git
  cd colmap && mkdir build && cd build
  cmake .. -GNinja -DCMAKE_BUILD_TYPE=Release
  ninja
  sudo ninja install

This takes 15-30+ minutes to compile. Full instructions (including optional
CUDA support for GPU dense stereo) are at https://colmap.github.io/install.html
EOF
  exit 1
fi

echo "==> Verifying installation..."
colmap -h | head -n 5 || {
  echo "COLMAP installed but failed to run. Check for missing shared libraries above."
  exit 1
}

echo "==> Done. Run 'python3 scripts/check_deps.py' to confirm everything the app needs is present."
