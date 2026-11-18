import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { automateScene, createBrowserLaunchOptions } from '../src/flowAutomator.js';
import { createWorker } from '../src/worker.js';

const scenePrompts = ['one', 'two', 'three', 'four', 'five'];

test('polls and streams five validated clips to the completion endpoint', async () => {
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
            job: { jobId: 'job/123', channelTitle: 'Channel', scenePrompts },
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
    clipGenerator: async ({ jobTmpDir, scenePrompts: prompts }) => {
      assert.deepEqual(prompts, scenePrompts);
      return Promise.all(
        prompts.map(async (_prompt, index) => {
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
    assert.match(Buffer.concat(uploads).toString('utf8'), /filename="clip_5\.mp4"/);
    assert.equal(worker.state.busy, false);
    assert.equal(worker.state.lastJobId, 'job/123');
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

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
      for (let index = 0; index < 5; index += 1) {
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

test('fills a mocked Flow page and saves its generated MP4 download', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hisa-flow-test-'));
  const outputPath = join(tempRoot, 'clip.mp4');
  let promptValue = '';
  let generated = false;

  const locator = (kind) => ({
    count: async () => {
      if (kind === 'ratio') return 1;
      if (kind === 'prompt') return 1;
      if (kind === 'generate') return generated ? 0 : 1;
      if (kind === 'download') return generated ? 1 : 0;
      return 0;
    },
    first() {
      return this;
    },
    isEnabled: async () => true,
    fill: async (value) => {
      promptValue = value;
    },
    click: async () => {
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
    locator: (selector) => locator(selector.startsWith('textarea') ? 'prompt' : 'other'),
    getByText: (text) => locator(text === '9:16' ? 'ratio' : 'other'),
    getByRole: (_role, options) =>
      locator(/generate|create/i.test(options.name) ? 'generate' : 'download'),
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
