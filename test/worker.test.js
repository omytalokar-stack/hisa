import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  automateScene,
  createBrowserLaunchOptions,
  decodeFlowStorageState,
  navigateToFlowWorkspace,
  writeFlowStorageState,
} from '../src/flowAutomator.js';
import { createWorker } from '../src/worker.js';

const scenePrompts = ['one', 'two', 'three'];

test('writes decoded Playwright storage state and configures it for Chromium', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hisa-storage-state-'));
  const storagePath = join(tempRoot, 'state.json');
  const state = { cookies: [], origins: [] };
  const encodedState = Buffer.from(JSON.stringify(state)).toString('base64');

  try {
    assert.equal(decodeFlowStorageState(encodedState), JSON.stringify(state));
    assert.equal(await writeFlowStorageState(encodedState, storagePath), storagePath);
    assert.deepEqual(JSON.parse(await readFile(storagePath, 'utf8')), state);
    assert.equal(
      createBrowserLaunchOptions({
        headless: true,
        browserChannel: 'bundled',
        storageState: storagePath,
      }).storageState,
      storagePath,
    );
    assert.throws(() => decodeFlowStorageState('not-json'), /FLOW_STORAGE_STATE_B64/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

for (const clipCount of [1, 3, 5]) {
  const prompts = Array.from({ length: clipCount }, (_, index) => `scene ${index + 1}`);
  test(`polls and streams ${clipCount} validated clips to the completion endpoint`, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'hisa-test-'));
    const uploads = [];
    let calls = 0;
    const worker = createWorker({
      config: {
        apiUrl: 'https://backend.example/',
        secret: 'test-secret',
        flowUrl: 'https://flow.example',
        profileDir: join(tempRoot, 'profile'),
        headless: true,
        pollIntervalMs: 60000,
      },
      fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(options.headers['x-hisa-secret'], 'test-secret');
        if (url.endsWith('/api/hisa/next-job')) {
          return {
            ok: true,
            json: async () => ({
              job: { jobId: 'job/123', channelTitle: 'Channel', scenePrompts: prompts },
            }),
          };
        }
        assert.equal(url, 'https://backend.example/api/hisa/complete-job/job%2F123');
        assert.equal(options.method, 'POST');
        assert.match(options.headers['content-type'], /^multipart\/form-data; boundary=/);
        for await (const chunk of options.body) {
          uploads.push(chunk);
        }
        return { ok: true };
      },
      clipGenerator: async ({ jobTmpDir, scenePrompts: generatedPrompts }) => {
        assert.deepEqual(generatedPrompts, prompts);
        return Promise.all(
          generatedPrompts.map(async (_prompt, index) => {
            const path = join(jobTmpDir, `clip_${index + 1}.mp4`);
            await writeFile(path, Buffer.alloc(51 * 1024, index));
            return path;
          }),
        );
      },
      logger: { info() {}, error() {} },
    });

    try {
      await worker.pollOnce();
      assert.equal(calls, 2);
      assert.match(Buffer.concat(uploads).toString('utf8'), new RegExp(`filename="clip_${clipCount}\\.mp4"`));
      assert.equal(worker.state.busy, false);
      assert.equal(worker.state.lastJobId, 'job/123');
      assert.deepEqual(await readdir(tempRoot), []);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
}

test('cleans up a job directory when a clip fails validation', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hisa-test-'));
  let uploadRequested = false;
  const worker = createWorker({
    config: {
      apiUrl: 'https://backend.example',
      secret: 'test-secret',
      flowUrl: 'https://flow.example',
      profileDir: tempRoot,
      headless: true,
      pollIntervalMs: 60000,
    },
    fetchImpl: async (url) => {
      if (url.endsWith('/next-job')) {
        return {
          ok: true,
          json: async () => ({ job: { jobId: 'small-clip', scenePrompts } }),
        };
      }
      uploadRequested = true;
      return { ok: true };
    },
    clipGenerator: async ({ jobTmpDir }) => {
      const paths = [];
      for (let index = 0; index < scenePrompts.length; index += 1) {
        const path = join(jobTmpDir, `clip_${index + 1}.mp4`);
        await writeFile(path, Buffer.alloc(index === 0 ? 50 * 1024 : 51 * 1024));
        paths.push(path);
      }
      return paths;
    },
    logger: { info() {}, error() {} },
  });

  try {
    await assert.rejects(worker.pollOnce(), /not larger than 50 KB/);
    assert.equal(uploadRequested, false);
    assert.equal(worker.state.busy, false);
    assert.equal((await readdir(tempRoot)).length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('opens the Flow app from the about page CTA in a popup', async () => {
  const popupPage = {
    url: () => 'https://labs.google/fx/tools/flow',
    title: async () => 'Google Flow',
    waitForTimeout: async () => {},
  };
  let resolvePopup;
  let clicked = false;
  const emptyLocator = { count: async () => 0 };
  const createWithFlowButton = {
    count: async () => 1,
    nth() {
      return this;
    },
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      clicked = true;
      resolvePopup(popupPage);
    },
  };
  const page = {
    url: () => 'https://flow.google.com/about#tools',
    title: async () => 'Google Flow — AI filmmaking',
    getByRole: (role, options) =>
      role === 'button' && /create with google flow/i.test(String(options.name))
        ? createWithFlowButton
        : emptyLocator,
    getByText: () => emptyLocator,
    waitForEvent: (eventName, { timeout }) => {
      assert.equal(eventName, 'popup');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No popup opened.')), timeout);
        resolvePopup = (popup) => {
          clearTimeout(timer);
          resolve(popup);
        };
      });
    },
  };
  const logMessages = [];

  const workspacePage = await navigateToFlowWorkspace(page, {
    info: (message) => logMessages.push(message),
  });

  assert.equal(clicked, true);
  assert.equal(workspacePage, popupPage);
  assert.ok(logMessages.some((message) => message.includes('https://labs.google/fx/tools/flow')));
});

test('follows a same-tab redirect from the Flow about page CTA', async () => {
  let currentUrl = 'https://flow.google.com/about#tools';
  const createWithFlowButton = {
    count: async () => 1,
    nth() {
      return this;
    },
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      currentUrl = 'https://flow.google.com/tools/flow';
    },
  };
  const emptyLocator = { count: async () => 0 };
  const page = {
    url: () => currentUrl,
    title: async () => 'Google Flow',
    getByRole: (role, options) =>
      role === 'button' && /try in google flow/i.test(String(options.name))
        ? createWithFlowButton
        : emptyLocator,
    getByText: () => emptyLocator,
    waitForEvent: async () => null,
    waitForTimeout: async () => {},
  };

  const workspacePage = await navigateToFlowWorkspace(page, { info() {} });

  assert.equal(workspacePage, page);
  assert.equal(workspacePage.url(), 'https://flow.google.com/tools/flow');
});

test('opens a new project and fills a contenteditable Flow prompt editor', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hisa-flow-test-'));
  const outputPath = join(tempRoot, 'clip.mp4');
  let promptValue = '';
  let generated = false;
  let promptVisible = false;

  const locator = (kind) => ({
    count: async () => {
      if (kind === 'ratio') return 1;
      if (kind === 'prompt') return promptVisible ? 1 : 0;
      if (kind === 'newProject') return 1;
      if (kind === 'generate') return generated ? 0 : 1;
      if (kind === 'download') return generated ? 1 : 0;
      return 0;
    },
    first() {
      return this;
    },
    nth() {
      return this;
    },
    isVisible: async () => true,
    isEnabled: async () => true,
    fill: async (value) => {
      promptValue = value;
    },
    click: async () => {
      if (kind === 'newProject') promptVisible = true;
      if (kind === 'generate') generated = true;
    },
  });

  test('uses the configured system Chromium executable instead of a browser channel', () => {
    const previousExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '/usr/bin/chromium';

    try {
      const options = createBrowserLaunchOptions({
        headless: false,
        downloadsPath: '/tmp/hisa-job',
        browserChannel: 'chrome',
      });
      assert.equal(options.executablePath, '/usr/bin/chromium');
      assert.equal(options.channel, undefined);
      assert.equal(options.downloadsPath, '/tmp/hisa-job');
      assert.ok(options.args.includes('--disable-dev-shm-usage'));
    } finally {
      if (previousExecutable === undefined) {
        delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      } else {
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = previousExecutable;
      }
    }
  });
  const page = {
    locator: (selector) =>
      locator(selector.includes('[contenteditable="true"]') ? 'prompt' : 'other'),
    getByText: (text) => locator(text === '9:16' ? 'ratio' : 'other'),
    getByRole: (_role, options) => {
      const name = String(options.name);
      if (/new project/i.test(name)) return locator('newProject');
      if (/aspect|ratio|9:16/i.test(name)) return locator('ratio');
      return locator(/generate|create/i.test(name) ? 'generate' : 'download');
    },
    waitForEvent: async () => ({
      saveAs: async (path) => writeFile(path, Buffer.alloc(51 * 1024)),
    }),
  };

  try {
    await automateScene(page, 'A cinematic scene', outputPath, 1000);
    assert.equal(promptValue, 'A cinematic scene');
    assert.equal((await readFile(outputPath)).byteLength, 51 * 1024);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('includes the current Flow page details when the prompt editor is missing', async () => {
  const page = {
    locator: (selector) => ({
      count: async () => (selector === 'body' ? 1 : 0),
      first() {
        return this;
      },
      innerText: async () => 'Welcome to Flow',
    }),
    getByText: () => ({ count: async () => 0 }),
    getByRole: () => ({ count: async () => 0 }),
    waitForTimeout: (timeout) => new Promise((resolve) => setTimeout(resolve, timeout)),
    url: () => 'https://flow.google.com/projects',
    title: async () => 'Google Flow projects',
  };

  await assert.rejects(
    automateScene(page, 'A cinematic scene', '/tmp/unused.mp4', 50),
    (error) =>
      error.message.includes('https://flow.google.com/projects') &&
      error.message.includes('Google Flow projects') &&
      error.message.includes('Welcome to Flow'),
  );
});
