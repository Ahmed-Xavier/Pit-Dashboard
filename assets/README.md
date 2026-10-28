# Pit Dashboard Assets Layout

This directory houses the 3D vehicle model, visual and collision meshes, and coordinate configuration for the ENIMIA Autonomous Outdoor RC car.

## Directory Structure

```
assets/
├── README.md               # This documentation
├── urdf/
│   └── enimia.urdf         # Resolved static URDF describing the vehicle kinematics
└── meshes/                 # Visual and collision mesh assets
    ├── body_shell.dae      # Exterior aerodynamic composite body shell (COLLADA, smooth normals)
    ├── canopy.dae          # Transparent cockpit canopy (COLLADA)
    ├── tail_tip.dae        # Red rear trailing edge (COLLADA)
    ├── body_collision.stl  # Simplified low-poly collision hull (STL)
    └── stl/                # Flat-shaded STL alternatives
        ├── body_shell.stl
        ├── canopy.stl
        └── tail_tip.stl
```

## Kinematics & Coordinate Frames

The vehicle description in `enimia.urdf` conforms to ROS [REP-103](https://www.ros.org/reps/rep-0103.html):
- **$+X$**: Forward
- **$+Y$**: Left
- **$+Z$**: Up
- **SI Units**: Meters, radians, seconds.

### Frame Hierarchy
```
base_footprint (Ground plane contact, center of wheelbase)
  └── base_link (Chassis level, z = +0.21 m)
        ├── body_link (Fixed joint to shell, canopy, tail_tip)
        ├── front_left_steer_link (Revolute joint around Z)
        │     └── front_left_wheel_link (Continuous joint around Y)
        ├── front_right_steer_link (Revolute joint around Z)
        │     └── front_right_wheel_link (Continuous joint around Y)
        ├── rear_wheel_link (Continuous drive wheel around Y)
        ├── lidar_link (RPLIDAR A1M8, +4° pitch tilt mount)
        ├── imu_link (BNO055 9-DOF IMU)
        └── gps_link (GT-U7 GNSS receiver)
```

## Mesh Path Style & Resolution Rules

In `enimia.urdf`, visual meshes strictly use ROS package URI format:
- `package://vehicle_description/meshes/body_shell.dae`
- `package://vehicle_description/meshes/canopy.dae`
- `package://vehicle_description/meshes/tail_tip.dae`
- `package://vehicle_description/meshes/body_collision.stl`

### Resolution Rules implemented in `urdfBuilder.js`:
1. **ROS Package URIs (`package://<pkg>/...`)**:
   Matches `package://[^/]+/(?:meshes/)?(.*)` and maps to `${config.urdf.meshBaseUrl}/$1`.
2. **Relative Paths (`./meshes/...` or `meshes/...`)**:
   Strips leading path components and resolves to `${config.urdf.meshBaseUrl}/<filename>`.
3. **Absolute Windows Paths (`C:\...` or `c:/...`)**:
   Extracts the final filename (`filename.replace(/^.*[\\/]/, '')`) and resolves to `${config.urdf.meshBaseUrl}/<filename>`.
4. **Primary Format**:
   Loads `.dae` (COLLADA) with Z_UP orientation preserved and canopy glass transparency configured.
5. **Fallback to STL**:
   If a `.dae` fetch or parse fails, attempts to load `${config.urdf.meshBaseUrl}/stl/<name>.stl`.
6. **Placeholder Box**:
   If both fail, renders an orange wireframe bounding box for that specific link and logs a warning to the dashboard faults panel without crashing the application.

