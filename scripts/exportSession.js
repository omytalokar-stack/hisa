import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { createBrowserLaunchOptions } from '../src/flowAutomator.js';

const FLOW_URL = 'https://labs.google/fx/tools/flow';
const sessionPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'session.b64');
const terminal = createInterface({ input: stdin, output: stdout });
let browser;

try {
  browser = await chromium.launch(
    createBrowserLaunchOptions({ headless: false, browserChannel: 'bundled' }),
  );
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded' });
  console.log('Sign in to Google Flow in the Chromium window.');
  await terminal.question('When sign-in is complete, press Enter here to save the session. ');

  const storageState = await context.storageState();
  await writeFile(sessionPath, `${Buffer.from(JSON.stringify(storageState)).toString('base64')}\n`, {
    mode: 0o600,
  });
  console.log(`Session saved to ${sessionPath}. Keep this file private.`);
} finally {
  terminal.close();
  if (browser) {
    await browser.close();
  }
}
