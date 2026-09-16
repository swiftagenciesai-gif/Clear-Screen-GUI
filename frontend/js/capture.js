// Turntable capture UI: webcam access, background plate step, guided
// multi-shot capture with a coverage ring + blur warnings, then upload and
// kick off backend reconstruction with live progress polling.
(() => {
  "use strict";

  const TARGET_SHOTS = 36; // 360 / 36 = 10 degrees/shot -- a reasonable default density
  const BLUR_VARIANCE_THRESHOLD = 25; // below this, flag the shot as likely blurry

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
  let shots = []; // { blob, sharpness, blurry }
  let autoTimer = null;
  let scanId = null;
  let pollTimer = null;

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
    await listCameras();
    $("bg-panel").style.display = "block";
    drawCoverageRing();
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

  // ---------- Background step -----------------------------------------------

  $("btn-capture-bg").addEventListener("click", async () => {
    const canvas = grabFrameCanvas();
    backgroundBlob = await canvasToBlob(canvas);
    $("bg-status").textContent = "Background captured ✓";
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
    drawCoverageRing();
  }

  // Draws a ring of tick marks around the video, one per target shot slot,
  // filled in as shots are taken. This assumes each capture corresponds to
  // one even rotation step -- it's a capture-count guide, not a real computer
  // vision estimate of the object's actual turned angle.
  function drawCoverageRing() {
    const w = overlay.width, h = overlay.height;
    if (!w || !h) return;
    octx.clearRect(0, 0, w, h);
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
