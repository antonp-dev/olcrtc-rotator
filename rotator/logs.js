// In-memory ring buffer feeding the web UI's log viewer. Deliberately not
// persisted to disk - `docker logs` / the mounted volume already cover
// durability, this only needs to answer "what has this process been doing
// recently" for whoever has the UI open.
const MAX_LINES = 500;
const buffer = [];

export function pushLog(line) {
  buffer.push(line);
  if (buffer.length > MAX_LINES) buffer.shift();
}

export function getLogs() {
  return buffer;
}
