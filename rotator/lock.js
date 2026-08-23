// Serializes rotation runs: the scheduled loop and a manual "rotate now"
// click both go through tryRotate(), so a manual trigger can never overlap
// a scheduled cycle (or another manual click) - launching two browsers at
// once against the same persisted session/panel state would race.
let inFlight = false;

export function isRotating() {
  return inFlight;
}

export async function tryRotate(rotateFn) {
  if (inFlight) return false;
  inFlight = true;
  try {
    await rotateFn();
  } finally {
    inFlight = false;
  }
  return true;
}
