// Small dependency-free web UI: view live logs/status and edit the rotator's
// configuration without a redeploy. Gated by HTTP Basic Auth (WEB_UI_USER/
// WEB_UI_PASS, falling back to the panel admin credentials so there's a
// working login out of the box) - this is meant to sit behind the same
// internal-only Traefik allowlist as the olcrtc admin panel, not be exposed
// publicly.
import http from 'node:http';
import crypto from 'node:crypto';
import { getConfig, updateConfig, EDITABLE_KEYS, SECRET_KEYS } from './config.js';
import { getLogs } from './logs.js';
import { getStatus } from './status.js';

const WEB_UI_PORT = Number(process.env.WEB_UI_PORT || '8080');

function currentAuth() {
  const config = getConfig();
  return {
    user: process.env.WEB_UI_USER || config.PANEL_USER,
    pass: process.env.WEB_UI_PASS || config.PANEL_PASS,
  };
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req) {
  const { user, pass } = currentAuth();
  if (!user || !pass) return false; // never allow open access, even misconfigured
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) return false;
  const reqUser = decoded.slice(0, separatorIndex);
  const reqPass = decoded.slice(separatorIndex + 1);
  return timingSafeStringEqual(reqUser, user) && timingSafeStringEqual(reqPass, pass);
}

function requireAuth(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="olcrtc-rotator"', 'content-type': 'text/plain' });
  res.end('Authentication required');
}

function maskedConfig() {
  const config = getConfig();
  const masked = {};
  for (const key of EDITABLE_KEYS) {
    masked[key] = SECRET_KEYS.includes(key) ? '' : config[key];
    masked[`${key}_set`] = Boolean(config[key]);
  }
  return masked;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>olcrtc-rotator</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #0f1115; color: #e6e6e6; }
  h1 { font-size: 1.25rem; }
  a { color: #6cb6ff; }
  fieldset { border: 1px solid #333; border-radius: 6px; margin-bottom: 1.5rem; padding: 1rem; }
  legend { padding: 0 0.4rem; }
  label { display: block; margin: 0.6rem 0 0.2rem; font-size: 0.85rem; color: #aaa; }
  input { width: 100%; box-sizing: border-box; padding: 0.4rem; background: #1a1d24; border: 1px solid #333; color: #e6e6e6; border-radius: 4px; }
  button { margin-top: 1rem; padding: 0.5rem 1rem; background: #2f6fed; border: none; color: white; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
  button:hover { background: #3f7cf5; }
  pre#logs { background: #05060a; padding: 1rem; height: 400px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; font-size: 0.8rem; border-radius: 6px; }
  #status { margin-bottom: 1rem; font-size: 0.9rem; color: #aaa; }
  .hint { font-size: 0.75rem; color: #888; margin-top: 0.75rem; }
</style>
</head>
<body>
<h1>olcrtc-rotator</h1>
<p><a id="admin-link" href="#" target="_blank" rel="noopener">Open olcrtc admin panel &rarr;</a></p>
<div id="status">loading status&hellip;</div>

<fieldset>
  <legend>Configuration</legend>
  <form id="config-form"></form>
  <button type="submit" form="config-form">Save</button>
  <div class="hint">Blank secret fields keep their current value. Changes apply on the next rotation cycle.</div>
</fieldset>

<fieldset>
  <legend>Logs</legend>
  <pre id="logs">loading&hellip;</pre>
</fieldset>

<script>
var SECRET_KEYS = ['PANEL_PASS', 'GOOGLE_PASSWORD', 'GOOGLE_TOTP_SECRET', 'TELEGRAM_BOT_TOKEN'];
var FIELD_LABELS = {
  PANEL_URL: 'Panel URL',
  PANEL_USER: 'Panel admin user',
  PANEL_PASS: 'Panel admin password',
  OLCRTC_ADMIN_PATH: 'Admin path (appended to Panel URL)',
  ROTATE_INTERVAL_HOURS: 'Rotate interval (hours)',
  ROOM_RETENTION_HOURS: 'Room retention (hours, prune older locations)',
  GOOGLE_EMAIL: 'Google account email',
  GOOGLE_PASSWORD: 'Google account password',
  GOOGLE_TOTP_SECRET: 'Google TOTP secret',
  TELEGRAM_BOT_TOKEN: 'Telegram bot token',
  TELEGRAM_CHAT_ID: 'Telegram chat id',
};

function loadConfig() {
  fetch('/api/config').then(function (res) { return res.json(); }).then(function (data) {
    var config = data.config;
    document.getElementById('admin-link').href = data.adminUrl;
    var form = document.getElementById('config-form');
    form.innerHTML = '';
    Object.keys(FIELD_LABELS).forEach(function (key) {
      var isSecret = SECRET_KEYS.indexOf(key) !== -1;
      var label = document.createElement('label');
      label.textContent = FIELD_LABELS[key] + (isSecret && config[key + '_set'] ? ' (set)' : '');
      var input = document.createElement('input');
      input.name = key;
      input.type = isSecret ? 'password' : 'text';
      input.value = config[key] || '';
      input.placeholder = isSecret && config[key + '_set'] ? 'leave blank to keep current value' : '';
      form.appendChild(label);
      form.appendChild(input);
    });
  });
}

document.getElementById('config-form').addEventListener('submit', function (event) {
  event.preventDefault();
  var form = event.target;
  var body = {};
  form.querySelectorAll('input').forEach(function (input) { body[input.name] = input.value; });
  fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(loadConfig);
});

function loadStatus() {
  fetch('/api/status').then(function (res) { return res.json(); }).then(function (status) {
    var el = document.getElementById('status');
    if (!status.lastRunAt) {
      el.textContent = 'No rotation has run yet.';
      return;
    }
    var text = 'Last rotation: ' + (status.lastSuccess ? 'OK' : 'FAILED') + ' at ' + status.lastRunAt;
    if (status.lastRoomId) text += ' — room ' + status.lastRoomId;
    if (status.lastError) text += ' — ' + status.lastError;
    el.textContent = text;
  });
}

function loadLogs() {
  fetch('/api/logs').then(function (res) { return res.json(); }).then(function (data) {
    var el = document.getElementById('logs');
    var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent = data.lines.join('\\n');
    if (atBottom) el.scrollTop = el.scrollHeight;
  });
}

loadConfig();
loadStatus();
loadLogs();
setInterval(loadStatus, 5000);
setInterval(loadLogs, 5000);
</script>
</body>
</html>
`;

export function startServer() {
  const server = http.createServer(async (req, res) => {
    if (!isAuthorized(req)) return requireAuth(res);

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE_HTML);
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(res, 200, { config: maskedConfig(), adminUrl: `${getConfig().PANEL_URL}${getConfig().OLCRTC_ADMIN_PATH}` });
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readJsonBody(req);
      updateConfig(body);
      return sendJson(res, 200, { config: maskedConfig() });
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
      return sendJson(res, 200, { lines: getLogs() });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, getStatus());
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.listen(WEB_UI_PORT, () => {
    console.log(`[${new Date().toISOString()}] olcrtc-rotator: web UI listening on :${WEB_UI_PORT}`);
  });

  return server;
}
