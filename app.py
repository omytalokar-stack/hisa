import atexit
import json
import os
import signal
import subprocess
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import gradio as gr


ROOT = Path(__file__).resolve().parent
STATUS_URL = "http://127.0.0.1:5050/health"
server_process = None


def start_services():
    global server_process

    environment = os.environ.copy()
    environment.update(
        {
            "PORT": "5050",
            "HEADLESS": "true",
            "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium",
        }
    )
    subprocess.run(["npm", "ci", "--omit=dev"], cwd=ROOT, check=True, env=environment)
    server_process = subprocess.Popen(
        ["node", "src/server.js"],
        cwd=ROOT,
        env=environment,
    )


def stop_server(*_args):
    if server_process and server_process.poll() is None:
        server_process.terminate()
        try:
            server_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_process.kill()
    if _args:
        raise SystemExit(0)


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


def create_dashboard():
    with gr.Blocks(title="Hisa Worker Status") as dashboard:
        gr.Markdown(
            "# Hisa Worker\n"
            "Dimag AI V2 → Google Flow AI video worker status."
        )
        gr.Markdown(
            "Google Flow authentication is supplied through the "
            "`FLOW_STORAGE_STATE_B64` secret."
        )
        with gr.Row():
            status_json = gr.JSON(label="Live worker status")
            with gr.Column():
                last_job = gr.Textbox(label="Last job ID", interactive=False)
                last_error = gr.Textbox(label="Last error", interactive=False, lines=4)

        outputs = [status_json, last_job, last_error]
        dashboard.load(worker_status, outputs=outputs)
        gr.Timer(5).tick(
            worker_status,
            outputs=outputs,
            show_progress="hidden",
        )

    return dashboard


def main():
    atexit.register(stop_server)
    signal.signal(signal.SIGTERM, stop_server)
    signal.signal(signal.SIGINT, stop_server)
    start_services()
    create_dashboard().launch(server_name="0.0.0.0", server_port=7860)


if __name__ == "__main__":
    main()
