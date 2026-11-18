import 'dotenv/config';
import express from 'express';
import { createWorker, ensureDirectory } from './worker.js';

const config = {
  apiUrl: process.env.DIMAG_API_URL ?? 'https://youtubi.onrender.com',
  secret: process.env.HISA_SECRET,
  flowUrl: process.env.FLOW_AI_URL ?? 'https://labs.google/fx/tools/flow',
  profileDir: process.env.CHROME_USER_DATA_DIR ?? './.chrome-profile',
  browserChannel: process.env.HISA_BROWSER_CHANNEL ?? 'chrome',
  headless: process.env.HEADLESS === 'true',
  pollIntervalMs: Number.parseInt(process.env.POLL_INTERVAL_MS ?? '60000', 10),
  port: Number.parseInt(process.env.PORT || '7860', 10),
};

if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 1000) {
  throw new Error('POLL_INTERVAL_MS must be an integer of at least 1000.');
}
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT must be a valid TCP port.');
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

await ensureDirectory(config.profileDir);
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Hisa health server listening on port ${config.port}.`);
});
void worker.start();

function shutdown() {
  worker.stop();
  server.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
