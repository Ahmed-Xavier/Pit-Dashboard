#!/usr/bin/env bash
set -euo pipefail
PIT_DIR="/mnt/c/My files/Pit dashboard"
DRIVER_DIR="/mnt/c/My files/Dashboard-E-ink"
source /opt/ros/jazzy/setup.bash
cp "$DRIVER_DIR/track.json" "$PIT_DIR/config/track.json"
python3 -m http.server 8080 --bind 0.0.0.0 --directory "$PIT_DIR" &
PIT_PID=$!
(cd "$DRIVER_DIR" && PYTHONDONTWRITEBYTECODE=1 python3 -u server.py) &
DRIVER_PID=$!
trap 'kill "$PIT_PID" "$DRIVER_PID" 2>/dev/null || true' EXIT INT TERM
printf 'Pit dashboard:   http://localhost:8080\nDriver dashboard: http://localhost:8000\n'
wait
