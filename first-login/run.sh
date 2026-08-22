#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. Install Node.js first (e.g. via nvm or apt), then rerun." >&2
  exit 1
fi

echo "Installing playwright (pinned 1.62.1, must match rotator/Dockerfile image tag)..."
npm install

echo "Installing Chromium browser binary for this playwright version..."
if ! npx playwright install chromium; then
  echo "Plain browser install failed, retrying with OS deps (needs sudo)..." >&2
  npx playwright install --with-deps chromium
fi

echo "Launching headed browser for manual login..."
node login.js

echo
echo "Done. Upload state.json to host: /mnt/raid5/olcrtc/rotator/state.json"
