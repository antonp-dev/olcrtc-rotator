// Last-rotation summary shown at the top of the web UI, so "is this thing
// alive" doesn't require reading through the log buffer.
let status = { lastRunAt: null, lastSuccess: null, lastRoomId: null, lastError: null };

export function getStatus() {
  return status;
}

export function setStatus(partial) {
  status = { ...status, ...partial };
}
