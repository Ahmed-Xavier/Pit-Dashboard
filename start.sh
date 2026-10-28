#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
BRIDGE_URL="${BRIDGE_URL:-ws://127.0.0.1:8765}"
OPEN_BROWSER="${OPEN_BROWSER:-1}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  printf 'Invalid PORT: %s\n' "$PORT" >&2
  exit 2
fi

port_is_free() {
  python3 - "$1" <<'PY'
import socket
import sys

with socket.socket() as sock:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("127.0.0.1", int(sys.argv[1])))
    except OSError:
        raise SystemExit(1)
PY
}

while ! port_is_free "$PORT"; do
  if (( PORT >= 65535 )); then
    printf 'No free TCP port found.\n' >&2
    exit 1
  fi
  PORT=$((PORT + 1))
done

BUILD_ID="$(date +%s)"
URL="http://127.0.0.1:${PORT}/?build=${BUILD_ID}&bridge=${BRIDGE_URL}"
printf 'Pit dashboard: %s\n' "$URL"
printf 'Serving:       %s\n' "$ROOT_DIR"
printf 'Bridge:        %s\n' "$BRIDGE_URL"
printf 'Press Ctrl+C to stop.\n'

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID"
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

(cd "$ROOT_DIR" && exec python3 - "$PORT" <<'PY'
import http.server
import os
import sys

port = int(sys.argv[1])

class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

with http.server.ThreadingHTTPServer(("127.0.0.1", port), DashboardHandler) as server:
    server.serve_forever()
PY
) &
SERVER_PID=$!

if [[ "$OPEN_BROWSER" == "1" ]] && command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
fi

wait "$SERVER_PID"
