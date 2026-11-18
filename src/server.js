import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import express from 'express';
import httpProxy from 'http-proxy';
import { createWorker, ensureDirectory } from './worker.js';

const { createProxyServer } = httpProxy;

const config = {
  apiUrl: process.env.DIMAG_API_URL ?? 'https://youtubi.onrender.com',
  secret: process.env.HISA_SECRET,
  flowUrl: process.env.FLOW_AI_URL ?? 'https://labs.google/fx/tools/flow',
  profileDir: process.env.CHROME_USER_DATA_DIR ?? './.chrome-profile',
  browserChannel: process.env.HISA_BROWSER_CHANNEL ?? 'chrome',
  headless: process.env.HEADLESS === 'true',
  pollIntervalMs: Number.parseInt(process.env.POLL_INTERVAL_MS ?? '60000', 10),
  port: Number.parseInt(process.env.PORT || '7860', 10),
  autoLogin: process.env.HISA_AUTO_LOGIN === 'true',
  enableVncProxy: process.env.ENABLE_VNC_PROXY === 'true',
  vncPassword: process.env.VNC_PASSWORD,
};

if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 1000) {
  throw new Error('POLL_INTERVAL_MS must be an integer of at least 1000.');
}
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}
if (config.enableVncProxy && !config.vncPassword) {
  throw new Error('VNC_PASSWORD is required when ENABLE_VNC_PROXY=true.');
}

const worker = createWorker({ config });
const app = express();
const getStatus = () => ({
  status: 'ok',
  service: 'hisa',
  busy: worker.state.busy,
  lastJobId: worker.state.lastJobId,
  lastError: worker.state.lastError,
});
app.get(['/', '/health'], (_request, response) => {
  response.json(getStatus());
});

function hasVncAuthorization(request) {
  const expected = Buffer.from(`hisa:${config.vncPassword}`).toString('base64');
  const supplied = request.headers.authorization?.match(/^Basic\s+(.+)$/i)?.[1];
  if (!supplied) {
    return false;
  }
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function requireVncAuthorization(request, response, next) {
  if (!hasVncAuthorization(request)) {
    response.set('WWW-Authenticate', 'Basic realm="Hisa VNC", charset="UTF-8"');
    response.status(401).send('VNC authentication required.');
    return;
  }
  next();
}

const vncProxy = config.enableVncProxy
  ? createProxyServer({ target: 'http://127.0.0.1:6080', ws: true, changeOrigin: true })
  : null;
if (vncProxy) {
  vncProxy.on('error', (error, _request, response) => {
    console.error(`noVNC proxy error: ${error.message}`);
    if (response && typeof response.writeHead === 'function' && !response.headersSent) {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('noVNC is unavailable.');
    } else if (response && typeof response.destroy === 'function') {
      response.destroy(error);
    }
  });
  app.use('/vnc', requireVncAuthorization, (request, response) => {
    request.url = request.originalUrl.replace(/^\/vnc(?=\/|$)/, '') || '/';
    vncProxy.web(request, response);
  });
}

await ensureDirectory(config.profileDir);
const server = app.listen(config.port, () => {
  console.log(`Hisa health server listening on port ${config.port}.`);
});
if (vncProxy) {
  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    if (!requestUrl.pathname.startsWith('/vnc/')) {
      return;
    }
    if (!hasVncAuthorization(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Hisa VNC"\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    requestUrl.pathname = requestUrl.pathname.replace(/^\/vnc/, '');
    request.url = `${requestUrl.pathname}${requestUrl.search}`;
    vncProxy.ws(request, socket, head);
  });
}

function startWorker() {
  void worker.start();
}

if (config.autoLogin) {
  const login = spawn(process.execPath, ['src/login.js'], {
    env: process.env,
    stdio: 'inherit',
  });
  login.once('error', (error) => {
    worker.state.lastError = `Could not launch the Flow sign-in browser: ${error.message}`;
    console.error(worker.state.lastError);
  });
  login.once('exit', (code, signal) => {
    if (code === 0) {
      console.log('Flow sign-in window closed; starting the Hisa worker.');
      startWorker();
      return;
    }
    worker.state.lastError = `Flow sign-in browser exited (code=${code}, signal=${signal}).`;
    console.error(worker.state.lastError);
  });
} else {
  startWorker();
}

function shutdown() {
  worker.stop();
  server.close();
  vncProxy?.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
