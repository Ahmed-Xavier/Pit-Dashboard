# ENIMIA — Autonomous Vehicle Engineering Dashboard

A bespoke, functional, trackside telemetry and sensor-fusion monitoring platform designed for **ENIMIA**, an autonomous Shell Eco-marathon prototype vehicle powered by ROS 2 Jazzy, a Raspberry Pi 5, and an ESP32 micro-ROS subsystem.

Built with a **warm, minimal, editorial motorsport engineering aesthetic** (`#F5F4EF` neutral warm surface, `#292B27` charcoal typography, muted olive green `#68785A`, burnt orange `#C77C4A`, restrained amber warnings, and muted red faults). No dark-blue/navy dominance, no sci-fi HUDs, no neon gimmicks.

---

## 1. System Architecture & Robotics Topics

The monitoring application interfaces with the vehicle's ROS 2 Jazzy compute stack (Raspberry Pi 5) and low-level microcontroller (ESP32 micro-ROS):

| Subsystem | Hardware Reference | ROS 2 Topic | Message Type | Semantics & Purpose |
|---|---|---|---|---|
| **LiDAR** | RPLIDAR A1M8 | `/scan` | `sensor_msgs/msg/LaserScan` | 360° 2D planar range returns @ 10 Hz, 0.15m–12.0m range |
| **GNSS / GPS** | u-blox NEO-M8N / ZED-F9P | `/fix` | `sensor_msgs/msg/NavSatFix` | Global coordinate fix, RTK status, SVs count, HDOP |
| **Odometry** | Optical wheel encoders + EKF | `/wheel/odom` | `nav_msgs/msg/Odometry` | Fused pose `(x, y, yaw)` and linear forward velocity `vx` |
| **IMU** | BNO085 9-DOF Inertial Unit | `/esp32/imu` | `sensor_msgs/msg/Imu` | Angular velocity $\omega_z$, lateral acceleration $a_y$ @ 50 Hz |
| **Wheel Encoders** | Hall/Optical ticks via ESP32 | `/esp32/encoder` | `std_msgs/msg/Float32MultiArray` | Left and right wheel angular velocity (rad/s) |
| **Motor Drive** | Motor controller (PWM/CAN) | `/esp32/motor_cmd` | `std_msgs/msg/Float32` | Normalized traction torque / velocity command |
| **Steering Servo** | Steering rack servo actuator | `/esp32/servo_cmd` | `std_msgs/msg/Float32` | Commanded Ackermann steering angle in radians |
| **Compute Diagnostics** | Raspberry Pi 5 (BCM2712) | `/diagnostics/pi5` | `diagnostic_msgs/msg/DiagnosticArray` | 4-core CPU load %, RAM usage, SoC core temperature |
| **Traction Battery** | 24V LiFePO4 pack & logic rails | `/power/battery` | `sensor_msgs/msg/BatteryState` | Pack voltage, discharge current, SoC %, cell delta |
| **Camera Vision** | Sony IMX219 CSI camera | `/camera/image_raw` | `sensor_msgs/msg/CompressedImage` | 640×480 @ 30 FPS forward track video |

---

## 2. Visual Design System

The visual identity is modeled after premium motorsport telemetry stations (WEC / Formula Student / Shell Eco-marathon pit equipment):

- **Main App Background**: `#F5F4EF` (warm neutral off-white)
- **Panel Surface**: `#FFFFFF`
- **Subtle Surface**: `#EEEEE8`
- **Canvas Viewports**: `#FAF9F5`
- **Primary Text**: `#292B27` (charcoal)
- **Secondary Text**: `#777970`
- **Borders & Dividers**: `1px solid #DADBD4`
- **Normal Operation & Planned Trajectory**: Muted Olive Green `#68785A`
- **Attention & Obstacle Detection**: Burnt Orange `#C77C4A`
- **Telemetry Warnings**: Restrained Amber `#C87A28`
- **Faults & Outages**: Muted Red `#BD3838`
- **Typography**: Editorial technical sans-serif with monospace tabular numerals (`"JetBrains Mono"`, `"SF Mono"`, monospace) for rapidly changing telemetry values.

---

## 3. Key Dashboard Panels & Capabilities

### A. Top Header
- Wordmark: `ENIMIA PROTOTYPE | AUTONOMOUS STAND MONITOR`.
- Active Session metadata: `SESSION: SEM26-DYN-T04`, `CIRCUIT DE VALENCE - STAND 03`.
- Global health indicator (`SYSTEM NOMINAL`, `TELEMETRY DEGRADED`, `SUBSYSTEM FAULT`).
- Clear Mode Switcher: **DEMO DATA** vs **LIVE FEED** (impossible to confuse).
- Live Bridge Status (`IDLE (DEMO ACTIVE)`, `LIVE WS (4ms RTT)`, or `DISCONNECTED (NO BRIDGE)`).
- Session elapsed timer and millisecond UTC clock.
- Settings dialog button for bridge configuration.

### B. Hardware & Subsystems Health Sidebar
- Real-time diagnostic monitors for all 7 key components:
  1. `Raspberry Pi 5` (CPU %, RAM, Temp, OS & ROS 2 Jazzy daemon).
  2. `ESP32 micro-ROS` (UART bridge, heap, RTT latency, jitter).
  3. `RPLIDAR A1M8` (Motor RPM, samples/scan, range bounds, health).
  4. `u-blox GNSS` (Fix quality, satellites count, HDOP, coordinates).
  5. `BNO085 9-DOF IMU` (Calibration quality, yaw rate, lateral acceleration).
  6. `Sony IMX219 CSI Camera` (Resolution, framerate, pipeline latency).
  7. `LiFePO4 Traction Battery` (Bus voltage, current, power wattage, SoC %, 12V and 5V logic rails).
- Data freshness monitor with millisecond age counter; components automatically transition to `STALE` if messages lag, or `FAULT` if dropped.
- Interactive accordion to inspect raw topic fields.

### C. Main Sensor-Fusion Visualizer (Centerpiece)
- Interactive 2D Canvas rendering the vehicle in ROS REP-103 coordinate conventions (+X forward, +Y left).
- Concentric range rings (1m, 2m, 4m, 6m, 8m, 10m) with metric distance annotations.
- Metric coordinate grid with millimeter accuracy.
- Technical silhouette of the Shell Eco-marathon aerodynamic prototype with front steered wheels rotating according to actual steering angle.
- Raw LiDAR point returns rendered in crisp charcoal (`#292B27`).
- Planned trajectory horizon drawn in muted olive green (`#68785A`).
- Estimated odometry historical breadcrumb trail.
- Detected obstacle footprints with safety inflation buffer in burnt orange (`#C77C4A`).
- Interactive controls: Pan, Zoom (+ / − / 1:1 Reset), Follow Vehicle toggle, and independent layer toggles (`[LIDAR]`, `[PLAN]`, `[ODOM]`, `[OBSTACLES]`, `[GRID]`).
- Live cursor coordinate readout translating screen pixels to world coordinates $(X, Y, \text{Range})$.

### D. Track & Navigation Schematic
- Schematic loop of the Circuit de Valence Shell Eco-marathon test loop.
- Track ribbon, curbs, and numbered waypoints (WP01 through WP12).
- Active waypoint tracking with target vector and olive highlight.
- Real-time navigation telemetry HUD: Active Target WP, Distance to WP (m), Cross-Track Error (m), and Lap Progress (%).

### E. Camera & Perception View
- Synthetic forward perspective track rendering with perspective curbs and lane polynomial lines.
- AI perception overlays with detected traffic cones and stop signs, bounding boxes, and confidence badges (`TRAFFIC_CONE 89%`, `STOP_SIGN 95%`).
- Overlay visibility toggle.
- **Honest Disconnected State**: When in Live mode without an active video topic, the canvas hides and displays an explicit placeholder stating topic `/camera/image_raw` is inactive—never fabricating fake camera frames.

### F. Autonomy Pipeline Diagnostics
- Visual 4-stage pipeline:
  `[01 LOCALIZATION] → [02 PERCEPTION] → [03 PLANNING] → [04 CONTROL]`
- Displays node frequency (Hz), processing latency (ms), and diagnostic state messages (e.g. EKF covariance, costmap horizon validity, pure pursuit commands).

### G. Live Telemetry Charts
- 4 real-time Canvas charts with subtle grid lines, tabular current values, and time-window selector (10s, 30s, 60s):
  1. `SPEED (M/S)`: Measured speed vs target speed.
  2. `STEERING (DEG)`: Measured steering angle vs commanded angle.
  3. `ENCODERS (RAD/S)`: Left vs right wheel angular velocity.
  4. `YAW RATE (°/S)`: IMU rotational dynamics.

### H. Chronological Event Log
- Timestamped events with millisecond precision (`HH:MM:SS.mmm`).
- Subsystem origin badges (`ROS2_HOST`, `MICRO_ROS`, `GNSS`, `AUTONOMY`, `PERCEPTION`, `SYSTEM`).
- Severity filtering (`ALL`, `WARN`, `FAULT`) and JSON export capability.

### I. Connection Settings Dialog
- Endpoint configuration for Foxglove WebSocket (`ws://127.0.0.1:8765`) or ROSBridge (`ws://127.0.0.1:9090`).
- Subscribed vehicle topics checklist.
- Protocol handshake status, total packet counter, and RTT latency.

---

## 4. Running the Dashboard

### Prerequisites
- Python 3.8+ (or Node.js 18+)
- Modern web browser (Chrome, Chromium, Firefox, Edge, Safari)

### Start Static HTTP Server
```bash
cd /enimia-dashboard
python3 server.py
```
Open `http://localhost:8080` in your web browser.

### Start with Mock ROS 2 WebSocket Bridge (for Live Testing)
```bash
python3 server.py --with-bridge
```
This starts both the HTTP dashboard on port 8080 and a mock Foxglove-compatible ROS 2 WebSocket bridge on port 8765 streaming simulated `/scan`, `/fix`, `/wheel/odom`, and `/esp32/imu` messages.

---

## 5. Verification & Captured Renderings

The dashboard has been verified and rendered using headless Chrome (1440 × 900 desktop viewport). Generated visual assets:
- `dashboard_main.png`: Normal trackside monitoring view with coordinated demo dynamics.
- `dashboard_settings.png`: Interactive ROS 2 Jazzy bridge settings configuration dialog.
- `dashboard_live_disconnected.png`: Live mode without bridge, demonstrating honest disconnected fallbacks and stale reporting.
