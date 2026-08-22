// Run this LOCALLY (not in the container) to mint the initial session file:
//
//   npm install playwright
//   npx playwright install chromium
//   node seed-login.js
//
// A real, visible Chromium window opens on telemost.yandex.ru. Sign in
// with "Google" using the account, complete any 2FA by hand, wait until
// you land back on the Telemost page logged in, then come back to this
// terminal and press Enter. It writes ./state.json - upload that file to
// the server as the rotator's STATE_PATH volume (see README).
import { chromium } from 'playwright';
import readline from 'node:readline/promises';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://telemost.yandex.ru/');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Finish signing in with Google in the opened browser, then press Enter here... ');
  rl.close();

  await context.storageState({ path: 'state.json' });
  console.log('Wrote state.json - upload this to the server as the rotator STATE_PATH volume.');

  await browser.close();
}

main();
