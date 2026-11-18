import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { generateClips } from './flowAutomator.js';

const MIN_CLIP_COUNT = 1;
const MAX_CLIP_COUNT = 5;
const MIN_CLIP_BYTES = 50 * 1024;

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function createMultipartBody(paths, boundary) {
  async function* parts() {
    for (let index = 0; index < paths.length; index += 1) {
      yield Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="clips"; filename="clip_${index + 1}.mp4"\r\n` +
          'Content-Type: video/mp4\r\n\r\n',
      );
      for await (const chunk of createReadStream(paths[index])) {
        yield chunk;
      }
      yield Buffer.from('\r\n');
    }
    yield Buffer.from(`--${boundary}--\r\n`);
  }

  return Readable.from(parts());
}

export function createWorker({
  config,
  fetchImpl = globalThis.fetch,
  clipGenerator = generateClips,
  logger = console,
}) {
  const missingConfig = [
    ['DIMAG_API_URL', config?.apiUrl],
    ['HISA_SECRET', config?.secret],
    ['FLOW_AI_URL', config?.flowUrl],
    ['CHROME_USER_DATA_DIR', config?.profileDir],
  ]
    .filter(([, value]) => typeof value !== 'string' || value.length === 0)
    .map(([name]) => name);
  if (missingConfig.length) {
    throw new Error(`Missing worker configuration: ${missingConfig.join(', ')}.`);
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required.');
  }

  const apiUrl = normalizeBaseUrl(config.apiUrl);
  const state = {
    busy: false,
    lastJobId: null,
    lastError: null,
  };
  let stopping = false;

  async function requestNextJob() {
    const response = await fetchImpl(`${apiUrl}/api/hisa/next-job`, {
      headers: { 'x-hisa-secret': config.secret },
    });
    if (!response.ok) {
      throw new Error(`Polling failed with HTTP ${response.status}.`);
    }
    return response.json();
  }

  async function uploadClips(jobId, clipPaths) {
    const boundary = `----hisa-${crypto.randomUUID()}`;
    const body = createMultipartBody(clipPaths, boundary);
    const response = await fetchImpl(
      `${apiUrl}/api/hisa/complete-job/${encodeURIComponent(jobId)}`,
      {
        method: 'POST',
        headers: {
          'x-hisa-secret': config.secret,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
        duplex: 'half',
      },
    );
    if (!response.ok) {
      throw new Error(`Job upload failed with HTTP ${response.status}.`);
    }
  }

  async function processJob(job) {
    const { jobId, channelTitle, scenePrompts } = job ?? {};
    if (
      !jobId ||
      !Array.isArray(scenePrompts) ||
      scenePrompts.length < MIN_CLIP_COUNT ||
      scenePrompts.length > MAX_CLIP_COUNT ||
      scenePrompts.some((prompt) => typeof prompt !== 'string' || prompt.trim().length === 0)
    ) {
      throw new Error('Received a job without a jobId and between one and five non-empty scenePrompts.');
    }

    state.busy = true;
    state.lastJobId = String(jobId);
    state.lastError = null;
    const jobTmpDir = await mkdtemp(join(tmpdir(), 'hisa-'));

    try {
      const clipPaths = await clipGenerator({
        channelTitle,
        scenePrompts,
        jobTmpDir,
        flowUrl: config.flowUrl,
        profileDir: config.profileDir,
        browserChannel: config.browserChannel,
        headless: config.headless,
      });

      if (!Array.isArray(clipPaths) || clipPaths.length !== scenePrompts.length) {
        throw new Error(`Flow automation did not return exactly ${scenePrompts.length} clip files.`);
      }

      for (const [index, path] of clipPaths.entries()) {
        const fileInfo = await stat(path);
        if (!fileInfo.isFile() || fileInfo.size <= MIN_CLIP_BYTES) {
          throw new Error(`Clip ${index + 1} is missing or is not larger than 50 KB.`);
        }
      }

      await uploadClips(jobId, clipPaths);
      logger.info(`Completed Hisa job ${jobId}.`);
    } finally {
      try {
        await rm(jobTmpDir, { recursive: true, force: true });
      } finally {
        state.busy = false;
      }
    }
  }

  async function pollOnce() {
    try {
      const result = await requestNextJob();
      state.lastError = null;
      if (result?.job) {
        await processJob(result.job);
      }
      return result?.job ?? null;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      logger.error(`Hisa worker error: ${state.lastError}`);
      throw error;
    }
  }

  async function start() {
    stopping = false;
    while (!stopping) {
      try {
        await pollOnce();
      } catch {
        // The failure is reported through lastError and the logger; keep polling.
      }
      if (!stopping) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, config.pollIntervalMs);
          timer.unref();
        });
      }
    }
  }

  function stop() {
    stopping = true;
  }

  return { state, pollOnce, start, stop };
}

export async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}
