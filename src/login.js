import 'dotenv/config';
import { openLoginWindow } from './flowAutomator.js';
import { ensureDirectory } from './worker.js';

const flowUrl = process.env.FLOW_AI_URL ?? 'https://labs.google/fx/tools/flow';
const profileDir = process.env.CHROME_USER_DATA_DIR ?? './.chrome-profile';
const browserChannel = process.env.HISA_BROWSER_CHANNEL ?? 'chrome';
const headless = process.env.HEADLESS === 'true';

await ensureDirectory(profileDir);
await openLoginWindow({ flowUrl, profileDir, browserChannel, headless });
