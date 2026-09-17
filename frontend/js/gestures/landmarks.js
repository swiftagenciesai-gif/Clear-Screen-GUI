// Small geometry helpers over MediaPipe Hands' 21-point landmark format.
// Landmarks are normalized [0,1] image-space coordinates: {x, y, z}.
// Index reference: https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

// "Hand scale" - a stable per-hand reference length (wrist to middle-finger
// MCP) used to normalize distances so gestures work regardless of how close
// the hand is to the camera.
export function handScale(landmarks) {
  return dist(landmarks[LM.WRIST], landmarks[LM.MIDDLE_MCP]) || 0.001;
}

// A finger counts as "extended" if its tip is meaningfully farther from the
// wrist than its own PIP joint is. This is orientation-tolerant enough for a
// webcam held at odd angles, unlike a simple "tip.y < pip.y" screen-space check.
export function isFingerExtended(landmarks, mcp, pip, tip) {
  const wrist = landmarks[LM.WRIST];
  return dist(wrist, landmarks[tip]) > dist(wrist, landmarks[pip]) * 1.1;
}

export function fingerStates(landmarks) {
  return {
    thumb: dist(landmarks[LM.WRIST], landmarks[LM.THUMB_TIP]) >
      dist(landmarks[LM.WRIST], landmarks[LM.THUMB_IP]) * 1.05,
    index: isFingerExtended(landmarks, LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_TIP),
    middle: isFingerExtended(landmarks, LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_TIP),
    ring: isFingerExtended(landmarks, LM.RING_MCP, LM.RING_PIP, LM.RING_TIP),
    pinky: isFingerExtended(landmarks, LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_TIP),
  };
}

export function centroid(landmarks) {
  const n = landmarks.length;
  let x = 0, y = 0, z = 0;
  for (const p of landmarks) { x += p.x; y += p.y; z += p.z || 0; }
  return { x: x / n, y: y / n, z: z / n };
}
