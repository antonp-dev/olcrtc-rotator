# olcrtc-homelab — stack overview

## What it is

Server-side deploy for [olcrtc](https://github.com/openlibrecommunity/olcrtc): an encrypted SOCKS5-over-WebRTC
tunnel disguised as a video call (Jitsi / Yandex Telemost / WbStream). This repo runs
[olcrtc-manager-panel](https://github.com/BigDaddy3334/olcrtc-manager-panel), a web admin panel that manages one
or more **srv** (exit) processes on the homelab host, plus a custom `olcrtc-rotator` sidecar (not part of the
upstream panel) that keeps Telemost rooms alive past their ~24h expiry.

Purpose: give a mobile client (cnc role, Android, in Russia) unrestricted internet via the homelab as exit node,
tunneled to look like a Jitsi/Telemost/WbStream call.

## Where it lives

- Source repo: self-hosted Forgejo instance
- Deploy target: Portainer CE, Docker standalone endpoint, host `<your-docker-host-ip>` (domain `example.com`)
- Deployed as a Portainer **git-based stack** named `olcrtc` — Portainer pulls this repo and runs
  `docker compose` against `docker-compose.yml` at the repo root. Redeploys happen via
  `StackGitRedeploy` (or the stack's webhook) whenever the repo is pushed to.
- Persistent state is bind-mounted directly on the host under `/mnt/raid5/olcrtc/`:
  - `/mnt/raid5/olcrtc/manager` → `olcrtc-manager:/etc/olcrtc-manager` (panel config, clients, keys)
  - `/mnt/raid5/olcrtc/rotator` → `olcrtc-rotator:/data` (Playwright `state.json` session, failure/diagnostic
    screenshots + console logs — see `olcrtc-rotator` below)
  This matches the convention used by other stacks on this host (e.g. `beszel`), which bind-mount under
  `/mnt/raid5/<stack-name>/...` rather than using Docker-managed named volumes.
  - Note: this stack previously used named volumes (`olcrtc_manager_data`, `olcrtc_rotator_data`, which Compose
    prefixed to `olcrtc_olcrtc_manager_data` / `olcrtc_olcrtc_rotator_data` under the `olcrtc` project name).
    Data was migrated out of those into the bind-mount paths above via a temporary `alpine` container copy.
    The old named volumes may still exist on the host and are safe to remove once the bind-mount paths are
    confirmed populated and working.

    ## Deployment prerequisites

    The stack assumes the following five host-level prerequisites:

    1. **Portainer CE:** A Docker standalone endpoint exists for the target Linux host. Deploy this repository
      as a Portainer Git-based stack using the root `docker-compose.yml`; define stack environment variables in
      Portainer rather than relying on a repository-side `.env` file.
    2. **Traefik `websecure`:** Traefik runs on the same host with a `websecure` entrypoint, working TLS
      certificates, and DNS for `olcrtc.<base-domain>`. Neither service publishes a host port; the manager is
      reached only through the Traefik labels in `docker-compose.yml`.
    3. **External `proxy` network:** A Docker network named `proxy` already exists and includes Traefik.
      It is declared `external: true`, so Portainer/Compose will fail instead of creating it when the network
      is absent.
    4. **Bind-mount directories:** The host has writable directories `/mnt/raid5/olcrtc/manager` and
      `/mnt/raid5/olcrtc/rotator`. The first stores manager state and keys; the second stores the rotator's
      Playwright session and diagnostics. Seed `rotator/state.json` during one-time setup when possible.
    5. **Linux privileges and stack variables:** Docker permits `privileged: true` for the manager so it can
      create network namespaces, veth devices, iptables rules, and traffic-control rules. Portainer must set
      `APP_DOMAIN`, `OLCRTC_ROTATOR_PANEL_USER`, and `OLCRTC_ROTATOR_PANEL_PASS`; Google and Telegram values
      are optional fallback/alerting settings. On cgroup v2-only hosts, per-client speed quotas may not apply.

## Services

### `olcrtc-manager`

- Built locally from this repo's `Dockerfile` (three-stage build: panel React frontend, `olcrtc-manager` Go
  binary with frontend embedded, `olcrtc` binary itself). Image tag `olcrtc-manager:local` — never pushed to a
  registry, so `docker-compose.yml` sets `pull_policy: build` on this service (otherwise Portainer's
  git-redeploy flow runs `docker compose pull` first and fails with "pull access denied").
- Runs `--privileged` because it manages per-client network namespaces/veth/iptables/tc rules for isolation
  and speed limits.
- Routed through Traefik at `https://olcrtc.example.com`, no published port. Gated by a Traefik
  `internal-only` IP-allowlist middleware (RFC1918 + loopback ranges) — only reachable from the LAN/loopback.
- Admin HTTP API: HTTP Basic Auth (`OLCRTC_MANAGER_USER`/`OLCRTC_MANAGER_PASS`, or `/etc/olcrtc-manager/panel.env`)
  works standalone on every `/api/*` call. Key endpoints:
  - `GET /api/state` — full config, including `clients[].locations[]` (`carrier`, `room_id`, `key`, `transport`, ...)
  - `PUT /api/clients/{id}` — full-replace of a client's `locations[]`
  - Room generation is only auto-supported for `jitsi` (random UUID sub-room); `telemost`/`wbstream` explicitly
    require a manually-created room id to be pasted in — this is exactly why `olcrtc-rotator` exists.
- Subscriptions (`/sub/<client-id>/`) render `olcrtc://` URIs live from current state on every fetch — no
  caching — so editing a location's `room_id` propagates to the client on its next scheduled poll, no
  re-pairing needed.

### `olcrtc-rotator`

- Custom Node + Playwright service, `rotator/` directory, built locally (`olcrtc-rotator:local`, also
  `pull_policy: build`).
- Purpose: Yandex Telemost instant-meeting links expire after ~24h, and the panel refuses to auto-generate
  telemost/wbstream rooms. This service periodically (`ROTATE_INTERVAL_HOURS`, currently 2h) drives a Chromium
  session against `telemost.yandex.ru`, creates a fresh meeting, and PUTs the new `room_id` into the panel's
  client config over the admin API described above — swapping only `telemost`-carrier locations.
- The browser runs **headed** (`headless: false`) inside the container under a virtual display (`Xvfb`, started
  by `rotator/entrypoint.sh` on `DISPLAY=:99` before `rotate.js` starts) rather than Chromium's native headless
  mode. This is part of an ongoing effort to avoid the app silently no-op'ing the create-call click for
  automated sessions — see the known issue below.
- Session persistence: a Playwright `storageState` (`state.json`) is seeded once locally (headed browser, real
  Google-via-Yandex login, done by hand) and uploaded to `/mnt/raid5/olcrtc/rotator/state.json`. The rotator
  reuses and re-saves this on every successful cycle, so login should be a one-time setup step, not a recurring
  one.
- Fallback: if the persisted session is ever rejected, it makes a best-effort *scripted* Google login using
  `GOOGLE_EMAIL`/`GOOGLE_PASSWORD`/`GOOGLE_TOTP_SECRET` env vars — treated as unreliable/best-effort (Google's
  login form is bot-detected), not the primary mechanism.
- Diagnostics: every cycle unconditionally writes `before-click.png`, `after-click.png`, and `after-wait.png`
  (plus sibling `*-console.txt` browser console/network-failure dumps) to `/data`, in addition to the
  failure-only `last-failure.png` — all under `/mnt/raid5/olcrtc/rotator/` on the host.
- Alerting: any failure (login, room creation, panel API) sends a Telegram message via
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` and dumps a screenshot to `/data/last-failure.png`
  (`/mnt/raid5/olcrtc/rotator/last-failure.png` on the host). A failed cycle is not an outage — the previous
  Telemost room keeps working until it naturally expires; a failed cycle just means "rotate it by hand in the
  panel" until the rotator is fixed.
- Required env vars (set directly in the Portainer stack's environment variables, **not** a committed `.env`
  file — Portainer git-deployed stacks don't read a repo-side `.env`):
  `OLCRTC_ROTATOR_PANEL_USER`, `OLCRTC_ROTATOR_PANEL_PASS`, plus optional
  `OLCRTC_ROTATOR_GOOGLE_EMAIL`/`_PASSWORD`/`_TOTP_SECRET` and `OLCRTC_ROTATOR_TELEGRAM_BOT_TOKEN`/`_CHAT_ID`.

## Playwright/Chromium version coupling

The `playwright` npm package version in `rotator/package.json` is pinned exactly (no `^` range) to match the
Docker base image tag in `rotator/Dockerfile` (`mcr.microsoft.com/playwright:v<version>-jammy`), since that
image ships browser binaries for that exact Playwright version only. Currently both are pinned to `1.62.1`.
Bumping one without the other reproduces the "Executable doesn't exist" failure seen earlier in this project's
history.

## Known open issue

See `rotator-telemost-click-issue.md` in this same directory for the full attempt log — the rotator's
room-creation click has repeatedly had no visible effect on the live Telemost page. The wrong-locator cause has
since been confirmed and fixed (real button uses `data-testid="create-call-button"`, English text once logged
in), but a separate automation-detection suspicion remains only partially confirmed: current mitigations are
`--disable-blink-features=AutomationControlled`, a `navigator.webdriver` override, and now a headed browser via
Xvfb. Status as of the last update in that doc is still not fully confirmed working end-to-end.
