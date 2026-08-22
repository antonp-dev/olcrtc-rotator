#!/bin/sh
set -eu

export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1280x1024x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
xvfb_pid=$!

cleanup() {
  kill "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 1
kill -0 "$xvfb_pid"
echo "DISPLAY=$DISPLAY"
echo "Xvfb pid=$xvfb_pid"

exec node /app/rotate.js
