// One Euro Filter: the standard adaptive smoothing technique for noisy
// real-time tracking signals (used widely in hand/body tracking and AR
// apps). A fixed-alpha exponential moving average forces a choice between
// "jittery but responsive" and "smooth but laggy" -- this instead lowers
// the cutoff (more smoothing) when the signal is nearly still, and raises
// it (less smoothing, less lag) when it's moving fast, so a resting hand
// stops shaking without slow gestures feeling delayed.
// Reference: Casiez, Roussel, Vogel, "1€ Filter" (CHI 2012).
export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  _alpha(cutoff, dtSeconds) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dtSeconds);
  }

  filter(x, tMs) {
    if (this.tPrev === null) {
      this.tPrev = tMs;
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }
    const dt = Math.max(1e-3, (tMs - this.tPrev) / 1000);
    const dx = (x - this.xPrev) / dt;
    const aD = this._alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this._alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.tPrev = tMs;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}

// Owns one OneEuroFilter per (hand slot, landmark index, coordinate) and
// smooths a fresh set of MediaPipe hand detections each frame. Hands are
// matched by handedness label (not array index/order, which MediaPipe can
// swap frame to frame) so a filter's history stays attached to the same
// physical hand; a hand's filters are dropped once it leaves the frame so a
// new hand doesn't inherit stale motion history.
export class HandLandmarkSmoother {
  constructor(options = {}) {
    this.options = options;
    this.filtersByHand = new Map(); // handedness label -> Array<{x,y,z: OneEuroFilter}>
  }

  smooth(hands, tMs) {
    const seen = new Set();
    const result = hands.map((hand) => {
      const key = hand.handedness || "Unknown";
      seen.add(key);
      let filters = this.filtersByHand.get(key);
      if (!filters || filters.length !== hand.landmarks.length) {
        filters = hand.landmarks.map(() => ({
          x: new OneEuroFilter(this.options),
          y: new OneEuroFilter(this.options),
          z: new OneEuroFilter(this.options),
        }));
        this.filtersByHand.set(key, filters);
      }
      const landmarks = hand.landmarks.map((p, i) => ({
        x: filters[i].x.filter(p.x, tMs),
        y: filters[i].y.filter(p.y, tMs),
        z: filters[i].z.filter(p.z || 0, tMs),
      }));
      return { ...hand, landmarks };
    });
    for (const key of this.filtersByHand.keys()) {
      if (!seen.has(key)) this.filtersByHand.delete(key);
    }
    return result;
  }
}
