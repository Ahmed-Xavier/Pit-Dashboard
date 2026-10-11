# ENIMIA Pit Dashboard

This is the pit-side replacement for Foxglove. It connects to ROS 2 through `foxglove_bridge` using the Foxglove WebSocket subprotocol, reads CDR messages, plots the simulation map and live vehicle position, and publishes/calls the waypoint manager interface.

## Run both dashboards

On Windows, install Python 3 and Pillow if needed, then run `start.ps1` in PowerShell. The script copies the driver's `track.json` into this folder, starts this static app on port 8080, starts the existing driver `server.py` on port 8000 with bytecode generation disabled, and opens both URLs.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start.ps1
```

The URLs are `http://localhost:8080` (pit) and `http://localhost:8000` (driver). Both processes run in the background; stop them from Task Manager or stop the `python` processes. Python's `http.server` is included with Python. Driver dashboard dependencies are documented in `Dashboard-E-ink\README.md`. If the Windows Python environment does not include ROS 2 `rclpy`, the unchanged driver server uses its built-in fake-data fallback; use the WSL start script for a ROS-enabled Python environment.

For WSL, from this folder run `bash ./start-wsl.sh`. Keep that terminal open; Ctrl+C stops both servers. It sources the ROS Jazzy underlay so the driver server can use `rclpy`. Browser access to WSL localhost forwarding and to the WebSocket at `ws://127.0.0.1:8765` depends on the local WSL2 forwarding configuration. If Windows localhost forwarding does not reach the bridge, use the WSL IP in `config/topics.json` (`ws://<WSL-IP>:8765`).

## Start the simulation

The source `bringup.yaml` sets `debug: true`, which makes `bringup.launch.py` include the visualization launch and start `foxglove_bridge` on port 8765. If debug is disabled, the bridge is not included. The standalone `simulation.launch.py` also starts the bridge on 8765.

From a WSL shell with the workspace built and sourced, start the project's bringup using its normal project command, then confirm:

```bash
source /opt/ros/jazzy/setup.bash
cd ~/Autonomous-outdoor-RC/ros2_ws
source install/setup.bash
ros2 topic list -t
ros2 service list -t
```

To override bringup's config flag without editing it, pass `debug:=true` to the existing `vehicle_bringup bringup.launch.py` launch command. Set `debug:=false` to suppress Foxglove Bridge.

The dashboard bridge is a separate launch from the simulation bringup. If progress/battery/temperature rows are silent and you want those values, start it in WSL after sourcing the workspace: `ros2 launch dashboard_bridge dashboard_bridge.launch.py use_sim_time:=true`. The battery and temperature values it publishes are simulation estimates from `fake_vehicle_status`, not physical sensor readings.

## Use the map and controls

Wait for the connection indicator to turn green. Press ADD, then click the track to publish `geometry_msgs/msg/PointStamped` to `/clicked_point` in frame `map`. New points appear as pending, then the `/waypoints/markers` feed supplies the manager-confirmed list and map labels. START, UNDO, and CLEAR call the advertised `std_srvs/srv/Trigger` services; CLEAR prompts for confirmation. The waypoint manager accepts additions only while its state is `COLLECTING`. A call result or bridge error appears below the controls. The waypoint list is read back from the manager, so it repopulates after a reload when markers are available.

The map uses the same transform as `dashboard_bridge/track_progress.py`: x=(pixel_x−300)×1.4321 m and y=(300−pixel_y)×1.4321 m, with frame `map`.

## Browser requirements

The app imports `@foxglove/rosmsg` and `@foxglove/rosmsg2-serialization` from esm.sh at pinned versions to parse ROS 2 message schemas and read/write CDR. The browser needs internet access to load these packages (and optional Google Fonts). For a fully offline installation, bundle these pinned npm packages locally.

## Network checks

The configured bridge URL is in `config/topics.json` (default `ws://127.0.0.1:8765`). In the browser, confirm the bridge is running, the server selected `foxglove.websocket.v1`, and WSL2 localhost forwarding is reachable. Topic rows change from silent to live only after data arrives. Battery and temperature topics come from the simulation's fake status node, and may be silent when that node is not launched.

See [docs/AUDIT.md](docs/AUDIT.md), [docs/TOPICS.md](docs/TOPICS.md), and [docs/CLEANUP.md](docs/CLEANUP.md).
