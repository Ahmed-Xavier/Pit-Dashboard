# ENIMIA Pit Dashboard

This is the pit-side replacement for Foxglove. It connects to ROS 2 through `foxglove_bridge` using the Foxglove WebSocket subprotocol, reads CDR messages, plots the simulation map and live vehicle position, and publishes/calls the waypoint manager interface.

> **Serving requirement:** The app **must** be served with `Pit-dashboard/` as the HTTP web root.
> `config.js` is imported as `/config.js` (absolute URL) from several modules deep in `src/`.
> Opening `index.html` directly as a `file://` URL will fail — always use a local HTTP server
> (`python -m http.server 8080` from this folder, or `start.ps1`).


## Run both dashboards

On Windows, install Python 3 and Pillow if needed, then run `start.ps1` in PowerShell. The script copies the driver's `track.json` into this folder, starts this static app on port 8080, starts the existing driver `server.py` on port 8000 with bytecode generation disabled, and opens both URLs.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start.ps1
```

The URLs are `http://localhost:8080` (pit) and `http://localhost:8000` (driver). Both processes run in the background; stop them from Task Manager or stop the `python` processes. Python's `http.server` is included with Python. Driver dashboard dependencies are documented in `Dashboard-E-ink\README.md`. If the Windows Python environment does not include ROS 2 `rclpy`, the unchanged driver server uses its built-in fake-data fallback; use the WSL start script for a ROS-enabled Python environment.

For WSL, from this folder run `bash ./start-wsl.sh`. Keep that terminal open; Ctrl+C stops both servers. It sources the ROS Jazzy underlay so the driver server can use `rclpy`. Browser access to WSL localhost forwarding and to the WebSocket at `ws://127.0.0.1:8765` depends on the local WSL2 forwarding configuration. If Windows localhost forwarding does not reach the bridge, use the WSL IP in `config/topics.json` (`ws://<WSL-IP>:8765`).

On Ubuntu, run the native launcher:

```bash
cd /home/ahmed/Pit-dashboard
chmod +x start.sh
./start.sh
```

For a double-click launcher, double-click `pit-dashboard.desktop` in this
folder and choose **Trust and Launch** if Ubuntu asks for confirmation. It
opens a terminal to keep the dashboard server running and opens the dashboard
in the browser.

The launcher serves the dashboard on the first free port starting at `8080`,
uses `ws://127.0.0.1:8765` for the ROS Foxglove bridge, and opens the URL with
`xdg-open` when available. Override either value without editing files:

```bash
PORT=8090 BRIDGE_URL=ws://192.168.1.20:8765 ./start.sh
```

Set `OPEN_BROWSER=0` when running without a desktop session. Start the ROS
simulation or bringup separately; this launcher does not start ROS nodes.

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

## Standalone Pit Dashboard launcher

Double-click `run_dashboard.bat` from any working directory, or pass an optional starting port such as `run_dashboard.bat 8090`. It serves this folder, advances to the next free port through 8090, opens the browser after one second, and leaves the server in the same window. Press Ctrl+C there to stop it. This starts neither ROS nor Foxglove Bridge. For the simulation bridge, in WSL run:

```bash
source /opt/ros/jazzy/setup.bash
cd ~/Autonomous-outdoor-RC/ros2_ws && source install/setup.bash
ros2 launch simulation simulation.launch.py
```

The Python development server does not send no-cache headers; use Ctrl+F5 after editing files.

## REPORT — freeze investigation (2026-10-20)

### Before / after

| Measurement | Before allocation change | After allocation change |
| --- | ---: | ---: |
| Full-rate mock, 5-minute long tasks | 1,886; 1,858 above 100 ms; max 1,373 ms | Not re-measured for 5 minutes; Part 1 does not pass |
| Heap, minutes 1 / 3 / 5 | 24.1 / 19.1 / 18.4 MB | Not re-measured on an equivalent run |
| `/planner/markers` | 23,599 bytes/message; max decode 704.2 ms in the soak; 1.403 ms average at minute 5 | A separate 7-second isolated run measured 46 messages, 0.226 ms average decode, 2.1 ms max; this is not an equivalent before/after comparison |

The mock’s default planner load follows `local_planner.yaml`: 11 arcs, each with 81 points (2 m horizon at 0.025 m steps). The world marker follows `world_markers.py` and advertises one mesh marker. Waypoint marker count is configurable; the default mock uses eight waypoints. Run artifacts are in `tools/results/`; `full-trace.json` is a Chrome DevTools trace and `full-soak-5min.json` contains the heap/topic snapshots. The recorded topic rates are browser-received rates; the headless run fell behind the configured publisher rates.

The 5-minute mock run did not meet acceptance: FPS was 7 / 3 / 2 at minutes 1 / 3 / 5. The trace’s ten longest main-thread tasks were 144–154 ms, dominated by Chrome `Commit` events of about 138–146 ms; JavaScript frame callbacks in that trace were at most 5.6 ms. Chrome logged SwiftShader GPU stalls. A no-topic run also recorded 62 long tasks (max 257 ms) at about 10 FPS, so this environment cannot establish normal laptop GPU performance. In the full soak `/planner/markers` was the largest decoder cost and had a 704.2 ms outlier. `cdr.js` now stores marker points in a flat `Float64Array` and uses explicit sequence loops to reduce per-point allocations. The post-change run did not prove that this removes the freeze.

### Code audit

- `state.js` defines `notifyIntervalMs` from `config.ui.updateHz` (10 Hz) and has one state UI interval. `scene3D.js` and `trackNav.js` each own an animation-frame loop, so there are two RAF loops. `resetLiveData()` runs when LIVE is selected; SDF auto-load begins during scene initialization, independent of LIVE, and the first-second startup cost was not isolated from asset loading.
- Bridge handlers decode and update latest-topic slots; UI-facing store updates happen in the tick. Store notifications mark panels dirty rather than synchronously invoking listeners. No notification-to-notification recursion was observed in the reviewed listener paths. `silentTimeoutMs` is configured but is not used by `rosBridge.js`; close reconnect is delayed 4 seconds. No reconnect storm was observed in the mock soak.
- TF lookup is called once from the scene render method per frame. The configured chain is `map → odom → base_footprint`; the mock sends competing direct and odom parent transforms. No live simulation comparison was completed.
- `/planner/markers` decoding is the biggest topic cost in the soak. The mock also recorded `/scan` at 5,837 bytes and `/world_markers` at 262 bytes. The one-second startup trace included SDF parse/extract work and GPU commits; repeated SDF uploads were not observed.

### Verification still required

- Run `npm install --no-save playwright` and `npx playwright install chromium` once, then `node tools/measure_dashboard.mjs --duration-sec 300 --topics all`; the script writes a Chrome trace and JSON report. The current environment used its provided Playwright runtime and local Chrome; it did not complete the script’s five-minute output path because the automation call hit its 300-second limit, though the soak JSON was saved.
- Repeat the full-rate run on a hardware-accelerated normal laptop and against the real WSL simulation. The 5-minute browser test here was under SwiftShader, and the attempted real-relay browser run did not return measurements.
- Part 2 waypoint controls and click publishing were not changed or verified. The read-only `waypoint_manager_node.py` contract is: `geometry_msgs/PointStamped` on `/clicked_point`, expected frame `map` (other frames are transformed via TF); Trigger services `/waypoints/add_here`, `/waypoints/start`, `/waypoints/undo`, `/waypoints/clear`; marker output `/waypoints/markers`; guidance `/waypoints/guidance`. `start` refreshes map coordinates from saved lat/lon and enters RUNNING once conversion completes. The four dashboard service buttons were not individually exercised against a real service server.

### Step A: freeze hardening and real decoder audit (2026-10-20)

**User supplied live result:** Ahmed reports that the dashboard remained responsive for 5 minutes, the car moved, and displayed values matched. No browser long-task, heap, or GPU frame-time export was supplied with that result, so those acceptance numbers are not independently measured here.

The saved 30-second capture is `tools/captures/real_20261020T050317Z.jsonl`. It contains 39 advertised channels and 4,873 binary messages. The recorder negotiated `foxglove.sdk.v1` with foxglove_bridge 3.6.0 / foxglove-sdk-cpp 0.28.0.

| Capture measurement | Result |
| --- | ---: |
| `/world_markers` mesh marker | 321 bytes on wire; 1 marker; `mesh_resource=package://simulation/worlds/models/silesia_ring/meshes/silesia_ring.glb` |
| `/tf_static` | 633 bytes; 6 transforms |
| `/planner/markers` largest message | 253 bytes |
| `/waypoints/markers` | 245 bytes; one `DELETEALL` marker in this capture |
| Largest binary message | `/robot_description`, 19,785 bytes |
| Largest JSON message | `advertiseServices`, 436,504 bytes |
| `/scan` | 18 messages; 360 ranges each; 292 `+Infinity` and 0 NaN; angle min/max `-3.14159274` / `3.14159274`, increment `0.01750191` rad; range min/max `0.15` / `12` m |

#### Protocol compatibility

The older [`foxglove.websocket.v1` spec](https://github.com/foxglove/ws-protocol/blob/main/docs/spec.md) is marked outdated by Foxglove. Current Foxglove SDK source uses `foxglove.sdk.v1`; the SDK WebSocket server rejects a handshake that does not offer that token. The app, recorder, synthetic mock, and capture replay now offer/select both tokens, preferring `foxglove.sdk.v1`. The dashboard debug overlay shows the negotiated value.

The current SDK v1 source retains the wire forms used by this dashboard for service calls, client publish, and asset fetch. Service calls use client binary opcode `0x02` and server response `0x03`; their payloads contain service id, call id, encoding length/name, then CDR or JSON payload. Client advertise/unadvertise are JSON operations; client publish is binary `0x01`, channel id, then payload. Asset fetch is JSON `fetchAsset` with URI/request id; its response is binary `0x04`, request id, status, error length/error, then asset bytes. The SDK v1 implementation additionally defines server opcode `0x05` (`PlaybackState`) and client opcode `0x03` (`PlaybackControlRequest`); the dashboard does not use playback. Current source: [SDK client v1](https://docs.rs/foxglove/latest/src/foxglove/protocol/v1/client.rs.html), [SDK server v1](https://docs.rs/foxglove/latest/src/foxglove/protocol/v1/server.rs.html), [SDK handshake](https://docs.rs/foxglove/latest/src/foxglove/websocket/handshake.rs.html). The older spec does not include those playback opcodes. The two protocol names are not a promise that future SDK releases will stay wire-identical; the old repo recommends migrating to the SDK.

`node tools/test_protocols.mjs --url=ws://127.0.0.1:<port>` passed against both `tools/replay_bridge.mjs` and `tools/mock_bridge.mjs`: each independently negotiated both tokens and delivered serverInfo and channel advertisements. The captured live session verifies telemetry delivery under SDK v1; service calls, client publish, and fetchAsset were not exercised against the real bridge in Step A.

#### Decoder and invalid-value checks

`npm.cmd run verify:decoder` compared the dashboard decoder against the read-only `@lichtblick/rosmsg2-serialization` package for every captured message. Result: **4,873 messages checked, 0 field mismatches, 0 decode errors, across 39 advertised channels**. This covers TF and TF static, IMU, NavSatFix, LaserScan, MarkerArray, Odometry, JointState, Float32MultiArray, String, and all other captured channel types. The audit found the real Marker schema includes texture, UV, and embedded-mesh fields that the previous decoder skipped; `src/cdr.js` now reads those fields before `mesh_resource`.

The independent audit found 9 `/odometry/gps` messages with an empty `child_frame_id`; the capture also has empty JointState `header.frame_id`, which is allowed for JointState. TF and Odometry used non-empty required frames and valid quaternions. `/scan` contains valid `+Infinity` no-return values; the decoder validator preserves that ROS sentinel, rejects NaN/other non-finite values, and rejects a zero angle increment when there are multiple ranges. Sequence lengths are capped at 20,000 elements before allocation; a TF message is capped at 256 transforms and a MarkerArray at 1,024 markers. Invalid messages are dropped, with at most one fault-panel warning per topic per 10 seconds.

`node tools/test_hostile_capture.mjs` passed 8 hostile cases using real captured Odometry, TF, LaserScan, and Marker messages: 1e220 position, zero quaternions, NaN ranges, zero angle increment, accepted +Infinity sentinel, and a 4,294,967,295-element declared CDR sequence rejected before allocation. This is an offline decoder/validator test; it does not prove browser long-task timing.

The real-packet regression `node tools/test_capture_freeze.mjs tools/captures/real_20261020T050317Z.jsonl` measured the old alignment decode at y=`-9.14803027613358e+220`; adding the 2 m grid step left the floating-point value unchanged. With the current decoder, y=`0.003048606084581617`; the test grid advanced from 0 m to 2 m. This proves the bad-value / non-progressing-loop mechanism offline, not that the live browser met its long-task threshold.

#### Loop bounds reviewed

- `src/cdr.js`: CDR arrays/sequences at most 20,000 elements; flattened Point sequences at most 60,000 numeric reads; validator traverses the resulting bounded object. TF/Marker checks are capped at 256 / 1,024 messages per array.
- `src/rosBridge.js`: target topic loop is the fixed configured topic list; scan decimation is at most 10,000 iterations; TF transforms are at most 256; planner path uses at most 20,000 points.
- `src/tf/transformTree.js`: transform insertion at most 256 per message; lookup walks use configured `config.tf.maxDepth` (16).
- `src/components/sensorFusion.js`: metric-grid axes are capped at 1,000 lines each; odometry history is 200 points; LiDAR points at most 10,000 after decimation; planned path at most 20,000 points.
- `src/components/telemetryCharts.js`: telemetry history is capped at 300 points, so its time-window `while` and chart loops stop within 300 iterations.
- `src/components/trackNav.js`: waypoint loops at most 1,024; centerline and nearest-segment loops at most 20,000 based on the SDF resampling cap in `src/sdf/sdfWorker.js`. The angle-wrap loops were replaced with finite-safe constant-time normalization; centerline output is capped at 20,000 points.
- SDF/URDF parser and renderer loops over XML-derived model/link/visual lists are bounded by the local input size but do not all have independent item-count caps yet. This is still an audit gap; those files are listed for Step A follow-up before Part B.

#### Freeze acceptance status

Ahmed's report says 5 minutes without a freeze, but no headed GPU Chrome/CDP capture, long-task list, heap samples, or watchdog result is available in this workspace. `tools/test_replay_browser.mjs --duration-sec=60 --topics=all` is the headed replay gate; `tools/test_replay_browser.mjs --bridge-url=ws://127.0.0.1:8765 --duration-sec=300 --topics=all` runs the same gate against the live bridge. Both use system Chrome without SwiftShader flags, record Long Task entries, sample heap/topic metrics, run the 500 ms CDP watchdog, and save a stack/profile on a watchdog timeout. These headed runs have not been run here because this environment cannot provide Ahmed's GPU desktop session. The SDF/URDF parser item-count audit is also incomplete. Step A therefore remains unpassed here despite strong offline decoder evidence and Ahmed's user-reported live result.


### Step B: waypoint controls, markers, and click publishing (2026-10-20)

Read-only inspection of `Autonomous-outdoor-RC/ros2_ws/src/navigation/navigation/waypoint_manager_node.py` confirms that `/clicked_point` is `geometry_msgs/msg/PointStamped`. An empty `frame_id` defaults to `map`; other frames are transformed through TF into `map`. Services are `/waypoints/add_here`, `/waypoints/start`, `/waypoints/undo`, and `/waypoints/clear`, all `std_srvs/srv/Trigger`. The node publishes `/waypoints/markers` and `/waypoints/guidance`. `start` rejects an empty route, refreshes each waypoint's map coordinate from its saved latitude/longitude, and switches to RUNNING when all conversions complete. `clear` stops the command, empties the route, resets the index, and returns to COLLECTING. The launch file configures foxglove_bridge with port 8765 and simulation time; it does not set service, topic, or client-publish allowlists. The captured real bridge advertises both `services` and `clientPublish`.

The real capture advertises these waypoint services (each has an empty Trigger request schema and a response with `bool success` and `string message`):

| Service | ID | Type |
| --- | ---: | --- |
| `/waypoints/add_here` | 83 | `std_srvs/srv/Trigger` |
| `/waypoints/start` | 85 | `std_srvs/srv/Trigger` |
| `/waypoints/undo` | 86 | `std_srvs/srv/Trigger` |
| `/waypoints/clear` | 84 | `std_srvs/srv/Trigger` |

`src/rosBridge.js` sends client opcode `0x02`, advertised service ID, call ID, encoding length and `cdr`, then the four-byte empty CDR request. It parses server opcode `0x03` and Trigger fields, validates response length, reports request/response bytes and elapsed time when `config.debug.services` is enabled, and times out after 5 seconds. The panel reports `ADD: ok (...)`, `ADD: failed (...)`, or `ADD: timeout after 5 s`; unavailable services remain disabled with a tooltip. Marker spheres and their line are rendered in 3D and rebuilt on waypoint/guidance updates. The click toggle (`W`) raycasts to the ground plane, converts through the inverse `rosRoot` transform, applies `world.originOffset`, and publishes a map-frame PointStamped. The minimap click path is not included.

`npm.cmd run test:waypoints` exercised all four visible service buttons in headed Chrome against the local mock and received successful Trigger responses. In that run, request-to-response measurements were 31.2 ms (START), 48.2 ms (ADD), 34.9 ms (UNDO), and 11.8 ms (CLEAR). A click produced a finite mock-decoded PointStamped at `x=-4.815`, `y=3.766`, `frame_id=map`. `npm.cmd run test:point-stamped` independently decoded the 44-byte CDR payload with `@lichtblick/rosmsg2-serialization`; it matched `x=1.25`, `y=-2.5`, `z=0`, `frame_id=map`. These are mock and encoder results. A live waypoint_manager service round-trip and a real map click followed by matching marker coordinates remain unverified; the recorded capture contains only a DELETEALL waypoint marker.

### Step C: LIVE car from `/robot_description` (2026-10-20)

LIVE now waits for `std_msgs/msg/String` on `/robot_description` for `config.urdf.waitSec` (10 seconds by default) and shows `WAITING FOR /robot_description` until it arrives. It parses and builds from the received XML once per changed description hash. The root link comes from the URDF graph. DEMO still loads `assets/urdf/enimia.urdf`, local meshes, and the SDF. The real capture contains a 19,785-byte wire message (19,761-byte XML), robot `enimia_black`, root link `base_footprint`, and these four package mesh URIs: `body_shell.dae`, `canopy.dae`, `tail_tip.dae`, and `body_collision.stl` under `package://vehicle_description/meshes/`.

The live builder uses Foxglove `fetchAsset` when `serverInfo` advertises `assets`, with four-request concurrency maximum, 10-second per-request timeout, and a per-URI memory cache. It falls back to the local mesh copy on bridge fetch errors; mesh loading failures produce placeholders and faults. The replay server resolves the URI basename inside `assets/meshes` and serves the real local body-shell asset for offline tests. The protocol's binary response layout is `0x04`, request ID, status, error length, error text, then asset bytes ([Foxglove v1 protocol](https://github.com/foxglove/ws-protocol/blob/main/docs/spec.md)). The captured `/robot_description` URIs match the current default `asset_uri_allowlist` suffix and package-path pattern; the simulation launch file does not override that setting. [Foxglove bridge parameter documentation](https://github.com/foxglove/foxglove-sdk/blob/main/ros/src/foxglove_bridge/README.md)

`npm.cmd run test:replay-assets` measured a successful 3,847,793-byte body-shell asset response from the replay bridge. In the latest `npm.cmd run test:live-urdf` headed replay run: URDF parse 3.8 ms, full car build 681.8 ms, root `base_footprint`, and one build. Mesh fetch / parse measurements were: body shell 111.5 / 412.0 ms (3,847,793 bytes), canopy 44.5 / 71.5 ms (730,985 bytes), and tail tip 7.7 / 12.2 ms (151,634 bytes). After a bridge reconnect, build count remained 1 and the negotiated protocol was `foxglove.sdk.v1`. The test also observed `localCarLoaded=false` and `sdfLoaded=false` in LIVE. These are replay results; timeout behavior, asset fallback, and a real bridge asset fetch remain unverified.

### Step D: selectable world map and LIVE minimap (2026-10-20)

The 3D panel now has MAP, SDF, and GRID world choices. LIVE starts on the configured MAP provider and waits for `/robot_description` as before; DEMO starts with the SDF. The MAP provider projects XYZ tiles into the configured local datum, keeps the grid below the tiles, limits requests to two at once, uses browser HTTP caching, caps a session at 2,000 tile requests and the decoded texture cache at 128 tiles, and times each fetch out after 10 seconds. HTTP 403/429 responses switch to GRID immediately. Other failures retry at 1, 5, and 15 seconds, then switch to GRID. Selecting MAP again retries failed tiles. OSM attribution is shown as a visible link while that layer is active. Tile requests use the standard [OpenStreetMap tile endpoint](https://tile.openstreetmap.org/) and follow the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/) (read 2026-10-20); the dashboard does not prefetch tiles or send cache-busting requests.

`config.geo.datum` is set to the SDF's spherical-coordinate origin (latitude 50.3568, longitude 18.4027); `mapYawOffsetDeg` defaults to zero and can be adjusted for a measured map-frame heading offset. When LIVE has no SDF centerline, the minimap shows the bounded odometry trail and waypoints instead of the full SDF track outline. The SDF can still be selected manually.

`npm.cmd run test:geo-ref` measured five geographic round trips with a maximum error of 0.0018751 m; the rotated round trip returned (122.9999983, -455.9999939) m for (123, -456) m, and the 100 m east check returned 99.9999835 m east with effectively zero northing. `npm.cmd run test:map-provider` ran in headed Chrome with intercepted tile responses: one tile became visible, the attribution link was visible, and the observed maximum was one concurrent fetch (limit is two). A second page received HTTP 429 and switched to GRID with `MAP BLOCKED (429)` and attribution hidden. In LIVE, the same test measured zero SDF centerline points and the minimap badge `LIVE TRACK`. These tests validate the provider logic with synthetic tile responses; they did not fetch or align against the public OSM service.

Real map alignment against the Gazebo/vehicle track, real OSM connectivity and cache headers, outage retry behavior over the full retry window, and the physical heading offset remain unverified. `config.geo.mapYawOffsetDeg=0` follows the simulation world's heading metadata, but it has not been checked against a measured location on the real vehicle.

### Launcher check (2026-10-20)

Started `run_dashboard.bat` with the default port while 8080 was occupied. It selected 8081, printed the WSL bridge reminder and stop instructions, and served the dashboard with HTTP 200 and the expected page title. Ctrl+C stopped the Python server. The delayed default-browser launch returned `Start-Process: Access denied` in this environment, so browser opening and a physical Explorer double-click remain unverified here.
