const { chromium } = require('playwright');
const readline = require('readline');
const path = require('path');

const STATE_PATH = path.join(__dirname, 'state.json');

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://telemost.yandex.ru');

  console.log('\nBrowser opened. Log in by hand (Google-via-Yandex), same account the rotator will use.');
  console.log('Once fully logged in and you can see your account/avatar, come back here.\n');

  await waitForEnter('Press Enter to save session and close browser... ');

  await context.storageState({ path: STATE_PATH });
  console.log(`Saved session to ${STATE_PATH}`);

  await browser.close();
})();
