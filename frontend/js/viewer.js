import { GestureRegistry, ActionRegistry, GestureEngine } from "./gestures/registry.js";
import { registerDefaultGestures } from "./gestures/default-gestures.js";
import { registerDefaultActions } from "./gestures/default-actions.js";
import { GestureDetectorSystem } from "./gestures/detector.js";

const $ = (id) => document.getElementById(id);

// Always-visible on-page debug panel: this app is used and debugged over a
// screenshot-relay more often than an actual attached devtools session, so
// diagnostics need to show up on the page itself, not just in the console.
const debugLines = [];
function initDebugPanel() {
  const el = document.createElement("div");
  el.id = "debug-panel";
  el.style.cssText =
    "position:fixed;left:12px;bottom:12px;z-index:40;max-width:480px;max-height:40vh;overflow-y:auto;" +
    "background:rgba(5,7,12,0.88);color:#7fdcff;font:11px/1.4 'Courier New',monospace;" +
    "padding:8px 10px;border-radius:6px;border:1px solid #232c3d;white-space:pre-wrap;pointer-events:none;";
  document.body.appendChild(el);
  return el;
}
const debugPanel = initDebugPanel();
function debugLog(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  debugLines.push(line);
  if (debugLines.length > 40) debugLines.shift();
  debugPanel.textContent = debugLines.join("\n");
  console.log(msg);
}
window.addEventListener("error", (e) => {
  debugLog(`ERROR: ${e.message} (${e.filename}:${e.lineno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  debugLog(`UNHANDLED REJECTION: ${e.reason?.message || e.reason}`);
});

function showFatalError(title, detail) {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;" +
    "background:rgba(5,7,12,0.95);color:#e7edf5;font-family:sans-serif;padding:24px;text-align:center;";
  el.innerHTML = `<div style="max-width:520px"><h2 style="color:#ff4d6d">${title}</h2><p style="color:#8a96ab;line-height:1.6">${detail}</p></div>`;
  document.body.appendChild(el);
}

// three.js and its addons are loaded from a CDN via the importmap in
// viewer.html (see README's "Offline / CDN-blocked networks" section for a
// local-vendoring fallback). A static `import` of a CDN module that fails to
// load aborts the whole script before any of our own code runs, so we use
// dynamic import() here specifically to be able to catch that failure and
// show the user an actionable message instead of a silently blank page.
async function loadThree() {
  try {
    const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
      import("three"),
      import("three/addons/loaders/GLTFLoader.js"),
      import("three/addons/controls/OrbitControls.js"),
    ]);
    return { THREE, GLTFLoader, OrbitControls };
  } catch (e) {
    throw new Error(
      "Could not load three.js from the CDN (cdn.jsdelivr.net). This app needs " +
        "internet access the first time it runs. If you're on a locked-down " +
        "network, see the README's 'Offline / CDN-blocked networks' section for " +
        "how to vendor three.js locally instead. Underlying error: " + e.message
    );
  }
}

async function boot() {
  let THREE, GLTFLoader, OrbitControls, createHolographicMaterial;
  try {
    ({ THREE, GLTFLoader, OrbitControls } = await loadThree());
    ({ createHolographicMaterial } = await import("./holo-shader.js"));
  } catch (e) {
    showFatalError("Couldn't load the 3D viewer", e.message);
    return;
  }

  // -------------------------------------------------------------------------
  // Scene setup: transparent three.js layer floating over the raw webcam feed.
  // -------------------------------------------------------------------------

  const canvas = $("three-canvas");
  debugLog(`three-canvas element found: ${!!canvas}, client size: ${canvas?.clientWidth}x${canvas?.clientHeight}`);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  debugLog(`WebGLRenderer created. context: ${renderer.getContext() ? "OK" : "NULL"}`);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0); // fully transparent clear -> webcam shows through

  const scene = new THREE.Scene(); // no scene.background -> nothing occludes the video feed
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 0, 3);

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const keyLight = new THREE.DirectionalLight(0x99ddff, 1.1);
  keyLight.position.set(2, 3, 4);
  scene.add(keyLight);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  renderer.domElement.style.pointerEvents = "auto"; // allow mouse-drag orbit as a fallback/testing aid

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  // -------------------------------------------------------------------------
  // Model state: the loaded object, its gesture-driven transform, and the
  // holographic materials applied to each mesh (kept so we can toggle
  // wireframe / update the animated time uniform every frame).
  // -------------------------------------------------------------------------

  const modelRoot = new THREE.Group();
  scene.add(modelRoot);
  let holoMaterials = [];
  let currentGestureScale = 1;
  const BASE_DISPLAY_SIZE = 1.4; // world-unit target size after mesh_export.py's own normalization to unit extent

  function clearModel() {
    while (modelRoot.children.length) modelRoot.remove(modelRoot.children[0]);
    holoMaterials = [];
  }

  function applyHolographicMaterial(root) {
    let meshCount = 0;
    let vertCount = 0;
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      meshCount++;
      vertCount += obj.geometry.attributes.position?.count || 0;
      const hasVertexColor = !!obj.geometry.attributes.color;
      const mat = createHolographicMaterial({ hasVertexColor });
      obj.material = mat;
      holoMaterials.push(mat);
    });
    debugLog(`applyHolographicMaterial: ${meshCount} mesh(es), ${vertCount} total vertices, hasVertexColor varies per-mesh`);
  }

  function loadModel(url) {
    debugLog(`loadModel: fetching ${url}`);
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          try {
            clearModel();
            applyHolographicMaterial(gltf.scene);
            gltf.scene.scale.setScalar(BASE_DISPLAY_SIZE);
            modelRoot.add(gltf.scene);
            currentGestureScale = 1;
            debugLog(
              `loadModel: added to scene. modelRoot children: ${modelRoot.children.length}, ` +
                `scene children: ${scene.children.length}, holoMaterials: ${holoMaterials.length}`
            );
            resolve(gltf);
          } catch (e) {
            debugLog(`loadModel onLoad callback threw: ${e.message}`);
            reject(e);
          }
        },
        (progressEvent) => {
          if (progressEvent.total) {
            debugLog(`loadModel progress: ${progressEvent.loaded}/${progressEvent.total} bytes`);
          }
        },
        (err) => {
          debugLog(`loadModel GLTFLoader error: ${err.message || err}`);
          reject(err);
        }
      );
    });
  }

  // -------------------------------------------------------------------------
  // Scan list + cycling
  // -------------------------------------------------------------------------

  let scanList = []; // [{id, ...status}]
  let currentScanIndex = -1;

  async function fetchReadyScans() {
    const res = await fetch("/api/scans");
    const scans = await res.json();
    return scans.filter((s) => s.glb_ready).sort((a, b) => a.created_at - b.created_at);
  }

  async function loadScanByIndex(idx) {
    if (!scanList.length) return;
    currentScanIndex = ((idx % scanList.length) + scanList.length) % scanList.length;
    const scan = scanList[currentScanIndex];
    $("scan-name").textContent = `${scan.id} (${currentScanIndex + 1}/${scanList.length})`;
    try {
      await loadModel(`/api/scans/${scan.id}/model.glb`);
    } catch (e) {
      $("scan-name").textContent = `Failed to load ${scan.id}: ${e.message}`;
    }
  }

  async function initScans() {
    scanList = await fetchReadyScans();
    if (!scanList.length) {
      $("scan-name").textContent = "No completed scans yet -- go capture one.";
      return;
    }
    const params = new URLSearchParams(location.search);
    const requested = params.get("scan");
    const idx = requested ? scanList.findIndex((s) => s.id === requested) : 0;
    await loadScanByIndex(idx >= 0 ? idx : 0);
  }

  // -------------------------------------------------------------------------
  // Gesture badge + marker UI feedback
  // -------------------------------------------------------------------------

  let badgeTimer = null;
  function showBadge(text, sub = "") {
    const badge = $("gesture-badge");
    $("gesture-badge-text").textContent = text;
    $("gesture-badge-sub").textContent = sub;
    badge.classList.add("show");
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => badge.classList.remove("show"), 1100);
  }

  function spawnMarker(xNorm, yNorm) {
    // xNorm/yNorm are in mirrored display space already (see detector.js's
    // `mirror: true` option), matching what the user visually sees, so we
    // can place the DOM dot directly using the video element's bounding box.
    const rect = $("webcam").getBoundingClientRect();
    const dot = document.createElement("div");
    dot.className = "marker-dot";
    dot.style.left = `${rect.left + xNorm * rect.width}px`;
    dot.style.top = `${rect.top + yNorm * rect.height}px`;
    document.body.appendChild(dot);
    setTimeout(() => dot.remove(), 1500);
  }

  // -------------------------------------------------------------------------
  // Viewer control surface: the only thing gesture actions are allowed to
  // touch. Keeping this as one small object is what lets the gesture layer
  // stay ignorant of three.js.
  // -------------------------------------------------------------------------

  const viewerApi = {
    getScale: () => currentGestureScale,
    setScale(v) {
      currentGestureScale = v;
      modelRoot.scale.setScalar(BASE_DISPLAY_SIZE * v);
    },
    lockScale() {
      /* no-op: scale simply stops changing once gesture updates stop firing */
    },
    rotateBy(dx, dy) {
      modelRoot.rotation.y += dx;
      modelRoot.rotation.x = THREE.MathUtils.clamp(modelRoot.rotation.x + dy, -1.2, 1.2);
    },
    resetView() {
      modelRoot.rotation.set(0, 0, 0);
      viewerApi.setScale(1);
      camera.position.set(0, 0, 3);
      controls.target.set(0, 0, 0);
      controls.update();
    },
    cycleScan(direction) {
      loadScanByIndex(currentScanIndex + direction);
    },
    toggleWireframe() {
      holoMaterials.forEach((m) => (m.wireframe = !m.wireframe));
    },
    spawnMarker,
    showBadge,
  };

  // -------------------------------------------------------------------------
  // Gesture engine wiring
  // -------------------------------------------------------------------------

  const gestureRegistry = new GestureRegistry();
  const actionRegistry = new ActionRegistry();
  registerDefaultGestures(gestureRegistry);
  registerDefaultActions(actionRegistry);

  // This is the whole gesture->action config. Edit this object (or call
  // engine.bind(...) at runtime) to change what a gesture does; add a new
  // entry to point a brand-new gesture at a brand-new or existing action.
  const GESTURE_ACTION_MAP = {
    handPan: "rotateControl",
    pinch: "scaleControl",
    twoHandSpread: "scaleControl",
    openPalm: "resetView",
    fist: "toggleWireframe",
    swipeLeft: "prevScan",
    swipeRight: "nextScan",
    point: "spawnMarker",
  };

  const engine = new GestureEngine(gestureRegistry, actionRegistry, GESTURE_ACTION_MAP, viewerApi);
  let lastRecognizedAt = 0;
  engine.onRecognized(() => {
    lastRecognizedAt = performance.now(); // drives a subtle skeleton color pulse, see drawSkeleton
  });

  // -------------------------------------------------------------------------
  // Webcam + hand tracking. Landmarks are mirrored (x -> 1 - x) once, inside
  // GestureDetectorSystem, so every downstream consumer (gestures, skeleton
  // drawing, marker placement) works in the same "what the user sees in the
  // mirrored video" coordinate space as the CSS-mirrored <video>.
  // -------------------------------------------------------------------------

  const video = $("webcam");
  const handCanvas = $("hand-overlay");
  const handCtx = handCanvas.getContext("2d");

  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [0, 9], [9, 10], [10, 11], [11, 12],
    [0, 13], [13, 14], [14, 15], [15, 16],
    [0, 17], [17, 18], [18, 19], [19, 20],
    [5, 9], [9, 13], [13, 17],
  ];

  function drawSkeleton(hands) {
    handCanvas.width = handCanvas.clientWidth;
    handCanvas.height = handCanvas.clientHeight;
    handCtx.clearRect(0, 0, handCanvas.width, handCanvas.height);
    const glow = performance.now() - lastRecognizedAt < 300;
    hands.forEach((hand) => {
      const pts = hand.landmarks.map((p) => ({ x: p.x * handCanvas.width, y: p.y * handCanvas.height }));
      handCtx.strokeStyle = glow ? "#3ddc84" : "#33e0ff";
      handCtx.lineWidth = 2;
      HAND_CONNECTIONS.forEach(([a, b]) => {
        handCtx.beginPath();
        handCtx.moveTo(pts[a].x, pts[a].y);
        handCtx.lineTo(pts[b].x, pts[b].y);
        handCtx.stroke();
      });
      handCtx.fillStyle = "#ffffff";
      pts.forEach((p) => {
        handCtx.beginPath();
        handCtx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        handCtx.fill();
      });
    });
  }

  async function initCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      // This view is looking at your own hands/face -- front camera on a
      // phone, hence "user" (only a hint, harmless on a single-camera laptop).
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: "user" } },
      audio: false,
    });
    video.srcObject = stream;
    await new Promise((res) => (video.onloadedmetadata = res));
  }

  async function initHandTracking() {
    const detector = new GestureDetectorSystem(video, {
      mirror: true,
      onResults: (ctx) => {
        drawSkeleton(ctx.hands);
        engine.update(ctx);
      },
      onHandsStatus: (status) => {
        const dot = document.querySelector("#hands-status .status-dot");
        dot.className = "status-dot " + status;
        $("hands-status-text").textContent =
          { ready: "Hand tracking ready", tracking: "Tracking hands", "no-hands": "No hands detected" }[status] ||
          status;
      },
    });
    await detector.init();
    detector.start();
  }

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  try {
    await initCamera();
  } catch (e) {
    $("hands-status-text").textContent = "Camera access denied: " + e.message;
    document.querySelector("#hands-status .status-dot").className = "status-dot error";
    return;
  }

  await initScans();

  try {
    await initHandTracking();
  } catch (e) {
    $("hands-status-text").textContent = e.message;
    document.querySelector("#hands-status .status-dot").className = "status-dot error";
  }

  debugLog(`Starting render loop. camera pos: ${camera.position.toArray().map((v) => v.toFixed(2))}, scene children: ${scene.children.length}`);
  const clock = new THREE.Clock();
  let frameCount = 0;
  let lastDebugTime = 0;
  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    frameCount++;
    if (t - lastDebugTime > 2) {
      lastDebugTime = t;
      debugLog(
        `frame ${frameCount}, modelRoot children: ${modelRoot.children.length}, ` +
          `modelRoot scale: ${modelRoot.scale.x.toFixed(2)}, holoMaterials: ${holoMaterials.length}, ` +
          `canvas size: ${canvas.width}x${canvas.height}`
      );
    }
    holoMaterials.forEach((m) => (m.uniforms.time.value = t));
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
}

boot();
