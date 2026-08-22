# Known issue: `olcrtc-rotator` room creation click has no effect

Status: **unresolved**, as of 2026-08-21. Root cause of the *original* symptom (wrong click target) is now
confirmed and fixed, but a second, deeper problem surfaced once that fix landed: the real button's click still
doesn't reach the app's handler inside this container, and that part is still not confirmed fixed.

## Original symptom

Every rotation cycle failed identically:

```
olcrtc-rotator: rotation FAILED: meeting created but could not find room id. url=https://telemost.yandex.ru/ title="Яндекс Телемост — бесплатные видеовстречи без регистрации и ограничения по времени" bodyText="21
+1 ТБ
Тарифы для бизнеса
Яндекс Телемост — чаты и видеозвонки
Создать видеовстречу
Подключиться
Запланировать
Мобильное приложение
Для звонков и переписки в чатах
Скачать
Поддержка
Частые вопросы"
```

The `bodyText` dump was byte-identical to the untouched landing page — no meeting-created UI, no copy-link box,
no error toast, no login prompt, captured ~45+ seconds after the click was issued and reported successful by
Playwright (no `TimeoutError`).

## Root cause found: wrong click locator (fixed)

The user pasted the real authenticated button's HTML: a native `<button data-testid="create-call-button">`
rendering **English** text "Create video meeting" — not the Russian "Создать видеовстречу" text the rotator was
matching. `getByRole('button', { name: /Создать видеовстречу/i })` found zero matches against the real button
and fell through to `getByText('Создать видеовстречу').last()`, which landed on a non-interactive Russian
marketing heading present on the page regardless of login state — click "succeeded" against that heading, doing
nothing, and `isLoggedIn()`'s use of the same ambiguous text meant it always reported `true` too.

Fix (now in `rotate.js`): both `isLoggedIn()` and `createRoom()` use `page.getByTestId('create-call-button')` —
the real, locale-independent control. Room-id extraction also gained a fallback: the on-page "Meeting No.
<digits>" text, confirmed (via a real-browser `createCall config {..., uri: '.../j/98878763622841', ...}` log)
to be the same digit string as the `/j/<id>` URL slug the panel/client expect.

## Root cause NOT yet found: click still doesn't fire in-container

After the locator fix deployed, the exact same "meeting created but could not find room id" failure recurred,
byte-identical bodyText, even though the button being clicked was now confirmed correct. Diagnostics added to
pin this down:

- Unconditional screenshots every cycle: `before-click.png`, `after-click.png` (10s post-click), `after-wait.png`
  (after the 45s URL/meeting-number wait) — all three came back **identical to the landing page**, no overlay,
  no modal, no blank/crashed state.
- Browser console + `pageerror` + `requestfailed` capture, dumped to sibling `*-console.txt` files next to each
  screenshot. Container dumps showed `net::ERR_CONNECTION_REFUSED` for `mc.yandex.ru/metrika/watch.js` and
  `csp.yandex.net/csp?...`, plus Module Federation "Unsatisfied version ^18.0.0 ... required ^16.x" warnings.
  **Ruled out as the cause**: the user confirmed their own real browser, on the same DNS, gets the identical
  errors and warnings and still works — these are harmless analytics-beacon noise, not a blocker.
- The decisive signal: a real logged-in browser logs `createCall config {connection_type: 'CONFERENCE', uri:
  'https://telemost.yandex.ru/j/98878763622841', room_id: '...', ...}` the instant the click lands. That log
  line has **never once appeared** in any container console dump, across every cycle captured so far — meaning
  the click event reaches the DOM (Playwright reports no error) but the app's real click handler is never
  invoked in-container.

This rules out: wrong locator (confirmed fixed), stale/invalid login session (fresh session didn't change the
outcome), a consent/GDPR overlay (screenshots show none), and the DNS-blocked-tracker theory (works fine
manually on the same network). It's consistent with the app silently gating the real handler behind an
automation check (e.g. `navigator.webdriver`), or some other headless/automation-specific quirk that doesn't
show up in a screenshot or in the app's own error handling.

## Automation-fingerprint mitigations tried (pushed, not yet confirmed)

1. `--disable-blink-features=AutomationControlled` launch flag, plus `context.addInitScript()` overriding
   `navigator.webdriver` to `undefined` on every page. Applied to the rotator container's browser launch (a
   version of this flag had already worked around a Google "this browser may not be secure" block in the local
   seed-login helper, but had never been applied to the container itself before this).
2. Switched the container's browser from headless to **headed** (`headless: false`), running under a virtual
   display: `rotator/Dockerfile` now installs `xvfb`, and `rotator/entrypoint.sh` starts `Xvfb :99` before
   `rotate.js`, on the theory that Chromium's headless mode (even "new" headless) may still be distinguishable
   from a real headed session by some client-side check.
3. Added a `--autoplay-policy=no-user-gesture-required` flag and a `probeMedia()` pre-check (calls
   `getUserMedia()` directly and logs enumerated devices / errors) to separately rule out a media-permission
   stall from being confused with the click issue.
4. Added a debug dump right before the click: `create-call-button` count, bounding rect, computed
   `elementFromPoint()` hit-target, and outer HTML — to catch an invisible overlay or coordinate mismatch that a
   full-page screenshot might not make obvious, plus a `before-click.png` screenshot.

None of these have been confirmed to fix the click yet — they were the latest push at the time this doc was
last updated. Check the next cycle's logs for the `createCall config {...}` line specifically; its presence or
absence is the clearest pass/fail signal, more reliable than watching for a successful room rotation.

## Recommended next diagnostic step

If the `createCall config` log still never appears after the headed-Xvfb + automation-fingerprint changes:

1. Check `before-click.png` for anything the earlier after-click/after-wait screenshots might have missed
   (e.g. a hydration state visible only in the instant before the click).
2. Consider that Xvfb's headed Chromium may still differ from a real desktop session in ways beyond
   `navigator.webdriver` (e.g. WebGL/canvas fingerprinting, screen/window geometry, missing fonts) — a real
   Chrome build (`channel: 'chrome'`) rather than Playwright's bundled Chromium might be the next lever, matching
   what the local seed-login helper already uses.
3. Compare the exact user-agent / `navigator` properties between the container's browser and a real desktop
   Chrome session, since Telemost's client-side check (if any) is still unidentified — no server-side code
   access, so this remains inference from symptoms, not confirmed source.

Until the `createCall config` log is seen from the container, treat the panel's Telemost room as **not** being
rotated automatically — the existing room keeps working until it naturally expires; rotate it by hand via the
panel UI in the meantime.
