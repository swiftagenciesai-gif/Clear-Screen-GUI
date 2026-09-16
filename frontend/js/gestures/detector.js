// Wraps MediaPipe Hands (loaded from CDN as the global `Hands`, see
// viewer.html's <script> tags) into a simple push-based frame source: each
// resolved detection turns into a FrameContext and is handed to a callback.
// This is the only file that knows MediaPipe's API shape -- everything else
// in gestures/ works against the small, stable FrameContext contract below.
import { RollingHistory } from "./default-gestures.js";

/**
 * @typedef FrameContext
 * @property {{landmarks: {x:number,y:number,z:number}[], handedness: string}[]} hands
 * @property {RollingHistory} history
 * @property {number} dtMs
 */

export class GestureDetectorSystem {
  constructor(videoEl, { onResults, onHandsStatus, mirror = true } = {}) {
    this.video = videoEl;
    this.onResults = onResults || (() => {});
    this.onHandsStatus = onHandsStatus || (() => {});
    this.mirror = mirror;
    this.history = new RollingHistory();
    this._running = false;
    this._busy = false;
    this._lastFrameTime = performance.now();
    this._hands = null;
  }

  async init() {
    if (typeof window.Hands === "undefined") {
      throw new Error(
        "MediaPipe Hands failed to load from CDN. Check your internet connection " +
          "(see README's offline/vendoring note) and reload."
      );
    }
    this._hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    this._hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.6,
    });
    this._hands.onResults((results) => this._handleResults(results));
    this.onHandsStatus("ready");
  }

  _handleResults(results) {
    const now = performance.now();
    const dtMs = now - this._lastFrameTime;
    this._lastFrameTime = now;

    // Mirror once, right at the source, so every downstream consumer
    // (gesture detectors, rolling history, skeleton drawing, marker
    // placement) works in the same coordinate space as the CSS-mirrored
    // <video> element the user actually sees themselves in.
    const hands = (results.multiHandLandmarks || []).map((landmarks, i) => ({
      landmarks: this.mirror ? landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })) : landmarks,
      handedness: results.multiHandedness?.[i]?.label || "Unknown",
    }));

    this.history.push(hands);
    this.onHandsStatus(hands.length > 0 ? "tracking" : "no-hands");

    /** @type {FrameContext} */
    const ctx = { hands, history: this.history, dtMs };
    this.onResults(ctx);
  }

  start() {
    this._running = true;
    const loop = async () => {
      if (!this._running) return;
      if (!this._busy && this.video.readyState >= 2) {
        this._busy = true;
        try {
          await this._hands.send({ image: this.video });
        } catch (e) {
          console.error("MediaPipe Hands error:", e);
        } finally {
          this._busy = false;
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this._running = false;
  }
}
