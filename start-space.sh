#!/bin/sh
set -eu

: "${HISA_SECRET:?Set HISA_SECRET as a Hugging Face Space secret.}"
: "${VNC_PASSWORD:?Set VNC_PASSWORD as a Hugging Face Space secret.}"

export PORT="${PORT:-7860}"
export DISPLAY="${DISPLAY:-:99}"
export HEADLESS=false
export HISA_BROWSER_CHANNEL=bundled
export HISA_AUTO_LOGIN=true
export ENABLE_VNC_PROXY=true

Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -ac &
xvfb_pid=$!
x11vnc -display "$DISPLAY" -localhost -forever -shared -rfbport 5900 -nopw -quiet &
x11vnc_pid=$!
websockify --web=/usr/share/novnc/ --listen=127.0.0.1 6080 127.0.0.1:5900 &
websockify_pid=$!

server_pid=
cleanup() {
  trap - EXIT INT TERM
  for process_id in "$server_pid" "$websockify_pid" "$x11vnc_pid" "$xvfb_pid"; do
    if [ -n "$process_id" ]; then
      kill "$process_id" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 1
kill -0 "$xvfb_pid"
kill -0 "$x11vnc_pid"
kill -0 "$websockify_pid"

node src/server.js &
server_pid=$!
wait "$server_pid"
