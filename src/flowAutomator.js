import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const CLIP_TIMEOUT_MS = 3 * 60 * 1000;
const FLOW_STORAGE_STATE_PATH = '/tmp/flow-storage-state.json';

export function decodeFlowStorageState(encodedState) {
  const stateJson = Buffer.from(encodedState, 'base64').toString('utf8');
  try {
    const state = JSON.parse(stateJson);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('Invalid storage state.');
    }
  } catch {
    throw new Error(
      'FLOW_STORAGE_STATE_B64 must contain a base64-encoded Playwright storage state JSON.',
    );
  }
  return stateJson;
}

export async function writeFlowStorageState(
  encodedState = process.env.FLOW_STORAGE_STATE_B64,
  storagePath = FLOW_STORAGE_STATE_PATH,
) {
  if (!encodedState) {
    return undefined;
  }
  await writeFile(storagePath, decodeFlowStorageState(encodedState), { mode: 0o600 });
  return storagePath;
}

export function createBrowserLaunchOptions({
  headless,
  downloadsPath,
  browserChannel,
  storageState,
}) {
  const options = {
    headless,
    acceptDownloads: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };
  if (downloadsPath) {
    options.downloadsPath = downloadsPath;
  }
  if (storageState) {
    options.storageState = storageState;
  }

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (executablePath) {
    options.executablePath = executablePath;
  } else if (browserChannel && browserChannel !== 'bundled') {
    options.channel = browserChannel;
  }
  return options;
}

function isSignInScreen(page) {
  return /accounts\.google\.com/i.test(page.url());
}

async function waitForWorkspace(page, logger) {
  if (!isSignInScreen(page)) {
    return;
  }

  logger.info('Please sign in to Google/Flow AI in the opened Chrome window...');
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (!isSignInScreen(page)) {
      await page.waitForLoadState('domcontentloaded');
      return;
    }
  }
  throw new Error('Timed out waiting for Google/Flow AI sign-in.');
}

async function clickFirst(locator) {
  if (await locator.count()) {
    await locator.first().click();
    return true;
  }
  return false;
}

async function selectVerticalAspectRatio(page) {
  const ratioMenu = page.getByRole('button', { name: /aspect|ratio|9:16/i });
  if (await ratioMenu.count()) {
    await ratioMenu.first().click();
  }
  await clickFirst(page.getByText('9:16', { exact: true }));
}

async function fillPrompt(page, prompt) {
  const inputs = page.locator('textarea, [contenteditable="true"], [role="textbox"]');
  if (!(await inputs.count())) {
    throw new Error('Could not find the Flow AI prompt input.');
  }
  await inputs.first().fill(prompt);
}

async function waitForDownloadButton(page, deadline) {
  while (Date.now() < deadline) {
    const selector =
      'button[aria-label*="download" i], button[title*="download" i], a[download], a[href*=".mp4"]';
    const downloadButton = page.locator(selector);
    if (await downloadButton.count()) {
      const first = downloadButton.first();
      if (await first.isEnabled()) {
        return first;
      }
    }
    const accessibleButton = page.getByRole('button', { name: /download/i });
    if (await accessibleButton.count()) {
      const first = accessibleButton.first();
      if (await first.isEnabled()) {
        return first;
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('Timed out waiting for the Flow AI video render to finish.');
}

export async function automateScene(page, prompt, outputPath, timeoutMs = CLIP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  await selectVerticalAspectRatio(page);
  await fillPrompt(page, prompt);

  const generateButton = page.getByRole('button', { name: /generate|create/i });
  if (!(await generateButton.count())) {
    throw new Error('Could not find the Flow AI generate button.');
  }
  await generateButton.first().click();

  const downloadButton = await waitForDownloadButton(page, deadline);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error('Timed out waiting for the Flow AI video render to finish.');
  }
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: remainingMs }),
    downloadButton.click({ timeout: remainingMs }),
  ]);
  await download.saveAs(outputPath);
}

export async function generateClips({
  scenePrompts,
  jobTmpDir,
  flowUrl,
  profileDir,
  browserChannel,
  headless,
  logger = console,
}) {
  const storageState = await writeFlowStorageState();
  const browserOptions = createBrowserLaunchOptions({
    headless,
    downloadsPath: jobTmpDir,
    browserChannel,
    storageState,
  });
  const context = await chromium.launchPersistentContext(profileDir, browserOptions);

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(flowUrl, { waitUntil: 'domcontentloaded' });
    await waitForWorkspace(page, logger);

    const clipPaths = [];
    for (const [index, prompt] of scenePrompts.entries()) {
      const clipPath = join(jobTmpDir, `clip_${index + 1}.mp4`);
      await automateScene(page, prompt, clipPath);
      clipPaths.push(clipPath);
    }
    return clipPaths;
  } finally {
    await context.close();
  }
}

export async function openLoginWindow({
  flowUrl,
  profileDir,
  browserChannel = 'chrome',
  headless = false,
}) {
  const browserOptions = createBrowserLaunchOptions({
    headless,
    browserChannel,
  });
  const context = await chromium.launchPersistentContext(profileDir, browserOptions);
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    const closed = new Promise((resolve) => page.once('close', resolve));
    await page.goto(flowUrl, { waitUntil: 'domcontentloaded' });
    console.log('Flow AI is open. Close the Chrome window when you are finished signing in.');
    await closed;
  } finally {
    await context.close();
  }
}
