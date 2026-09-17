#!/usr/bin/env bash
# Builds OpenMVS from source on macOS for CPU-only dense reconstruction +
# photo-texturing -- a substantial mesh-quality upgrade over the app's
# built-in sparse-point fallback, for machines with no CUDA GPU (i.e. every
# Mac). Entirely OPTIONAL: the app works without this, just with a
# lower-detail mesh. Read the README's OpenMVS section before running this.
#
# There is no Homebrew formula for OpenMVS, so this builds it from source --
# expect 20-60 minutes depending on your machine, and some risk of needing
# manual troubleshooting since it depends on your exact Xcode/CGAL/Boost
# versions. Every command-line flag the app itself passes to the resulting
# binaries was verified against OpenMVS's own source code, not guessed by
# analogy -- but the *build* can still fail on your specific setup. If it
# does, the app keeps working fine without it (it just uses the lower-detail
# fallback mesh).
#
# Usage: bash scripts/install_openmvs.sh
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script targets macOS. For other platforms see OpenMVS's own build docs:"
  echo "  https://github.com/cdcseacave/openMVS/wiki/Building"
  exit 1
fi

if ! xcode-select -p &>/dev/null; then
  echo "Xcode Command Line Tools are required first:"
  echo "  xcode-select --install"
  exit 1
fi

if ! command -v brew &>/dev/null; then
  echo "Homebrew is required first: https://brew.sh"
  exit 1
fi

echo "==> Installing build dependencies via Homebrew (boost, eigen, opencv, cgal, ceres-solver, nanoflann)..."
brew install cmake boost eigen opencv cgal ceres-solver nanoflann

WORK_DIR="${OPENMVS_WORK_DIR:-$HOME/openmvs_build}"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

if [[ ! -d vcglib ]]; then
  echo "==> Cloning the VCG library (an OpenMVS dependency with no Homebrew package)..."
  git clone --depth 1 https://github.com/cdcseacave/VCG.git vcglib
fi

# TinyEXIF (another OpenMVS dependency with no Homebrew package) is a real
# CMake package, unlike VCG which OpenMVS just points at as a raw source
# tree -- it has to actually be built and installed so its
# TinyEXIFConfig.cmake exists somewhere OpenMVS's own find_package() call
# can see, hence the separate local install prefix below.
LOCAL_PREFIX="$WORK_DIR/local"
if [[ ! -f "$LOCAL_PREFIX/lib/cmake/TinyEXIF/TinyEXIFConfig.cmake" ]]; then
  if [[ ! -d TinyEXIF ]]; then
    echo "==> Cloning TinyEXIF (an OpenMVS dependency with no Homebrew package)..."
    git clone --depth 1 https://github.com/cdcseacave/TinyEXIF.git
  fi
  echo "==> Building and installing TinyEXIF into $LOCAL_PREFIX..."
  cmake -S TinyEXIF -B TinyEXIF/build -DCMAKE_INSTALL_PREFIX="$LOCAL_PREFIX" -DBUILD_SHARED_LIBS=OFF
  cmake --build TinyEXIF/build --config Release
  cmake --install TinyEXIF/build
fi

if [[ ! -d openMVS ]]; then
  echo "==> Cloning OpenMVS..."
  git clone --depth 1 https://github.com/cdcseacave/openMVS.git
fi

mkdir -p openMVS_build
cd openMVS_build

echo "==> Configuring (CUDA and OpenMP both off: no Mac has a CUDA GPU, and Apple's"
echo "    default clang has no OpenMP support without extra setup this script skips)..."
cmake ../openMVS \
  -DCMAKE_BUILD_TYPE=Release \
  -DVCG_ROOT="$WORK_DIR/vcglib" \
  -DCMAKE_PREFIX_PATH="$LOCAL_PREFIX" \
  -DOpenMVS_USE_CUDA=OFF \
  -DOpenMVS_USE_OPENMP=OFF \
  -DOpenMVS_BUILD_VIEWER=OFF \
  -DOpenMVS_ENABLE_TESTS=OFF \
  -G "Unix Makefiles"

echo "==> Building (this is the slow part -- 15-45 minutes is normal)..."
make -j"$(sysctl -n hw.ncpu)"

BIN_DIR="$WORK_DIR/openMVS_build/bin"
if [[ ! -f "$BIN_DIR/DensifyPointCloud" ]]; then
  # Some OpenMVS versions/configs put binaries directly in the build root
  # instead of bin/ -- check there before giving up.
  if [[ -f "$WORK_DIR/openMVS_build/DensifyPointCloud" ]]; then
    BIN_DIR="$WORK_DIR/openMVS_build"
  else
    echo ""
    echo "Build finished but DensifyPointCloud wasn't found where expected."
    echo "Look for it under $WORK_DIR/openMVS_build and set OPENMVS_BIN_DIR to its folder yourself:"
    echo "  find $WORK_DIR/openMVS_build -name DensifyPointCloud"
    exit 1
  fi
fi

echo ""
echo "==> Build complete. Binaries are in: $BIN_DIR"
echo ""
echo "Add this to your shell profile (~/.zshrc) so the app can find them, then restart your terminal:"
echo "  export OPENMVS_BIN_DIR=\"$BIN_DIR\""
echo ""
echo "Then run 'python3 scripts/check_deps.py' to confirm OpenMVS is detected -- new scans will"
echo "automatically use it for much higher mesh quality, no other configuration needed."
