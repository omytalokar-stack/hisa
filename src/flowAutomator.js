import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const CLIP_TIMEOUT_MS = 3 * 60 * 1000;
const PROMPT_INPUT_TIMEOUT_MS = 15 * 1000;
const PROJECT_BUTTON_TIMEOUT_MS = 3 * 1000;
const FLOW_STORAGE_STATE_PATH = '/tmp/flow-storage-state.json';
const PROMPT_INPUT_SELECTOR = [
  'textarea:visible',
  '[contenteditable="true"]:visible',
  '[role="textbox"]:visible',
  'input[placeholder*="prompt" i]:visible',
  'input[placeholder*="describe" i]:visible',
  'input[placeholder*="imagine" i]:visible',
  'input[placeholder*="create" i]:visible',
].join(', ');

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

async function findPromptInput(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const inputs = page.locator(PROMPT_INPUT_SELECTOR);
    if (await inputs.count()) {
      return inputs.first();
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await page.waitForTimeout(Math.min(250, deadline - Date.now()));
  }
}

async function clickProjectCreationButton(page, timeoutMs) {
  const candidates = [
    page.getByRole('button', { name: /new project/i }),
    page.getByRole('button', { name: /create with flow/i }),
    page.getByRole('button', { name: /^\s*\+\s*$/ }),
    page.locator(
      'button[aria-label*="new project" i], button[title*="new project" i], ' +
        'button[aria-label*="create project" i], button[title*="create project" i]',
    ),
  ];
  const deadline = Date.now() + timeoutMs;

  while (true) {
    for (const candidate of candidates) {
      const count = await candidate.count();
      for (let index = 0; index < count; index += 1) {
        const button = candidate.nth(index);
        if (await button.isVisible() && await button.isEnabled()) {
          await button.click();
          return true;
        }
      }
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await page.waitForTimeout(Math.min(250, deadline - Date.now()));
  }
}

async function promptInputError(page) {
  let pageText;
  try {
    pageText = (await page.locator('body').innerText({ timeout: 2000 })).slice(0, 1200);
  } catch (error) {
    pageText = `Unable to read page text: ${error.message}`;
  }
  return new Error(
    `Could not find the Flow AI prompt input.\n` +
      `Current URL: ${page.url()}\n` +
      `Page title: ${await page.title()}\n` +
      `Page text: ${pageText}`,
  );
}

async function selectVerticalAspectRatio(page) {
  const ratioMenu = page.getByRole('button', { name: /aspect|ratio|9:16/i });
  if (await ratioMenu.count()) {
    await ratioMenu.first().click();
  }
  await clickFirst(page.getByText('9:16', { exact: true }));
}

async function fillPrompt(page, prompt, timeoutMs) {
  const startedAt = Date.now();
  const inputTimeout = Math.min(PROMPT_INPUT_TIMEOUT_MS, timeoutMs);
  let input = await findPromptInput(page, 0);

  if (!input) {
    await clickProjectCreationButton(
      page,
      Math.min(PROJECT_BUTTON_TIMEOUT_MS, inputTimeout),
    );
    input = await findPromptInput(page, Math.max(0, inputTimeout - (Date.now() - startedAt)));
  }
  if (!input) {
    throw await promptInputError(page);
  }
  await input.fill(prompt);
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
  await fillPrompt(page, prompt, Math.max(0, deadline - Date.now()));

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
    const pageUrl = page.url();
    const pageTitle = await page.title();
    logger.info(
      `Google Flow page after navigation: ${JSON.stringify({ url: pageUrl, title: pageTitle })}`,
    );
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
