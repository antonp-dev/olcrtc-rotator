#!/bin/sh
set -eu

CONFIG_DIR=/etc/olcrtc-manager
CONFIG_FILE="$CONFIG_DIR/config.json"

mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "==> no config found, seeding empty manager config (first run only)"
  cat > "$CONFIG_FILE" <<EOF
{
  "version": 1,
  "name": "olcrtc homelab",
  "port": ${OLCRTC_MANAGER_PORT:-8888},
  "refresh": "10m",
  "clients": []
}
EOF
fi

# the panel hardcodes "data": "data" on every location it creates, which
# olcrtc resolves relative to its runtime config file - and the panel always
# writes that file under os.TempDir() (/tmp here), so every spawned olcrtc
# process looks for /tmp/data/{names,surnames}. The panel never creates that
# dir itself, so olcrtc fails at startup without it. Seed a minimal shared
# word list once; every client location resolves to this same path.
NAMES_DIR=/tmp/data
if [ ! -f "$NAMES_DIR/names" ] || [ ! -f "$NAMES_DIR/surnames" ]; then
  mkdir -p "$NAMES_DIR"
  cat > "$NAMES_DIR/names" <<EOF
Alex
Sam
Jordan
Taylor
Morgan
Casey
Jamie
Riley
Avery
Dana
EOF
  cat > "$NAMES_DIR/surnames" <<EOF
Smith
Johnson
Williams
Brown
Jones
Garcia
Miller
Davis
Wilson
Moore
EOF
fi

exec /usr/local/bin/olcrtc-manager \
  -config "$CONFIG_FILE" \
  -addr "${OLCRTC_MANAGER_ADDR:-0.0.0.0}"
