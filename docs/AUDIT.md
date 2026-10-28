# Pit dashboard audit

## Pit dashboard

The supplied app was a static, dependency-free ES module dashboard with HTML/CSS/JavaScript and an unused copied Python server. Its demo mode injected mock telemetry. The connection modal allowed a rosbridge JSON mode or Foxglove; the old `src/rosBridge.js` defaulted to `ws://127.0.0.1:8765` but had no valid Foxglove binary deserializer, no ROS 2 CDR decoder, and incomplete handshakes. It also declared guessed or nonexistent simulation topics (`/power/battery`, `/diagnostics/pi5`, `/camera/image_raw`, `/esp32/status`, `/esp32/imu`) and had no native waypoint service UI. See `CLEANUP.md` for the preserved original files; their relative imports did not escape the old nested app.

The replacement stays static ES modules. It uses pinned `@foxglove/rosmsg` to parse ROS 2 message definitions and `@foxglove/rosmsg2-serialization` `MessageReader`/`MessageWriter` for CDR. This fits a browser JavaScript stack with no Node build step, but requires internet access from the browser for esm.sh imports. The `@foxglove/ws-protocol` TypeScript library is deprecated/archived, so the app implements only the small v1 client subset it needs over native `WebSocket`; its wire format is recorded in the linked protocol spec. The separate client uses the `foxglove.websocket.v1` WebSocket subprotocol. References: [`@foxglove/rosmsg`](https://github.com/foxglove/rosmsg), [`@foxglove/rosmsg2-serialization`](https://www.npmjs.com/package/%40foxglove/rosmsg2-serialization), [`@foxglove/ws-protocol` status](https://github.com/foxglove/ws-protocol).

## Simulation interfaces and bridge

The source audit found these ROS topics and types:

| Topic | Type | Evidence / role |
|---|---|---|
| `/clock` | `rosgraph_msgs/msg/Clock` | Gazebo ROS bridge |
| `/joint_states` | `sensor_msgs/msg/JointState` | Gazebo joint state remap; vehicle state node |
| `/odom` | `nav_msgs/msg/Odometry` | Gazebo ground-truth odometry; dashboard status input |
| `/tf` | `tf2_msgs/msg/TFMessage` | Gazebo TF remap |
| `/tf_static` | `tf2_msgs/msg/TFMessage` | Static transforms from robot description publishers |
| `/enimia/rear_wheel_cmd` | `std_msgs/msg/Float64` | Gazebo drive command bridge |
| `/enimia/steer_left_cmd` | `std_msgs/msg/Float64` | Gazebo steering command bridge |
| `/enimia/steer_right_cmd` | `std_msgs/msg/Float64` | Gazebo steering command bridge |
| `/scan` | `sensor_msgs/msg/LaserScan` | Gazebo lidar remap; planner and safety inputs |
| `/imu/data` | `sensor_msgs/msg/Imu` | Gazebo IMU remap; localization input |
| `/fix` | `sensor_msgs/msg/NavSatFix` | Gazebo GPS remap; waypoint manager input |
| `/wheel/odom` | `nav_msgs/msg/Odometry` | Vehicle-state publisher / simulation relay |
| `/odometry/local` | `nav_msgs/msg/Odometry` | Local EKF output |
| `/odometry/global` | `nav_msgs/msg/Odometry` | Global EKF output; navigation and track progress input |
| `/odometry/gps` | `nav_msgs/msg/Odometry` | navsat_transform output to global EKF |
| `/esp32/imu` | `sensor_msgs/msg/Imu` | IMU stamper input; simulation launch comments say it is idle in simulation |
| `/esp32/encoder` | `std_msgs/msg/Int32` | simulated ESP32/vehicle-state input |
| `/esp32/servo_cmd` | `std_msgs/msg/Int16` | controller output and vehicle-state input |
| `/esp32/motor_cmd` | `std_msgs/msg/Int16` | controller output / simulated ESP32 input |
| `/cmd_vel_nav` | `geometry_msgs/msg/Twist` | waypoint manager output; planner input |
| `/cmd_vel_plan` | `geometry_msgs/msg/Twist` | local planner output |
| `/cmd_vel_gated` | `geometry_msgs/msg/Twist` | LiDAR command gate output |
| `/obstacle_stop` | `std_msgs/msg/Bool` | safety-stop state output |
| `/cmd_vel` | `geometry_msgs/msg/Twist` | controller input (simulation launch remaps navigation command) |
| `/safety/gate_status` | `std_msgs/msg/String` | command gate state |
| `/safety/gate_markers` | `visualization_msgs/msg/MarkerArray` | command gate visualization |
| `/planner/status` | `std_msgs/msg/String` | local planner status |
| `/planner/markers` | `visualization_msgs/msg/MarkerArray` | local planner visualization |
| `/waypoints/markers` | `visualization_msgs/msg/MarkerArray` | waypoint manager visualization |
| `/waypoints/guidance` | `std_msgs/msg/Float32MultiArray` | waypoint manager output / local planner input |
| `/world_markers` | `visualization_msgs/msg/MarkerArray` | simulation world markers |
| `/clicked_point` | `geometry_msgs/msg/PointStamped` | waypoint-manager subscription for clicked map locations |
| `/goal_pose` | `geometry_msgs/msg/PoseStamped` | optional waypoint-manager subscription |
| `/rosout` | `rcl_interfaces/msg/Log` | standard ROS 2 node logging topic |
| `/parameter_events` | `rcl_interfaces/msg/ParameterEvent` | standard ROS 2 parameter event topic |
| `/track/progress` | `std_msgs/msg/Float32` | dashboard bridge progress node |
| `/vehicle/battery_percent` | `std_msgs/msg/Float32` | dashboard bridge fake status node |
| `/vehicle/temperature_c` | `std_msgs/msg/Float32` | dashboard bridge fake status node |

The bringup/navigation services are `/waypoints/add_here`, `/waypoints/start`, `/waypoints/clear`, and `/waypoints/undo` (`std_srvs/srv/Trigger`), plus `/fromLL` (`robot_localization/srv/FromLL`) and `/navsat_transform/toLL` (`robot_localization/srv/ToLL`). The waypoint manager also subscribes to `/clicked_point` (`geometry_msgs/msg/PointStamped`) and optionally `/goal_pose` (`geometry_msgs/msg/PoseStamped`); it does not provide an add-point service. The pit UI publishes clicked map coordinates to `/clicked_point`, and calls START/UNDO/CLEAR.

`dashboard_bridge.launch.py` is a separate launch, and neither the audited bringup nor standalone simulation launch includes it. The actual `/track/progress`, `/vehicle/battery_percent`, and `/vehicle/temperature_c` publishers therefore need that separate node launch; progress is computed from global odometry, while battery and temperature are generated by the package's explicitly named `fake_vehicle_status` node (simulation estimates, not physical sensor readings). In WSL after sourcing the overlay, launch it with `ros2 launch dashboard_bridge dashboard_bridge.launch.py use_sim_time:=true` if these dashboard readings are needed.

`bringup.yaml` contains `debug: true` and `foxglove_port: 8765`. `bringup.launch.py` reads `debug`; only when true does it include `visualization.launch.py`, which launches package `foxglove_bridge`, executable `foxglove_bridge`, with `port` from config (default 8765). The launch passes no explicit capabilities or whitelists. The separate standalone `simulation.launch.py` launches the bridge directly on port 8765. Source-only topic/service enumeration cannot prove which optional simulation/dashboard launch components are running at a particular moment.

Upstream ROS 2 Foxglove Bridge documentation gives defaults for capabilities including `clientPublish` and `services`, and `.*` topic/service/client-topic whitelists; these are vendor defaults, not explicit settings in this project's YAML. The pit client still checks the actual `serverInfo` capabilities and service advertisements. If this installed bridge differs, see `SIM_REQUESTS.md` for the pit-side alternate bridge procedure. References: [ROS 2 bridge configuration](https://github.com/foxglove/foxglove-sdk/tree/main/ros/src/foxglove_bridge) and [Foxglove WebSocket v1 spec](https://github.com/foxglove/ws-protocol/blob/main/docs/spec.md).

The Windows WSL runtime query was attempted, but `wsl -l -q` returned `E_ACCESSDENIED`; ROS cannot be queried from this session. From PowerShell, first run `wsl -l -q`, then replace `<distro>` below with one listed there:

```bash
wsl -d <distro> -- bash -lc 'source /opt/ros/jazzy/setup.bash && cd ~/Autonomous-outdoor-RC/ros2_ws && source install/setup.bash && ros2 topic list -t && ros2 service list -t'
```

## Why the old connection failed

The old app had two selectable transports and ROSBridge JSON logic, but this project's bridge is Foxglove Bridge. The old bridge URL was 8765, which is correct for this bridge's default; `ws://localhost:9090` would target a usual rosbridge endpoint and fail here. `bringup.yaml` debug controls whether that bridge starts in the bringup path. WSL2 networking can also prevent Windows browser access to a WSL-hosted listener; this could not be checked because WSL enumeration was denied. Foxglove WebSocket requires the `foxglove.websocket.v1` subprotocol. ROS 2 topic payloads arrive as CDR binary, not rosbridge JSON, so the old code could not decode them. The replacement removes rosbridge transport code and uses Foxglove CDR message parsing/serialization.

## Driver dashboard

`Dashboard-E-ink/track.json` is a closed list of pixels traced from a Silesia Ring layout image. The first point is the start/finish line; points follow driving direction. Coordinates have no metric scale in that file and image y points downward. Its `server.py` loads the JSON and fits the polygon for drawing. The simulation-side `track_progress.py` uses center `(300,300)` and `1.4321 m/pixel`, mapping x=`(px−300)*1.4321`, y=`(300−py)*1.4321` into `map`. The pit sync script copies this track read-only and applies the same transform from `config/track-transform.json`.

The existing driver server binds port 8000, serves `/` and `/dash.png`, and may subscribe to `/odom`, `/track/progress`, `/vehicle/battery_percent`, and `/vehicle/temperature_c` when `rclpy` imports successfully. Its README says Windows/Linux setup uses `python server.py`; the pit start script runs from folder 3 with `PYTHONDONTWRITEBYTECODE=1`. The Windows Python script will use its fake-data fallback unless that Python environment has ROS 2 `rclpy`; use the WSL start script with ROS sourced for ROS subscriptions. The captured pre-work Git status already showed `Dashboard-E-ink/server.py` modified; it is preserved without edits.

## Verification limits

No live ROS system was reachable from this Windows session, so WebSocket, live CDR decode against ROS-generated samples, click publish, service calls, WSL port forwarding, and browser behavior against the running simulation remain unverified. The app displays explicit connection/topic silence states and reports service/capability errors when connected.
