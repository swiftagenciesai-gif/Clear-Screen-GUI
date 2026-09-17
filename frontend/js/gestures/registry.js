// The extensible gesture -> action layer.
//
// Three pieces, kept deliberately decoupled so none of them need to know
// about hand-tracking internals or three.js internals:
//
//   GestureRegistry  - named detector functions that look at hand landmarks
//                      each frame and report whether "their" gesture is
//                      happening right now (continuous) or just happened
//                      (discrete).
//   ActionRegistry   - named callback functions that DO something (rotate
//                      the model, reset the camera, cycle scans, ...).
//   GestureEngine    - runs every registered detector against the current
//                      frame's landmarks, applies debouncing/edge-triggering,
//                      and dispatches to whatever action a config object
//                      says that gesture is currently bound to.
//
// To add a new gesture: GestureRegistry.register('myGesture', detectorFn).
// To add a new action:  ActionRegistry.register('myAction', fn).
// To wire them together: add an entry to the map passed into GestureEngine,
// or call engine.bind('myGesture', 'myAction') at runtime. No changes to
// detection code, three.js code, or MediaPipe wiring are ever required.

export class GestureRegistry {
  constructor() {
    this._detectors = new Map(); // name -> { detect, type, cooldownMs }
  }

  /**
   * @param {string} name
   * @param {(ctx: FrameContext) => (DetectorResult|null)} detect
   * @param {{type?: 'discrete'|'continuous', cooldownMs?: number}} [opts]
   */
  register(name, detect, opts = {}) {
    this._detectors.set(name, {
      detect,
      type: opts.type || "discrete",
      cooldownMs: opts.cooldownMs ?? 600,
    });
    return this;
  }

  unregister(name) {
    this._detectors.delete(name);
  }

  list() {
    return [...this._detectors.keys()];
  }

  get(name) {
    return this._detectors.get(name);
  }
}

export class ActionRegistry {
  constructor() {
    this._actions = new Map(); // name -> { onStart, onUpdate, onEnd, onTrigger }
  }

  /**
   * An action can implement any subset of:
   *   onTrigger(data, api)          - for discrete gestures
   *   onStart(data, api)            - continuous gesture began
   *   onUpdate(data, api)           - continuous gesture still active
   *   onEnd(data, api)              - continuous gesture stopped
   */
  register(name, handlers) {
    this._actions.set(name, handlers);
    return this;
  }

  get(name) {
    return this._actions.get(name);
  }

  list() {
    return [...this._actions.keys()];
  }
}

/**
 * Runs the registered gesture detectors against each frame's hand landmarks
 * and dispatches to whichever action the gesture is currently bound to.
 *
 * `api` is an arbitrary object passed through to every action handler -- in
 * this app it's the viewer control surface (rotate/scale/reset/cycle/etc),
 * but the engine itself has no idea what's in it.
 */
export class GestureEngine {
  constructor(gestureRegistry, actionRegistry, gestureToAction, api) {
    this.gestures = gestureRegistry;
    this.actions = actionRegistry;
    this.map = { ...gestureToAction }; // gesture name -> action name
    this.api = api;
    this._active = new Map(); // gesture name -> true while a continuous gesture is ongoing
    this._lastFired = new Map(); // gesture name -> timestamp, for discrete cooldowns
    this._onRecognized = null; // UI feedback hook: (gestureName, data) => void
  }

  bind(gestureName, actionName) {
    this.map[gestureName] = actionName;
  }

  onRecognized(cb) {
    this._onRecognized = cb;
  }

  /** @param {FrameContext} frameCtx - see detector.js for the shape */
  update(frameCtx) {
    const now = performance.now();
    for (const name of this.gestures.list()) {
      const det = this.gestures.get(name);
      const result = det.detect(frameCtx);
      const actionName = this.map[name];
      const action = actionName ? this.actions.get(actionName) : null;

      if (det.type === "continuous") {
        const wasActive = this._active.get(name) || false;
        const isActive = !!(result && result.active);
        if (isActive && !wasActive) {
          action?.onStart?.(result.data, this.api);
          this._notify(name, result);
        } else if (isActive && wasActive) {
          action?.onUpdate?.(result.data, this.api);
        } else if (!isActive && wasActive) {
          action?.onEnd?.(result.data, this.api);
        }
        this._active.set(name, isActive);
      } else {
        // Discrete: fire once per detection, then enforce a cooldown so a
        // gesture held for a second doesn't spam the action repeatedly.
        if (result) {
          const last = this._lastFired.get(name) || 0;
          if (now - last >= det.cooldownMs) {
            this._lastFired.set(name, now);
            action?.onTrigger?.(result.data, this.api);
            this._notify(name, result);
          }
        }
      }
    }
  }

  _notify(name, result) {
    this._onRecognized?.(name, result);
  }
}
