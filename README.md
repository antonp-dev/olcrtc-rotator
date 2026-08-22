# olcrtc-homelab

srv-side deploy for [olcrtc](https://github.com/openlibrecommunity/olcrtc) — tunnels SOCKS5 traffic
disguised as a WebRTC video call (Jitsi / Yandex Telemost / WbStream). This repo runs
[olcrtc-manager-panel](https://github.com/BigDaddy3334/olcrtc-manager-panel), a web admin panel that
manages one or more **srv** (exit) processes on the homelab host: client/room creation, key rotation,
QR export, per-client subscriptions, traffic quotas and network-namespace isolation, all from a UI —
no more manual `rooms.txt` editing. Client side is a phone running the **cnc** role via a sideloaded
Android app (see below) — no client YAML needed.

## Layout

- `Dockerfile` — three-stage build: compiles the panel's React frontend (`PANEL_REF`), builds the
  `olcrtc-manager` Go binary with the frontend embedded, and separately builds the `olcrtc` binary
  itself (`OLCRTC_REF`); final image is Debian-slim with both binaries plus `iproute2`/`iptables`.
- `entrypoint.sh` — seeds an empty `/etc/olcrtc-manager/config.json` (first run only) and a shared
  `/tmp/data/{names,surnames}` word list (the panel hardcodes a `data` override per location but never
  provisions the directory it points at — see comment in the script), then execs `olcrtc-manager`.
- `docker-compose.yml` — `olcrtc-manager` (the panel, `privileged: true` for its per-client network
  namespaces/veth/iptables/tc rules) routed through Traefik at `olcrtc.example.com` with no
  published port, plus `olcrtc-rotator` (see below). Both bind-mount their state under
  `/mnt/raid5/olcrtc/` on the host, matching the rest of the homelab's stacks.
- `rotator/` — standalone headless-browser service that keeps a Telemost room alive past its ~24h
  expiry by rotating it automatically. See "Automated Telemost room rotation" below.

## First run

1. `docker compose up -d --build`
2. Open `https://olcrtc.example.com/admin` (reachable only from RFC1918/loopback ranges per the
   Traefik `internal-only` middleware) — first run prompts you to set an admin password (no
   `panel.env` is pre-seeded, unlike the panel's own install.sh flow).
3. In the panel: add a client → add a location → pick provider (`jitsi` / `telemost` / `wbstream`) →
   for Telemost/WbStream paste a room id you created on the provider's own site first (Jitsi accepts
   any full room URL ad hoc). The panel generates the key and starts the `olcrtc` process for you.
4. Export the client's subscription / QR from the panel and pair it into an Android client — see
   below.

## Updating

```
docker compose build && docker compose up -d
```

Bumps `PANEL_REF`/`OLCRTC_REF` pull fresh source; state (clients, keys, quotas) lives in
`/mnt/raid5/olcrtc/manager` on the host, untouched by a rebuild.

## Rotating a room/key

Key rotation and one-off room swaps: use the panel UI (per-location "rotate room/key" action) — no
manual file edits or container restarts needed. The panel renders each client's `olcrtc://` URI live
from current state on every subscription fetch (`/sub/<client-id>/`), so a client picks up a new room
id or key on its next scheduled poll, no re-pairing needed.

For Telemost specifically, the panel can't generate rooms itself (`wbstream`/`telemost` room
generation isn't supported by olcrtc — you always have to create one on the provider's own site and
paste the id in). That's what `olcrtc-rotator` automates below, so you don't have to do it by hand
every ~24h.

## Automated Telemost room rotation

`olcrtc-rotator` (in `rotator/`) is a small headless-Chromium service that, every
`ROTATE_INTERVAL_HOURS` (default 8h — three attempts inside each ~24h Telemost expiry window):

1. Reuses a persisted Yandex/Google browser session (`state.json`) to open telemost.yandex.ru.
2. Clicks "Создать видеовстречу" to spin up a fresh instant meeting and reads the new room id from
   the resulting URL.
3. Calls the panel's admin API (`GET /api/state` + `PUT /api/clients/{id}`, HTTP Basic Auth) to swap
   just the `room_id` on that client's `telemost` location(s), leaving keys/transport/proxy untouched.
4. Re-saves the (self-refreshing) session back to `state.json`.

If the persisted session is ever rejected, it makes a best-effort scripted Google login using
`GOOGLE_EMAIL`/`GOOGLE_PASSWORD`/`GOOGLE_TOTP_SECRET` — treat this as a fallback, not the primary
mechanism: Google's login form is heavily bot-detected and scripted credential submission can and
will fail sometimes. Any failure (expired session, fallback login also failing, panel API error)
sends a Telegram alert instead of silently giving up, and leaves the previous room untouched — a
failed cycle degrades to "rotate it by hand in the panel" rather than an outage, since the old room
keeps working until it naturally expires.

### One-time setup

1. **Capture the initial browser session.** On your own machine (not the server), install the
   `first-login` dependencies and launch the headed login helper:
   ```
   cd first-login
   npm install
   npx playwright install chromium
   node login.js
   ```
   A real browser window opens on telemost.yandex.ru. Sign in with "Google" using the account, finish
   any 2FA by hand, then press Enter in the terminal once you're logged in. This writes
   `first-login/state.json`. The same steps can be run with `./run.sh` from the `first-login/`
   directory; it installs the Node modules and Chromium for you.
2. **Upload `state.json`** to `/mnt/raid5/olcrtc/rotator/state.json` on the server (e.g. `scp
   first-login/state.json <host>:/mnt/raid5/olcrtc/rotator/state.json`) before first starting the container —
   otherwise the first cycle falls straight to the Google-login fallback.
3. **Create a `.env`** next to `docker-compose.yml`:
   ```
   OLCRTC_ROTATOR_PANEL_USER=<panel admin user you set on first run>
   OLCRTC_ROTATOR_PANEL_PASS=<panel admin pass you set on first run>
  APP_DOMAIN=<your base domain, for example example.com>
   OLCRTC_ROTATOR_GOOGLE_EMAIL=<the Google account, for the fallback login only>
   OLCRTC_ROTATOR_GOOGLE_PASSWORD=<...>
   OLCRTC_ROTATOR_GOOGLE_TOTP_SECRET=<base32 TOTP secret, if 2FA is on; omit otherwise>
   OLCRTC_ROTATOR_TELEGRAM_BOT_TOKEN=<from @BotFather>
   OLCRTC_ROTATOR_TELEGRAM_CHAT_ID=<your chat id>
   ```
4. `docker compose up -d --build olcrtc-rotator`

### If it stops rotating

Check the container logs and the Telegram alert text first — it names the failing step. Most likely
causes: the persisted session finally expired and the Google fallback also got blocked (re-run
`first-login/run.sh` and re-upload `state.json`), or Telemost's page markup changed (the button-text
selector in `rotator/rotate.js` needs a matching update — `rotator/rotate.js:DEBUG_SCREENSHOT_PATH`
saves a screenshot on failure to help diagnose which).

## Android client

olcrtc itself ships no Play Store app (no Play Store/F-Droid listing at all — expected for this
category). Sideload one of the community clients that read an `olcrtc://` URI or the panel's
subscription format directly, APK from GitHub releases:

- [owenclave](https://github.com/owenewans/owenclave) — reference client for the `olcrtc://` URI,
  actively released. Recommended: paste/QR the URI/subscription from the panel, nothing else to
  configure.
- [olcbox](https://github.com/alananisimov/olcbox) — Kotlin Multiplatform, nicer UI, all
  providers/transports, split tunneling.

[Obtainium](https://github.com/ImranR98/Obtainium) can track and auto-update either APK straight
from its GitHub releases.

## Notes

- No inbound ports needed for the tunnel itself — `olcrtc` only makes outbound WebRTC connections to
  the provider, same as a browser joining a call. The admin panel has no published port either; it's
  only reachable through Traefik's `websecure` entrypoint, gated by the `internal-only` IP allowlist
  (RFC1918 + loopback).
- `privileged: true` is required because the panel manages network namespaces/veth/iptables/tc for
  per-client isolation and speed limits — this is a materially larger privilege footprint than the
  old single-room container had.
- Per-client speed quotas use the cgroup v1 `net_cls,net_prio` controller; on a cgroup-v2-only host
  that specific limit may not apply, room/key management and `traffic_gb` quotas are unaffected.
- Room id + key together are the shared secret. Don't paste real room ids/keys into issues, commits,
  or a public remote. Same goes for `rotator/state.json` and the rotator's `.env` — both are
  effectively credentials (a live Yandex/Google session and, optionally, the account password).
