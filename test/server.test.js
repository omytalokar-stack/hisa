import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

test('serves live status JSON at / and /health on the configured port', async () => {
  const backend = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ job: null }));
  });
  const backendPort = await listen(backend);
  const profileDir = await mkdtemp(join(tmpdir(), 'hisa-server-test-'));
  const portReservation = createServer();
  const port = await listen(portReservation);
  await close(portReservation);

  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      DIMAG_API_URL: `http://127.0.0.1:${backendPort}`,
      HISA_SECRET: 'server-test-secret',
      CHROME_USER_DATA_DIR: profileDir,
      HEADLESS: 'true',
      PORT: String(port),
      POLL_INTERVAL_MS: '60000',
      ENABLE_VNC_PROXY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    childOutput += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    childOutput += chunk;
  });

  try {
    let statuses;
    let lastError;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Hisa server exited with code ${child.exitCode}: ${childOutput}`);
      }
      try {
        const [rootResponse, healthResponse] = await Promise.all([
          fetch(`http://127.0.0.1:${port}/`),
          fetch(`http://127.0.0.1:${port}/health`),
        ]);
        assert.equal(rootResponse.status, 200);
        assert.equal(healthResponse.status, 200);
        statuses = await Promise.all([rootResponse.json(), healthResponse.json()]);
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    assert.ok(statuses, `Hisa health routes did not become ready: ${lastError}`);
    for (const status of statuses) {
      assert.deepEqual(status, {
        status: 'ok',
        service: 'hisa',
        busy: false,
        lastJobId: null,
        lastError: null,
      });
    }
  } finally {
    await stopChild(child);
    await close(backend);
    await rm(profileDir, { recursive: true, force: true });
  }
});
