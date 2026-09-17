// Built-in gesture detectors, registered through the same public
// GestureRegistry API that any user-added gesture would use -- nothing here
// is special-cased by the engine.
//
// Each detector receives a FrameContext:
//   {
//     hands: [ { landmarks: [21 x {x,y,z}], handedness: 'Left'|'Right' }, ... ],
//     history: RollingHistory,   // see below
//     dtMs: number,
//   }
// and returns either null, or:
//   discrete:   { data }                     (presence alone means "fired")
//   continuous: { active: boolean, data }
import { LM, dist, handScale, fingerStates, centroid } from "./landmarks.js";

const PINCH_ON_RATIO = 0.35; // thumb-index distance / hand-scale below this = pinching
const PINCH_OFF_RATIO = 0.45; // hysteresis so it doesn't flicker at the boundary

// Tracks short rolling wrist-position history per hand so swipe/pan gestures
// can look at recent motion instead of a single frame. Keyed by handedness
// label, not array position -- MediaPipe's multiHandLandmarks/multiHandedness
// arrays don't guarantee a stable index-to-physical-hand correspondence
// across frames (their order can swap when hands cross or one briefly drops
// out of detection), so indexing by position risked silently splicing one
// hand's motion onto another's history mid-gesture, which would show up as
// a spurious swipe firing or handPan suddenly jerking sideways.
export class RollingHistory {
  constructor(maxLen = 12) {
    this.maxLen = maxLen;
    this.byHand = new Map(); // handedness label -> [{x,y,t}], oldest first
  }

  push(hands) {
    const seen = new Set();
    for (const h of hands) {
      const key = h.handedness || "Unknown";
      seen.add(key);
      let buf = this.byHand.get(key);
      if (!buf) {
        buf = [];
        this.byHand.set(key, buf);
      }
      buf.push({ ...h.landmarks[LM.WRIST], t: performance.now() });
      if (buf.length > this.maxLen) buf.shift();
    }
    for (const key of this.byHand.keys()) {
      if (!seen.has(key)) this.byHand.delete(key); // hand left the frame; don't let stale history leak into a new gesture
    }
  }

  forHandedness(label) {
    return this.byHand.get(label) || [];
  }
}

function firstHand(ctx) {
  return ctx.hands[0] || null;
}

export function registerDefaultGestures(registry) {
  // --- Pinch (continuous) ---------------------------------------------------
  // Thumb tip + index tip close together. Used for scale control: while
  // pinching, vertical hand movement zooms in/out (see default-actions.js).
  let pinchState = false; // per-detector hysteresis state
  registry.register(
    "pinch",
    (ctx) => {
      const hand = firstHand(ctx);
      if (!hand) { pinchState = false; return { active: false, data: {} }; }
      const lm = hand.landmarks;
      const ratio = dist(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]) / handScale(lm);
      pinchState = pinchState ? ratio < PINCH_OFF_RATIO : ratio < PINCH_ON_RATIO;
      const wrist = lm[LM.WRIST];
      return { active: pinchState, data: { ratio, wristY: wrist.y, wristX: wrist.x } };
    },
    { type: "continuous" }
  );

  // --- Open palm (discrete) -------------------------------------------------
  registry.register(
    "openPalm",
    (ctx) => {
      const hand = firstHand(ctx);
      if (!hand) return null;
      const f = fingerStates(hand.landmarks);
      const allExtended = f.thumb && f.index && f.middle && f.ring && f.pinky;
      return allExtended ? { data: {} } : null;
    },
    { type: "discrete", cooldownMs: 1200 }
  );

  // --- Fist (discrete) -------------------------------------------------------
  registry.register(
    "fist",
    (ctx) => {
      const hand = firstHand(ctx);
      if (!hand) return null;
      const f = fingerStates(hand.landmarks);
      const allCurled = !f.thumb && !f.index && !f.middle && !f.ring && !f.pinky;
      return allCurled ? { data: {} } : null;
    },
    { type: "discrete", cooldownMs: 1200 }
  );

  // --- Point (discrete: index extended, everything else curled) --------------
  registry.register(
    "point",
    (ctx) => {
      const hand = firstHand(ctx);
      if (!hand) return null;
      const f = fingerStates(hand.landmarks);
      const isPoint = f.index && !f.middle && !f.ring && !f.pinky;
      if (!isPoint) return null;
      const tip = hand.landmarks[LM.INDEX_TIP];
      return { data: { x: tip.x, y: tip.y } };
    },
    { type: "discrete", cooldownMs: 900 }
  );

  // --- Swipe left / right (discrete, from wrist history) ----------------------
  const SWIPE_MIN_DIST = 0.22; // normalized screen-width fraction
  const SWIPE_MAX_MS = 500;

  function detectSwipe(ctx, direction) {
    const hand = firstHand(ctx);
    if (!hand) return null;
    const buf = ctx.history.forHandedness(hand.handedness);
    if (buf.length < 4) return null;
    const first = buf[0];
    const last = buf[buf.length - 1];
    const dtMs = last.t - first.t;
    if (dtMs > SWIPE_MAX_MS || dtMs <= 0) return null;
    const dx = last.x - first.x; // note: video is mirrored in the UI, handled at display layer
    if (direction === "left" && dx < -SWIPE_MIN_DIST) return { data: { dx, dtMs } };
    if (direction === "right" && dx > SWIPE_MIN_DIST) return { data: { dx, dtMs } };
    return null;
  }

  registry.register("swipeLeft", (ctx) => detectSwipe(ctx, "left"), {
    type: "discrete",
    cooldownMs: 900,
  });
  registry.register("swipeRight", (ctx) => detectSwipe(ctx, "right"), {
    type: "discrete",
    cooldownMs: 900,
  });

  // --- Two-hand spread (continuous: distance between hand centroids) ---------
  let spreadBaseline = null;
  registry.register(
    "twoHandSpread",
    (ctx) => {
      if (ctx.hands.length < 2) {
        spreadBaseline = null;
        return { active: false, data: {} };
      }
      const c0 = centroid(ctx.hands[0].landmarks);
      const c1 = centroid(ctx.hands[1].landmarks);
      const d = dist(c0, c1);
      if (spreadBaseline === null) spreadBaseline = d;
      return { active: true, data: { distance: d, baseline: spreadBaseline } };
    },
    { type: "continuous" }
  );

  // --- Hand pan (continuous: any single tracked hand moving, not pinching) ---
  // Drives model rotation. Deliberately excludes the pinch state so pinch-zoom
  // and pan-rotate don't fight over the same hand motion.
  registry.register(
    "handPan",
    (ctx) => {
      const hand = firstHand(ctx);
      if (!hand) return { active: false, data: {} };
      const buf = ctx.history.forHandedness(hand.handedness);
      if (buf.length < 2) return { active: false, data: {} };
      const lm = hand.landmarks;
      const pinchRatio = dist(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]) / handScale(lm);
      if (pinchRatio < PINCH_ON_RATIO) return { active: false, data: {} }; // let pinch own this motion instead
      const prev = buf[buf.length - 2];
      const cur = buf[buf.length - 1];
      return { active: true, data: { dx: cur.x - prev.x, dy: cur.y - prev.y } };
    },
    { type: "continuous" }
  );
}
