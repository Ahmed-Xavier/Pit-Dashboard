import { config } from '/config.js';
import { debugInstrumentation } from './debugInstrumentation.js';

class StateStore {
  constructor() {
    this.listeners = new Set();
    this.notifyIntervalMs = 1000 / (config.ui?.updateHz || 10);
    this.drainCallback = null;
    this.uiTickTimer = null;

    this.dirtyPanels = {
      pipeline: true,
      health: true,
      header: true,
      telemetry: true,
      waypoints: true,
      eventLog: true,
      camera: true
    };

    this.startUiTick();

    // Mode: 'demo' or 'live'
    this.mode = 'demo';

    // Test session info
    this.session = {
      id: 'SEM26-DYN-T04',
      track: 'CIRCUIT DE VALENCE - STAND 03',
      startTime: Date.now() - 142000, // 2m 22s ago
    };

    // Live ROS Connection state
    this.connection = {
      status: 'DISCONNECTED', // 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'FAULT'
      endpoint: new URLSearchParams(window.location.search).get('bridge') || 'ws://127.0.0.1:8765',
      bridgeType: 'foxglove', // 'foxglove' | 'rosbridge'
      protocol: '',
      rtt: 0,
      msgRate: 0,
      totalPackets: 0,
      droppedPackets: 0,
      lastPacketTime: 0,
      errorMsg: null
    };

    // Subsystem hardware diagnostics
    this.components = {
      pi5: {
        id: 'pi5',
        name: 'Raspberry Pi 5',
        subsystem: 'COMPUTE',
        topic: '/diagnostics/pi5',
        status: 'nominal', // 'nominal' | 'stale' | 'fault' | 'disconnected'
        rate: 10.0,
        lastMsgTime: Date.now(),
        cpu: 28.4,
        mem: '1.9 / 8.0 GB (24%)',
        temp: 48.5,
        throttle: 'None (OK)',
        os: 'Ubuntu 24.04 (ROS 2 Jazzy)'
      },
      esp32: {
        id: 'esp32',
        name: 'ESP32 micro-ROS',
        subsystem: 'LOW-LEVEL MCU',
        topic: '/esp32/status',
        status: 'nominal',
        rate: 50.0,
        lastMsgTime: Date.now(),
        heap: '184.2 KB free',
        rtt: 3.8,
        jitter: 0.6,
        baud: '921600 bps UART'
      },
      rplidar: {
        id: 'rplidar',
        name: 'RPLIDAR A1M8',
        subsystem: 'LIDAR',
        topic: '/scan',
        status: 'nominal',
        rate: 10.2,
        lastMsgTime: Date.now(),
        rpm: 604,
        samples: 360,
        rangeMin: '0.15 m',
        rangeMax: '12.00 m',
        health: 'Standard (Good)'
      },
      gps: {
        id: 'gps',
        name: 'u-blox GNSS',
        subsystem: 'NAVIGATION',
        topic: '/fix',
        status: 'nominal',
        rate: 5.0,
        lastMsgTime: Date.now(),
        fixType: 'RTK Float / 3D',
        sats: 14,
        hdop: 0.82,
        lat: 44.931245,
        lon: 4.896512,
        alt: '128.4 m'
      },
      imu: {
        id: 'imu',
        name: 'BNO085 9-DOF IMU',
        subsystem: 'INERTIAL',
        topic: '/esp32/imu',
        status: 'nominal',
        rate: 50.0,
        lastMsgTime: Date.now(),
        calib: 'G:3 A:3 M:2 (Full)',
        temp: 34.2,
        yawRate: 0.0,
        lateralAcc: 0.0
      },
      camera: {
        id: 'camera',
        name: 'Sony IMX219 CSI',
        subsystem: 'VISION',
        topic: '/camera/image_raw',
        status: 'nominal',
        rate: 30.0,
        lastMsgTime: Date.now(),
        res: '640 × 480',
        fps: 30.1,
        latency: 22.4,
        exposure: 'Auto (1/120s)'
      },
      power: {
        id: 'power',
        name: 'LiFePO4 Traction Pack',
        subsystem: 'POWER',
        topic: '/power/battery',
        status: 'nominal',
        rate: 10.0,
        lastMsgTime: Date.now(),
        voltage: 26.42,
        current: 4.18,
        soc: 88.4,
        temp: 26.8,
        powerDraw: 110.4,
        rail12v: '12.04 V',
        rail5v: '5.06 V'
      }
    };

    // Autonomy Pipeline Diagnostic States
    this.pipeline = {
      localization: {
        name: 'Localization',
        stage: 1,
        status: 'nominal',
        hz: 50.0,
        latencyMs: 3.2,
        diagnostic: 'EKF Fused (Cov: 0.012 m²)'
      },
      perception: {
        name: 'Perception',
        stage: 2,
        status: 'nominal',
        hz: 20.0,
        latencyMs: 16.8,
        diagnostic: 'LiDAR Cluster + Vision (2 Obj)'
      },
      planning: {
        name: 'Planning',
        stage: 3,
        status: 'nominal',
        hz: 10.0,
        latencyMs: 11.4,
        diagnostic: 'Nav2 TEB (2.4s horizon valid)'
      },
      control: {
        name: 'Control',
        stage: 4,
        status: 'nominal',
        hz: 50.0,
        latencyMs: 1.8,
        diagnostic: 'Ackermann Pursuit -> ESP32'
      }
    };

    // Vehicle kinematic and localization state (REP-103 convention)
    this.vehicle = {
      x: 0,
      y: 0,
      yaw: 0, // radians
      vx: 4.2, // m/s
      targetVx: 4.5,
      steering: 0.0, // radians
      targetSteering: 0.0,
      yawRate: 0.0, // rad/s
      accelY: 0.0,
      encLeft: 34.1, // rad/s
      encRight: 34.5,
      motorCurrent: 4.2,
      crossTrackError: 0.04, // meters
      headingError: -0.8, // degrees
      lapProgress: 0.28, // 0 to 1
      currentLap: 2,
      activeWaypointIndex: 3,
      distToNextWp: 14.6 // meters
    };

    // Odometry historical path buffer
    this.odomHistory = [];
    this.maxOdomHistory = 200;

    // Planned path waypoints
    this.plannedPath = [];

    // Track definition waypoints
    this.trackWaypoints = [];
    this.trackWaypointLine = [];
    this.robotDescription = null;
    this.trackCenterline = [];
    this.hasGlobalOdom = false;

    // Current LiDAR scan points (relative to vehicle: [{x, y, range, angle, intensity}])
    this.lidarPoints = [];
    this.cameraFrame = null;
    this.lidarObstacles = [];

    // Camera perception detections
    this.perceptionDetections = [
      { id: 1, type: 'TRAFFIC_CONE', x: 260, y: 310, w: 34, h: 56, conf: 0.92, dist: 5.4 },
      { id: 2, type: 'STOP_SIGN', x: 420, y: 160, w: 42, h: 42, conf: 0.96, dist: 12.8 }
    ];
    this.lanePolynomials = {
      left: { detected: true, conf: 0.94 },
      right: { detected: true, conf: 0.95 }
    };

    // Telemetry time-series circular buffers (time in seconds)
    this.maxTelemetryPoints = 300;
    this.telemetry = {
      timestamps: [],
      speedActual: [],
      speedTarget: [],
      steerActual: [],
      steerTarget: [],
      encLeft: [],
      encRight: [],
      imuYawRate: [],
      powerCurrent: [],
      powerVoltage: []
    };

    // Chronological event log
    this.events = [
      {
        id: 'evt-01',
        time: Date.now() - 124000,
        timeStr: this.formatTime(Date.now() - 124000),
        source: 'ROS2_HOST',
        severity: 'info',
        message: 'ROS 2 Jazzy core stack initialized on Raspberry Pi 5. Master discovery OK.'
      },
      {
        id: 'evt-02',
        time: Date.now() - 118000,
        timeStr: this.formatTime(Date.now() - 118000),
        source: 'MICRO_ROS',
        severity: 'info',
        message: 'ESP32 micro-ROS agent connected via /dev/ttyAMA0 @ 921600. Jitter < 1.0ms.'
      },
      {
        id: 'evt-03',
        time: Date.now() - 95000,
        timeStr: this.formatTime(Date.now() - 95000),
        source: 'GNSS',
        severity: 'info',
        message: 'u-blox GNSS achieved RTK Float fix (14 SVs, HDOP 0.82).'
      },
      {
        id: 'evt-04',
        time: Date.now() - 72000,
        timeStr: this.formatTime(Date.now() - 72000),
        source: 'AUTONOMY',
        severity: 'info',
        message: 'Mission Start: Autonomous trajectory tracking engaged for Session SEM26-DYN-T04.'
      },
      {
        id: 'evt-05',
        time: Date.now() - 34000,
        timeStr: this.formatTime(Date.now() - 34000),
        source: 'PERCEPTION',
        severity: 'info',
        message: 'YOLOv8-tiny detected STOP_SIGN ahead (conf: 0.96, range: 14.2m).'
      }
    ];

    // User visualization settings
    this.settings = {
      zoom: 1.0,
      centerOnVehicle: true,
      showLidar: true,
      showPath: true,
      showOdom: true,
      showObstacles: true,
      showWaypoints: true,
      showGrid: true,
      showRangeRings: true,
      cameraOverlays: true,
      chartTimeWindow: 30 // seconds
    };
  }

  formatTime(ms) {
    const d = new Date(ms);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerDrainCallback(fn) {
    this.drainCallback = fn;
  }

  startUiTick() {
    if (this.uiTickTimer) return;
    this.uiTickTimer = setInterval(() => this.uiTick(), this.notifyIntervalMs);
  }

  stopUiTick() {
    if (this.uiTickTimer) {
      clearInterval(this.uiTickTimer);
      this.uiTickTimer = null;
    }
  }

  uiTick() {
    const tickStartedAt = performance.now();
    if (this.drainCallback && this.mode === 'live') {
      this.drainCallback();
    }
    this.checkFreshness();

    // Check if any panel has pending changes
    const hasDirty = Object.values(this.dirtyPanels).some(v => v);
    if (!hasDirty && this.mode === 'live') {
      debugInstrumentation.recordUiTick(performance.now() - tickStartedAt);
      return;
    }

    const t0 = performance.now();
    for (const listener of this.listeners) {
      try {
        listener(this, this.dirtyPanels);
      } catch (err) {
        console.error('Dashboard state listener failed:', err);
      }
    }
    const elapsed = performance.now() - t0;
    debugInstrumentation.recordUiTick(performance.now() - tickStartedAt);
    if (elapsed > 100) {
      debugInstrumentation.logLongFrame('UI_TICK_LISTENERS', elapsed);
    }

    // Reset dirty flags
    for (const key of Object.keys(this.dirtyPanels)) {
      this.dirtyPanels[key] = false;
    }
  }

  notify(panelKey) {
    if (panelKey) {
      this.dirtyPanels[panelKey] = true;
    } else {
      for (const k of Object.keys(this.dirtyPanels)) {
        this.dirtyPanels[k] = true;
      }
    }
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'live') {
      this.resetLiveData();
      this.session = { id: 'LIVE ROS 2', track: 'ADC COURSE', startTime: Date.now() };
    }
    this.addEvent({
      source: 'SYSTEM',
      severity: mode === 'live' ? 'info' : 'warn',
      message: mode === 'live'
        ? 'Switched to LIVE mode: Listening to ROS 2 bridge topics. Zero mock data injected.'
        : 'Switched to DEMO mode: Coordinated simulation dynamics active for stand evaluation.'
    });
    this.notify();
  }

  resetLiveData() {
    this.vehicle = {
      x: 0, y: 0, yaw: 0, vx: 0, targetVx: null, steering: 0, targetSteering: null,
      yawRate: 0, accelY: 0, encLeft: null, encRight: null, motorCurrent: null,
      crossTrackError: null, headingError: null, lapProgress: null, currentLap: null,
      activeWaypointIndex: null, distToNextWp: null
    };
    this.odomHistory = [];
    this.plannedPath = [];
    this.trackWaypoints = [];
    this.trackWaypointLine = [];
    this.trackCenterline = [];
    this.hasGlobalOdom = false;
    this.trackProgressReceived = false;
    this.guidance = null;
    this.lidarPoints = [];
    this.cameraFrame = null;
    this.lidarObstacles = [];
    this.perceptionDetections = [];
    this.lanePolynomials = { left: { detected: false }, right: { detected: false } };
    for (const values of Object.values(this.telemetry)) values.length = 0;
    this.events = [];
    this.pipeline = {
      localization: { name: 'Localization', stage: 1, status: 'fault', hz: 0, latencyMs: 0, diagnostic: 'Waiting for /odometry/global' },
      perception: { name: 'Perception', stage: 2, status: 'fault', hz: 0, latencyMs: 0, diagnostic: 'Waiting for /scan' },
      planning: { name: 'Planning', stage: 3, status: 'fault', hz: 0, latencyMs: 0, diagnostic: 'Waiting for planner status' },
      control: { name: 'Control', stage: 4, status: 'fault', hz: 0, latencyMs: 0, diagnostic: 'Waiting for /esp32 commands' }
    };
    this.systemHealth = 'DEGRADED';
    const reset = (id, topic, name) => {
      const component = this.components[id];
      Object.assign(component, { name, topic, status: 'disconnected', rate: 0, lastMsgTime: 0, messages: 0 });
    };
    reset('pi5', '/odometry/global', 'Global EKF odometry');
    reset('esp32', '/esp32/encoder', 'ESP32 encoder');
    reset('rplidar', '/scan', 'LiDAR');
    reset('gps', '/fix', 'GNSS fix');
    reset('imu', '/imu/data', 'IMU');
    reset('camera', '/camera/image_raw', 'Camera');
    reset('power', '/power/battery', 'Battery telemetry');
    this.components.rplidar.samples = null;
    this.components.rplidar.rangeMin = '';
    this.components.rplidar.rangeMax = '';
    this.components.gps.fixType = '';
    this.components.esp32.encoderTicks = null;
    this.connection.totalPackets = 0;
  }

  addEvent(sourceOrObj, severity, message) {
    const now = Date.now();
    let src, sev, msg;
    if (sourceOrObj && typeof sourceOrObj === 'object') {
      // Object-form: addEvent({ source, severity, message })
      src = sourceOrObj.source || 'SYSTEM';
      sev = sourceOrObj.severity || 'info';
      msg = String(sourceOrObj.message ?? '');
    } else {
      // Positional-form: addEvent(source, severity, message)
      src = String(sourceOrObj || 'SYSTEM');
      sev = severity || 'info';
      msg = String(message ?? '');
    }
    this.events.unshift({
      id: `evt-${now}-${Math.random().toString(36).substr(2, 4)}`,
      time: now,
      timeStr: this.formatTime(now),
      source: src,
      severity: sev,
      message: msg
    });
    if (this.events.length > 100) this.events.pop();
    this.notify();
  }

  appendTelemetryPoint({ timestamp, speedActual, speedTarget, steerActual, steerTarget, encLeft, encRight, imuYawRate, powerCurrent, powerVoltage }) {
    const t = this.telemetry;
    t.timestamps.push(timestamp);
    t.speedActual.push(speedActual);
    t.speedTarget.push(speedTarget);
    t.steerActual.push(steerActual);
    t.steerTarget.push(steerTarget);
    t.encLeft.push(encLeft);
    t.encRight.push(encRight);
    t.imuYawRate.push(imuYawRate);
    t.powerCurrent.push(powerCurrent);
    t.powerVoltage.push(powerVoltage);

    if (t.timestamps.length > this.maxTelemetryPoints) {
      t.timestamps.shift();
      t.speedActual.shift();
      t.speedTarget.shift();
      t.steerActual.shift();
      t.steerTarget.shift();
      t.encLeft.shift();
      t.encRight.shift();
      t.imuYawRate.shift();
      t.powerCurrent.shift();
      t.powerVoltage.shift();
    }
  }

  updateComponent(id, partial) {
    if (this.components[id]) {
      Object.assign(this.components[id], partial);
      this.components[id].lastMsgTime = Date.now();
      this.components[id].messages = (this.components[id].messages || 0) + 1;
    }
  }

  checkFreshness() {
    const now = Date.now();
    let hasFault = false;
    let hasDegraded = false;

    for (const key of Object.keys(this.components)) {
      const comp = this.components[key];
      const ageMs = now - comp.lastMsgTime;
      const expectedIntervalMs = 1000 / (comp.rate || 10);

      if (this.mode === 'live' && this.connection.status !== 'CONNECTED') {
        comp.status = 'disconnected';
        hasDegraded = true;
        continue;
      }

      if (!comp.lastMsgTime) {
        comp.status = this.mode === 'live' ? 'disconnected' : 'fault';
        hasDegraded = true;
      } else if (ageMs > expectedIntervalMs * 10) {
        comp.status = 'fault';
        hasFault = true;
      } else if (ageMs > expectedIntervalMs * 3) {
        comp.status = 'stale';
        hasDegraded = true;
      } else {
        comp.status = 'nominal';
      }
    }

    if (hasFault) {
      this.systemHealth = 'FAULT';
    } else if (hasDegraded) {
      this.systemHealth = 'DEGRADED';
    } else {
      this.systemHealth = 'NOMINAL';
    }
  }

  addFault(source, message) {
    this.addEvent(source, 'warn', message);
  }
}

export const store = new StateStore();
