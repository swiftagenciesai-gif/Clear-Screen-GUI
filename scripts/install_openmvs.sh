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

echo "==> Installing build dependencies via Homebrew (boost, eigen, opencv@4, cgal, ceres-solver, nanoflann, tinyxml2)..."
# opencv@4, not plain opencv: OpenMVS's develop branch (libs/Common/Types.inl)
# unconditionally defines cv::DataType<unsigned> and cv::DataType<uint64_t>
# for any OpenCV major version > 2, on the assumption OpenCV itself never
# defines those two -- true for OpenCV 3.x/4.x (verified directly against
# OpenCV 4.14.0's traits.hpp, which has neither), but OpenCV 5.0.0 now
# defines both itself, so building against plain `opencv` (currently v5 on
# Homebrew) fails with "redefinition of DataType<...>". opencv@4 is a real,
# actively-bottled Homebrew formula (keg-only, so it installs alongside any
# existing plain `opencv` without conflict) that sidesteps this entirely.
brew install cmake boost eigen opencv@4 cgal ceres-solver nanoflann tinyxml2

# opencv@4 is keg-only (not symlinked into the normal Homebrew prefix), so
# find_package(OpenCV) won't see it without an explicit hint. Locating its
# OpenCVConfig.cmake by searching the keg -- rather than hardcoding a
# lib/cmake/opencv4 style path -- avoids guessing Homebrew's exact install
# layout, which has changed across OpenCV major versions before.
# -L: brew --prefix returns /opt/homebrew/opt/opencv@4, itself a symlink into
# the Cellar, so the search must follow it to see anything underneath.
OPENCV4_PREFIX="$(brew --prefix opencv@4)"
OPENCV4_CMAKE_DIR="$(dirname "$(find -L "$OPENCV4_PREFIX" -name OpenCVConfig.cmake 2>/dev/null | head -1)")"
if [[ -z "$OPENCV4_CMAKE_DIR" || "$OPENCV4_CMAKE_DIR" == "." ]]; then
  echo "Couldn't locate OpenCVConfig.cmake under $OPENCV4_PREFIX -- opencv@4 may have changed its layout." >&2
  echo "Here's every .cmake file actually under that prefix, to figure out the real path:" >&2
  find -L "$OPENCV4_PREFIX" -name "*.cmake" 2>/dev/null >&2
  exit 1
fi

WORK_DIR="${OPENMVS_WORK_DIR:-$HOME/openmvs_build}"
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

if [[ ! -d vcglib ]]; then
  echo "==> Cloning the VCG library (an OpenMVS dependency with no Homebrew package)..."
  git clone --depth 1 https://github.com/cdcseacave/VCG.git vcglib
fi

# TinyEXIF, TinyNPY, PoseLib, tinyply, and halfmesh (more OpenMVS dependencies
# with no Homebrew package -- normally installed via vcpkg, which this script
# deliberately avoids in favor of Homebrew) are real CMake packages, unlike
# VCG which OpenMVS just points at as a raw source tree -- each has to
# actually be built and installed so its <Name>Config.cmake exists somewhere
# OpenMVS's own find_package() calls can see, hence the separate local
# install prefix below. TinyEXIF/TinyNPY/PoseLib are REQUIRED in OpenMVS's
# SFM module and tinyply/halfmesh in its MVS module (confirmed by reading
# libs/SFM/CMakeLists.txt and libs/MVS/CMakeLists.txt on OpenMVS's actual
# default branch, "develop" -- not "master", which is a separate, less
# current branch that doesn't even have these modules).
#
# -DCMAKE_PREFIX_PATH is passed to every local dep's own configure step too
# (not just OpenMVS's), because halfmesh below depends on tinyply, which is
# itself one of these local-only deps -- without it, halfmesh's own
# find_package(tinyply CONFIG REQUIRED) wouldn't see the copy we just built.
LOCAL_PREFIX="$WORK_DIR/local"
build_local_cmake_dep() {
  local repo="$1" name="$2"; shift 2
  if [[ -f "$LOCAL_PREFIX/lib/cmake/$name/${name}Config.cmake" ]]; then
    return
  fi
  if [[ ! -d "$name" ]]; then
    echo "==> Cloning $name (an OpenMVS dependency with no Homebrew package)..."
    git clone --depth 1 "$repo" "$name"
  fi
  echo "==> Building and installing $name into $LOCAL_PREFIX..."
  cmake -S "$name" -B "$name/build" -DCMAKE_INSTALL_PREFIX="$LOCAL_PREFIX" -DCMAKE_PREFIX_PATH="$LOCAL_PREFIX" -DBUILD_SHARED_LIBS=OFF "$@"
  cmake --build "$name/build" --config Release
  cmake --install "$name/build"
}
build_local_cmake_dep "https://github.com/cdcseacave/TinyEXIF.git" "TinyEXIF"
build_local_cmake_dep "https://github.com/cdcseacave/TinyNPY.git" "TinyNPY"
# WERROR defaults ON upstream (treats every compiler warning as a build
# failure) -- turned off since AppleClang 21 is newer than this library's
# authors tested against, and a new pedantic warning shouldn't be allowed to
# block an otherwise-working build.
build_local_cmake_dep "https://github.com/PoseLib/PoseLib.git" "PoseLib" -DWERROR=OFF
build_local_cmake_dep "https://github.com/ddiakopoulos/tinyply.git" "tinyply"

# tinygltf and bshoshany-thread-pool (halfmesh's own dependencies, per its
# vcpkg.json) are header-only with no CMake config at all -- even vcpkg just
# copies their single headers onto the include path rather than building
# anything. Dropping them straight into the same local include prefix lets
# both halfmesh's and OpenMVS's own find_path() calls for them (OpenMVS's
# libs/MVS/CMakeLists.txt does its own separate find_path for tiny_gltf.h)
# succeed automatically, since CMAKE_PREFIX_PATH already covers this prefix.
# json.hpp is nlohmann/json's single header, needed because tiny_gltf.h does
# a plain #include "json.hpp" (verified straight from tinygltf's own source)
# whenever TINYGLTF_USE_RAPIDJSON isn't defined -- halfmesh doesn't define
# it, so this is required, not optional.
mkdir -p "$LOCAL_PREFIX/include"
if [[ ! -f "$LOCAL_PREFIX/include/tiny_gltf.h" ]]; then
  echo "==> Fetching tinygltf's header (an OpenMVS/halfmesh dependency with no Homebrew package or CMake config)..."
  curl -fsSL -o "$LOCAL_PREFIX/include/tiny_gltf.h" "https://raw.githubusercontent.com/syoyo/tinygltf/v3.0.0/tiny_gltf.h"
fi
if [[ ! -f "$LOCAL_PREFIX/include/json.hpp" ]]; then
  echo "==> Fetching nlohmann/json's single header (needed by tinygltf's implementation)..."
  curl -fsSL -o "$LOCAL_PREFIX/include/json.hpp" "https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp"
fi
if [[ ! -f "$LOCAL_PREFIX/include/BS_thread_pool.hpp" ]]; then
  echo "==> Fetching BS::thread_pool's header (an OpenMVS/halfmesh dependency with no Homebrew package or CMake config)..."
  curl -fsSL -o "$LOCAL_PREFIX/include/BS_thread_pool.hpp" "https://raw.githubusercontent.com/bshoshany/thread-pool/v5.1.0/include/BS_thread_pool.hpp"
fi

# halfmesh defines TINYGLTF_NO_STB_IMAGE/_WRITE itself (it bakes glTF textures
# through OpenCV instead), so stb headers are never included and don't need
# fetching -- confirmed by reading tiny_gltf.h's own include guards.
# -DOpenCV_DIR pins this to the same opencv@4 build OpenMVS itself will use
# below -- linking two different major OpenCV versions' static libs into one
# final binary would be its own bug, separate from the DataType<> conflict.
# Force a clean rebuild here: build_local_cmake_dep's normal skip-if-installed
# check would otherwise keep an earlier run's halfmesh (built before the
# opencv@4 pin existed, against whatever `opencv` happened to be linked)
# instead of picking up -DOpenCV_DIR now.
rm -rf "$LOCAL_PREFIX"/lib/cmake/halfmesh "$LOCAL_PREFIX"/lib/libhalfmesh.a "$LOCAL_PREFIX"/include/halfmesh "$WORK_DIR/halfmesh/build"
build_local_cmake_dep "https://github.com/cdcseacave/halfmesh.git" "halfmesh" \
  -DHALFMESH_BUILD_TESTS=OFF -DHALFMESH_BUILD_TOOLS=OFF -DHALFMESH_BUILD_PYTHON=OFF \
  -DOpenCV_DIR="$OPENCV4_CMAKE_DIR"

if [[ ! -d openMVS ]]; then
  echo "==> Cloning OpenMVS..."
  git clone --depth 1 https://github.com/cdcseacave/openMVS.git
fi

# Homebrew's libheif formula (an OpenMVS/libs/IO dependency, pulled in via
# pkg-config -- not installed by this script directly, but present already if
# libheif is on the machine) builds TWICE: once normally (a shared dylib whose
# own transitive codec deps are resolved automatically at load time), and once
# again as a second, separate static-only build whose libheif.a is dropped
# into the exact same lib/ directory purely for consumers who want static
# linking (verified straight from the formula's own `install` method). Static
# archives never bundle their dependencies, so that .a alone is missing
# aom/libde265/x265/webp's symbols.
#
# OpenMVS's own build (libs/IO/CMakeLists.txt's pkg_check_modules_fullpath_libs
# macro) always prefers a co-located static archive over the resolved dylib
# when one exists, which is exactly this case -- so it silently picks the
# incomplete .a and fails at link time with "undefined symbols" for those
# codecs. Rather than patch OpenMVS's vendored source (fragile against
# re-clones) or touch Homebrew's installed files, this links libheif's own
# real dependencies (confirmed directly from libheif's Homebrew formula)
# explicitly alongside it.
brew install aom libde265 x265 webp
HEIF_CODEC_LINKER_FLAGS=""
for codec_pkg in aom libde265 x265 webp; do
  HEIF_CODEC_LINKER_FLAGS="$HEIF_CODEC_LINKER_FLAGS -L$(brew --prefix "$codec_pkg")/lib"
done
HEIF_CODEC_LINKER_FLAGS="$HEIF_CODEC_LINKER_FLAGS -laom -lde265 -lx265 -lsharpyuv"

mkdir -p openMVS_build
cd openMVS_build

echo "==> Configuring (CUDA and OpenMP both off: no Mac has a CUDA GPU, and Apple's"
echo "    default clang has no OpenMP support without extra setup this script skips)..."
cmake ../openMVS \
  -DCMAKE_BUILD_TYPE=Release \
  -DVCG_ROOT="$WORK_DIR/vcglib" \
  -DCMAKE_PREFIX_PATH="$LOCAL_PREFIX" \
  -DOpenCV_DIR="$OPENCV4_CMAKE_DIR" \
  -DCMAKE_SHARED_LINKER_FLAGS="$HEIF_CODEC_LINKER_FLAGS" \
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
