#!/bin/sh
set -eu

: "${HISA_SECRET:?Set HISA_SECRET as a Hugging Face Space secret.}"

export PORT="${PORT:-7860}"
export HEADLESS=true
export HISA_BROWSER_CHANNEL=bundled
exec node src/server.js
