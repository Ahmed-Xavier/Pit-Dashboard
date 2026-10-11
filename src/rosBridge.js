/* ==========================================================================
   ENIMIA Dashboard — ROS 2 Live Bridge Client
   Supports both Foxglove WebSocket protocol and ROSBridge v2.0 protocol
   Subscribes to actual vehicle topics from ROS 2 Jazzy & ESP32 micro-ROS
   ========================================================================== */

import { store } from './state.js';
import { decodeRosMessage } from './cdr.js';

export class RosBridgeClient {
  constructor() {
    this.ws = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastPingTime = 0;
    this.channels = new Map(); // Foxglove channelId -> metadata
    this.subscriptions = new Map(); // topic -> subId
    this.subscriptionChannels = new Map(); // subId -> Foxglove channel
    this.nextSubscriptionId = 1;
    this.topicRates = new Map();
    this.lastJointPositions = null;
    this.services = new Map();
    this.serviceCalls = new Map();
    this.nextServiceCallId = 1;
    this.capabilities = new Set();

    // Target vehicle topics
    this.targetTopics = [
      { topic: '/scan', type: 'sensor_msgs/msg/LaserScan', compId: 'rplidar' },
      { topic: '/fix', type: 'sensor_msgs/msg/NavSatFix', compId: 'gps' },
      { topic: '/wheel/odom', type: 'nav_msgs/msg/Odometry', compId: null },
      { topic: '/odometry/global', type: 'nav_msgs/msg/Odometry', compId: null },
      { topic: '/imu/data', type: 'sensor_msgs/msg/Imu', compId: 'imu' },
      { topic: '/esp32/encoder', type: 'std_msgs/msg/Int32', compId: 'esp32' },
      { topic: '/esp32/motor_cmd', type: 'std_msgs/msg/Int16', compId: null },
      { topic: '/esp32/servo_cmd', type: 'std_msgs/msg/Int16', compId: null },
      { topic: '/joint_states', type: 'sensor_msgs/msg/JointState', compId: null },
      { topic: '/track/progress', type: 'std_msgs/msg/Float32', compId: null },
      { topic: '/waypoints/guidance', type: 'std_msgs/msg/Float32MultiArray', compId: null },
      { topic: '/waypoints/markers', type: 'visualization_msgs/msg/MarkerArray', compId: null },
      { topic: '/planner/markers', type: 'visualization_msgs/msg/MarkerArray', compId: null },
      { topic: '/planner/status', type: 'std_msgs/msg/String', compId: null },
      { topic: '/safety/gate_status', type: 'std_msgs/msg/String', compId: null },
      { topic: '/obstacle_stop', type: 'std_msgs/msg/Bool', compId: null },
      { topic: '/cmd_vel', type: 'geometry_msgs/msg/Twist', compId: null }
    ];
  }

  connect(url = store.connection.endpoint) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    store.connection.endpoint = url;
    store.connection.status = 'CONNECTING';
    store.connection.errorMsg = null;
    store.notify();

    try {
      this.ws = store.connection.bridgeType === 'foxglove'
        ? new WebSocket(url, ['foxglove.websocket.v1', 'foxglove.sdk.v1'])
        : new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = this.handleOpen;
      this.ws.onmessage = this.handleMessage;
      this.ws.onerror = this.handleError;
      this.ws.onclose = this.handleClose;
    } catch (err) {
      this.handleError(err);
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    store.connection.status = 'DISCONNECTED';
    store.notify();
  }

  handleOpen = () => {
    store.connection.status = 'CONNECTED';
    store.connection.errorMsg = null;
    store.addEvent({
      source: 'ROS2_BRIDGE',
      severity: 'info',
      message: `WebSocket bridge transport established with ${store.connection.endpoint} (protocol: ${this.ws?.protocol || 'none'}). Initiating topic subscriptions.`
    });

    if (store.connection.bridgeType === 'rosbridge') {
      this.pingTimer = setInterval(this.measurePing, 2000);
      this.subscribeRosbridge();
    }

    store.notify();
  };

  subscribeRosbridge() {
    for (const item of this.targetTopics) {
      this.sendJson({
        op: 'subscribe',
        topic: item.topic,
        type: item.type
      });
    }
  }

  measurePing = () => {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.lastPingTime = performance.now();
      if (store.connection.bridgeType === 'rosbridge') {
        this.sendJson({ op: 'ping' });
      }
    }
  };

  handleMessage = (event) => {
    store.connection.totalPackets++;
    store.connection.lastPacketTime = Date.now();

    // RTT measurement on pong
    if (this.lastPingTime > 0) {
      store.connection.rtt = Math.round(performance.now() - this.lastPingTime);
      this.lastPingTime = 0;
    }

    try {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        this.processJsonMessage(msg);
      } else if (event.data instanceof ArrayBuffer) {
        this.processBinaryMessage(event.data);
      }
    } catch (err) {
      console.warn('Error parsing incoming bridge message:', err);
    }
  };

  processJsonMessage(msg) {
    if (msg.op === 'serverInfo') {
      this.capabilities = new Set(msg.capabilities || []);
      store.notify();
    } else if (msg.op === 'status' && msg.level >= 1) {
      store.connection.errorMsg = msg.message || 'Foxglove bridge reported an error';
      store.addEvent({ source: 'FOXGLOVE_BRIDGE', severity: msg.level > 1 ? 'fault' : 'warn', message: store.connection.errorMsg });
    } else if (msg.op === 'advertiseServices') {
      for (const service of msg.services || []) this.services.set(service.name, service);
      store.notify();
    } else if (msg.op === 'serviceCallFailure') {
      const pending = this.serviceCalls.get(msg.callId);
      if (pending) {
        this.serviceCalls.delete(msg.callId);
        clearTimeout(pending.timeout);
        pending.reject(new Error(msg.message || 'Service call failed'));
      }
    }
    // 1. ROSBridge Protocol Handling
    if (msg.op === 'publish' && msg.topic) {
      this.routeTopicMessage(msg.topic, msg.msg);
    }
    // 2. Foxglove Protocol Handling
    else if (msg.op === 'advertise') {
      for (const ch of msg.channels || []) {
        this.channels.set(ch.id, ch);
        // Automatically subscribe if matches target topic
        const matched = this.targetTopics.find(t => t.topic === ch.topic);
        if (matched) {
          const subId = this.nextSubscriptionId++;
          this.subscriptions.set(ch.topic, subId);
          this.subscriptionChannels.set(subId, ch);
          this.sendJson({
            op: 'subscribe',
            subscriptions: [{ id: subId, channelId: ch.id }]
          });
        }
      }
    } else if (msg.op === 'message') {
      // Decode foxglove message payload
      const ch = this.channels.get(msg.channelId);
      if (ch) {
        this.routeTopicMessage(ch.topic, msg.data);
      }
    }
  }

  processBinaryMessage(buffer) {
    const view = new DataView(buffer);
    const op = view.getUint8(0);
    if (op === 1) {
      const subscriptionId = view.getUint32(1, true);
      const channel = this.subscriptionChannels.get(subscriptionId);
      if (!channel) return;
      try {
        const data = decodeRosMessage(buffer.slice(13), channel.schemaName || channel.type);
        if (data !== undefined) this.routeTopicMessage(channel.topic, data);
      } catch (err) {
        console.warn(`Could not decode ${channel.topic} (${channel.schemaName || channel.type}):`, err);
      }
      return;
    }
    if (op !== 3) return;
    const serviceId = view.getUint32(1, true);
    const callId = view.getUint32(5, true);
    const encodingLength = view.getUint32(9, true);
    const service = [...this.services.values()].find((item) => item.id === serviceId);
    const pending = this.serviceCalls.get(callId);
    if (!pending) return;
    this.serviceCalls.delete(callId);
    clearTimeout(pending.timeout);
    try {
      if (service?.type !== 'std_srvs/srv/Trigger') throw new Error('Waypoint controls only support std_srvs/srv/Trigger');
      const payloadOffset = 13 + encodingLength;
      const responseView = new DataView(buffer, payloadOffset);
      const messageLength = responseView.getUint32(8, true);
      const messageBytes = new Uint8Array(buffer, payloadOffset + 12, Math.max(0, messageLength - 1));
      const response = {
        success: responseView.getUint8(4) !== 0,
        message: new TextDecoder().decode(messageBytes)
      };
      pending.resolve(response);
    } catch (err) {
      pending.reject(err);
    }
  }

  callTrigger(serviceName) {
    if (store.connection.bridgeType !== 'foxglove') throw new Error('Waypoint buttons require Foxglove WebSocket');
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Bridge is disconnected');
    if (!this.capabilities.has('services')) throw new Error('Bridge does not advertise the services capability');
    const service = this.services.get(serviceName);
    if (!service) throw new Error(`${serviceName} has not been advertised by foxglove_bridge`);

    if (service.type !== 'std_srvs/srv/Trigger') throw new Error(`${serviceName} is not a Trigger service`);
    const request = service.request || {};
    const requestBytes = new Uint8Array([0, 1, 0, 0]);
    const encoding = new TextEncoder().encode(request.encoding || 'cdr');
    const callId = this.nextServiceCallId++;
    const frame = new Uint8Array(13 + encoding.length + requestBytes.length);
    const view = new DataView(frame.buffer);
    view.setUint8(0, 2);
    view.setUint32(1, service.id, true);
    view.setUint32(5, callId, true);
    view.setUint32(9, encoding.length, true);
    frame.set(encoding, 13);
    frame.set(requestBytes, 13 + encoding.length);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.serviceCalls.delete(callId)) reject(new Error(`${serviceName} timed out`));
      }, 6000);
      this.serviceCalls.set(callId, { resolve, reject, timeout });
      this.ws.send(frame);
    });
  }

  routeTopicMessage(topic, data) {
    if (store.mode !== 'live') return;

    const now = Date.now();
    const previous = this.topicRates.get(topic);
    const hz = previous ? 1000 / Math.max(1, now - previous) : 0;
    this.topicRates.set(topic, now);

    if (topic === '/scan' && data.ranges) {
      store.updateComponent('rplidar', { rate: hz, samples: data.ranges.length, rangeMin: `${data.range_min.toFixed(2)} m`, rangeMax: `${data.range_max.toFixed(2)} m` });
      const points = [];
      const angleMin = data.angle_min || 0;
      const angleInc = data.angle_increment || (Math.PI / 180);
      for (let i = 0; i < data.ranges.length; i += 2) {
        const r = data.ranges[i];
        if (r >= (data.range_min || 0.15) && r <= (data.range_max || 12.0)) {
          const a = angleMin + i * angleInc;
          points.push({
            x: r * Math.cos(a),
            y: r * Math.sin(a),
            range: r,
            angle: a,
            intensity: data.intensities ? (data.intensities[i] || 150) : 150
          });
        }
      }
      store.lidarPoints = points;
    }

    else if (topic === '/fix' && data.latitude !== undefined) {
      store.updateComponent('gps', {
        lat: data.latitude,
        lon: data.longitude,
        alt: `${data.altitude.toFixed(1)} m`,
        fixType: data.status?.status >= 0 ? `Fix ${data.status.status}` : 'No fix',
        status: data.status?.status >= 0 ? 'nominal' : 'fault', rate: hz
      });
    }
    else if ((topic === '/odometry/global' || topic === '/wheel/odom') && data.pose?.pose) {
      const pos = data.pose.pose.position;
      const q = data.pose.pose.orientation;
      // Convert quaternion to yaw
      const siny_cosp = 2 * (q.w * q.z + q.x * q.y);
      const cosy_cosp = 1 - 2 * (q.y * q.y + q.z * q.z);
      const yaw = Math.atan2(siny_cosp, cosy_cosp);

      if (topic === '/odometry/global') {
        store.vehicle.x = pos.x;
        store.vehicle.y = pos.y;
        store.vehicle.yaw = yaw;
        store.hasGlobalOdom = true;
        store.odomHistory.push({ x: pos.x, y: pos.y, yaw });
        if (store.odomHistory.length > store.maxOdomHistory) store.odomHistory.shift();
      }
      if (data.twist?.twist?.linear) {
        store.vehicle.vx = data.twist.twist.linear.x;
        if (topic === '/odometry/global') this.appendLiveTelemetry(now);
      }
    }
    else if (topic === '/imu/data' && data.angular_velocity) {
      const yawRateDeg = (data.angular_velocity.z * 180) / Math.PI;
      const latAcc = data.linear_acceleration?.y || 0;
      store.updateComponent('imu', {
        yawRate: yawRateDeg,
        lateralAcc: latAcc, rate: hz
      });
      store.vehicle.yawRate = data.angular_velocity.z;
      store.vehicle.accelY = latAcc;
    }
    else if (topic === '/esp32/encoder') {
      store.updateComponent('esp32', { encoderTicks: data.data, rate: hz });
    }
    else if (topic === '/joint_states') {
      const names = data.name || [], positions = data.position || [];
      const at = (name) => positions[names.indexOf(name)];
      const leftSteer = at('front_left_steer_joint'), rightSteer = at('front_right_steer_joint');
      if (Number.isFinite(leftSteer) && Number.isFinite(rightSteer)) store.vehicle.steering = (leftSteer + rightSteer) / 2;
      const leftWheel = at('rear_left_wheel_joint'), rightWheel = at('rear_right_wheel_joint');
      if (this.lastJointPositions && Number.isFinite(leftWheel) && Number.isFinite(rightWheel)) {
        const dt = (now - this.lastJointPositions.time) / 1000;
        if (dt > 0) {
          const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
          store.vehicle.encLeft = wrapAngle(leftWheel - this.lastJointPositions.left) / dt;
          store.vehicle.encRight = wrapAngle(rightWheel - this.lastJointPositions.right) / dt;
        }
      }
      if (Number.isFinite(leftWheel) && Number.isFinite(rightWheel)) this.lastJointPositions = { left: leftWheel, right: rightWheel, time: now };
    }
    else if (topic === '/esp32/servo_cmd') {
      store.vehicle.targetSteering = (data.data - 48) * Math.PI / 180;
    }
    else if (topic === '/esp32/motor_cmd') {
      store.vehicle.motorCommand = data.data;
    }
    else if (topic === '/track/progress') {
      store.vehicle.lapProgress = data.data;
      store.trackProgressReceived = true;
    }
    else if (topic === '/waypoints/guidance' && data.data?.length >= 4) {
      store.guidance = data.data;
      store.vehicle.distToNextWp = data.data[0];
      store.vehicle.activeWaypointIndex = Math.max(0, Math.floor(data.data[2]));
      store.vehicle.headingError = data.data[1] * 180 / Math.PI;
      store.vehicle.currentLap = null;
    }
    else if (topic === '/waypoints/markers' && data.markers) {
      const markers = data.markers.filter((marker) => marker.action !== 2 && marker.type === 2 && marker.ns === 'waypoints');
      store.trackWaypoints = markers.map((marker, index) => ({
        id: `WP${String(index + 1).padStart(2, '0')}`, name: `Waypoint ${index + 1}`,
        x: marker.pose.position.x, y: marker.pose.position.y
      }));
    }
    else if (topic === '/planner/markers' && data.markers) {
      const lines = data.markers.filter((marker) => marker.action === 0 && marker.type === 4 && marker.points?.length > 1);
      const line = lines.find((marker) => marker.color?.r > 0.9 && marker.color?.g > 0.75) || lines.find((marker) => marker.color?.g > 0.75);
      if (!line) store.plannedPath = [];
      else if (line.header?.frame_id === 'base_link' || line.header?.frame_id === 'base_footprint') {
        const c = Math.cos(store.vehicle.yaw), s = Math.sin(store.vehicle.yaw);
        store.plannedPath = line.points.map(({ x, y }) => ({
          x: store.vehicle.x + x * c - y * s,
          y: store.vehicle.y + x * s + y * c
        }));
      } else {
        store.plannedPath = line.points.map(({ x, y }) => ({ x, y }));
      }
    }
    else if (topic === '/planner/status') {
      store.pipeline.planning.diagnostic = data.data || 'No planner status';
      store.pipeline.planning.hz = hz;
      store.pipeline.planning.status = /NO_|STALE|ERROR|FAIL/.test(data.data || '') ? 'warn' : 'nominal';
    }
    else if (topic === '/safety/gate_status') {
      store.pipeline.control.diagnostic = data.data || 'No safety-gate status';
      store.pipeline.control.hz = hz;
      store.pipeline.control.status = /BLOCK|FAIL|ERROR/.test(data.data || '') ? 'warn' : 'nominal';
    }
    else if (topic === '/obstacle_stop') {
      store.pipeline.perception.diagnostic = data.data ? 'Obstacle stop active' : 'Obstacle stop clear';
      store.pipeline.perception.status = data.data ? 'warn' : 'nominal';
    }
    else if (topic === '/cmd_vel') {
      store.pipeline.control.hz = hz;
    }
    if (topic === '/odometry/global') {
      store.updateComponent('pi5', { rate: hz });
      store.pipeline.localization.diagnostic = 'Global EKF odometry received';
      store.pipeline.localization.hz = hz;
      store.pipeline.localization.status = 'nominal';
    }
    if (topic === '/scan') {
      store.pipeline.perception.diagnostic = `${data.ranges.length} LiDAR returns`;
      store.pipeline.perception.hz = hz;
      if (store.pipeline.perception.status !== 'warn') store.pipeline.perception.status = 'nominal';
    }
    store.checkFreshness();
    store.notify();
  }

  appendLiveTelemetry(timestamp) {
    const v = store.vehicle;
    const t = store.telemetry;
    const last = t.timestamps.at(-1);
    if (last !== undefined && timestamp / 1000 - last < 0.05) return;
    store.appendTelemetryPoint({
      timestamp: timestamp / 1000,
      speedActual: v.vx,
      speedTarget: v.targetVx,
      steerActual: v.steering * 180 / Math.PI,
      steerTarget: v.targetSteering == null ? null : v.targetSteering * 180 / Math.PI,
      encLeft: v.encLeft,
      encRight: v.encRight,
      imuYawRate: v.yawRate * 180 / Math.PI,
      powerCurrent: null,
      powerVoltage: null
    });
  }

  sendJson(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  handleError = (err) => {
    store.connection.status = 'FAULT';
    store.connection.errorMsg = 'Failed to connect to ROS bridge WebSocket at ' + store.connection.endpoint;
    store.notify();
  };

  handleClose = (event) => {
    store.connection.status = 'DISCONNECTED';
    const closeDetail = `Bridge closed the connection (code ${event.code || 1006}${event.reason ? `: ${event.reason}` : ''}).`;
    store.connection.errorMsg = closeDetail;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (store.mode === 'live') {
      store.addEvent({
        source: 'ROS2_BRIDGE',
        severity: 'warn',
        message: `${closeDetail} Attempting automatic reconnect in 4s...`
      });
      // Auto reconnect after 4s
      this.reconnectTimer = setTimeout(() => {
        if (store.mode === 'live') {
          this.connect(store.connection.endpoint);
        }
      }, 4000);
    }
    store.notify();
  };
}

export const rosBridge = new RosBridgeClient();
