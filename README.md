---
title: Hisa
emoji: 🐠
colorFrom: green
colorTo: purple
sdk: gradio
sdk_version: 6.32.0
python_version: '3.12'
app_file: app.py
pinned: false
---

# Hisa

Hisa polls Dimag AI V2 for video jobs, creates five vertical clips in Google Flow AI using Playwright, and streams the MP4s back to the backend. Video files remain on disk during upload rather than being buffered together in memory.

## Requirements

- Node.js 20 or newer
- Google Flow AI access
- A Dimag AI V2 `CRON_SECRET` value for `HISA_SECRET`

## Local setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and set `HISA_SECRET` to the same value as Dimag AI V2's `CRON_SECRET`.
3. Run `npm run export-session` to open Chromium, sign in to Google Flow, then press Enter in the terminal. The base64 Playwright storage state is saved to the gitignored `session.b64` file. Keep it private.
4. Set `FLOW_STORAGE_STATE_B64` to the contents of `session.b64`, then run `npm start`.
5. Check `http://localhost:7860/health` for the worker status.

Alternatively, `npm run login` opens Flow AI in the persistent profile at `CHROME_USER_DATA_DIR` (default `./.chrome-profile`). The profile is reused by future runs. `HISA_BROWSER_CHANNEL` defaults to `chrome`; use `bundled` to run Playwright's bundled Chromium.

The worker requests jobs at `GET /api/hisa/next-job` and uploads five multipart `clips` fields to `POST /api/hisa/complete-job/:jobId`, authenticating both requests with `x-hisa-secret`. The job response must contain `job.jobId`, `job.channelTitle`, and exactly five strings in `job.scenePrompts`.

## Commands

- `npm start` — health server and continuous polling worker
- `npm run login` — open Flow AI with the persistent profile
- `npm run export-session` — export a signed-in Playwright storage state to `session.b64`
- `npm test` — run mocked worker and Flow page tests
- `npm run check` — syntax-check service and script files

## Hugging Face Spaces (Gradio SDK)

The Space `https://huggingface.co/spaces/omytalokar/hisa` uses `app.py` as its Gradio entrypoint. `packages.txt` installs only Node.js, npm, and Chromium; `requirements.txt` installs Gradio. The app runs the worker headlessly on internal port 5050 and serves the status dashboard on port 7860. It does not require VNC or an X server.

1. Run `npm run export-session` on your local computer and sign in to Google Flow in the opened Chromium window.
2. Add these values under the Space **Settings → Variables and secrets**:
   - `DIMAG_API_URL` = `https://youtubi.onrender.com`
   - `HISA_SECRET` = the same value as Dimag AI V2's `CRON_SECRET`
   - `FLOW_STORAGE_STATE_B64` = the full contents of your local `session.b64` file
3. Keep `session.b64` private and never commit or share it. The storage state grants access to your Google account; rotate/re-export it if it is exposed or expires.
4. Push this repository to the Space and wait for its Gradio build to complete.
5. Open the Space dashboard to view live worker status, the last job ID, and errors.

`app.py` starts `node src/server.js` with `HEADLESS=true`, `PORT=5050`, and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`. The Node worker decodes `FLOW_STORAGE_STATE_B64` into a temporary Playwright state file before launching Chromium. Re-export the state and update the Space secret if Google sign-in expires.

## Optional Hugging Face Spaces (Docker SDK)

1. Create a Hugging Face Space using the **Docker** SDK. The repository root must contain `Dockerfile` and `start-space.sh`.
2. Add `DIMAG_API_URL`, `HISA_SECRET`, and `FLOW_STORAGE_STATE_B64` as Space secrets. Generate the Flow value with `npm run export-session`.
3. Enable persistent storage if desired and set `CHROME_USER_DATA_DIR` to `/data/chrome-profile`.
4. Push the repository to the Space and wait for the Docker build to finish.
5. Open the Space URL to view the worker status.

The Docker launcher uses Playwright's bundled Chromium in headless mode and listens on the Space-provided `PORT` (default 7860). It does not start VNC or X11 services.

The Flow UI can change, so selectors may need updates if Google's interface changes.
