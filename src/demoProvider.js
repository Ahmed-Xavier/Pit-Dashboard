/* ==========================================================================
   ENIMIA Dashboard — Coordinated Kinematic Demo Provider
   Shell Eco-marathon Circuit Simulation with Coordinated Multi-Sensor Physics
   ========================================================================== */

import { store } from './state.js';

export class DemoProvider {
  constructor() {
    this.timer = null;
    this.running = false;
    this.lastTime = performance.now();

    // Shell Eco-marathon prototype circuit definition (~280m track loop)
    // Points defined in local metric coordinates (x, y in meters)
    this.trackSpline = [
      { x: 0, y: 0, type: 'straight' },
      { x: 45, y: 0, type: 'straight' },
      { x: 75, y: 10, type: 'turn_right' },
      { x: 95, y: 35, type: 'turn_right' },
      { x: 85, y: 65, type: 'hairpin' },
      { x: 55, y: 75, type: 'turn_left' },
      { x: 25, y: 60, type: 'chicane' },
      { x: -10, y: 55, type: 'turn_left' },
      { x: -35, y: 40, type: 'turn_left' },
      { x: -45, y: 20, type: 'turn_left' },
      { x: -30, y: 5, type: 'straight' },
      { x: -15, y: 0, type: 'pit_entry' }
    ];

    // Build dense track points and waypoints
    this.denseTrack = this.generateDenseTrack(this.trackSpline, 600);
    this.trackLength = this.computeTrackLength(this.denseTrack);
    this.trackWidth = 5.6; // meters track width

    // Define Waypoints
    this.waypoints = this.trackSpline.map((pt, i) => ({
      index: i + 1,
      id: `WP${(i + 1).toString().padStart(2, '0')}`,
      x: pt.x,
      y: pt.y,
      name: this.getWaypointName(i)
    }));

    // Track obstacles (fixed cones/markers in world coordinates)
    this.worldObstacles = [
      { id: 1, type: 'TRAFFIC_CONE', x: 26, y: 0.8, radius: 0.25 }, // Direct ahead on pit straight
      { id: 2, type: 'TRAFFIC_CONE', x: 78, y: 12, radius: 0.25 },
      { id: 3, type: 'TRAFFIC_CONE', x: 80, y: 62, radius: 0.25 },
      { id: 4, type: 'STOP_SIGN', x: 42, y: -2.2, radius: 0.4 } // Trackside stop marker
    ];

    // Simulation state along the track
    this.trackDistance = 15.0; // start 15m from origin
    this.lap = 1;
    this.wheelbase = 1.25; // Shell Eco-marathon prototype wheelbase
    this.trackGauge = 0.68; // track width (front axle)
    this.wheelRadius = 0.24; // 16-inch Michelin Eco-marathon tire

    this.historyInitialized = false;
  }

  getWaypointName(idx) {
    const names = [
      'Start/Finish Line', 'Pit Straight Exit', 'Turn 1 Approach', 'Turn 1 Apex',
      'East Hairpin Entry', 'Hairpin Apex', 'Technical Chicane', 'West Curve Entry',
      'Back Straight Approach', 'Turn 4 Sweeper', 'Final Complex', 'Main Straight Entry'
    ];
    return names[idx] || `Waypoint ${idx + 1}`;
  }

  generateDenseTrack(spline, numSamples) {
    const pts = [];
    const n = spline.length;
    for (let i = 0; i < numSamples; i++) {
      const t = (i / numSamples) * n;
      const idx = Math.floor(t) % n;
      const nextIdx = (idx + 1) % n;
      const fraction = t - Math.floor(t);

      // Smooth cosine interpolation
      const mu = (1 - Math.cos(fraction * Math.PI)) / 2;
      const x = spline[idx].x * (1 - mu) + spline[nextIdx].x * mu;
      const y = spline[idx].y * (1 - mu) + spline[nextIdx].y * mu;
      pts.push({ x, y });
    }
    return pts;
  }

  computeTrackLength(pts) {
    let len = 0;
    for (let i = 0; i < pts.length; i++) {
      const next = pts[(i + 1) % pts.length];
      const dx = next.x - pts[i].x;
      const dy = next.y - pts[i].y;
      len += Math.hypot(dx, dy);
    }
    return len;
  }

  initTelemetryHistory() {
    const now = Date.now();
    for (let i = 60; i >= 0; i--) {
      const t = (now - i * 500) / 1000;
      store.appendTelemetryPoint({
        timestamp: t,
        speedActual: 4.1 + Math.sin(i * 0.2) * 0.3,
        speedTarget: 4.5,
        steerActual: Math.sin(i * 0.1) * 3.2,
        steerTarget: Math.sin(i * 0.1) * 3.4,
        encLeft: 34.0 + Math.sin(i * 0.2) * 2.5,
        encRight: 34.2 + Math.cos(i * 0.2) * 2.5,
        imuYawRate: Math.sin(i * 0.1) * 4.0,
        powerCurrent: 3.8 + Math.abs(Math.sin(i * 0.15)) * 1.5,
        powerVoltage: 26.45 - (60 - i) * 0.001
      });
    }
  }

  start() {
    if (this.running) return;
    store.trackWaypoints = this.waypoints;
    if (!this.historyInitialized) {
      this.initTelemetryHistory();
      this.historyInitialized = true;
    }
    this.running = true;
    this.lastTime = performance.now();
    this.loop();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      cancelAnimationFrame(this.timer);
      this.timer = null;
    }
  }

  loop = () => {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    if (store.mode === 'demo') {
      this.step(dt);
    }

    this.timer = requestAnimationFrame(this.loop);
  };

  step(dt) {
    // 1. Advance distance along track
    // Shell Eco-marathon typical cruise velocity: ~4.2 - 5.0 m/s (~15-18 km/h)
    const targetSpeed = 4.6; // m/s
    const speed = 4.2 + 0.35 * Math.sin(this.trackDistance * 0.08); // speed varies with curvature
    this.trackDistance = (this.trackDistance + speed * dt) % this.trackLength;
    const lapProgress = this.trackDistance / this.trackLength;

    // 2. Interpolate position and heading on dense track
    const sampleIdx = Math.floor((this.trackDistance / this.trackLength) * this.denseTrack.length) % this.denseTrack.length;
    const currentPt = this.denseTrack[sampleIdx];
    const lookAheadIdx = (sampleIdx + 8) % this.denseTrack.length;
    const lookAheadPt = this.denseTrack[lookAheadIdx];

    const dx = lookAheadPt.x - currentPt.x;
    const dy = lookAheadPt.y - currentPt.y;
    const trackHeading = Math.atan2(dy, dx);

    // Realistic cross-track error perturbation
    const crossTrackPerturbation = 0.06 * Math.sin(this.trackDistance * 0.25);
    const perpHeading = trackHeading + Math.PI / 2;
    const posX = currentPt.x + Math.cos(perpHeading) * crossTrackPerturbation;
    const posY = currentPt.y + Math.sin(perpHeading) * crossTrackPerturbation;

    // Vehicle heading aligns with trajectory with slight slip angle
    const yaw = trackHeading + 0.015 * Math.sin(this.trackDistance * 0.4);

    // Compute curvature and steering angle: δ ≈ atan(L * κ)
    const farLookAheadIdx = (sampleIdx + 20) % this.denseTrack.length;
    const farPt = this.denseTrack[farLookAheadIdx];
    const curvature = ((farPt.y - currentPt.y) * dx - (farPt.x - currentPt.x) * dy) / Math.pow(Math.hypot(dx, dy), 3);
    const targetSteerRad = Math.max(-0.45, Math.min(0.45, Math.atan(this.wheelbase * curvature * 12.0)));
    const actualSteerRad = targetSteerRad * 0.94 + 0.01 * (Math.random() - 0.5);

    const steerDeg = (actualSteerRad * 180) / Math.PI;
    const targetSteerDeg = (targetSteerRad * 180) / Math.PI;

    // Kinematic Yaw Rate: r = (v / L) * tan(δ)
    const yawRateRad = (speed / this.wheelbase) * Math.tan(actualSteerRad);
    const yawRateDeg = (yawRateRad * 180) / Math.PI;
    const lateralAcc = speed * yawRateRad; // m/s²

    // Wheel Encoders (rad/s)
    const vLeft = speed - (yawRateRad * this.trackGauge) / 2;
    const vRight = speed + (yawRateRad * this.trackGauge) / 2;
    const encLeft = vLeft / this.wheelRadius;
    const encRight = vRight / this.wheelRadius;

    // Electrical Power (Amps & Volts)
    // Motor current increases with speed & acceleration: I = 2.0 + 0.4 * v + 1.2 * abs(latAcc)
    const currentA = 2.2 + 0.35 * speed + 0.8 * Math.abs(lateralAcc) + 0.1 * Math.sin(Date.now() * 0.005);
    // Battery voltage sag with internal resistance
    const voltageV = 26.45 - currentA * 0.045 - (this.trackDistance / 10000);
    const soc = Math.max(10, 88.4 - (this.trackDistance / 500));

    // Update Vehicle in State
    store.vehicle = {
      x: posX,
      y: posY,
      yaw: yaw,
      vx: speed,
      targetVx: targetSpeed,
      steering: actualSteerRad,
      targetSteering: targetSteerRad,
      yawRate: yawRateRad,
      accelY: lateralAcc,
      encLeft: encLeft,
      encRight: encRight,
      motorCurrent: currentA,
      crossTrackError: crossTrackPerturbation,
      headingError: ((yaw - trackHeading) * 180) / Math.PI,
      lapProgress: lapProgress,
      currentLap: this.lap,
      activeWaypointIndex: this.findActiveWaypointIndex(posX, posY),
      distToNextWp: this.findDistToNextWaypoint(posX, posY)
    };

    // Odometry History Ring
    store.odomHistory.push({ x: posX, y: posY, yaw: yaw });
    if (store.odomHistory.length > store.maxOdomHistory) {
      store.odomHistory.shift();
    }

    // Planned Path (15m lookahead horizon)
    const planned = [];
    for (let k = 0; k <= 30; k++) {
      const pIdx = (sampleIdx + k * 2) % this.denseTrack.length;
      planned.push({ x: this.denseTrack[pIdx].x, y: this.denseTrack[pIdx].y });
    }
    store.plannedPath = planned;

    // 3. Generate Coherent 360° LiDAR Scan (RPLIDAR A1M8 in vehicle frame)
    this.generateLidarScan(posX, posY, yaw);

    // 4. Generate Camera Perception Detections
    this.generatePerceptionDetections(posX, posY, yaw);

    // 5. Update Component Health Timestamps & Freshness
    store.updateComponent('pi5', {
      cpu: 26.0 + 4.0 * Math.sin(Date.now() * 0.001) + Math.random() * 2.0,
      temp: 48.0 + 1.2 * Math.sin(Date.now() * 0.0002)
    });
    store.updateComponent('esp32', {
      rtt: 3.5 + 0.6 * Math.random(),
      jitter: 0.5 + 0.3 * Math.random()
    });
    store.updateComponent('rplidar', {
      rpm: 602 + Math.floor(Math.random() * 6)
    });
    store.updateComponent('gps', {
      lat: 44.931245 + posY * 0.0000089,
      lon: 4.896512 + posX * 0.0000124
    });
    store.updateComponent('imu', {
      yawRate: yawRateDeg,
      lateralAcc: lateralAcc,
      temp: 34.0 + 0.4 * Math.sin(Date.now() * 0.001)
    });
    store.updateComponent('camera', {
      fps: 29.8 + Math.random() * 0.4
    });
    store.updateComponent('power', {
      voltage: voltageV,
      current: currentA,
      powerDraw: voltageV * currentA,
      soc: soc
    });

    // 6. Record Telemetry sample (at ~10 Hz)
    const simTimestamp = Date.now() / 1000;
    store.appendTelemetryPoint({
      timestamp: simTimestamp,
      speedActual: speed,
      speedTarget: targetSpeed,
      steerActual: steerDeg,
      steerTarget: targetSteerDeg,
      encLeft: encLeft,
      encRight: encRight,
      imuYawRate: yawRateDeg,
      powerCurrent: currentA,
      powerVoltage: voltageV
    });

    // Check subsystem health
    store.checkFreshness();
  }

  findActiveWaypointIndex(x, y) {
    let minDist = Infinity;
    let closestIdx = 0;
    for (let i = 0; i < this.waypoints.length; i++) {
      const d = Math.hypot(this.waypoints[i].x - x, this.waypoints[i].y - y);
      if (d < minDist) {
        minDist = d;
        closestIdx = i;
      }
    }
    // Target is next waypoint along track
    return (closestIdx + 1) % this.waypoints.length;
  }

  findDistToNextWaypoint(x, y) {
    const nextIdx = this.findActiveWaypointIndex(x, y);
    const wp = this.waypoints[nextIdx];
    return Math.hypot(wp.x - x, wp.y - y);
  }

  generateLidarScan(vx, vy, vyaw) {
    // 360 rays @ 1 degree step (RPLIDAR A1M8 10Hz)
    const points = [];
    const obstacles = [];
    const halfWidth = this.trackWidth / 2;

    // Check obstacles within 15 meters
    for (const obs of this.worldObstacles) {
      const dx = obs.x - vx;
      const dy = obs.y - vy;
      const dist = Math.hypot(dx, dy);
      if (dist < 14.0) {
        // Transform to vehicle frame (X forward, Y left)
        const angle = Math.atan2(dy, dx) - vyaw;
        const localX = dist * Math.cos(angle);
        const localY = dist * Math.sin(angle);
        obstacles.push({
          type: obs.type,
          x: localX,
          y: localY,
          radius: obs.radius,
          dist: dist
        });
      }
    }
    store.lidarObstacles = obstacles;

    // Raycast track bounds and obstacles
    for (let deg = 0; deg < 360; deg += 2) { // 180 points for high 60fps rendering efficiency
      const angleRad = (deg * Math.PI) / 180; // in vehicle frame (0 = forward, PI/2 = left)
      const worldBeamAngle = vyaw + angleRad;

      // Approximate intersection with track curb boundaries (left and right at ~halfWidth)
      let minRange = 10.0; // default max detection range

      // Side wall intersection approximation
      const cosA = Math.cos(angleRad);
      const sinA = Math.sin(angleRad);
      if (Math.abs(sinA) > 0.05) {
        const sideRange = Math.abs(halfWidth / sinA);
        if (sideRange > 0.4 && sideRange < minRange) {
          minRange = sideRange;
        }
      }

      // Intersect with nearby world obstacles
      for (const obs of obstacles) {
        const obsAngle = Math.atan2(obs.y, obs.x);
        let dAngle = Math.abs(angleRad - obsAngle);
        while (dAngle > Math.PI) dAngle = Math.abs(dAngle - 2 * Math.PI);
        if (dAngle < 0.12 && obs.dist < minRange) {
          minRange = obs.dist;
        }
      }

      // Add realistic measurement noise (±1.5 cm)
      const range = Math.max(0.2, minRange + (Math.random() - 0.5) * 0.04);
      const px = range * Math.cos(angleRad);
      const py = range * Math.sin(angleRad);
      const intensity = Math.min(255, Math.floor(180 - range * 10 + Math.random() * 20));

      points.push({ x: px, y: py, range, angle: angleRad, intensity });
    }

    store.lidarPoints = points;
  }

  generatePerceptionDetections(vx, vy, vyaw) {
    // Camera FoV ~60° forward
    const detections = [];
    for (const obs of store.lidarObstacles) {
      if (obs.x > 0.8 && obs.x < 16.0 && Math.abs(obs.y) < obs.x * 0.6) {
        // Project to 640x480 camera frame
        const screenX = 320 - (obs.y / obs.x) * 360;
        const screenY = 240 + (1.2 / obs.x) * 160;
        const boxH = Math.max(20, Math.min(140, (1.2 / obs.x) * 180));
        const boxW = boxH * (obs.type === 'STOP_SIGN' ? 1.0 : 0.6);

        if (screenX > 20 && screenX < 620 && screenY > 50 && screenY < 450) {
          detections.push({
            id: obs.type + '_' + Math.round(obs.dist),
            type: obs.type,
            x: screenX - boxW / 2,
            y: screenY - boxH,
            w: boxW,
            h: boxH,
            conf: 0.88 + Math.random() * 0.09,
            dist: obs.dist
          });
        }
      }
    }
    store.perceptionDetections = detections;
  }
}

export const demoProvider = new DemoProvider();
