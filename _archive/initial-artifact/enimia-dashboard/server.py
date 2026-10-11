#!/usr/bin/env python3
"""
ENIMIA Autonomous Vehicle Dashboard — Local HTTP & Mock ROS Bridge Server
Serves static dashboard files on port 8080 and provides an optional mock
ROS 2 / Foxglove WebSocket bridge on port 8765 for integration testing.
"""

import os
import sys
import time
import json
import math
import asyncio
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler

try:
    import websockets
except ImportError:
    websockets = None

STATIC_PORT = 8080
WS_PORT = 8765

class StaticHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        directory = os.path.dirname(os.path.abspath(__file__))
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self):
        # Enable CORS and disable aggressive caching for development
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

def run_http_server():
    server_address = ('0.0.0.0', STATIC_PORT)
    httpd = HTTPServer(server_address, StaticHandler)
    print(f"[*] ENIMIA Static Dashboard serving on http://localhost:{STATIC_PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()

async def ws_handler(websocket):
    print(f"[+] Client connected to ROS 2 WebSocket bridge: {websocket.remote_address}")
    try:
        # Handshake: advertise vehicle topics (Foxglove protocol)
        advertise_msg = {
            "op": "advertise",
            "channels": [
                {"id": 1, "topic": "/scan", "encoding": "json", "schemaName": "sensor_msgs/msg/LaserScan"},
                {"id": 2, "topic": "/fix", "encoding": "json", "schemaName": "sensor_msgs/msg/NavSatFix"},
                {"id": 3, "topic": "/wheel/odom", "encoding": "json", "schemaName": "nav_msgs/msg/Odometry"},
                {"id": 4, "topic": "/esp32/imu", "encoding": "json", "schemaName": "sensor_msgs/msg/Imu"},
                {"id": 5, "topic": "/power/battery", "encoding": "json", "schemaName": "sensor_msgs/msg/BatteryState"}
            ]
        }
        await websocket.send(json.dumps(advertise_msg))

        # Stream periodic ROS 2 topic messages at 10 Hz
        t = 0.0
        while True:
            await asyncio.sleep(0.1)
            t += 0.1

            # Simulated LaserScan message
            scan_ranges = [2.0 + 0.5 * math.sin(t + i * 0.05) for i in range(180)]
            msg = {
                "op": "message",
                "channelId": 1,
                "data": {
                    "angle_min": -math.pi,
                    "angle_max": math.pi,
                    "angle_increment": (2 * math.pi) / 180,
                    "range_min": 0.15,
                    "range_max": 12.0,
                    "ranges": scan_ranges
                }
            }
            await websocket.send(json.dumps(msg))

            # Simulated NavSatFix message
            gps_msg = {
                "op": "message",
                "channelId": 2,
                "data": {
                    "latitude": 44.931245 + 0.00001 * math.sin(t * 0.2),
                    "longitude": 4.896512 + 0.00001 * math.cos(t * 0.2),
                    "altitude": 128.4,
                    "status": {"status": 0}
                }
            }
            await websocket.send(json.dumps(gps_msg))

    except Exception as e:
        print(f"[-] Client disconnected: {e}")

async def run_ws_server():
    if not websockets:
        print("[!] websockets module not found, skipping mock WS bridge.")
        return
    print(f"[*] Mock ROS 2 / Foxglove WebSocket bridge running on ws://0.0.0.0:{WS_PORT}")
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        await asyncio.Future()

def start_ws_loop():
    if websockets:
        asyncio.run(run_ws_server())

if __name__ == '__main__':
    # Start WS server in background thread if requested
    if '--with-bridge' in sys.argv:
        t_ws = threading.Thread(target=start_ws_loop, daemon=True)
        t_ws.start()

    run_http_server()
