// Mutable rotator configuration.
//
// Precedence per field: a value saved through the web UI (persisted to
// CONFIG_PATH) beats the env var, which beats the built-in default. This
// lets the web UI change behavior (interval, retention, credentials) without
// a redeploy, while every field still has a working env-var-only default for
// anyone who never opens the UI.
import fs from 'node:fs';
import nodePath from 'node:path';

const CONFIG_PATH = process.env.CONFIG_PATH || '/data/rotator-config.json';

const DEFAULTS = {
  PANEL_URL: '',
  PANEL_USER: '',
  PANEL_PASS: '',
  OLCRTC_ADMIN_PATH: '/admin',
  ROTATE_INTERVAL_HOURS: '12',
  ROOM_RETENTION_HOURS: '24',
  GOOGLE_EMAIL: '',
  GOOGLE_PASSWORD: '',
  GOOGLE_TOTP_SECRET: '',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
};

export const EDITABLE_KEYS = Object.keys(DEFAULTS);

// Fields never echoed back to the web UI in plaintext - only whether a
// value is currently set. Saving one requires typing a fresh value; leaving
// it blank keeps whatever is already configured.
export const SECRET_KEYS = ['PANEL_PASS', 'GOOGLE_PASSWORD', 'GOOGLE_TOTP_SECRET', 'TELEGRAM_BOT_TOKEN'];

function loadPersistedOverrides() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

let overrides = loadPersistedOverrides();

function computeConfig() {
  const config = {};
  for (const key of EDITABLE_KEYS) {
    config[key] = overrides[key] ?? process.env[key] ?? DEFAULTS[key];
  }
  return config;
}

let current = computeConfig();

export function getConfig() {
  return current;
}

// Applies a partial update (e.g. from the web UI's save form) and persists
// it to CONFIG_PATH. Blank/missing values are ignored rather than clearing
// the field - a form field left empty means "no change", not "unset".
export function updateConfig(partial) {
  let changed = false;
  for (const key of Object.keys(partial ?? {})) {
    if (!EDITABLE_KEYS.includes(key)) continue;
    const value = partial[key];
    if (value === '' || value === undefined || value === null) continue;
    overrides[key] = value;
    changed = true;
  }
  if (changed) {
    fs.mkdirSync(nodePath.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(overrides, null, 2));
  }
  current = computeConfig();
  return current;
}
