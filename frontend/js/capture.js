// Turntable capture UI: webcam access, background plate step, guided
// multi-shot capture with a coverage ring + blur warnings, then upload and
// kick off backend reconstruction with live progress polling.
import { GestureDetectorSystem } from "./gestures/detector.js";

(() => {
  "use strict";

  const TARGET_SHOTS = 36; // 360 / 36 = 10 degrees/shot -- a reasonable default density
  const BLUR_VARIANCE_THRESHOLD = 25; // below this, flag the shot as likely blurry

  // Live object-outline detection: the same background-subtraction idea the
  // backend uses for masking (masks.py), just done cheaply in-browser on a
  // small grid so it can run every frame as a continuous preview of what the
  // app currently sees as "the object", well before any photo is taken.
  const OUTLINE_GRID_W = 120;
  const OUTLINE_GRID_H = 68;
  const OUTLINE_DIFF_THRESHOLD = 25;
  const OUTLINE_MIN_COMPONENT_FRACTION = 0.01; // ignore blobs smaller than 1% of the grid as noise

  const COLMAP_STEPS = [
    "masking", "feature_extraction", "matching", "sparse_reconstruction",
    "undistortion", "dense_stereo", "stereo_fusion", "meshing", "mesh_export",
  ];
  const MESHROOM_STEPS = ["masking", "meshroom_batch", "mesh_export"];

  const $ = (id) => document.getElementById(id);
  const video = $("video");
  const overlay = $("overlay");
  const octx = overlay.getContext("2d");

  let stream = null;
  let backgroundBlob = null;
  let backgroundGrayGrid = null; // Float32Array, OUTLINE_GRID_W x OUTLINE_GRID_H, set once background is captured
  let shots = []; // { blob, sharpness, blurry }
  let autoTimer = null;
  let scanId = null;
  let pollTimer = null;
  let lastOutlineHull = null; // grid-space convex hull points from the most recent frame, or null
  let lastOutlineCentroid = null; // grid-space {x,y} of the locked-on object, for frame-to-frame continuity
  let latestHandLandmarks = []; // most recent frame's hands, each a 21-point landmark array in raw (unmirrored) video-normalized coords
  let handDetectorStarted = false;

  // ---------- Camera setup ----------------------------------------------------

  async function listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    const select = $("camera-select");
    select.innerHTML = "";
    cams.forEach((c, i) => {
      const opt = document.createElement("option");
      opt.value = c.deviceId;
      opt.textContent = c.label || `Camera ${i + 1}`;
      select.appendChild(opt);
    });
    select.style.display = cams.length > 1 ? "inline-block" : "none";
  }

  async function startCamera(deviceId) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    const constraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // Scanning a physical object means the *rear* camera on a phone --
        // only used as a hint (not "exact") so it's harmless on laptops with
        // a single front-facing webcam.
        facingMode: deviceId ? undefined : { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await new Promise((res) => (video.onloadedmetadata = res));
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    startHandMaskingIfNeeded();
    await listCameras();
    $("bg-panel").style.display = "block";
  }

  $("btn-start-cam").addEventListener("click", async () => {
    // Speech recognition has to be started from inside a real user click,
    // not on page load -- browsers treat it like any other mic-permission
    // API and reject an unsolicited start with a "not-allowed" error, so
    // this piggybacks on the same click as enabling the camera.
    initVoiceControl();
    try {
      await startCamera(null);
      $("btn-start-cam").textContent = "Camera Active";
      $("btn-start-cam").disabled = true;
    } catch (err) {
      alert("Could not access camera: " + err.message);
    }
  });

  $("camera-select").addEventListener("change", (e) => startCamera(e.target.value));

  // ---------- Frame capture + sharpness -----------------------------------------

  function grabFrameCanvas() {
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c;
  }

  // Fast approximate blur detector: downsample to a small grayscale image and
  // compute the variance of a simple Laplacian-like convolution. Low variance
  // means few sharp edges, i.e. probably motion-blurred or out of focus. This
  // is a heuristic, not a substitute for reviewing the actual thumbnail.
  function estimateSharpness(sourceCanvas) {
    const w = 160, h = Math.round((160 * sourceCanvas.height) / sourceCanvas.width);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(sourceCanvas, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    const lap = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const val =
          4 * gray[idx] - gray[idx - 1] - gray[idx + 1] - gray[idx - w] - gray[idx + w];
        lap.push(val);
      }
    }
    const mean = lap.reduce((a, b) => a + b, 0) / lap.length;
    const variance = lap.reduce((a, v) => a + (v - mean) ** 2, 0) / lap.length;
    return variance;
  }

  function canvasToBlob(canvas, quality = 0.92) {
    return new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  }

  // ---------- Live object outline (background-subtraction on a small grid) ---

  const outlineGridCanvas = document.createElement("canvas");
  outlineGridCanvas.width = OUTLINE_GRID_W;
  outlineGridCanvas.height = OUTLINE_GRID_H;
  const outlineGridCtx = outlineGridCanvas.getContext("2d", { willReadFrequently: true });

  function computeGrayGrid(source) {
    outlineGridCtx.drawImage(source, 0, 0, OUTLINE_GRID_W, OUTLINE_GRID_H);
    const { data } = outlineGridCtx.getImageData(0, 0, OUTLINE_GRID_W, OUTLINE_GRID_H);
    const gray = new Float32Array(OUTLINE_GRID_W * OUTLINE_GRID_H);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return gray;
  }

  // 4-connected flood fill returning every connected foreground component
  // (not just the largest) plus whether each one touches the grid edge.
  function getAllComponents(mask, gw, gh) {
    const visited = new Uint8Array(gw * gh);
    const idx = (x, y) => y * gw + x;
    const components = [];
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = idx(x, y);
        if (!mask[i] || visited[i]) continue;
        const stack = [[x, y]];
        visited[i] = 1;
        const points = [];
        let touchesBorder = false;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          points.push({ x: cx, y: cy });
          if (cx === 0 || cy === 0 || cx === gw - 1 || cy === gh - 1) touchesBorder = true;
          const neighbors = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
          for (const [nx, ny] of neighbors) {
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const ni = idx(nx, ny);
            if (mask[ni] && !visited[ni]) {
              visited[ni] = 1;
              stack.push([nx, ny]);
            }
          }
        }
        components.push({ points, touchesBorder });
      }
    }
    return components;
  }

  function centroidOf(points) {
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    return { x: sx / points.length, y: sy / points.length };
  }

  // Picks which connected component is "the object", rather than blindly
  // taking whatever's biggest this frame. Border-touching and near-full-
  // frame candidates get a score *penalty*, not a hard rejection -- an
  // earlier version hard-rejected both, which correctly filtered out
  // lighting-artifact noise but also blocked perfectly legitimate large or
  // tightly-framed objects, so nothing ever got drawn. A real, well-framed
  // object should still win even while touching an edge or filling most of
  // the frame, as long as it's clearly the best candidate available.
  //  - only a candidate covering virtually the *entire* frame (a global
  //    exposure/white-balance shift, not a real object) is rejected outright
  //  - once something is locked on, prefers whatever's closest to where it
  //    was last frame over whatever's technically largest this frame, so a
  //    same-instant larger blob elsewhere doesn't steal the lock.
  function pickObjectComponent(mask, gw, gh, lastCentroid) {
    const total = gw * gh;
    const minFraction = OUTLINE_MIN_COMPONENT_FRACTION;
    const maxFraction = 0.97; // reject only "virtually the whole frame changed"
    const candidates = getAllComponents(mask, gw, gh).filter((c) => {
      const frac = c.points.length / total;
      return frac >= minFraction && frac <= maxFraction;
    });
    if (!candidates.length) return null;

    const gridDiag = Math.hypot(gw, gh);
    let best = null, bestScore = -Infinity;
    for (const c of candidates) {
      const sizeScore = c.points.length / total;
      const borderPenalty = c.touchesBorder ? 0.12 : 0;
      // Distance-from-last-lock dominates the score once something's
      // tracked, so a real object doesn't get outvoted by a same-instant
      // larger blob elsewhere (a stray shadow, background noise) -- that
      // flip-flopping between candidates is what "randomly selecting
      // different things" looked like before this scoring existed.
      const dist = lastCentroid
        ? Math.hypot(centroidOf(c.points).x - lastCentroid.x, centroidOf(c.points).y - lastCentroid.y) / gridDiag
        : 0;
      const score = sizeScore - borderPenalty - dist * 1.2;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best.points;
  }

  function hullCross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  // Andrew's monotone chain convex hull. This traces the outer boundary of
  // whatever's different from the background plate -- for most household
  // objects that's a good, robust approximation of their silhouette, and
  // much simpler (and less bug-prone) to get right than pixel-level contour
  // tracing with concave notches.
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && hullCross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && hullCross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  // Starts live hand tracking (reusing the same MediaPipe wrapper the
  // gesture viewer uses) purely so the outline detector can tell "your hand"
  // apart from "the thing in your hand" -- without this, a hand touching the
  // object just merges into one big blob, and the loudest/largest connected
  // shape is often more hand+arm than object. If MediaPipe fails to load
  // (e.g. no internet for the CDN script), the outline falls back to plain
  // largest-blob detection rather than breaking capture entirely.
  function startHandMaskingIfNeeded() {
    if (handDetectorStarted) return;
    handDetectorStarted = true;
    const handDetector = new GestureDetectorSystem(video, {
      mirror: false, // this page's video isn't CSS-mirrored, so raw MediaPipe coords already match the overlay canvas
      onResults: (ctx) => {
        latestHandLandmarks = ctx.hands.map((h) => h.landmarks);
      },
      onHandsStatus: () => {},
    });
    handDetector
      .init()
      .then(() => handDetector.start())
      .catch((e) => {
        console.warn("Hand detection unavailable, outline will use largest-blob only:", e.message);
      });
  }

  // Zeroes out a small disk around every hand landmark so the hand's own
  // silhouette doesn't get counted as part of "the object" -- a rough
  // approximation (21 points per hand, not a pixel-perfect hand mask), but
  // enough to disconnect a held object from the arm holding it.
  function excludeHandsFromMask(mask, gw, gh) {
    const radius = Math.round(gw * 0.045); // ~5px on a 120-wide grid
    for (const landmarks of latestHandLandmarks) {
      for (const p of landmarks) {
        const cx = Math.round(p.x * gw);
        const cy = Math.round(p.y * gh);
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy > radius * radius) continue;
            const x = cx + dx, y = cy + dy;
            if (x >= 0 && y >= 0 && x < gw && y < gh) mask[y * gw + x] = 0;
          }
        }
      }
      // MediaPipe only tracks the hand itself (wrist to fingertips), not the
      // forearm -- left unmasked, that forearm segment can bridge the held
      // object to the frame edge, or just look like a stray arm-shaped
      // component. Approximate it by blanking a corridor from the wrist
      // toward whichever frame edge is closest (the direction the arm is
      // most likely continuing off-screen).
      const wrist = landmarks[0];
      const gx = Math.round(wrist.x * gw), gy = Math.round(wrist.y * gh);
      const distances = { left: wrist.x, right: 1 - wrist.x, top: wrist.y, bottom: 1 - wrist.y };
      const nearestEdge = Object.keys(distances).reduce((a, b) => (distances[a] < distances[b] ? a : b));
      const halfWidth = Math.round(gw * 0.035);
      if (nearestEdge === "left" || nearestEdge === "right") {
        const xRange = nearestEdge === "left" ? [0, gx] : [gx, gw - 1];
        for (let x = xRange[0]; x <= xRange[1]; x++) {
          for (let dy = -halfWidth; dy <= halfWidth; dy++) {
            const y = gy + dy;
            if (x >= 0 && x < gw && y >= 0 && y < gh) mask[y * gw + x] = 0;
          }
        }
      } else {
        const yRange = nearestEdge === "top" ? [0, gy] : [gy, gh - 1];
        for (let y = yRange[0]; y <= yRange[1]; y++) {
          for (let dx = -halfWidth; dx <= halfWidth; dx++) {
            const x = gx + dx;
            if (x >= 0 && x < gw && y >= 0 && y < gh) mask[y * gw + x] = 0;
          }
        }
      }
    }
  }

  // Recomputes the live outline from the current video frame. Cheap enough
  // (a 120x68 grid) to call every animation frame.
  function updateObjectOutline() {
    if (!backgroundGrayGrid || video.readyState < 2) {
      lastOutlineHull = null;
      lastOutlineCentroid = null;
      return;
    }
    const currentGray = computeGrayGrid(video);
    const mask = new Uint8Array(OUTLINE_GRID_W * OUTLINE_GRID_H);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = Math.abs(currentGray[i] - backgroundGrayGrid[i]) > OUTLINE_DIFF_THRESHOLD ? 1 : 0;
    }
    if (latestHandLandmarks.length) excludeHandsFromMask(mask, OUTLINE_GRID_W, OUTLINE_GRID_H);
    // Only ever the single object component -- "one thing at a time" --
    // picked by size plus temporal continuity with the last frame's lock
    // rather than just whatever's biggest this instant (see
    // pickObjectComponent for why: that's what stops it flickering between
    // different regions).
    const component = pickObjectComponent(mask, OUTLINE_GRID_W, OUTLINE_GRID_H, lastOutlineCentroid);
    if (component) {
      lastOutlineCentroid = centroidOf(component);
      lastOutlineHull = convexHull(component);
    } else {
      lastOutlineCentroid = null;
      lastOutlineHull = null;
    }
  }

  function drawObjectOutline() {
    if (!lastOutlineHull || lastOutlineHull.length < 3) return;
    const sx = overlay.width / OUTLINE_GRID_W;
    const sy = overlay.height / OUTLINE_GRID_H;
    octx.save();
    octx.beginPath();
    lastOutlineHull.forEach((p, i) => {
      const x = (p.x + 0.5) * sx;
      const y = (p.y + 0.5) * sy;
      if (i === 0) octx.moveTo(x, y);
      else octx.lineTo(x, y);
    });
    octx.closePath();
    octx.lineJoin = "round";
    octx.fillStyle = "rgba(51, 224, 255, 0.12)";
    octx.strokeStyle = "#33e0ff";
    octx.lineWidth = 3;
    octx.shadowColor = "#33e0ff";
    octx.shadowBlur = 8;
    octx.fill();
    octx.stroke();
    octx.restore();
  }

  // Continuous render loop for the overlay: live object outline underneath,
  // coverage ring on top, running the whole time the camera is on rather
  // than only redrawing on specific button clicks.
  function overlayLoop() {
    if (overlay.width && overlay.height) {
      octx.clearRect(0, 0, overlay.width, overlay.height);
      updateObjectOutline();
      drawObjectOutline();
      drawCoverageRingOnly();
    }
    requestAnimationFrame(overlayLoop);
  }
  requestAnimationFrame(overlayLoop);

  // ---------- Background step -----------------------------------------------

  $("btn-capture-bg").addEventListener("click", async () => {
    const canvas = grabFrameCanvas();
    backgroundBlob = await canvasToBlob(canvas);
    backgroundGrayGrid = computeGrayGrid(video);
    $("bg-status").textContent = "Background captured ✓ -- live object outline is now active below.";
    $("capture-panel").style.display = "block";
    $("deg-per-shot").textContent = Math.round(360 / TARGET_SHOTS);
    $("target-shots-label").textContent = TARGET_SHOTS;
  });

  // ---------- Turntable capture -----------------------------------------------

  function renderThumbs() {
    const grid = $("thumbs");
    grid.innerHTML = "";
    shots.forEach((shot, i) => {
      const div = document.createElement("div");
      div.className = "thumb" + (shot.blurry ? " blurry" : "");
      const img = document.createElement("img");
      img.src = URL.createObjectURL(shot.blob);
      div.appendChild(img);
      const idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = i + 1;
      div.appendChild(idx);
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.onclick = () => {
        shots.splice(i, 1);
        renderThumbs();
        updateStats();
      };
      div.appendChild(del);
      if (shot.blurry) {
        const b = document.createElement("span");
        b.className = "blur-badge";
        b.textContent = "possibly blurry";
        div.appendChild(b);
      }
      grid.appendChild(div);
    });
  }

  function updateStats() {
    $("shot-count").textContent = shots.length;
    $("coverage-pct").textContent = Math.min(100, Math.round((shots.length / TARGET_SHOTS) * 100)) + "%";
    $("blur-count").textContent = shots.filter((s) => s.blurry).length;
    $("upload-panel").style.display = shots.length >= 8 ? "block" : "none";
  }

  // Draws a ring of tick marks around the video, one per target shot slot,
  // filled in as shots are taken. This assumes each capture corresponds to
  // one even rotation step -- it's a capture-count guide, not a real computer
  // vision estimate of the object's actual turned angle. Called from the
  // continuous overlayLoop, which owns clearing the canvas each frame.
  function drawCoverageRingOnly() {
    const w = overlay.width, h = overlay.height;
    if (!w || !h) return;
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.46;
    for (let i = 0; i < TARGET_SHOTS; i++) {
      const angle = (i / TARGET_SHOTS) * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + Math.cos(angle) * r;
      const y1 = cy + Math.sin(angle) * r;
      const x2 = cx + Math.cos(angle) * (r - 14);
      const y2 = cy + Math.sin(angle) * (r - 14);
      octx.strokeStyle = i < shots.length ? "#33e0ff" : "rgba(255,255,255,0.25)";
      octx.lineWidth = 3;
      octx.beginPath();
      octx.moveTo(x1, y1);
      octx.lineTo(x2, y2);
      octx.stroke();
    }
  }

  async function captureShot() {
    const canvas = grabFrameCanvas();
    const sharpness = estimateSharpness(canvas);
    const blob = await canvasToBlob(canvas);
    shots.push({ blob, sharpness, blurry: sharpness < BLUR_VARIANCE_THRESHOLD });
    renderThumbs();
    updateStats();
    flashCapture();
  }

  function flashCapture() {
    overlay.style.filter = "brightness(2)";
    setTimeout(() => (overlay.style.filter = ""), 100);
  }

  $("btn-capture-shot").addEventListener("click", captureShot);
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && $("capture-panel").style.display !== "none") {
      e.preventDefault();
      captureShot();
    }
  });

  // Auto-capture used to fire on a bare interval with zero warning, so
  // there was no way to see what was actually about to be photographed.
  // This drives a live countdown instead: the overlay always shows time
  // remaining until the next shot, so the current framing is visible right
  // up to (and through) the moment it's captured.
  const countdownEl = $("countdown-overlay");
  let nextCaptureAt = 0;
  let lastWholeSecond = -1;

  function updateCountdownOverlay() {
    const remainingMs = Math.max(0, nextCaptureAt - performance.now());
    const remainingSec = remainingMs / 1000;
    const wholeSecond = Math.ceil(remainingSec);
    if (wholeSecond !== lastWholeSecond) {
      lastWholeSecond = wholeSecond;
      countdownEl.classList.add("tick");
      setTimeout(() => countdownEl.classList.remove("tick"), 120);
    }
    countdownEl.innerHTML = `\u{1F4F7} next shot in <span class="num">${remainingSec.toFixed(1)}</span>s`;
  }

  $("btn-auto-toggle").addEventListener("click", () => {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
      countdownEl.style.display = "none";
      $("btn-auto-toggle").textContent = "Start Auto-Capture";
      return;
    }
    const intervalSec = parseFloat($("auto-interval").value) || 2;
    $("btn-auto-toggle").textContent = `Auto-capturing (every ${intervalSec}s) - click to stop`;
    countdownEl.style.display = "flex";
    nextCaptureAt = performance.now() + intervalSec * 1000;
    lastWholeSecond = -1;
    autoTimer = setInterval(() => {
      updateCountdownOverlay();
      if (performance.now() >= nextCaptureAt) {
        captureShot();
        nextCaptureAt = performance.now() + intervalSec * 1000;
        lastWholeSecond = -1;
      }
    }, 100);
  });

  // ---------- Record-and-extract capture ---------------------------------------
  // Alternative to clicking a shot every rotation step: record a short video
  // while turning the object, then pull evenly-spaced frames out of it
  // afterward. Triggerable by a click or by saying "scan" (voice control is
  // feature-detected -- most non-Chromium browsers, Safari included as of
  // this writing, don't implement SpeechRecognition, so it degrades to the
  // button only rather than silently doing nothing).

  const MAX_RECORD_SECONDS = 45;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordTimerInterval = null;
  let recordStartTime = 0;

  function pickRecorderMimeType() {
    const candidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4",
    ];
    return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  }

  function isRecording() {
    return !!mediaRecorder && mediaRecorder.state === "recording";
  }

  function startRecording() {
    if (!stream) {
      $("record-status").textContent = "Enable the camera first (step 1) before recording.";
      return;
    }
    if (isRecording()) return;
    const mimeType = pickRecorderMimeType();
    if (!window.MediaRecorder || !mimeType) {
      $("record-status").textContent = "Video recording isn't supported in this browser -- use Capture Shot / Auto-Capture instead.";
      return;
    }
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => onRecordingStopped(mimeType);
    mediaRecorder.start();
    recordStartTime = performance.now();

    const btn = $("btn-record-toggle");
    btn.textContent = "⏹ Stop Recording (0s)";
    btn.classList.add("recording");
    recordTimerInterval = setInterval(() => {
      const elapsed = (performance.now() - recordStartTime) / 1000;
      btn.textContent = `⏹ Stop Recording (${elapsed.toFixed(0)}s)`;
      if (elapsed >= MAX_RECORD_SECONDS) stopRecording();
    }, 250);
    $("record-status").textContent = "Recording -- rotate the object smoothly and evenly, then stop when you've gone all the way around.";
  }

  function stopRecording() {
    if (!isRecording()) return;
    mediaRecorder.stop();
    clearInterval(recordTimerInterval);
    const btn = $("btn-record-toggle");
    btn.textContent = "⏺ Start Recording";
    btn.classList.remove("recording");
  }

  async function onRecordingStopped(mimeType) {
    $("record-status").textContent = "Extracting frames from the recording…";
    const blob = new Blob(recordedChunks, { type: mimeType });
    try {
      const frames = await extractFramesFromVideoBlob(blob, TARGET_SHOTS);
      for (const canvas of frames) {
        const sharpness = estimateSharpness(canvas);
        const frameBlob = await canvasToBlob(canvas);
        shots.push({ blob: frameBlob, sharpness, blurry: sharpness < BLUR_VARIANCE_THRESHOLD });
      }
      renderThumbs();
      updateStats();
      $("record-status").textContent = `Pulled ${frames.length} frames from the recording. Review the thumbnails below, then upload.`;
    } catch (err) {
      $("record-status").textContent = "Couldn't extract frames from the recording: " + err.message;
    }
  }

  // Seeks a hidden <video> element through the recorded blob at evenly
  // spaced timestamps and grabs a still frame at each one. This runs after
  // recording stops, not live, so it doesn't compete with the camera preview.
  function extractFramesFromVideoBlob(blob, targetCount) {
    return new Promise((resolve, reject) => {
      const offscreenVideo = document.createElement("video");
      offscreenVideo.muted = true;
      offscreenVideo.playsInline = true;
      offscreenVideo.src = URL.createObjectURL(blob);

      offscreenVideo.onloadedmetadata = async () => {
        let duration = offscreenVideo.duration;
        if (!isFinite(duration) || duration <= 0) {
          // MediaRecorder blobs commonly report duration as Infinity/NaN
          // until the browser has actually scanned the whole stream --
          // seeking near the end forces that scan and fixes it up. This is
          // a known quirk of MediaRecorder-produced media, not a bug in the
          // recording itself.
          duration = await fixInfiniteDuration(offscreenVideo);
        }
        if (!isFinite(duration) || duration <= 0) {
          reject(new Error("recorded video has no usable duration"));
          return;
        }
        const frames = [];
        // Trim a small margin off each end -- the first/last few frames are
        // often where a hand is still moving into/out of frame.
        const margin = Math.min(0.5, duration * 0.05);
        const usable = Math.max(0.01, duration - margin * 2);
        for (let i = 0; i < targetCount; i++) {
          const t = margin + (usable * i) / Math.max(1, targetCount - 1);
          await seekTo(offscreenVideo, t);
          const canvas = document.createElement("canvas");
          canvas.width = offscreenVideo.videoWidth;
          canvas.height = offscreenVideo.videoHeight;
          canvas.getContext("2d").drawImage(offscreenVideo, 0, 0, canvas.width, canvas.height);
          frames.push(canvas);
        }
        URL.revokeObjectURL(offscreenVideo.src);
        resolve(frames);
      };
      offscreenVideo.onerror = () => reject(new Error("failed to load recorded video for frame extraction"));
    });
  }

  function fixInfiniteDuration(videoEl) {
    return new Promise((resolve) => {
      const onTimeUpdate = () => {
        videoEl.removeEventListener("timeupdate", onTimeUpdate);
        const fixed = videoEl.duration;
        videoEl.currentTime = 0;
        resolve(fixed);
      };
      videoEl.addEventListener("timeupdate", onTimeUpdate);
      videoEl.currentTime = 1e10; // seeking past the end forces a real duration to be computed
    });
  }

  function seekTo(videoEl, time) {
    return new Promise((resolve) => {
      const onSeeked = () => {
        videoEl.removeEventListener("seeked", onSeeked);
        resolve();
      };
      videoEl.addEventListener("seeked", onSeeked);
      videoEl.currentTime = time;
    });
  }

  $("btn-record-toggle").addEventListener("click", () => {
    if (isRecording()) stopRecording();
    else startRecording();
  });

  // ---------- Voice control ("say 'Scan'") -------------------------------------

  // Errors that mean "the browser/user refused permission" -- retrying
  // immediately just reproduces the same error forever, so these stop the
  // listener instead of restarting it. Everything else (no-speech timeouts,
  // transient network hiccups) is worth auto-restarting.
  const VOICE_FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed"]);

  let voiceControlStarted = false;

  function initVoiceControl() {
    if (voiceControlStarted) return; // guard against the click handler firing more than once
    voiceControlStarted = true;

    const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionImpl) {
      $("voice-status").textContent =
        "Voice control ('say Scan') isn't supported in this browser (Safari and Firefox generally don't implement it) -- use the button instead.";
      return;
    }
    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    let deliberatelyStopped = false;

    recognition.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      const transcript = last[0].transcript.trim().toLowerCase();
      if (transcript.includes("scan") && !isRecording()) {
        startRecording();
      } else if (transcript.includes("stop") && isRecording()) {
        stopRecording();
      }
    };
    recognition.onerror = (e) => {
      if (VOICE_FATAL_ERRORS.has(e.error)) {
        deliberatelyStopped = true;
        $("voice-status").textContent =
          `Voice control was denied microphone access (${e.error}). Check Safari's site permissions for ` +
          "this page (or System Settings > Privacy & Security > Microphone) and reload -- use the button meanwhile.";
      } else {
        $("voice-status").textContent = `Voice control hiccup (${e.error}) -- still listening.`;
      }
    };
    // Browsers auto-stop continuous recognition after a while; restart it
    // transparently unless it failed for a reason retrying won't fix.
    recognition.onend = () => {
      if (!deliberatelyStopped) recognition.start();
    };

    try {
      recognition.start();
      $("voice-status").textContent = 'Voice control ready -- say "Scan" to start recording, "Stop" to stop.';
    } catch (e) {
      $("voice-status").textContent = "Voice control failed to start: " + e.message;
    }

    window.addEventListener("beforeunload", () => {
      deliberatelyStopped = true;
      recognition.stop();
    });
  }

  // ---------- Upload + processing ---------------------------------------------

  async function apiUploadFile(url, blob, filename) {
    const fd = new FormData();
    fd.append("file", blob, filename);
    const res = await fetch(url, { method: "POST", body: fd });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  $("btn-upload-process").addEventListener("click", async () => {
    const btn = $("btn-upload-process");
    btn.disabled = true;
    $("processing-status").style.display = "block";
    try {
      const createRes = await fetch("/api/scans", { method: "POST" });
      const scan = await createRes.json();
      scanId = scan.id;

      if (backgroundBlob) {
        setStatusMessage("Uploading background plate...");
        await apiUploadFile(`/api/scans/${scanId}/background`, backgroundBlob, "background.jpg");
      }

      for (let i = 0; i < shots.length; i++) {
        setStatusMessage(`Uploading photo ${i + 1}/${shots.length}...`);
        await apiUploadFile(`/api/scans/${scanId}/photos`, shots[i].blob, `frame_${i}.jpg`);
      }

      setStatusMessage("Starting reconstruction...");
      const engine = $("engine-select").value;
      const startRes = await fetch(`/api/scans/${scanId}/process?engine=${engine}`, { method: "POST" });
      if (!startRes.ok) throw new Error(await startRes.text());

      buildStepList("colmap");
      startPolling();
    } catch (err) {
      setStatusMessage("Error: " + err.message);
      btn.disabled = false;
    }
  });

  function setStatusMessage(msg) {
    $("status-message").textContent = msg;
  }

  function buildStepList(engine) {
    const steps = engine === "meshroom" ? MESHROOM_STEPS : COLMAP_STEPS;
    const el = $("step-list");
    el.innerHTML = "";
    steps.forEach((s) => {
      const pill = document.createElement("span");
      pill.className = "step-pill";
      pill.dataset.step = s;
      pill.textContent = s.replace(/_/g, " ");
      el.appendChild(pill);
    });
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1500);
    pollStatus();
  }

  async function pollStatus() {
    const res = await fetch(`/api/scans/${scanId}/status`);
    if (!res.ok) return;
    const s = await res.json();

    if (s.engine) buildStepList(s.engine);

    const badge = $("state-badge");
    badge.textContent = s.state;
    badge.className = "badge state-" + s.state;

    const pct = Math.round((s.overall_progress || 0) * 100);
    $("progress-bar").style.width = pct + "%";
    $("progress-pct").textContent = pct + "%";
    setStatusMessage(s.message || "");

    document.querySelectorAll("#step-list .step-pill").forEach((pill) => {
      pill.classList.remove("active", "done");
      const steps = s.engine === "meshroom" ? MESHROOM_STEPS : COLMAP_STEPS;
      const curIdx = steps.indexOf(s.step);
      const pillIdx = steps.indexOf(pill.dataset.step);
      if (pillIdx < curIdx) pill.classList.add("done");
      if (pillIdx === curIdx) pill.classList.add("active");
    });

    const logBox = $("log-box");
    logBox.textContent = (s.log_tail || []).join("\n");
    logBox.scrollTop = logBox.scrollHeight;

    if (s.state === "done") {
      clearInterval(pollTimer);
      $("done-actions").style.display = "flex";
      $("btn-view").href = `viewer.html?scan=${scanId}`;
      refreshScanList();
    } else if (s.state === "error") {
      clearInterval(pollTimer);
      $("btn-upload-process").disabled = false;
    }
  }

  // ---------- Previous scans ---------------------------------------------------

  async function refreshScanList() {
    const res = await fetch("/api/scans");
    const scans = await res.json();
    const el = $("scan-list");
    if (!scans.length) {
      el.innerHTML = '<p class="hint">No scans yet.</p>';
      return;
    }
    el.innerHTML = "";
    scans.forEach((s) => {
      const row = document.createElement("div");
      row.className = "scan-row";
      row.innerHTML = `
        <span class="id">${s.id}</span>
        <span class="badge state-${s.state}">${s.state}</span>
        <span>
          ${s.glb_ready ? `<a class="btn" href="viewer.html?scan=${s.id}">View</a>` : ""}
          <button class="btn danger" data-id="${s.id}">Delete</button>
        </span>`;
      row.querySelector("button.danger").addEventListener("click", async (e) => {
        await fetch(`/api/scans/${s.id}`, { method: "DELETE" });
        refreshScanList();
      });
      el.appendChild(row);
    });
  }

  refreshScanList();
})();
