// Built-in actions. Each is registered under a plain name that the
// gesture->action config maps a gesture to -- swap the config to rebind, or
// call actionRegistry.register('myAction', {...}) to add a brand new
// behavior a future gesture can target, all without touching detection code.
//
// `api` (the viewer control surface) is implemented in viewer.js and passed
// into GestureEngine at construction time -- see registerDefaultActions below.

const SCALE_MIN = 0.3;
const SCALE_MAX = 3.0;
const PINCH_DRAG_SENSITIVITY = 2.2; // vertical hand travel -> scale multiplier
const ROTATE_SENSITIVITY = 6.0; // hand pan speed -> radians/sec

export function registerDefaultActions(actions) {
  // --- Rotation, driven by the continuous "handPan" gesture ------------------
  actions.register("rotateControl", {
    onStart(_data, api) {
      api.showBadge("Rotate", "hand pan");
    },
    onUpdate(data, api) {
      // dx is a normalized-screen-space delta per frame; scale by sensitivity
      // so rotation speed feels consistent regardless of frame rate.
      api.rotateBy(data.dx * ROTATE_SENSITIVITY, data.dy * ROTATE_SENSITIVITY);
    },
    onEnd() {
      // Rotation has no "lock" concept -- it simply stops changing once hand
      // motion stops, which falls out naturally from onUpdate not firing.
    },
  });

  // --- Scale, driven by either "pinch" (vertical drag) or "twoHandSpread" ----
  // (distance between hands). Whichever continuous gesture is currently
  // active owns the live scale value; releasing it freezes the model at
  // whatever scale it last reported -- no drift, no inertia.
  // Known limitation: if both gestures somehow become active at once (e.g.
  // pinching with one hand while a second hand appears), each start/update
  // call overwrites the shared baseline last-writer-wins -- there's no
  // conflict resolution between two continuous gestures mapped to the same
  // action. In practice this is rare since twoHandSpread needs two open hands
  // and pinch needs a closed thumb-index on the tracked hand.
  let scaleState = null; // { startScale }

  function clampScale(v) {
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, v));
  }

  actions.register("scaleControl", {
    onStart(data, api) {
      scaleState = { startScale: api.getScale(), startWristY: data.wristY, startDistance: data.distance };
      api.showBadge("Scale", data.distance !== undefined ? "two-hand spread" : "pinch + drag");
    },
    onUpdate(data, api) {
      if (!scaleState) return;
      let target;
      if (data.distance !== undefined) {
        // Two-hand spread: scale tracks the ratio of current to baseline hand distance.
        target = scaleState.startScale * (data.distance / (data.baseline || data.distance));
      } else {
        // Single-hand pinch-drag: moving the pinched hand up zooms in.
        const dy = scaleState.startWristY - data.wristY;
        target = scaleState.startScale * (1 + dy * PINCH_DRAG_SENSITIVITY);
      }
      api.setScale(clampScale(target));
    },
    onEnd(_data, api) {
      // Explicit lock step: commit the current value as the new resting scale
      // so a future gesture start computes its delta from here, not from a
      // stale baseline.
      api.lockScale();
      scaleState = null;
    },
  });

  // --- Reset, driven by the discrete "openPalm" gesture -----------------------
  actions.register("resetView", {
    onTrigger(_data, api) {
      api.resetView();
      api.showBadge("Reset View", "open palm");
    },
  });

  // --- Scan cycling, driven by discrete swipe gestures ------------------------
  actions.register("prevScan", {
    onTrigger(_data, api) {
      api.cycleScan(-1);
      api.showBadge("Previous Scan", "swipe left");
    },
  });
  actions.register("nextScan", {
    onTrigger(_data, api) {
      api.cycleScan(1);
      api.showBadge("Next Scan", "swipe right");
    },
  });

  // --- Example custom-callback actions, to demonstrate the extension point ---
  // These aren't essential viewer features; they exist so it's obvious how to
  // wire an arbitrary function to a gesture without editing detection code.
  actions.register("toggleWireframe", {
    onTrigger(_data, api) {
      api.toggleWireframe();
      api.showBadge("Toggle Wireframe", "fist (custom callback)");
    },
  });

  actions.register("spawnMarker", {
    onTrigger(data, api) {
      api.spawnMarker(data.x, data.y);
      api.showBadge("Marker", "point (custom callback)");
    },
  });
}
