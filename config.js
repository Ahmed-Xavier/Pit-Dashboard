/* ==========================================================================
   ENIMIA Pit Dashboard — Centralized System Configuration
   All parameters, topic names, frame names, and asset URLs are defined here.
   Do not hardcode these values in individual components.
   ========================================================================== */

export const config = {
  // Temporary debug instrumentation (default false)
  debug: true,

  // UI panel update rate in Hz
  ui: {
    updateHz: 10,
  },

  // --------------------------------------------------------------------------
  // 1. WebSocket Bridge Connection
  // --------------------------------------------------------------------------
  bridge: {
    // Default Foxglove bridge endpoint exposed by vehicle_bringup / simulation.launch.py
    defaultUrl: "ws://127.0.0.1:8765",
    // Prefer current foxglove_bridge 3.x SDK protocol; retain compatibility
    // with servers that still implement the archived WebSocket v1 protocol.
    subprotocols: ['foxglove.sdk.v1', 'foxglove.websocket.v1'],
    reconnectIntervalMs: 3000,
    silentTimeoutMs: 2500,
  },

  // --------------------------------------------------------------------------
  // 2. Coordinate Frames & TF
  // --------------------------------------------------------------------------
  frames: {
    // Fixed world reference frame (matches Gazebo world origin & map origin)
    worldFrame: "map",

    // Odometry frame (continuous local dead-reckoning)
    odomFrame: "odom",

    // Car root frame in the URDF:
    // In enimia.urdf, <link name="base_footprint"/> is the kinematic root at ground level.
    // base_link is offset +0.21m above base_footprint by base_footprint_joint.
    carFrame: "base_footprint",

    // Internal vehicle frames (for optional joint state / sensor visualizers)
    baseLink: "base_link",
    bodyLink: "body_link",
    lidarLink: "lidar_link",
    imuLink: "imu_link",
    gpsLink: "gps_link",
  },

  // --------------------------------------------------------------------------
  // 2b. TF / Pose Source Settings
  // --------------------------------------------------------------------------
  tf: {
    // Explicit TF chain to walk (child → parent order). Lookup only traverses
    // this chain; unknown frame relationships are logged once and ignored.
    chain: ['map', 'odom', 'base_footprint'],

    // Maximum number of edges to traverse (cycle guard)
    maxDepth: 16,

    // 'tf'  — prefer TF tree lookup (map→base_footprint)
    // 'odom' — always use /odometry/global store.vehicle pose
    poseSource: 'tf',
  },

  // --------------------------------------------------------------------------
  // 3. ROS 2 Topics
  // Verified from Autonomous-outdoor-RC launch files & simulation bridges
  // --------------------------------------------------------------------------
  topics: {
    // Transform trees
    tf: "/tf",
    tfStatic: "/tf_static",

    // Odometry & Vehicle Pose
    // Primary: Global EKF output (map -> odom -> base_footprint)
    odomGlobal: "/odometry/global",
    // Secondary fallback: Local EKF
    odomLocal: "/odometry/local",
    // Ground truth / simulation odometry:
    odomSim: "/odom",
    wheelOdom: "/wheel/odom",

    // Sensor feeds
    scan: "/scan",                 // sensor_msgs/msg/LaserScan (bridged from /lidar_link/scan)
    fix: "/fix",                   // sensor_msgs/msg/NavSatFix (bridged from /gps_link/navsat)
    imu: "/imu/data",              // sensor_msgs/msg/Imu (bridged from /imu_link/imu)
    jointStates: "/joint_states",  // sensor_msgs/msg/JointState (steer & wheel joints)
    camera: "/camera/image_raw",   // sensor_msgs/msg/Image

    // Commands & actuators
    cmdVel: "/cmd_vel",
    motorCmd: "/esp32/motor_cmd",
    servoCmd: "/esp32/servo_cmd",
    encoder: "/esp32/encoder",

    // Navigation & safety
    trackProgress: "/track/progress",
    plannerStatus: "/planner/status",
    safetyGate: "/safety/gate_status",
    obstacleStop: "/obstacle_stop",
    waypointMarkers: "/waypoints/markers",
    clickedPoint: "/clicked_point",
  },

  // --------------------------------------------------------------------------
  // 4. Waypoint Services (std_srvs/srv/Trigger)
  // --------------------------------------------------------------------------
  services: {
    addHere: "/waypoints/add_here",
    start: "/waypoints/start",
    undo: "/waypoints/undo",
    clear: "/waypoints/clear",
  },
  definitions: {
    clickedPoint: `std_msgs/Header header
geometry_msgs/Point point

================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id

================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec

================================================================================
MSG: geometry_msgs/Point
float64 x
float64 y
float64 z`,
  },

  // --------------------------------------------------------------------------
  // 5. URDF & 3D Car Model Configuration
  // --------------------------------------------------------------------------
  urdf: {
    waitSec: 10,
    assetTimeoutMs: 10_000,
    // Relative path to the static resolved URDF
    url: "./assets/urdf/enimia.urdf",

    // Base directory for resolving package://vehicle_description/meshes/...
    // Maps "package://vehicle_description/meshes/<filename>" -> "./assets/meshes/<filename>"
    meshBaseUrl: "./assets/meshes",

    // Whether to update wheel rotation and steering angles from /joint_states
    // (Default OFF to minimize overhead; togglable in UI)
    applyJointStates: false,
  },

  // --------------------------------------------------------------------------
  // 6. World SDF Configuration
  // --------------------------------------------------------------------------
  world: {
    // Relative path to the active ADC course world used by simulation.
    defaultSdfUrl: "./world/adc_course.sdf",

    /*
     * GAZEBO WORLD & SPAWN ORIGIN RESEARCH FINDINGS:
     * ------------------------------------------------------------------------
     * 1. Spherical Coordinates (silesia_ring.sdf):
     *    <surface_model>EARTH_WGS84</surface_model>
     *    <latitude_deg>50.3568</latitude_deg>     (Kamień Śląski airport / Silesia Ring, Poland)
     *    <longitude_deg>18.4027</longitude_deg>
     *    <elevation>270.0</elevation>
     *    <heading_deg>0</heading_deg>
     *
     * 2. Track Origin & Spawn:
     *    - <model name="track_segment_0000"> is placed at:
     *      x = 1.5000 m, y = -0.0022 m, z = 0.0030 m, yaw = -0.00146 rad.
     *    - The Gazebo world origin (0, 0, 0) directly corresponds to the start
     *      of the straight (the start/finish line) and coincides with the 'map' frame.
     *    - The car spawns at base_footprint (z ≈ 0.0m on the track surface)
     *      pointing down the main straight (+X forward, REP-103).
     *    - Therefore, the Gazebo world coordinate system directly aligns with
     *      the ROS 'map' frame without an arbitrary coordinate offset.
     *      originOffset provides a tunable delta if local simulation requires fine trimming.
     */
    worldFrame: "map",
    originOffset: {
      x: 0.0,   // meters delta between Gazebo world origin and ROS map
      y: 0.0,   // meters delta
      yaw: 0.0  // radians delta
    },

    // Centerline resampling spacing (meters between waypoints)
    centerlineSpacing: 0.5,

    // Fallback only; the active ADC SDF provides width per road segment.
    trackWidth: 12.0,
  },

  geo: {
    datum: { lat: 50.3568, lon: 18.4027 },
    // Gazebo's spherical-coordinates heading is zero: +X=east, +Y=north.
    mapYawOffsetDeg: 0,
    carSource: 'tf',
  },

  map: {
    defaultProvider: 'sdf',
    maxTilesPerSession: 2000,
    tileCacheSize: 128,
    providers: [{
      id: 'xyz-osm', label: 'OpenStreetMap',
      urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileSize: 256, maxZoom: 19,
      attribution: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
    }],
  },

  // --------------------------------------------------------------------------
  // 7. Demo Mode Settings
  // --------------------------------------------------------------------------
  demo: {
    // Maximum cruise speed on straight sections (m/s)
    speedMps: 4.5,

    // Maximum lateral acceleration used to reduce speed on curves (m/s²)
    // v_curve = min(speedMps, sqrt(aLatMax / |curvature|))
    aLatMax: 6.0,

    // If true, add ±noiseAmp m lateral perturbation (for cross-track error display)
    noise: false,
    noiseAmp: 0.04,
  },

  // --------------------------------------------------------------------------
  // 8. 3D Scene & Camera Defaults
  // --------------------------------------------------------------------------
  camera: {
    defaultMode: "chase", // 'chase' | 'orbit' | 'top-down'

    // Chase Camera parameters (all tunable from config)
    chase: {
      distance: 2.2,     // Distance in meters behind car
      height: 1.0,       // Height in meters above car
      lookAhead: 1.5,    // Distance in meters in front of car to aim at
      smoothFactor: 5.0, // Exponential damping factor: alpha = 1 - exp(-k * dt)
    },

    // Orbit Camera parameters
    orbit: {
      initialDistance: 4.0,
      minDistance: 0.5,
      maxDistance: 800.0,
    },

    // Top-Down Camera parameters
    topDown: {
      height: 25.0,      // Height in meters above car
    },

    fov: 55,
    near: 0.3,           // Set to 0.3 per user specification
    far: 4000,
  },

  // --------------------------------------------------------------------------
  // 9. Items to verify on the live system with ROS 2 CLI
  // --------------------------------------------------------------------------
  toVerify: [
    "Verify camera topic format (/camera/image_raw vs compressed) with: ros2 topic info /camera/image_raw",
    "Verify active TF frame tree with: ros2 run tf2_tools view_frames",
    "Verify if /odometry/global publishes continuously in frame 'map' with child_frame_id 'base_footprint'",
    "Verify whether /esp32/encoder and /esp32/status are active in simulation or only on physical hardware"
  ]
};
