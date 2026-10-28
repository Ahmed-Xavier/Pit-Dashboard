/* ==========================================================================
   ENIMIA Dashboard — Coordinated Kinematic Demo Provider
   Drives along the Silesia Ring centerline extracted from silesia_ring.sdf.
   Uses C1-continuous Catmull-Rom spline interpolation for silky-smooth motion,
   continuous tangent heading, rate-limited steering, and smooth acceleration.
   ========================================================================== */

import { store } from './state.js';
import { config } from '/config.js';

export class DemoProvider {
  constructor() {
    this.timer = null;
    this.running = false;
    this.lastTime = performance.now();

    // Demo physics parameters (tunable from config)
    const demoCfg = config.demo || {};
    this.speedMps   = demoCfg.speedMps    ?? 4.5;     // max speed m/s
    this.aLatMax    = demoCfg.aLatMax     ?? 6.0;     // max lateral accel m/s²
    this.noiseOn    = demoCfg.noise       ?? false;   // lateral noise
    this.noiseAmp   = demoCfg.noiseAmp    ?? 0.04;    // noise amplitude m

    this.wheelbase  = 1.25;   // m
    this.trackGauge = 0.68;   // m
    this.wheelRadius = 0.24;  // m

    // Smooth state variables
    this.currentSpeed   = this.speedMps;
    this.actualSteerRad = 0;

    // Arc-length state
    this.s = 0;             // current arc-length position along centerline
    this.lap = 1;

    // Working copy of centerline (refreshed when store.trackCenterline changes)
    this.totalLength = 0;

    this.historyInitialized = false;
  }

  /** Return true when the centerline is available */
  get worldReady() {
    return Array.isArray(store.trackCenterline) && store.trackCenterline.length > 3;
  }

  /**
   * Sample centerline at arc-length s using Catmull-Rom cubic spline interpolation.
   * Guarantees C1 continuity for (x, y), velocity tangent, heading, and curvature.
   * Returns {x, y, yaw, curvature, trackWidth, s}.
   */
  sampleCenterline(s) {
    const cl = store.trackCenterline;
    if (!cl || cl.length === 0) return { x: 0, y: 0, yaw: 0, curvature: 0, trackWidth: 3.16, s: 0 };

    const n = cl.length;
    const spacing = config.world?.centerlineSpacing ?? 0.5;
    const len = this.totalLength || (n * spacing);
    const sWrap = ((s % len) + len) % len;

    // Continuous floating-point index along the regularly spaced centerline
    const fIdx = sWrap / spacing;
    const i1 = Math.floor(fIdx) % n;
    const i0 = (i1 - 1 + n) % n;
    const i2 = (i1 + 1) % n;
    const i3 = (i1 + 2) % n;
    const t = Math.max(0, Math.min(1, fIdx - Math.floor(fIdx)));

    const p0 = cl[i0], p1 = cl[i1], p2 = cl[i2], p3 = cl[i3];

    // Catmull-Rom cubic basis functions:
    // P(t) = 0.5 * ( (2*p1) + (-p0 + p2)*t + (2*p0 - 5*p1 + 4*p2 - p3)*t^2 + (-p0 + 3*p1 - 3*p2 + p3)*t^3 )
    const t2 = t * t;
    const t3 = t2 * t;

    const c0x = 2 * p1.x;
    const c1x = -p0.x + p2.x;
    const c2x = 2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x;
    const c3x = -p0.x + 3 * p1.x - 3 * p2.x + p3.x;

    const c0y = 2 * p1.y;
    const c1y = -p0.y + p2.y;
    const c2y = 2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y;
    const c3y = -p0.y + 3 * p1.y - 3 * p2.y + p3.y;

    const x = 0.5 * (c0x + c1x * t + c2x * t2 + c3x * t3);
    const y = 0.5 * (c0y + c1y * t + c2y * t2 + c3y * t3);

    // Continuous analytical tangent vector: dP/dt
    const dx = 0.5 * (c1x + 2 * c2x * t + 3 * c3x * t2);
    const dy = 0.5 * (c1y + 2 * c2y * t + 3 * c3y * t2);

    const yaw = Math.atan2(dy, dx);

    // Second derivative d2P/dt2 for continuous curvature
    const ddx = 0.5 * (2 * c2x + 6 * c3x * t);
    const ddy = 0.5 * (2 * c2y + 6 * c3y * t);
    const speedSq = dx * dx + dy * dy;
    const curvature = speedSq > 0.0001
      ? (dx * ddy - dy * ddx) / Math.pow(speedSq, 1.5)
      : (p1.curvature || 0);

    return {
      x,
      y,
      yaw,
      curvature,
      trackWidth: p1.trackWidth ?? 3.16,
      s: sWrap
    };
  }

  /** Compute total arc length from centerline */
  computeTotalLength(cl) {
    if (!cl || cl.length < 2) return 0;
    const last = cl[cl.length - 1];
    const spacing = config.world?.centerlineSpacing ?? 0.5;
    return (last.s != null ? last.s : (cl.length - 1) * spacing) + spacing;
  }

  start() {
    if (this.running) return;
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
    const dt = Math.min((now - this.lastTime) / 1000, 0.05); // cap at 50ms to prevent jumps
    this.lastTime = now;

    if (store.mode === 'demo') {
      this.step(dt);
    }

    this.timer = requestAnimationFrame(this.loop);
  };

  step(dt) {
    // ── Wait for world ──
    if (!this.worldReady) {
      store.vehicle = Object.assign({}, store.vehicle, {
        vx: 0, targetVx: 0
      });
      store.worldNotLoaded = true;
      store.notify();
      return;
    }
    store.worldNotLoaded = false;

    // Refresh centerline reference + total length
    this.totalLength = this.computeTotalLength(store.trackCenterline);

    // Initialise telemetry history once
    if (!this.historyInitialized) {
      this._initTelemetryHistory();
      this.historyInitialized = true;
      this._publishWaypoints();
    }

    // ── Curvature-aware smooth acceleration/braking ──
    const pt = this.sampleCenterline(this.s);
    const kappa = Math.abs(pt.curvature);
    const vMax = this.speedMps;
    // v_target = min(vMax, sqrt(aLat_max / kappa)), clamped to reasonable minimum
    const targetSpeed = kappa > 0.001
      ? Math.max(2.4, Math.min(vMax, Math.sqrt(this.aLatMax / kappa)))
      : vMax;

    // Smooth speed change: realistic acceleration (2.5 m/s²) and braking (4.2 m/s²)
    const accelMax = 2.5 * dt;
    const decelMax = 4.2 * dt;
    if (targetSpeed > this.currentSpeed) {
      this.currentSpeed = Math.min(targetSpeed, this.currentSpeed + accelMax);
    } else {
      this.currentSpeed = Math.max(targetSpeed, this.currentSpeed - decelMax);
    }
    const speed = this.currentSpeed;

    // Advance arc-length
    this.s += speed * dt;
    if (this.s >= this.totalLength) {
      this.s -= this.totalLength;
      this.lap++;
    }

    const lapProgress = this.totalLength > 0 ? this.s / this.totalLength : 0;

    // ── Position & heading from spline ──
    const pt2 = this.sampleCenterline(this.s);
    let posX = pt2.x;
    let posY = pt2.y;
    const yaw = pt2.yaw;

    // Optional subtle lateral perturbation
    if (this.noiseOn) {
      const perpHeading = yaw + Math.PI / 2;
      const noise = this.noiseAmp * Math.sin(this.s * 0.7);
      posX += Math.cos(perpHeading) * noise;
      posY += Math.sin(perpHeading) * noise;
    }

    // ── Steering & dynamics with rate limiting ──
    const kappaSigned = pt2.curvature; // positive = left turn
    const targetSteerRad = Math.max(-0.45, Math.min(0.45, Math.atan(this.wheelbase * kappaSigned)));

    // Slew rate limit on steering (2.8 rad/s max steering rate)
    const maxSteerDelta = 2.8 * dt;
    const steerDiff = targetSteerRad - this.actualSteerRad;
    this.actualSteerRad += Math.max(-maxSteerDelta, Math.min(maxSteerDelta, steerDiff));
    const actualSteerRad = this.actualSteerRad;

    const steerDeg = (actualSteerRad * 180) / Math.PI;
    const targetSteerDeg = (targetSteerRad * 180) / Math.PI;

    const yawRateRad = (speed / this.wheelbase) * Math.tan(actualSteerRad);
    const lateralAcc = speed * yawRateRad;

    const vLeft  = speed - (yawRateRad * this.trackGauge) / 2;
    const vRight = speed + (yawRateRad * this.trackGauge) / 2;
    const encLeft  = vLeft  / this.wheelRadius;
    const encRight = vRight / this.wheelRadius;

    // ── Power model ──
    const currentA = 2.2 + 0.35 * speed + 0.8 * Math.abs(lateralAcc) + 0.1 * Math.sin(Date.now() * 0.005);
    const voltageV = 26.45 - currentA * 0.045 - (this.s / 50000);
    const soc = Math.max(10, 88.4 - (this.s / 500));

    // ── Waypoint tracking ──
    const wps = store.trackWaypoints || [];
    const activeWpIdx = this._findActiveWpIndex(posX, posY, wps);
    const distToNextWp = activeWpIdx >= 0 ? Math.hypot(wps[activeWpIdx].x - posX, wps[activeWpIdx].y - posY) : 0;

    // Cross-track error vs centerline
    const crossTrackError = kappa > 0.001 ? this.noiseAmp * Math.sin(this.s * 0.7) : 0;

    // Quaternion for exact Z-up rotation
    const halfYaw = yaw / 2;
    const quat = {
      x: 0,
      y: 0,
      z: Math.sin(halfYaw),
      w: Math.cos(halfYaw)
    };

    // ── Publish to store ──
    store.vehicle = {
      x: posX,
      y: posY,
      z: 0.003, // sit cleanly on top of Silesia Ring asphalt surface
      yaw: yaw,
      orientation: quat,
      vx: speed,
      targetVx: this.speedMps,
      steering: actualSteerRad,
      targetSteering: targetSteerRad,
      yawRate: yawRateRad,
      accelY: lateralAcc,
      encLeft: encLeft,
      encRight: encRight,
      motorCurrent: currentA,
      crossTrackError: crossTrackError,
      headingError: 0,
      lapProgress: lapProgress,
      currentLap: this.lap,
      activeWaypointIndex: activeWpIdx,
      distToNextWp: distToNextWp
    };

    // Odometry history ring
    store.odomHistory.push({ x: posX, y: posY, yaw });
    if (store.odomHistory.length > store.maxOdomHistory) store.odomHistory.shift();

    // Planned path lookahead (35 steps at spacing)
    const planned = [];
    for (let k = 0; k <= 35; k++) {
      const pp = this.sampleCenterline(this.s + k * (config.world?.centerlineSpacing ?? 0.5));
      planned.push({ x: pp.x, y: pp.y });
    }
    store.plannedPath = planned;

    // LiDAR scan simulation
    this._generateLidarScan(posX, posY, yaw, pt2.trackWidth);

    // Component diagnostics
    store.updateComponent('pi5', {
      cpu: 26.0 + 4.0 * Math.sin(Date.now() * 0.001) + Math.random() * 2.0,
      temp: 48.0 + 1.2 * Math.sin(Date.now() * 0.0002)
    });
    store.updateComponent('esp32', { rtt: 3.5 + 0.6 * Math.random(), jitter: 0.5 + 0.3 * Math.random() });
    store.updateComponent('rplidar', { rpm: 602 + Math.floor(Math.random() * 6) });
    store.updateComponent('gps', {
      lat: 50.3568 + posY * 0.0000089,
      lon: 18.4027 + posX * 0.0000124
    });
    store.updateComponent('imu', {
      yawRate: (yawRateRad * 180) / Math.PI,
      lateralAcc: lateralAcc,
      temp: 34.0 + 0.4 * Math.sin(Date.now() * 0.001)
    });
    store.updateComponent('camera', { fps: 29.8 + Math.random() * 0.4 });
    store.updateComponent('power', {
      voltage: voltageV,
      current: currentA,
      powerDraw: voltageV * currentA,
      soc: soc
    });

    // Telemetry point
    store.appendTelemetryPoint({
      timestamp: Date.now() / 1000,
      speedActual: speed,
      speedTarget: this.speedMps,
      steerActual: steerDeg,
      steerTarget: targetSteerDeg,
      encLeft: encLeft,
      encRight: encRight,
      imuYawRate: (yawRateRad * 180) / Math.PI,
      powerCurrent: currentA,
      powerVoltage: voltageV
    });

    store.checkFreshness();
  }

  _findActiveWpIndex(x, y, wps) {
    if (!wps || wps.length === 0) return -1;
    let minDist = Infinity, closest = 0;
    for (let i = 0; i < wps.length; i++) {
      const d = Math.hypot(wps[i].x - x, wps[i].y - y);
      if (d < minDist) { minDist = d; closest = i; }
    }
    return (closest + 1) % wps.length;
  }

  /** Place waypoints evenly along centerline (every ~50m) */
  _publishWaypoints() {
    const cl = store.trackCenterline;
    if (!cl || cl.length < 2) return;
    const spacing = 50; // meters between waypoints
    const wps = [];
    let nextS = 0;
    for (let i = 0; i < cl.length; i++) {
      if (cl[i].s >= nextS) {
        wps.push({
          index: wps.length + 1,
          id: `WP${String(wps.length + 1).padStart(2, '0')}`,
          x: cl[i].x,
          y: cl[i].y,
          name: `Lap Point ${wps.length + 1}`
        });
        nextS += spacing;
      }
    }
    store.trackWaypoints = wps;
  }

  _initTelemetryHistory() {
    const now = Date.now();
    for (let i = 60; i >= 0; i--) {
      const t = (now - i * 500) / 1000;
      store.appendTelemetryPoint({
        timestamp: t,
        speedActual: 4.1 + Math.sin(i * 0.2) * 0.3,
        speedTarget: this.speedMps,
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

  _generateLidarScan(vx, vy, vyaw, trackWidth) {
    const halfWidth = (trackWidth ?? 3.16) / 2;
    const points = [];

    for (let deg = 0; deg < 360; deg += 2) {
      const angleRad = (deg * Math.PI) / 180;
      let minRange = 10.0;

      const cosA = Math.cos(angleRad);
      const sinA = Math.sin(angleRad);
      if (Math.abs(sinA) > 0.05) {
        const sideRange = Math.abs(halfWidth / sinA);
        if (sideRange > 0.4 && sideRange < minRange) minRange = sideRange;
      }

      const range = Math.max(0.2, minRange + (Math.random() - 0.5) * 0.04);
      points.push({
        x: range * cosA,
        y: range * sinA,
        range,
        angle: angleRad,
        intensity: Math.min(255, Math.floor(180 - range * 10 + Math.random() * 20))
      });
    }
    store.lidarPoints = points;
    store.lidarObstacles = [];
  }
}

export const demoProvider = new DemoProvider();
