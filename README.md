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

## Deployment prerequisites

This stack is intended for a Linux Docker host managed by Portainer. Before deploying, confirm all
five requirements:

1. **Portainer:** Portainer CE has a Docker standalone endpoint for the target host, and the stack is
  deployed as a Git-based stack from this repository. Configure Portainer to use the repository's
  root `docker-compose.yml` and set the stack environment variables there.
2. **Traefik HTTPS routing:** Traefik is running on the same Docker host with a `websecure` entrypoint,
  TLS certificates, and DNS for `olcrtc.<your-base-domain>`. The compose labels route both services
  through Traefik; this stack does not publish a host port.
3. **External proxy network:** A Docker network named `proxy` already exists and is connected to
  Traefik. Because the compose file declares it as external, Compose/Portainer will not create it.
4. **Persistent host directories:** Create `/mnt/raid5/olcrtc/manager` and
  `/mnt/raid5/olcrtc/rotator` on the Docker host, with permissions that allow the containers to read
  and write their mounted state. Before the first start, the rotator directory must contain a valid
  `state.json` created by the one-time browser login setup described below. The scripted Google login
  fallback is untested and must not be relied on for initial setup.
5. **Host capabilities and variables:** The Docker host must permit the manager's `privileged: true`
  networking operations (network namespaces, veth, iptables, and tc). Set `APP_DOMAIN`,
  `OLCRTC_ROTATOR_PANEL_USER`, and `OLCRTC_ROTATOR_PANEL_PASS` in Portainer; optional Google and
  Telegram variables are documented below. A cgroup-v2-only host may not enforce per-client speed
  quotas.

## First run

1. Complete the one-time rotator setup below and copy `first-login/state.json` to
  `/mnt/raid5/olcrtc/rotator/state.json` on the Docker host. This file must exist in the mounted
  location before starting `olcrtc-rotator`; otherwise the rotator cannot authenticate reliably.
2. `docker compose up -d --build`
3. Open `https://olcrtc.example.com/admin` (reachable only from RFC1918/loopback ranges per the
   Traefik `internal-only` middleware) — first run prompts you to set an admin password (no
   `panel.env` is pre-seeded, unlike the panel's own install.sh flow).
4. In the panel: add a client → add a location → pick provider (`jitsi` / `telemost` / `wbstream`) →
   for Telemost/WbStream paste a room id you created on the provider's own site first (Jitsi accepts
   any full room URL ad hoc). The panel generates the key and starts the `olcrtc` process for you.
5. Export the client's subscription / QR from the panel and pair it into an Android client — see
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

The automated Telemost rotator appends the new room instead of immediately replacing the previous
one. Generated locations use the existing `name` field as a timestamp marker:
`rotated_at: <RFC3339 timestamp> | <original name>`. Previous rooms remain available until their
timestamp is at least 24 hours old, allowing clients to transition while both `olcrtc` processes run.
For legacy locations without that prefix, the rotator falls back to `runtime.started_at`; locations
without a valid timestamp are retained conservatively.

For Telemost specifically, the panel can't generate rooms itself (`wbstream`/`telemost` room
generation isn't supported by olcrtc — you always have to create one on the provider's own site and
paste the id in). That's what `olcrtc-rotator` automates below, so you don't have to do it by hand
every ~24h.

## Automated Telemost room rotation

`olcrtc-rotator` (in `rotator/`) is a small headless-Chromium service that, every
`ROTATE_INTERVAL_HOURS` (default 12h — two attempts inside each ~24h Telemost expiry window):

1. Reuses a persisted Yandex/Google browser session (`state.json`) to open telemost.yandex.ru.
2. Clicks "Создать видеовстречу" to spin up a fresh instant meeting and reads the new room id from
   the resulting URL.
3. Calls the panel's admin API (`GET /api/state` + `PUT /api/clients/{id}`, HTTP Basic Auth) to append
  a new timestamped location for that client's `telemost` location(s), leaving keys/transport/proxy
  untouched. Locations at least 24 hours old are pruned during the same update.
4. Re-saves the (self-refreshing) session back to `state.json`.

If the persisted session is ever rejected, it makes a best-effort scripted Google login using
`GOOGLE_EMAIL`/`GOOGLE_PASSWORD`/`GOOGLE_TOTP_SECRET`. This fallback has not been tested and should
not be used for initial setup: Google's login form is heavily bot-detected and scripted credential
submission can fail. Any failure (expired session, fallback login also failing, panel API error)
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
2. **Copy `state.json` to the mounted location before starting the container.** For example:
  `scp first-login/state.json <host>:/mnt/raid5/olcrtc/rotator/state.json`. Verify that the file exists
  on the Docker host at exactly `/mnt/raid5/olcrtc/rotator/state.json`; this persisted session is
  required for the first run.
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
  If you created a new bot, open its Telegram chat and send `/start` before deploying. Telegram will
  not deliver messages to a chat that has not started the bot.
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
