# 3D Scan + Gesture Control

A local web app in two parts:

1. **Capture & reconstruct** -- guide a webcam turntable photo capture, run
   real photogrammetry (COLMAP structure-from-motion + multi-view stereo, or
   Meshroom as a fallback) on the photos, and export a web-ready `.glb` mesh.
2. **Gesture-controlled viewer** -- load that `.glb` into a three.js scene
   floating semi-transparently over your live webcam feed, and control it
   with real-time hand tracking (MediaPipe Hands) through an extensible
   gesture -> action mapping layer.

Everything runs locally: a Python/FastAPI backend does the reconstruction,
a plain HTML/JS frontend (served by the same backend) does the capture UI
and the viewer.

---

## 1. Setup

### Requirements

- Python 3.10+
- A webcam
- **COLMAP** -- see below, doesn't ship with this repo since it's a large,
  compiled, platform-specific tool. (Meshroom exists as an alternative
  engine in the code, but has no official macOS build at all -- see the
  note under "Install a photogrammetry engine" below. On macOS, COLMAP is
  your only real option.)
- Internet access the first time you open the viewer page, to fetch
  three.js and MediaPipe Hands from a CDN (see "Offline / CDN-blocked
  networks" below if that's not available on your network).

### Check what you have

```bash
python3 scripts/check_deps.py
```

This tells you exactly what's missing and what command to run for it. Do
this first -- it will save you a failed run partway through a 20-minute
reconstruction.

### Install Python dependencies

```bash
cd backend
pip3 install -r requirements.txt
```

(Consider a virtualenv: `python3 -m venv .venv && source .venv/bin/activate`
before the `pip3 install`.)

### Install a photogrammetry engine

**COLMAP (recommended)** -- does real structure-from-motion + multi-view
stereo, not an approximation.

```bash
# Ubuntu/Debian:
bash scripts/install_colmap.sh

# macOS:
brew install colmap

# Windows:
# download a prebuilt release from https://github.com/colmap/colmap/releases
# and add its bin/ folder to your PATH

# Any OS, if the above fails to build/run:
docker pull colmap/colmap:latest
```

Verify:

```bash
colmap -h   # should print COLMAP's version and command list
```

**Meshroom (fallback, Linux/Windows only)** -- AliceVision does not publish
an official macOS build, so this isn't a real option on a Mac (building it
from source yourself is possible but a significant undertaking, well
outside "download a binary"). On Linux or Windows, prebuilt and no
compiling:

```
https://alicevision.org/#meshroom  ->  download, unzip, add the folder
containing `meshroom_batch` to your PATH.
```

On macOS without a CUDA GPU (i.e. every Mac), just use COLMAP -- this app
automatically falls back to a CPU-only sparse-point-cloud mesh when dense
stereo isn't available (see "Real limitations" below for what that means
for quality), unless you also install OpenMVS (next section), which fixes
that gap without needing a GPU at all.

Re-run `python3 scripts/check_deps.py` until it reports everything ready.

### Optional: OpenMVS, for real dense reconstruction without a GPU

COLMAP's own dense multi-view stereo (`patch_match_stereo`) hard-requires a
CUDA GPU -- there's no CPU code path for it at all, which is why the CPU-only
fallback above meshes directly from the *sparse* point cloud (a few thousand
feature points) instead. [OpenMVS](https://github.com/cdcseacave/openMVS)
does the equivalent dense-reconstruction step on CPU instead, then builds a
proper surface mesh from that dense cloud and bakes your actual photos onto
it as a real texture map -- a substantial jump in both geometric detail and
visual quality over per-vertex-colored Poisson output, still without a GPU.

It's entirely optional and auto-detected: if it's installed, new scans use it
automatically; if not, the app works exactly as before. There's no Homebrew
formula for it, so it has to be built from source:

```bash
bash scripts/install_openmvs.sh
```

This installs OpenMVS's build dependencies via Homebrew (Boost, Eigen,
OpenCV, CGAL, Ceres), clones OpenMVS and its VCG library dependency, and
builds it with CUDA and OpenMP both explicitly disabled (no Mac has a CUDA
GPU, and Apple's default clang has no OpenMP support without extra setup).
Expect 20-60 minutes depending on your machine -- it's a real from-source
build of a fairly large C++ project, with the usual small chance of needing
manual troubleshooting for your specific Xcode/library versions. If it
fails, the app is completely unaffected; it just keeps using the sparse-only
fallback.

When it finishes, the script prints an `export OPENMVS_BIN_DIR=...` line --
add that to your shell profile, open a new terminal, and re-run
`python3 scripts/check_deps.py` to confirm it's detected. No other
configuration is needed; `colmap_pipeline.py` checks for OpenMVS
automatically on every scan that has no GPU available.

If you'd also like it to refine mesh geometry against the source photos
after the initial reconstruction (slower, and can meaningfully improve
surface detail on smooth/curved objects), set `OPENMVS_REFINE=1` before
starting the backend.

---

## 2. Run it

```bash
cd backend
uvicorn app:app --reload --port 8000
```

Open:

- **http://localhost:8000/index.html** -- capture a scan
- **http://localhost:8000/viewer.html** -- view + gesture-control a finished scan

The backend also serves the frontend directly (no separate dev server, no
CORS setup needed for normal local use).

### Using it from your phone (iPhone or otherwise)

Both pages work on a phone's browser -- same WiFi network, one extra setup
step. **This step is not optional for iOS**: Safari (and every other mobile
browser) only allows camera access (`getUserMedia`) on a "secure context",
which means either `https://` or the exact hostname `localhost`. Visiting
your Mac's plain `http://<lan-ip>:8000` from a phone will load the page but
silently fail to get the camera -- there's no setting or workaround for that
besides actually serving over TLS.

```bash
bash scripts/generate_dev_cert.sh
cd backend
uvicorn app:app --host 0.0.0.0 --port 8000 --ssl-keyfile=../certs/dev-key.pem --ssl-certfile=../certs/dev-cert.pem
```

Then from your phone, visit `https://<your-mac's-lan-ip>:8000/index.html`
(the script prints the exact URL it detected). Your phone will warn that the
certificate isn't trusted -- that's expected for a self-signed cert made for
local testing, not a red flag. In Safari: tap "Show Details" -> "visit this
website". The page still loads over a genuinely encrypted connection once
you do, and the camera works normally from there.

A few phone-specific things worth knowing:
- The capture page asks for the **rear** camera by default (you're scanning
  a physical object); the gesture viewer asks for the **front** camera
  (you're looking at your own hands). Both are just hints, so a laptop with
  one webcam still works fine.
- MediaPipe Hands and the three.js viewer both run happily on a modern
  iPhone, but it's genuinely more GPU/CPU work than a desktop browser doing
  the same thing -- expect it to run warmer and the battery to drain faster
  than normal camera use.
- Voice control ("say Scan") depends on the Web Speech API, which has
  inconsistent support in mobile Safari just like on desktop -- see the
  on-page status message to know whether it's actually listening on your
  device; the button always works regardless.
- The video-recording capture mode uses `MediaRecorder`, which iOS Safari
  has supported since 14.3 -- fine on any reasonably current iPhone.

---

## 3. Using it

### Part 1: Capture

1. **Enable Camera.** Grant webcam access.
2. **Capture Background.** Remove the object from frame (keep the camera and
   turntable exactly where they'll stay) and take one clean shot. This is
   used to auto-mask the object out from the background in every photo,
   which measurably improves reconstruction quality -- COLMAP otherwise
   wastes matches on a static background and can get confused by it.
3. **Turntable Capture.** Put the object back, and alternate rotate-a-bit /
   capture-a-shot, working all the way around 360 degrees. The on-screen
   ring fills in as you go (a capture-count guide -- see limitations below),
   plus a live shot counter and a per-shot blur warning (heuristic, based on
   image sharpness -- always worth glancing at the thumbnail too). Aim for
   **at least 24-36 shots**; more, denser coverage produces a noticeably
   better mesh, especially on objects with fine detail.
   - Manual **Capture Shot** (or hit Space), or toggle **Auto-Capture** for
     a fixed interval if you're rotating the object by hand and want both
     hands free.
   - Click a thumbnail's &times; to delete a bad shot before uploading.
4. **Upload & Start Reconstruction.** Uploads everything, then runs the
   pipeline on the backend. Progress updates live: current step, percentage,
   and a scrolling log tail straight from COLMAP/Meshroom's own output --
   this is not a fake progress bar.
5. When it finishes, **View in 3D Gesture Viewer** opens Part 2 with that
   scan loaded.

### Part 2: Gesture-controlled viewer

Opens your webcam again, floats the loaded model semi-transparently over the
live feed (a "holographic" look via a custom rim-glow/scanline shader, not a
solid object on a black background), and tracks your hands in real time.
A small skeleton overlay confirms what the camera sees; a badge at the
bottom of the screen confirms which gesture was just recognized. The
holographic shader shows a model's real photo texture when it has one
(OpenMVS's output) and its per-vertex color otherwise (COLMAP/Meshroom's
Poisson-based output) -- both feed through the same rim-glow/scanline
treatment.

Default gestures (all defined in one config object -- see "Extending
gestures" below):

| Gesture | Action |
|---|---|
| Move an open hand | Rotate the model |
| Pinch + drag vertically | Scale (zoom) |
| Two hands, spread apart/together | Scale (zoom) |
| Open palm | Reset view |
| Fist | Toggle wireframe (example custom callback) |
| Swipe left / right | Cycle to previous/next completed scan |
| Point | Spawn a marker at the fingertip (example custom callback) |

Scale **locks in place** the instant you stop pinching/spreading -- there's
no momentum or drift, because the scale value only changes while the
continuous gesture is actively reporting updates.

You can also drag with the mouse to orbit the camera itself (via
OrbitControls) -- useful for testing the viewer without a working camera or
hand tracking.

---

## Architecture

```
backend/
  app.py                  FastAPI app: scan lifecycle endpoints, serves frontend/
  pipeline/
    jobs.py               Per-scan status.json (progress, logs, state machine)
    masks.py               Background-subtraction masking (OpenCV)
    colmap_pipeline.py     Drives the COLMAP CLI end-to-end (SfM, then GPU/OpenMVS/sparse dense path)
    openmvs_pipeline.py    Optional CPU dense reconstruction + photo-texturing via OpenMVS
    meshroom_pipeline.py   Drives `meshroom_batch` as a fallback engine
    mesh_export.py         Cleans up + decimates + exports mesh -> .glb (trimesh/Open3D)
    runner.py              Orchestrates: pick engine -> mask -> reconstruct -> export
  scans/<scan_id>/         Per-scan working directory (raw photos, COLMAP workspace, model.glb)

frontend/
  index.html, js/capture.js       Part 1: capture UI
  viewer.html, js/viewer.js       Part 2: three.js scene + webcam compositing
  js/holo-shader.js               Holographic ShaderMaterial
  js/gestures/
    registry.js            GestureRegistry / ActionRegistry / GestureEngine (the extensible core)
    detector.js             MediaPipe Hands wiring -> FrameContext
    landmarks.js             Landmark geometry helpers
    default-gestures.js      Built-in gesture detectors (pinch, fist, swipe, ...)
    default-actions.js       Built-in actions (rotate, scale, reset, cycle, ...)

scripts/
  check_deps.py            Dependency checker with install instructions
  install_colmap.sh        COLMAP installer (Ubuntu/Debian)
```

### The COLMAP pipeline (what actually runs)

`colmap_pipeline.py` always drives `feature_extractor` -> matcher ->
`mapper` (incremental sparse reconstruction / SfM) first. The matcher choice
is now automatic and depends on whether GPU dense stereo is about to run
afterwards:
- **With a CUDA GPU** (`COLMAP_GPU=1`): `sequential_matcher`, since the
  capture UI's photos are already in turntable rotation order and dense
  stereo will do the real heavy lifting regardless of small sparse-model
  imperfections -- faster, and avoids wasting time on genuinely
  non-overlapping pairs (front vs. back of the object).
- **Without a GPU** (the default on every Mac): `exhaustive_matcher`
  instead. On this path the sparse (or OpenMVS-densified) point cloud *is*
  the final geometry, with no dense-stereo pass to smooth over drift --
  and `sequential_matcher`'s default overlap window never compares the
  last few turntable shots back against the first few, so a full
  360-degree rotation never gets its loop closed. Exhaustive matching
  compares every pair including that wrap-around; COLMAP's own geometric
  verification (RANSAC) already discards pairs that don't actually
  overlap, so this doesn't reintroduce spurious matches, and a turntable
  set (tens of images) is still fast to match exhaustively on CPU.

From the sparse model, one of three paths produces the mesh, in order of
preference -- see "Real limitations" below for what each actually looks
like:
1. **CUDA GPU available**: `image_undistorter` -> `patch_match_stereo`
   (dense depth maps) -> `stereo_fusion` (colored dense point cloud) ->
   `poisson_mesher`.
2. **No GPU, OpenMVS installed**: `image_undistorter` -> OpenMVS's
   `InterfaceCOLMAP` -> `DensifyPointCloud` (CPU dense stereo) ->
   `ReconstructMesh` -> `TextureMesh` (real photo texture). See
   `openmvs_pipeline.py`.
3. **Neither**: mesh directly from the sparse point cloud via Open3D
   Poisson reconstruction (`_mesh_from_sparse_cpu` in `colmap_pipeline.py`).

`mesh_export.py` then cleans up the result before exporting `.glb` via
trimesh: for a per-vertex-colored mesh (paths 1 and 3), it trims small
disconnected debris (a known Poisson artifact), optionally fills small
holes, decimates to a target face count, then recenters/rescales. A
UV-textured mesh (path 2) skips the trim/decimate steps -- its size was
already controlled by OpenMVS's `--target-face-num` at generation time, and
simplifying it here would risk desyncing its texture coordinates from the
decimated geometry -- but still gets recentered/rescaled. Every step in all
three paths is a genuine reconstruction step -- nothing here is a
lower-fidelity shortcut or placeholder shape.

Progress for the COLMAP steps is reported by parsing COLMAP's own stdout
progress lines (`[i/n]`, `Registering image #i`, `Processing view i/n`); if
a future COLMAP version changes that output format, the pipeline still runs
correctly, it just falls back to per-step start/end progress instead of
granular percentages. OpenMVS's steps use a time-based progress estimate
instead (an exponential curve that never claims 100% until the step
actually finishes) since we haven't verified its stdout format is stable
enough to parse the same way.

### Extending gestures

This is the part built to keep growing. To add a new gesture:

```js
// anywhere before the engine starts (e.g. in default-gestures.js, or your
// own new file imported by viewer.js)
gestureRegistry.register(
  "myGesture",
  (frameCtx) => {
    // inspect frameCtx.hands[i].landmarks (21-point MediaPipe format) and
    // frameCtx.history (rolling per-hand wrist position buffer)
    // return null (discrete: not detected) or { data } (discrete: detected)
    // or { active: bool, data } (continuous)
  },
  { type: "discrete", cooldownMs: 800 } // or { type: "continuous" }
);
```

To add a new action:

```js
actionRegistry.register("myAction", {
  onTrigger(data, api) { /* discrete gestures */ },
  onStart(data, api) { /* continuous gesture began */ },
  onUpdate(data, api) { /* continuous gesture ongoing */ },
  onEnd(data, api) { /* continuous gesture stopped */ },
});
```

`api` is the small viewer control surface defined in `viewer.js`
(`rotateBy`, `setScale`/`getScale`/`lockScale`, `resetView`, `cycleScan`,
`toggleWireframe`, `spawnMarker`, `showBadge`) -- add your own method there
if your action needs a new capability.

Then bind them -- just edit the one config object in `viewer.js`:

```js
const GESTURE_ACTION_MAP = {
  myGesture: "myAction",
  // ...
};
```

No changes to MediaPipe wiring, no changes to other gestures, no changes to
three.js code. That's the whole extension point.

---

## Real limitations (read before you scan something)

**Dense stereo requires an NVIDIA CUDA GPU -- there is no CPU version, at
all.** This is COLMAP's own limitation (and it's not alone: AliceVision's
Meshroom needs one too, and doesn't even ship an official macOS build in
the first place -- building it from source is its own project). Concretely:
- **No Mac has one.** Apple dropped NVIDIA support years ago, so this
  applies to every Mac, Apple Silicon or Intel, with or without an eGPU.
- **Most Windows/Linux laptops don't either** unless they specifically have
  a discrete NVIDIA GPU (integrated Intel/AMD graphics don't count, and
  neither do AMD discrete GPUs -- CUDA is NVIDIA-only).
- If you *do* have a working CUDA-enabled COLMAP build, set `COLMAP_GPU=1`
  before starting the backend to use it and get real dense multi-view
  stereo (millions of points, fine surface detail).
- **Without that**, this app checks for [OpenMVS](#optional-openmvs-for-real-dense-reconstruction-without-a-gpu)
  next -- a genuinely dense, CPU-only reconstruction + real photo-texturing
  path (see the setup section above for why this is a much better default
  than it sounds: OpenMVS's dense stereo is CPU-native, not a CUDA feature
  running in a slow compatibility mode). Install it once with
  `bash scripts/install_openmvs.sh` and every future scan benefits
  automatically, no GPU needed.
- **Without OpenMVS either** (the true last resort), this app falls back to
  building the mesh directly from COLMAP's *sparse* point cloud (Poisson
  surface reconstruction via Open3D, entirely CPU-based, no extra installs
  at all). This is a real reconstruction from your photos, but a much
  rougher one -- typically hundreds to a few thousand points instead of the
  hundreds of thousands OpenMVS or CUDA dense stereo produce, so expect a
  blobby overall shape that captures the object's rough form, not fine
  surface texture or detail. A cloud GPU instance or a paid hosted
  photogrammetry API are the only ways to get *more* detail than OpenMVS's
  CPU path, and neither is set up here.

**Processing time.** The CPU sparse-fallback path (no GPU, no OpenMVS)
completes in seconds to a couple minutes -- it's fast because it's not doing
dense reconstruction at all. The full CUDA dense pipeline (feature
extraction -> matching -> SfM -> dense stereo -> meshing) on a 30-50 photo
scan commonly takes **5-30+ minutes**, with dense stereo
(`patch_match_stereo`) as the slowest step by far. OpenMVS's CPU dense path
lands in a similar range to the CUDA pipeline or somewhat slower depending
on your machine -- `DensifyPointCloud` is real multi-view stereo running on
CPU instead of GPU, so it's genuinely doing that much work, not skipping it.
There is no way around dense reconstruction being slow when it runs -- the
progress UI is there so it's honest about that rather than making it look
broken.

**Lighting and background requirements.** COLMAP needs sharp, well-textured,
consistently-lit photos with genuine overlap between consecutive views.
Concretely:
- Diffuse, even lighting. Hard shadows or shifting sunlight between shots
  actively hurt feature matching.
- Non-reflective, non-transparent objects work far better. Shiny metal,
  glass, and glossy plastic confuse both SfM matching and dense stereo
  (their appearance changes with viewpoint, breaking the "same point looks
  the same from multiple angles" assumption the whole pipeline relies on).
- Plain, static, non-reflective background (a poster board or featureless
  wall works well) -- and the background-plate masking step matters a lot
  here.
- Textured object surfaces reconstruct much better than flat, uniformly
  colored ones (SfM literally cannot triangulate points it can't uniquely
  identify across photos).
- Keep the camera-to-object distance roughly steady if capturing by hand;
  large swings in framing between shots hurt, but see the very next point --
  height/tilt is the one thing you deliberately *should* vary.

**A flat, single-height turntable spin produces a flattened, "2D-looking"
result -- this is expected, not a bug.** Rotating an object on a turntable
while the camera stays at one fixed height/angle for the whole 360 degrees
is a classic degenerate case for structure-from-motion: that motion pattern
gives the solver very weak depth cues, especially combined with a webcam's
unknown intrinsics (no real focal length/distortion calibration, just an
initial guess COLMAP refines as it goes). The fix is capture technique, not
a setting: vary the camera's height or tilt across the sequence -- roughly a
third of shots angled down from above, a third level, a third angled up from
below -- rather than one perfectly flat sweep. That's the difference between
a recognizable 3D shape and a flat blob from the exact same object. Saying
this once in the instructions text at the top of the page wasn't enough to
actually change people's capture habits mid-scan, so the capture flow now
pauses itself every 6 shots with an unmissable on-video banner (auto-capture
included -- it holds off the next shot until you've had a few seconds to
react) telling you to change height/tilt right now, not just reminding you
once at the start.

**The coverage ring is a capture-count guide, not real angle estimation.**
It assumes each shot is one even rotation step of a full 360-degree turn; it
does not analyze the photo to detect the object's actual turned angle. If
your rotation increments are uneven, the ring will look more "complete" than
your actual coverage is -- use it as a shot-count reminder, not a
computer-vision-verified coverage map.

**Blur detection is a heuristic.** It flags shots with low edge-variance in
a downsampled grayscale frame -- fast to compute in-browser, but it can
both miss real blur and occasionally flag a genuinely sharp but
low-texture shot. Always glance at flagged thumbnails yourself.

**The live object outline is background-subtraction, not object
recognition.** When you capture the background plate, it samples 8 frames
and averages them (canceling out per-frame sensor noise a single snapshot
would bake in) while measuring how much those frames actually differ from
each other frame-to-frame -- that measured noise level sets the detection
threshold for the rest of the session (clamped to a sane range), rather than
one fixed number that's either too twitchy on a noisy webcam or too
insensitive on a clean one. Each live frame is then compared against that
background in full color (a 3-channel distance, not grayscale luminance),
since a same-*brightness*-different-*color* object is a real case a
brightness-only diff would simply miss. Before thresholding, it also
estimates and cancels out any global exposure/white-balance shift the
camera's auto-adjustment introduced since the background was captured (the
median per-cell color diff across the *entire* grid, which approximates that
shift as long as the object covers a minority of the frame) -- without this,
a webcam re-brightening the whole image the instant a hand or object enters
frame reads as if the entire wall behind it "changed," which looked like the
outline going haywire and tracing the room instead of the object. The result
is then cleaned up with a 3x3 erode-then-dilate pass that wipes out isolated
sensor-noise speckles before they can ever be mistaken for a separate small
object. It then traces
the actual pixel-level silhouette of whatever's left (an 8-connected
boundary walk, smoothed to remove staircase jitter), not a convex hull -- so
a concave shape (a mug's handle gap, an L-shaped object) is drawn as its
real outline rather than a bulged-out shape that bridges over the notch.
This all happens after erasing a disk around each detected
hand landmark plus a corridor from the wrist toward the nearest frame edge
(approximating the forearm, which MediaPipe doesn't track) so a held object
doesn't just get lumped in with your hand/arm as one blob. Candidate regions
that touch the frame border get a soft penalty rather than being rejected
outright (a border-hugging region is usually a lighting artifact or an
unmasked bit of arm, but a legitimately large or tightly-framed object can
touch an edge too, and should still win when it's clearly the best
candidate); only a region covering virtually the *entire* frame -- a global
exposure/white-balance shift, not an actual object -- gets thrown out
completely. It only ever draws **one** outline: with nothing locked on yet,
it takes the single largest candidate, even if several distinct things
changed in the same frame. Once something is locked on, a new candidate has
to both sit near the same spot *and* be a similar size to take over the lock
-- a hand or a second object passing nearby can't steal it just by being
slightly closer. A brief miss (a hand fully covering the object for a
frame or two, a flash of glare) doesn't drop the lock either; it keeps
drawing the last known outline for about half a second before giving up and
letting the next thing it sees become the new lock. None of that makes it
object recognition, though: it isn't aware of what the object *is*, only
that something changed from the empty background near your hand. If the
object leaves frame for good and something else (a second object, your own
arm) is now the biggest change from the background, that's what it'll lock
onto next -- it can't tell "your object" apart from "whatever's different"
by identity, only by size and position continuity. It's a live sanity check
on framing, not a guarantee of what will end up in the reconstruction.

**Hardware constraints.**
- No GPU is required to run the pipeline, but expect the CPU-only timings
  above.
- Dense reconstruction is memory-hungry with high photo counts/resolutions;
  if `patch_match_stereo` runs out of memory, retry with fewer/smaller
  photos (the pipeline undistorts to `--max_image_size 2000` by default,
  configurable in `colmap_pipeline.py`).
- MediaPipe Hands runs happily on CPU in-browser, but a weak/old GPU can
  make the three.js render loop choppy at high resolutions; the app doesn't
  down-res the viewer canvas automatically.

**Reconstruction can fail outright.** Too few overlapping photos, extreme
motion blur, or a featureless/reflective object can leave COLMAP unable to
register enough images into a sparse model. When that happens the pipeline
reports a clear error (not a silent bad mesh) with the reason; see the
Troubleshooting section.

**Gesture detection is heuristic geometry, not a trained classifier.**
Finger-extension/curl thresholds, pinch distance ratios, and swipe velocity
thresholds are tuned by hand and work well in normal indoor lighting with a
hand clearly in frame, but can misfire in poor lighting, at extreme angles,
or with unusual hand shapes. All thresholds are simple constants at the top
of `default-gestures.js` if you need to retune them for your setup.

**Offline / CDN-blocked networks.** `viewer.html` loads three.js and
MediaPipe Hands from `cdn.jsdelivr.net` at runtime via an import map. On a
network that blocks that CDN, the viewer shows a clear on-screen error
rather than a blank page. To run fully offline:
1. `npm install three@0.169.0` and copy `node_modules/three/build/` and
   `node_modules/three/examples/jsm/` into `frontend/vendor/three/`.
2. Update the `<script type="importmap">` block in `viewer.html` to point
   at `vendor/three/...` instead of the CDN URLs.
3. Download the MediaPipe Hands WASM/model assets and change the
   `locateFile` callback in `frontend/js/gestures/detector.js` to point at
   your local copy instead of `cdn.jsdelivr.net`.

---

## Troubleshooting

- **`COLMAP could not reconstruct a sparse model from these photos.`** or
  **only a handful of your photos show up as "Registered" / most log lines
  say `Could not register, trying another image`** -- almost always means
  consecutive photos didn't actually change viewpoint enough for COLMAP to
  triangulate anything. This happens if you click "Capture Shot" repeatedly
  without genuinely rotating the object a real, visible amount between each
  shot (rotating it in your head doesn't count -- the object itself has to
  visibly turn in the frame). Retake the set making sure each shot is a
  distinct ~10-degree turn from the last, with good overlap between
  consecutive views, more even lighting, and a more textured/less
  reflective object.
- **`colmap: command not found`** -- run `python3 scripts/check_deps.py` and
  follow its instructions, or `bash scripts/install_colmap.sh` on
  Ubuntu/Debian.
- **`Dense stereo reconstruction requires CUDA, which is not available on
  your system.`** -- expected on any machine without an NVIDIA GPU
  (including every Mac). Not an error to fix -- the app automatically uses
  the CPU sparse-mesh fallback instead once you retry. See "Real
  limitations" above for what that means for output quality.
- **Stuck at "dense_stereo" for a very long time** -- this is genuinely the
  slowest step; check the live log tail in the capture page to confirm it's
  still emitting `Processing view i/n` lines rather than actually stuck.
- **Viewer shows "Couldn't load the 3D viewer"** -- your network is blocking
  the CDN. See "Offline / CDN-blocked networks" above.
- **"Hand tracking ready" but gestures don't fire** -- check the skeleton
  overlay is actually drawing on your hand; if not, improve lighting or
  move your hand fully into frame. If the skeleton looks right but a
  specific gesture won't trigger, the heuristic thresholds in
  `default-gestures.js` may need retuning for your hand size/camera angle.
