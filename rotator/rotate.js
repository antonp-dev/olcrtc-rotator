// olcrtc room rotator
//
// Keeps a Telemost instant-meeting link alive past its ~24h expiry by
// periodically creating a fresh room (via a headless browser reusing a
// persisted Yandex/Google session) and pushing the new room id into
// olcrtc-manager-panel's client config over its admin API.
//
// This is deliberately semi-automated: the common path (reuse + refresh a
// persisted browser session) is fully hands-off, but if that session is
// ever rejected, this only *attempts* a scripted Google login as a
// best-effort fallback - Google's login form is heavily bot-detected and
// scripted credential submission is expected to fail sometimes. Any
// failure alerts Telegram instead of silently giving up; the previous
// room keeps working until it naturally expires, so a failed cycle is not
// an outage by itself.
import { chromium } from 'playwright';
import { authenticator } from 'otplib';
import fs from 'node:fs';
import nodePath from 'node:path';
import { getConfig } from './config.js';
import { pushLog } from './logs.js';
import { setStatus } from './status.js';
import { startServer } from './server.js';
import { tryRotate } from './lock.js';

const {
  STATE_PATH = '/data/state.json',
  DEBUG_SCREENSHOT_PATH = '/data/last-failure.png',
  STACK_ENV = '',
} = process.env;

// STACK_ENV is a leading-hyphen suffix ("-dev") used compose-side to
// namespace container names/volumes/routers; here we only want the bare
// label for tagging alerts, e.g. "-dev" -> "dev".
const ENV_LABEL = STACK_ENV.replace(/^-/, '');
const ENV_TAG = ENV_LABEL ? `[${ENV_LABEL}] ` : '';

const ROTATED_NAME_RE = /^rotated_at:\s*(\S+)(?:\s*\|\s*(.*))?$/;

function roomRetentionMs() {
  const hours = Number(getConfig().ROOM_RETENTION_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

function locationAgeStartedAt(location) {
  const nameMatch = String(location.name ?? '').match(ROTATED_NAME_RE);
  const timestamp = nameMatch?.[1] ?? location.runtime?.started_at;
  if (!timestamp) return null;

  const startedAt = Date.parse(timestamp);
  return Number.isNaN(startedAt) ? null : startedAt;
}

function originalLocationName(location) {
  const nameMatch = String(location.name ?? '').match(ROTATED_NAME_RE);
  return nameMatch?.[2]?.trim() || 'Telemost location';
}

function rotatedLocationName(location, now = new Date()) {
  return `rotated_at: ${now.toISOString()} | ${originalLocationName(location)}`;
}

function shouldRetainLocation(location, now) {
  const startedAt = locationAgeStartedAt(location);
  if (startedAt === null) return true;
  return now - startedAt < roomRetentionMs();
}

function validateConfig() {
  const config = getConfig();
  for (const name of ['PANEL_URL', 'PANEL_USER', 'PANEL_PASS']) {
    if (!config[name]) throw new Error(`missing required config value ${name}`);
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] olcrtc-rotator: ${message}`;
  console.log(line);
  pushLog(line);
}

function logError(message) {
  const line = `[${new Date().toISOString()}] olcrtc-rotator ERROR: ${message}`;
  console.error(message);
  pushLog(line);
}

// Diagnostic screenshots taken unconditionally on every cycle (not just on
// failure like DEBUG_SCREENSHOT_PATH), so a run that "succeeds" without
// finding a room id - or one that succeeds outright - still leaves visual
// evidence of what the page looked like right after the click and right
// after the wait, for spotting overlays/modals the innerText dump misses.
const AFTER_CLICK_SCREENSHOT_PATH = nodePath.join(nodePath.dirname(DEBUG_SCREENSHOT_PATH), 'after-click.png');
const AFTER_WAIT_SCREENSHOT_PATH = nodePath.join(nodePath.dirname(DEBUG_SCREENSHOT_PATH), 'after-wait.png');

// Screenshots alone don't explain a blank/white page - the cause is usually
// a JS error or warning printed to the browser's own console, which a
// screenshot can't show. Capture it on every page (including popups) in
// the context, and dump whatever's accumulated so far next to each
// screenshot as a sibling .txt file.
function attachConsoleCapture(context) {
  const logs = [];
  context.on('page', (p) => {
    p.on('console', (msg) => {
      logs.push(`[${new Date().toISOString()}] console.${msg.type()}: ${msg.text()}`);
    });
    p.on('pageerror', (err) => {
      logs.push(`[${new Date().toISOString()}] pageerror: ${err.message}`);
    });
    // console.error's "Failed to load resource: net::ERR_..." text never
    // includes which resource - only requestfailed carries the URL.
    p.on('requestfailed', (req) => {
      logs.push(
        `[${new Date().toISOString()}] requestfailed: ${req.method()} ${req.url()} - ${req.failure()?.errorText}`,
      );
    });
  });
  return logs;
}

function dumpConsoleLogs(screenshotPath, logs) {
  const txtPath = screenshotPath.replace(/\.png$/, '-console.txt');
  fs.writeFileSync(txtPath, logs.length ? logs.join('\n') : '(no console output captured)');
  return txtPath;
}

async function notify(message) {
  // Tagged so a Telegram chat/log shared between main and dev (or any other
  // STACK_ENV) still tells you which environment is actually failing.
  const taggedMessage = ENV_TAG + message;
  logError(taggedMessage);
  const config = getConfig();
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    logError('telegram notify skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing');
    return false;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text: taggedMessage }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
    log('telegram notification sent');
    return true;
  } catch (err) {
    logError(`telegram notify failed: ${err.message}`);
    return false;
  }
}

// Best-effort scripted login, used only when the persisted session is
// rejected. Selectors here are unverified against the live, JS-rendered
// sign-in flow - if this breaks, it just means the fallback fails and you
// get a Telegram alert asking you to re-seed state.json by hand, same as
// any other failure.
async function googleLoginFallback(page) {
  const config = getConfig();
  if (!config.GOOGLE_EMAIL || !config.GOOGLE_PASSWORD) {
    throw new Error('stored session invalid and no GOOGLE_EMAIL/GOOGLE_PASSWORD fallback configured');
  }

  log('googleLoginFallback: navigating to telemost.yandex.ru');
  await page.goto('https://telemost.yandex.ru/', { waitUntil: 'networkidle' });
  log('googleLoginFallback: clicking sign-in');
  await page.getByText(/войти|sign in/i).first().click({ timeout: 15000 });
  log('googleLoginFallback: clicking google option');
  await page.getByText(/google/i).first().click({ timeout: 15000 });

  log('googleLoginFallback: filling email');
  await page.fill('input[type="email"]', config.GOOGLE_EMAIL);
  await page.click('#identifierNext');
  await page.waitForTimeout(1500);

  log('googleLoginFallback: filling password');
  await page.fill('input[type="password"]', config.GOOGLE_PASSWORD);
  await page.click('#passwordNext');
  await page.waitForTimeout(1500);

  if (config.GOOGLE_TOTP_SECRET) {
    const totpInput = page.locator('input[name="totpPin"]');
    if (await totpInput.isVisible({ timeout: 8000 }).catch(() => false)) {
      log('googleLoginFallback: TOTP prompt shown, filling code');
      await totpInput.fill(authenticator.generate(config.GOOGLE_TOTP_SECRET));
      await page.click('#totpNext');
    }
  }

  log('googleLoginFallback: waiting for redirect back to telemost.yandex.ru');
  await page.waitForURL('**/telemost.yandex.ru/**', { timeout: 30000 });
  log('googleLoginFallback: done');
}

// The "Создать видеовстречу" text check used here previously is unreliable:
// that text appears on the landing page's marketing heading regardless of
// auth state or UI locale (the authenticated create-call button renders in
// English, "Create video meeting"). data-testid="create-call-button" is the
// real, locale-independent control and is only rendered once actually
// logged in, so its visibility is the correct signal.
async function isLoggedIn(page) {
  log('isLoggedIn: navigating to telemost.yandex.ru');
  await page.goto('https://telemost.yandex.ru/', { waitUntil: 'networkidle' });
  const loggedIn = await page
    .getByTestId('create-call-button')
    .first()
    .isVisible({ timeout: 10000 })
    .catch(() => false);
  log(`isLoggedIn: create-call-button visible=${loggedIn}`);
  return loggedIn;
}

// Telemost is a client-side SPA: creating a meeting changes the URL via
// history.pushState rather than a full document navigation, so
// page.waitForURL()'s default waitUntil:'load' never fires - it just hangs
// until the timeout even though the URL did change. Poll location.href
// directly instead, and also handle the case where "create meeting" opens
// a new tab rather than navigating the current one.
const ROOM_ID_RE = /\/j\/(\S+)/;
const ROOM_ID_RE2 = /telemost\.yandex\.ru\/([\w-]{6,})\/?(?:$|[?#])/;
// CSS-module class name Telemost renders the meeting number in
// ("MeetingNumberText_<hash>") - hash suffix is build-specific, match by
// prefix instead of the full class.
const MEETING_NUMBER_SELECTOR = '[class*="MeetingNumberText_"]';

// Extract a meeting link either from the URL (SPA navigation) or from any
// on-page text/input value (some flows show a "copy link" box instead of
// navigating at all).
async function extractRoomId(target) {
  const url = target.url();
  let match = url.match(ROOM_ID_RE) ?? url.match(ROOM_ID_RE2);
  if (match) {
    log(`extractRoomId: matched from URL, url=${url}`);
    return match[1];
  }

  const domText = await target
    .evaluate(() =>
      document.body.innerText + ' ' + Array.from(document.querySelectorAll('input')).map((i) => i.value).join(' '),
    )
    .catch(() => '');
  match = domText.match(ROOM_ID_RE) ?? domText.match(ROOM_ID_RE2);
  if (match) {
    log('extractRoomId: matched from DOM text/input value');
    return match[1];
  }
  log(`extractRoomId: no URL/DOM regex match, url=${url}, trying meeting-number fallback`);

  // Fallback: the on-page "Meeting No. <digits grouped with spaces>" text.
  // Unconfirmed whether this numeric id is interchangeable with the /j/<id>
  // URL slug the panel/client otherwise expect - used only when neither URL
  // nor DOM regex matched anything, and logged loudly so a bad id is easy to
  // spot rather than silently propagated.
  const meetingNumberText = await target
    .locator(MEETING_NUMBER_SELECTOR)
    .first()
    .innerText()
    .catch(() => '');
  const digits = meetingNumberText.replace(/\D/g, '');
  if (digits) {
    logError(
      `extractRoomId: falling back to on-page meeting number "${digits}" (from "${meetingNumberText}") - ` +
        `no /j/<id> URL or DOM match found, this id's format is unconfirmed against what the panel/client expect`,
    );
    return digits;
  }

  return null;
}

async function createRoom(page, consoleLogs) {
  const initialUrl = page.url();
  const context = page.context();
  const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  const createButton = page.getByTestId('create-call-button').first();

  const buttonCount = await page.getByTestId('create-call-button').count();
  const buttonDebug = await createButton
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hitTarget = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        tag: element.tagName,
        text: element.textContent?.trim(),
        disabled: element instanceof HTMLButtonElement ? element.disabled : element.getAttribute('aria-disabled'),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        hitTarget: hitTarget?.outerHTML.slice(0, 300),
        outerHTML: element.outerHTML.slice(0, 500),
      };
    })
    .catch((err) => ({ error: err.message }));
  log(`createRoom: create-call-button count=${buttonCount} debug=${JSON.stringify(buttonDebug)}`);
  await page.screenshot({ path: nodePath.join(nodePath.dirname(AFTER_CLICK_SCREENSHOT_PATH), 'before-click.png'), fullPage: true }).catch(() => {});

  log('createRoom: clicking create-call-button');
  // Real, locale-independent control - see isLoggedIn() comment. Previous
  // getByRole/getByText Russian-text matching never found this element once
  // logged in (button renders "Create video meeting" in English), and fell
  // through to clicking a non-interactive Russian marketing heading instead
  // - click "succeeded" but had no effect on the page.
  await createButton.click({ timeout: 15000 });
  log('createRoom: click done, waiting for popup (8s) or same-tab navigation');

  const popup = await popupPromise;
  const target = popup ?? page;
  log(`createRoom: using ${popup ? 'popup tab' : 'same tab'}, waiting up to 45s for URL change or meeting-number element`);

  await target.waitForTimeout(10000);
  await target.screenshot({ path: AFTER_CLICK_SCREENSHOT_PATH, fullPage: true }).catch(() => {});
  const afterClickLogPath = dumpConsoleLogs(AFTER_CLICK_SCREENSHOT_PATH, consoleLogs);
  log(`createRoom: took post-click screenshot (10s after click) at ${AFTER_CLICK_SCREENSHOT_PATH}, console log at ${afterClickLogPath}`);

  // Race URL change against the meeting-number element appearing (some
  // flows render a "Meeting No." box without ever navigating). Flags below
  // are set as soon as either resolves, purely for logging - the race
  // itself still exits on whichever finishes first, same timing as before.
  let urlChanged = false;
  let meetingNumberShown = false;
  await Promise.race([
    target
      .waitForFunction((old) => window.location.href !== old, initialUrl, { timeout: 45000 })
      .then(() => { urlChanged = true; })
      .catch(() => null),
    target
      .locator(MEETING_NUMBER_SELECTOR)
      .first()
      .waitFor({ timeout: 45000 })
      .then(() => { meetingNumberShown = true; })
      .catch(() => null),
  ]);
  log(`createRoom: wait finished, urlChanged=${urlChanged} meetingNumberShown=${meetingNumberShown} currentUrl=${target.url()}`);

  await target.screenshot({ path: AFTER_WAIT_SCREENSHOT_PATH, fullPage: true }).catch(() => {});
  const afterWaitLogPath = dumpConsoleLogs(AFTER_WAIT_SCREENSHOT_PATH, consoleLogs);
  log(`createRoom: took post-wait screenshot (after 45s wait) at ${AFTER_WAIT_SCREENSHOT_PATH}, console log at ${afterWaitLogPath}`);

  const roomId = await extractRoomId(target);
  if (!roomId) {
    const title = await target.title().catch(() => '?');
    const bodyText = await target
      .evaluate(() => document.body.innerText.slice(0, 500))
      .catch(() => '?');
    throw new Error(
      `meeting created but could not find room id. url=${target.url()} title="${title}" bodyText="${bodyText}"`,
    );
  }
  log(`createRoom: extracted roomId=${roomId}`);

  return roomId;
}

async function probeMedia(page) {
  const result = await page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      return {
        devices: devices.map(({ kind, label }) => ({ kind, label })),
        audioTracks: stream.getAudioTracks().length,
        videoTracks: stream.getVideoTracks().length,
      };
    } catch (error) {
      return {
        devices: devices.map(({ kind, label }) => ({ kind, label })),
        error: `${error.name}: ${error.message}`,
      };
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  });
  log(`probeMedia: ${JSON.stringify(result)}`);
}

async function panelFetch(path, opts = {}) {
  const config = getConfig();
  const auth = Buffer.from(`${config.PANEL_USER}:${config.PANEL_PASS}`).toString('base64');
  const res = await fetch(`${config.PANEL_URL}${path}`, {
    ...opts,
    headers: { ...(opts.headers ?? {}), authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    throw new Error(`panel ${opts.method ?? 'GET'} ${path} -> ${res.status}: ${await res.text()}`);
  }

  return res;
}

async function updateRoom(roomId) {
  log('updateRoom: fetching panel state for all clients');
  const state = await (await panelFetch('/api/state')).json();
  const clients = state.clients ?? [];
  const now = Date.now();
  if (!clients.length) {
    log('updateRoom: panel state contains no clients, nothing to update');
    return;
  }

  const retentionHours = getConfig().ROOM_RETENTION_HOURS;
  let updatedCount = 0;
  let failedCount = 0;
  let prunedCount = 0;
  for (const client of clients) {
    let touched = false;
    let freshRoomPresent = false;
    const locations = [];
    for (const loc of client.locations ?? []) {
      if (loc.carrier !== 'telemost') {
        locations.push(loc);
        continue;
      }

      touched = true;
      if (loc.room_id === roomId) {
        freshRoomPresent = true;
        locations.push(loc);
        continue;
      }

      if (shouldRetainLocation(loc, now)) {
        locations.push(loc);
        if (locationAgeStartedAt(loc) === null) {
          log(
            `updateRoom: client=${client.client_id} retaining telemost room=${loc.room_id} ` +
              'because it has no valid rotated_at or runtime.started_at timestamp',
          );
        }
      } else {
        prunedCount += 1;
        log(`updateRoom: client=${client.client_id} pruning telemost room=${loc.room_id} (older than ${retentionHours}h retention)`);
      }
    }

    if (touched && !freshRoomPresent) {
      const sourceLocation = (client.locations ?? []).find((loc) => loc.carrier === 'telemost');
      const { runtime: _runtime, uri: _uri, ...newLocation } = sourceLocation;
      locations.push({
        ...newLocation,
        room_id: roomId,
        name: rotatedLocationName(sourceLocation, new Date(now)),
      });
    }

    if (!touched) {
      log(`updateRoom: client=${client.client_id} has no telemost locations, skipping`);
      continue;
    }

    log(`updateRoom: PUT-ing client=${client.client_id} (roomId=${roomId}) back to panel`);
    try {
      await panelFetch(`/api/clients/${encodeURIComponent(client.client_id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...client, locations }),
      });
      updatedCount += 1;
    } catch (err) {
      failedCount += 1;
      const message =
        `olcrtc-rotator: rotation FAILED for client=${client.client_id}: ${err.message}\n` +
        `Room ${roomId} was not applied to this client; other clients will still be attempted.`;
      log(message);
      await notify(message);
    }
  }

  if (!updatedCount) throw new Error('no clients have telemost locations to rotate');
  log(
    `updateRoom: cleanup done - panel updated for ${updatedCount} client(s), failed for ${failedCount} client(s), ` +
      `pruned ${prunedCount} expired location(s) (retention=${retentionHours}h)`,
  );
}

async function rotateOnce() {
  log('rotateOnce: starting cycle, launching browser');
  // Telemost's create-meeting flow calls getUserMedia() before it finishes
  // creating the room; headless Chromium blocks camera/mic by default with
  // no visible error, so the click "succeeds" but the page just hangs
  // forever waiting on a permission prompt nobody answers. Fake devices +
  // an explicit grant avoid that stall.
  //
  // --disable-blink-features=AutomationControlled: click on the real
  // create-call-button was confirmed to never reach the app's handler in
  // this container (no "createCall config" log ever appears, identical
  // screenshots before/after) despite working instantly in a real browser
  // - consistent with client-side code silently no-op'ing for automated
  // (navigator.webdriver) sessions.
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const hasState = fs.existsSync(STATE_PATH);
  log(`rotateOnce: ${hasState ? 'loading' : 'no'} persisted state from ${STATE_PATH}`);
  const contextOpts = hasState ? { storageState: STATE_PATH } : {};
  const context = await browser.newContext(contextOpts);
  // The launch flag alone doesn't always fully hide navigator.webdriver -
  // mask it explicitly on every page as well.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const consoleLogs = attachConsoleCapture(context);
  await context.grantPermissions(['camera', 'microphone'], { origin: 'https://telemost.yandex.ru' });
  const page = await context.newPage();

  try {
    if (!(await isLoggedIn(page))) {
      await notify('olcrtc-rotator: stored Yandex session invalid, attempting Google login fallback');
      await googleLoginFallback(page);
    } else {
      log('rotateOnce: session valid, proceeding to create room');
    }

    await probeMedia(page);
    const roomId = await createRoom(page, consoleLogs);
    await updateRoom(roomId);
    await context.storageState({ path: STATE_PATH });
    log(`rotateOnce: saved refreshed session to ${STATE_PATH}`);

    console.log(`rotated telemost room for all clients -> ${roomId}`);
    setStatus({ lastRunAt: new Date().toISOString(), lastSuccess: true, lastRoomId: roomId, lastError: null });
  } catch (err) {
    log(`rotateOnce: FAILED - ${err.message}`);
    setStatus({ lastRunAt: new Date().toISOString(), lastSuccess: false, lastError: err.message });
    await page.screenshot({ path: DEBUG_SCREENSHOT_PATH, fullPage: true }).catch(() => {});
    const failureLogPath = dumpConsoleLogs(DEBUG_SCREENSHOT_PATH, consoleLogs);
    log(`rotateOnce: dumped console log at ${failureLogPath}`);
    await notify(
      `olcrtc-rotator: rotation FAILED: ${err.message}\n` +
        `Old room keeps working until it naturally expires. If this is a login problem, ` +
        `re-run the local seed-login helper and re-upload ${STATE_PATH}. ` +
        `Debug screenshot: ${DEBUG_SCREENSHOT_PATH}`,
    );
  } finally {
    await browser.close();
    log('rotateOnce: browser closed, cycle finished');
  }
}

async function main() {
  log('main: starting');

  for (;;) {
    try {
      validateConfig();
      const ran = await tryRotate(rotateOnce);
      if (!ran) log('main: skipped scheduled cycle - a manually triggered rotation was already running');
    } catch (err) {
      logError(err.message ?? String(err));
      await notify(`olcrtc-rotator: cycle FAILED before its normal error handler: ${err.message}`);
    }

    const intervalHours = getConfig().ROTATE_INTERVAL_HOURS;
    const intervalMs = Number(intervalHours) * 60 * 60 * 1000;
    log(`main: sleeping ${intervalHours}h until next cycle`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Passed into the web UI so its "rotate now" button can kick off a cycle
// on-demand; tryRotate() ensures it can never overlap the scheduled loop.
function triggerRotation() {
  return tryRotate(rotateOnce);
}

startServer(triggerRotation);
main();
