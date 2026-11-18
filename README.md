---
title: Hisa
sdk: gradio
app_file: app.py
---

# Hisa

Hisa is a standalone Node.js worker that polls Dimag AI V2 for video jobs, creates five vertical clips in Google Flow AI using a persistent Chrome profile, and streams the MP4s back to the backend. Video files remain on disk during upload rather than being buffered together in memory.

## Requirements

- Node.js 20 or newer
- Google Chrome installed locally (the worker launches it with Playwright's `channel: "chrome"`)
- A Dimag AI V2 `CRON_SECRET` value for `HISA_SECRET`
- Access to Google Flow AI

## Local setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and set `HISA_SECRET` to the same value as Dimag AI V2's `CRON_SECRET`.
3. Run `npm run login` to open Flow AI in the persistent profile. Complete Google sign-in in Chrome; the profile is reused by future runs.
4. Run `npm start` to start the worker and health endpoint.
5. Check `http://localhost:7860/health` or `http://localhost:7860/`.

The worker opens a visible Chrome window by default. Set `HEADLESS=true` only when the persistent profile is already authenticated and the deployment supports browser automation. `CHROME_USER_DATA_DIR` defaults to `./.chrome-profile`; keep that directory persistent and private. `HISA_BROWSER_CHANNEL` defaults to `chrome` for the installed desktop Chrome. The Docker image uses `bundled` to run the Chromium shipped with Playwright.

The worker requests jobs at `GET /api/hisa/next-job` and uploads five multipart `clips` fields to `POST /api/hisa/complete-job/:jobId`, authenticating both requests with `x-hisa-secret`. The job response must contain `job.jobId`, `job.channelTitle`, and exactly five strings in `job.scenePrompts`.

## Commands

- `npm start` — health server and continuous polling worker
- `npm run login` — open Flow AI with the persistent profile
- `npm test` — run mocked worker and Flow page tests
- `npm run check` — syntax-check service source files

## Hugging Face Spaces (Gradio SDK)

The Space `https://huggingface.co/spaces/omytalokar/hisa` uses `app.py` as its Gradio entrypoint. Root-level `packages.txt` installs Node.js, Chromium, Xvfb, x11vnc, noVNC, and websockify; `requirements.txt` installs Gradio.

1. In the Space **Settings → Variables and secrets**, add these secrets:
   - `DIMAG_API_URL` = `https://youtubi.onrender.com`
   - `HISA_SECRET` = the same value as Dimag AI V2's `CRON_SECRET`
   - `VNC_PASSWORD` = a private password for the VNC session
2. Enable persistent storage if available and set `CHROME_USER_DATA_DIR` to `/data/chrome-profile`; otherwise Google sign-in may need to be repeated after a Space restart.
3. Push this repository to the Space and wait for its Gradio build to complete.
4. Open the Space dashboard and choose **Open the remote Chrome desktop (noVNC)**. Sign in to Google/Flow AI in the desktop. Close the Chrome window after sign-in; the Hisa worker then begins polling.
5. The dashboard displays the live worker JSON, last job ID, and errors. The worker's internal health URL is `http://127.0.0.1:5050/health`.

The Gradio app starts Xvfb on `:99`, x11vnc protected by `VNC_PASSWORD`, and websockify/noVNC on an internal port 6080. It proxies the noVNC page and WebSocket through the Space's Gradio port 7860, so no additional public port is required. The Node worker starts with `PORT=5050`, `DISPLAY=:99`, `HEADLESS=false`, and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`. Keep the Space private if appropriate and never publish its secrets or browser profile.

## Optional Hugging Face Spaces (Docker SDK)

1. Create a new Hugging Face Space and select **Docker** as the Space SDK. The repository root must contain this `Dockerfile` and `start-space.sh`.
2. In **Settings → Variables and secrets**, add these **secrets**:
   - `DIMAG_API_URL` = `https://youtubi.onrender.com`
   - `HISA_SECRET` = the same value as Dimag AI V2's `CRON_SECRET`
   - `VNC_PASSWORD` = a strong, unique password for the browser desktop
3. Enable persistent storage for the Space. Set the Space variable `CHROME_USER_DATA_DIR` to `/data/chrome-profile` so the Google sign-in profile survives container restarts.
4. Commit/push the project to the Space repository and wait for the Docker build to finish.
5. Open `https://<space-name>.hf.space/vnc/vnc.html?autoconnect=1&resize=remote&path=vnc/websockify`. At the browser's HTTP Basic Auth prompt, enter username `hisa` and the `VNC_PASSWORD` secret. The noVNC session is proxied through port 7860 and protected by that password.
6. In the remote desktop, complete Google sign-in in Flow AI. Close the Chrome window when done; the worker then starts polling. Google may occasionally require re-authentication, so the persistent profile must remain private.
7. Check `https://<space-name>.hf.space/health` (or `/`) for the live worker status JSON.

The image starts Xvfb, a localhost-only VNC server, and noVNC/websockify, then launches Chromium with a visible X display (`HEADLESS=false`). The profile is stored under `/data/chrome-profile` when configured as above. Chromium uses container-safe flags and the Playwright-bundled browser. The Space-provided `PORT` is honored; the default is 7860. Optional Space variables include `FLOW_AI_URL` and `POLL_INTERVAL_MS`. Do not expose port 6080 directly or publish the VNC password.

The Flow UI can change, so selectors may need updates if Google's interface changes.
