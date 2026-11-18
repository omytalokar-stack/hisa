import asyncio
import atexit
import html
import inspect
import json
import os
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import gradio as gr
import httpx
import websockets
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse, Response


ROOT = Path(__file__).resolve().parent
DISPLAY = ":99"
STATUS_URL = "http://127.0.0.1:5050/health"
VNC_URL = "http://127.0.0.1:6080"
processes = []
process_log_files = []


def start_process(command, *, env=None, quiet=False):
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL if quiet else None,
        stderr=subprocess.STDOUT if quiet else None,
        start_new_session=True,
    )
    processes.append(process)
    return process


def stop_processes(*_args):
    for process in reversed(processes):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for process in reversed(processes):
        if process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
    for log_file in process_log_files:
        if not log_file.closed:
            log_file.close()
    if _args:
        raise SystemExit(0)


def report_vnc_failure(name, log_path, error=None):
    details = str(error) if error else "process exited during startup"
    output = ""
    try:
        output = log_path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError as log_error:
        output = f"Could not read {log_path}: {log_error}"
    message = f"VNC warning: {name} failed to start: {details}"
    if output:
        message = f"{message}\n{output}"
    print(message, flush=True)


def start_logged_process(name, command):
    log_path = Path("/tmp") / f"hisa-{name}.log"
    try:
        log_file = log_path.open("w", encoding="utf-8")
    except OSError as error:
        print(f"VNC warning: cannot create {log_path}: {error}", flush=True)
        return None

    try:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as error:
        log_file.close()
        report_vnc_failure(name, log_path, error)
        return None

    processes.append(process)
    process_log_files.append(log_file)
    time.sleep(0.5)
    if process.poll() is not None:
        report_vnc_failure(name, log_path)
        return None
    return process


def choose_profile_dir():
    requested = Path(os.environ.get("CHROME_USER_DATA_DIR", "/data/chrome-profile"))
    fallback = Path("/tmp/chrome-profile")
    candidates = [requested]
    if requested != fallback:
        candidates.append(fallback)

    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=candidate, prefix=".hisa-write-test-"):
                pass
            return candidate
        except OSError as error:
            print(
                f"Profile directory {candidate} is not writable: {error}",
                flush=True,
            )

    print(f"VNC warning: using profile fallback {fallback}.", flush=True)
    return fallback


def start_services():
    vnc_password = os.environ.get("VNC_PASSWORD")
    profile_dir = choose_profile_dir()

    environment = os.environ.copy()
    environment.update(
        {
            "PORT": "5050",
            "DISPLAY": DISPLAY,
            "HEADLESS": "false",
            "HISA_AUTO_LOGIN": "true",
            "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium",
            "CHROME_USER_DATA_DIR": str(profile_dir),
        }
    )

    start_logged_process("xvfb", ["Xvfb", DISPLAY, "-screen", "0", "1280x800x24"])

    password_file = Path("/tmp/vnc.passwd")
    password_stored = False
    if not vnc_password:
        print("VNC warning: VNC_PASSWORD is not set; remote sign-in is unavailable.", flush=True)
    else:
        try:
            result = subprocess.run(
                ["x11vnc", "-storepasswd", vnc_password, str(password_file)],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                password_file.chmod(0o600)
                password_stored = True
            else:
                output = (result.stdout + result.stderr).strip()
                print(
                    "VNC warning: could not store VNC password: "
                    + (output or f"x11vnc exited with status {result.returncode}"),
                    flush=True,
                )
        except OSError as error:
            print(f"VNC warning: could not store VNC password: {error}", flush=True)

    if password_stored:
        start_logged_process(
            "x11vnc",
            [
                "x11vnc",
                "-display",
                DISPLAY,
                "-localhost",
                "-forever",
                "-shared",
                "-rfbport",
                "5900",
                "-rfbauth",
                str(password_file),
            ],
        )

    websockify = start_logged_process(
        "websockify",
        [
            "python3",
            "-m",
            "websockify",
            "--web=/usr/share/novnc/",
            "6080",
            "127.0.0.1:5900",
        ],
    )
    if websockify is None:
        start_logged_process(
            "novnc-proxy",
            [
                "novnc_proxy",
                "--vnc",
                "127.0.0.1:5900",
                "--listen",
                "6080",
                "--web",
                "/usr/share/novnc/",
            ],
        )

    subprocess.run(["npm", "ci", "--omit=dev"], cwd=ROOT, check=True, env=environment)
    start_process(["node", "src/server.js"], env=environment)


def worker_status():
    try:
        with urlopen(STATUS_URL, timeout=3) as response:
            status = json.load(response)
            return (
                status,
                str(status.get("lastJobId") or "—"),
                str(status.get("lastError") or "None"),
            )
    except (OSError, URLError, TimeoutError, ValueError) as error:
        status = {
            "status": "starting",
            "service": "hisa",
            "busy": False,
            "lastJobId": None,
            "lastError": str(error),
        }
        return status, "—", str(error)


async def proxy_vnc_http(path, request):
    target_url = f"{VNC_URL}/{path}"
    if request.url.query:
        target_url = f"{target_url}?{request.url.query}"
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in {"host", "connection", "content-length"}
    }

    async with httpx.AsyncClient(follow_redirects=False, timeout=30) as client:
        upstream = await client.request(
            request.method,
            target_url,
            headers=headers,
            content=await request.body(),
        )

    response_headers = {
        key: value
        for key, value in upstream.headers.items()
        if key.lower() not in {"connection", "content-length", "transfer-encoding"}
    }
    location = response_headers.get("location")
    if location and location.startswith("/"):
        response_headers["location"] = f"/vnc{location}"
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=response_headers,
    )


async def proxy_vnc_websocket(browser_socket: WebSocket, path: str):
    query = browser_socket.url.query
    upstream_url = f"ws://127.0.0.1:6080/{path}"
    if query:
        upstream_url = f"{upstream_url}?{query}"

    connect_options = {
        "origin": browser_socket.headers.get("origin"),
        "subprotocols": browser_socket.headers.get("sec-websocket-protocol", "").split(",")
        if browser_socket.headers.get("sec-websocket-protocol")
        else None,
        "open_timeout": 10,
        "max_size": None,
    }
    header_name = (
        "additional_headers"
        if "additional_headers" in inspect.signature(websockets.connect).parameters
        else "extra_headers"
    )
    connect_options[header_name] = {
        key: value
        for key, value in browser_socket.headers.items()
        if key.lower() in {"cookie", "authorization"}
    }

    try:
        async with websockets.connect(upstream_url, **connect_options) as upstream:
            await browser_socket.accept(subprotocol=upstream.subprotocol)

            async def relay_to_vnc():
                while True:
                    message = await browser_socket.receive()
                    if message["type"] == "websocket.disconnect":
                        break
                    if message.get("text") is not None:
                        await upstream.send(message["text"])
                    elif message.get("bytes") is not None:
                        await upstream.send(message["bytes"])

            async def relay_to_browser():
                async for message in upstream:
                    if isinstance(message, str):
                        await browser_socket.send_text(message)
                    else:
                        await browser_socket.send_bytes(message)

            tasks = {
                asyncio.create_task(relay_to_vnc()),
                asyncio.create_task(relay_to_browser()),
            }
            _done, pending = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
    except (OSError, websockets.exceptions.WebSocketException, WebSocketDisconnect):
        if browser_socket.client_state.name == "CONNECTED":
            await browser_socket.close(code=1011)


def create_dashboard():
    space_host = os.environ.get("SPACE_HOST")
    vnc_page = f"https://{space_host}/vnc/vnc.html" if space_host else "/vnc/vnc.html"
    vnc_link = f"{vnc_page}?autoconnect=1&resize=remote&path=vnc/websockify"

    with gr.Blocks(title="Hisa Worker Status") as dashboard:
        gr.Markdown(
            "# Hisa Worker\n"
            "Dimag AI V2 → Google Flow AI video worker status."
        )
        gr.HTML(
            f'<p><a href="{html.escape(vnc_link, quote=True)}" target="_blank" '
            'rel="noopener noreferrer">Open the remote Chrome desktop (noVNC)</a></p>'
            "<p>Use your VNC_PASSWORD when prompted. Sign in to Google/Flow AI, "
            "then close the Chrome window to let job polling begin.</p>"
        )
        with gr.Row():
            status_json = gr.JSON(label="Live worker status")
            with gr.Column():
                last_job = gr.Textbox(label="Last job ID", interactive=False)
                last_error = gr.Textbox(label="Last error", interactive=False, lines=4)

        dashboard.load(worker_status, outputs=[status_json, last_job, last_error])
        gr.Timer(5).tick(
            worker_status,
            outputs=[status_json, last_job, last_error],
            show_progress="hidden",
        )

    return dashboard


def main():
    atexit.register(stop_processes)
    signal.signal(signal.SIGTERM, stop_processes)
    signal.signal(signal.SIGINT, stop_processes)
    start_services()

    application = FastAPI()

    @application.get("/vnc")
    async def vnc_root():
        return RedirectResponse("/vnc/vnc.html")

    @application.api_route(
        "/vnc/{path:path}", methods=["GET", "HEAD", "POST", "OPTIONS"]
    )
    async def vnc_http(path: str, request: Request):
        return await proxy_vnc_http(path, request)

    @application.websocket("/vnc/{path:path}")
    async def vnc_websocket(browser_socket: WebSocket, path: str):
        await proxy_vnc_websocket(browser_socket, path)

    application = gr.mount_gradio_app(application, create_dashboard(), path="/")

    import uvicorn

    uvicorn.run(application, host="0.0.0.0", port=7860)


if __name__ == "__main__":
    main()
