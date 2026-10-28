/* ==========================================================================
   ENIMIA Dashboard — ROS 2 Live Bridge Client
   Supports both Foxglove WebSocket protocol and ROSBridge v2.0 protocol
   Subscribes to actual vehicle topics from ROS 2 Jazzy & ESP32 micro-ROS
   ========================================================================== */

import { store } from './state.js';
import { config } from '/config.js';
import { decodeRosMessage, encodePointStamped, validateDecodedMessage } from './cdr.js';
import { tfTree } from './tf/transformTree.js';
import { debugInstrumentation } from './debugInstrumentation.js';

/**
 * Build the subscription allowlist from config.topics.
 * Only subscribes to topics that are actually needed by the panels.
 * /joint_states is gated by config.urdf.applyJointStates.
 * /wheel/odom is dropped (duplicate with /odometry/global).
 */
function buildTargetTopics() {
  const t = config.topics;
  const topics = [
    // TF — always needed
    { topic: t.tf,       type: 'tf2_msgs/msg/TFMessage',             compId: null },
    { topic: t.tfStatic, type: 'tf2_msgs/msg/TFMessage',             compId: null },
    // Primary pose
    { topic: t.odomGlobal, type: 'nav_msgs/msg/Odometry',           compId: null },
    { topic: t.odomLocal, type: 'nav_msgs/msg/Odometry',             compId: null },
    { topic: t.odomSim, type: 'nav_msgs/msg/Odometry',               compId: null },
    { topic: t.wheelOdom, type: 'nav_msgs/msg/Odometry',             compId: null },
    // Sensors
    { topic: t.scan, type: 'sensor_msgs/msg/LaserScan',              compId: 'rplidar' },
    { topic: t.fix,  type: 'sensor_msgs/msg/NavSatFix',              compId: 'gps' },
    { topic: t.imu,  type: 'sensor_msgs/msg/Imu',                   compId: 'imu' },
    { topic: t.camera, type: 'sensor_msgs/msg/Image',                compId: 'camera' },
    // Actuators / ESP32
    { topic: t.encoder,  type: 'std_msgs/msg/Int32',                 compId: 'esp32' },
    { topic: t.motorCmd, type: 'std_msgs/msg/Int16',                 compId: null },
    { topic: t.servoCmd, type: 'std_msgs/msg/Int16',                 compId: null },
    // Navigation
    { topic: t.trackProgress,  type: 'std_msgs/msg/Float32',         compId: null },
    { topic: '/waypoints/guidance', type: 'std_msgs/msg/Float32MultiArray', compId: null },
    { topic: t.waypointMarkers, type: 'visualization_msgs/msg/MarkerArray', compId: null },
    { topic: '/planner/markers',    type: 'visualization_msgs/msg/MarkerArray', compId: null },
    { topic: t.plannerStatus, type: 'std_msgs/msg/String',           compId: null },
    { topic: t.safetyGate,    type: 'std_msgs/msg/String',           compId: null },
    { topic: t.obstacleStop,  type: 'std_msgs/msg/Bool',             compId: null },
    { topic: t.cmdVel,        type: 'geometry_msgs/msg/Twist',        compId: null },
    { topic: '/world_markers', type: 'visualization_msgs/msg/MarkerArray', compId: null },
    { topic: '/robot_description', type: 'std_msgs/msg/String', compId: null },
  ];

  // Subscribe regardless of whether the 3D model applies joint positions so
  // bridge load tests exercise the production message decoder and slot path.
  topics.push({ topic: t.jointStates, type: 'sensor_msgs/msg/JointState', compId: null });

  // Remove config gaps, then optionally isolate topics for repeatable load tests:
  // ?topics=tf,scan or ?topics=/tf,/scan. `all` keeps the normal allowlist.
  const configured = topics.filter(e => !!e.topic);
  const requested = new URLSearchParams(window.location.search).get('topics');
  const debugOverride = Array.isArray(config.debug?.topicAllowlist)
    ? config.debug.topicAllowlist.join(',')
    : '';
  const allowlist = requested ?? debugOverride;
  if (!allowlist || allowlist.trim().toLowerCase() === 'all') return configured;
  const allow = new Set(allowlist.split(',').map(value => {
    const name = value.trim();
    return name === 'tf' ? '/tf' : name === 'tf_static' ? '/tf_static' : name.startsWith('/') ? name : `/${name}`;
  }).filter(Boolean));
  return configured.filter(entry => allow.has(entry.topic));
}

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
    this.clientPublishChannelId = 0x7ffffffe;
    this.clientPublishAdvertised = false;
    this.nextAssetRequestId = 1;
    this.assetRequests = new Map();
    this.assetQueue = [];
    this.activeAssetRequests = 0;
    this.assetCache = new Map();
    this.capabilities = new Set();
    this.negotiatedProtocol = '';
    this.topicSlots = new Map(); // topic -> { data, hz, timestamp }
    this.invalidMessageWarnings = new Map();

    // Target vehicle topics — derived from config allowlist (Fix Group 2)
    this.targetTopics = buildTargetTopics();
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
        ? new WebSocket(url, config.bridge.subprotocols)
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
      this.unadvertiseClickedPoint();
      this.ws.close();
      this.ws = null;
    }
    store.connection.status = 'DISCONNECTED';
    store.connection.protocol = '';
    window.__foxgloveProtocol = '';
    store.notify();
  }

  handleOpen = () => {
    this.negotiatedProtocol = this.ws?.protocol || '';
    store.connection.protocol = this.negotiatedProtocol;
    window.__foxgloveProtocol = this.negotiatedProtocol;
    store.connection.status = 'CONNECTED';
    store.connection.errorMsg = null;
    store.addEvent({
      source: 'ROS2_BRIDGE',
      severity: 'info',
      message: `WebSocket bridge transport established with ${store.connection.endpoint} (protocol: ${this.negotiatedProtocol || 'none'}). Initiating topic subscriptions.`
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
        const service = [...this.services.values()].find((item) => item.id === pending.serviceId);
        const error = new Error(msg.message || 'Service call failed');
        this.recordServiceResult(service?.name || 'unknown', pending.startedAt, error);
        pending.reject(error);
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
      const t0 = performance.now();
      let decodeMs = 0, storeMs = 0;
      try {
        const data = decodeRosMessage(buffer.slice(13), channel.schemaName || channel.type);
        const t1 = performance.now();
        decodeMs = t1 - t0;
        if (data !== undefined) {
          const invalidReason = validateDecodedMessage(channel.topic, channel.schemaName || channel.type, data);
          if (invalidReason) this.noteInvalidMessage(channel.topic, invalidReason);
          else {
            const t2 = performance.now();
            this.routeTopicMessage(channel.topic, data);
            storeMs = performance.now() - t2;
          }
        }
        debugInstrumentation.recordMessage(channel.topic, buffer.byteLength, decodeMs, storeMs);
      } catch (err) {
        console.warn(`Could not decode ${channel.topic} (${channel.schemaName || channel.type}):`, err);
      }
      return;
    }
    if (op === 4) {
      this.handleFetchAssetResponse(buffer);
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
      if (payloadOffset + 12 > buffer.byteLength) throw new Error('Truncated Trigger response');
      const responseView = new DataView(buffer, payloadOffset);
      const messageLength = responseView.getUint32(8, true);
      if (messageLength > buffer.byteLength - payloadOffset - 12 || messageLength < 1) throw new Error('Invalid Trigger response message length');
      const messageBytes = new Uint8Array(buffer, payloadOffset + 12, messageLength - 1);
      const response = {
        success: responseView.getUint8(4) !== 0,
        message: new TextDecoder().decode(messageBytes)
      };
      this.recordServiceResult(service?.name || 'unknown', pending.startedAt, response);
      pending.resolve(response);
    } catch (err) {
      pending.reject(err);
    }
  }

  noteInvalidMessage(topic, reason) {
    const now = Date.now();
    const last = this.invalidMessageWarnings.get(topic) || 0;
    if (now - last < 10_000) return;
    this.invalidMessageWarnings.set(topic, now);
    store.addFault('ROS2_BRIDGE', `Dropped invalid ${topic} message: ${reason}`);
  }

  callTrigger(serviceName) {
    if (store.connection.bridgeType !== 'foxglove') throw new Error('Waypoint buttons require Foxglove WebSocket');
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Bridge is disconnected');
    if (!this.capabilities.has('services')) throw new Error('Bridge does not advertise the services capability');
    const service = this.services.get(serviceName);
    if (!service) throw new Error(`${serviceName} has not been advertised by foxglove_bridge`);

    if (service.type !== 'std_srvs/srv/Trigger') throw new Error(`${serviceName} is not a Trigger service`);
    const request = service.request || {};
    const requestEncoding = request.encoding || service.requestEncoding || 'cdr';
    const requestBytes = new Uint8Array([0, 1, 0, 0]);
    const encoding = new TextEncoder().encode(requestEncoding);
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
        if (this.serviceCalls.delete(callId)) {
          const error = new Error(`${serviceName} timed out after 5 s`);
          this.recordServiceResult(serviceName, startedAt, error);
          reject(error);
        }
      }, 5000);
      const startedAt = performance.now();
      this.serviceCalls.set(callId, { resolve, reject, timeout, startedAt, serviceId: service.id });
      if (config.debug?.services) console.info('[Foxglove service request]', { serviceName, serviceId: service.id, callId, encoding: requestEncoding, bytes: frame.byteLength, requestBytes: requestBytes.byteLength });
      this.ws.send(frame);
    });
  }

  recordServiceResult(serviceName, startedAt, result) {
    const durationMs = Number((performance.now() - startedAt).toFixed(2));
    const detail = result instanceof Error
      ? { serviceName, durationMs, error: result.message }
      : { serviceName, durationMs, success: result.success, message: result.message };
    if (config.debug?.services) console.info('[Foxglove service response]', detail);
    store.addEvent({ source: 'WAYPOINT_SERVICE', severity: result instanceof Error || !result.success ? 'warn' : 'info', message: result instanceof Error ? `${serviceName}: ${result.message} (${durationMs} ms)` : `${serviceName}: ${result.message || (result.success ? 'Success' : 'Failure')} (${durationMs} ms)` });
  }

  advertiseClickedPoint() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Bridge is disconnected');
    if (!this.capabilities.has('clientPublish')) throw new Error('Bridge does not advertise the clientPublish capability');
    if (this.clientPublishAdvertised) return this.clientPublishChannelId;
    this.sendJson({ op: 'advertise', channels: [{
      id: this.clientPublishChannelId, topic: config.topics.clickedPoint,
      encoding: 'cdr', schemaName: 'geometry_msgs/msg/PointStamped',
      schemaEncoding: 'ros2msg', schema: config.definitions.clickedPoint
    }] });
    this.clientPublishAdvertised = true;
    return this.clientPublishChannelId;
  }

  publishClickedPoint(point, frameId = config.frames.worldFrame) {
    const channelId = this.advertiseClickedPoint();
    const payload = encodePointStamped(point, frameId);
    const frame = new Uint8Array(5 + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint8(0, 1);
    view.setUint32(1, channelId, true);
    frame.set(payload, 5);
    this.ws.send(frame);
    return { channelId, bytes: frame.byteLength };
  }

  unadvertiseClickedPoint() {
    if (!this.clientPublishAdvertised) return;
    this.sendJson({ op: 'unadvertise', channelIds: [this.clientPublishChannelId] });
    this.clientPublishAdvertised = false;
  }

  fetchAsset(uri) {
    if (!this.capabilities.has('assets')) return Promise.reject(new Error('Bridge does not advertise the assets capability'));
    const cached = this.assetCache.get(uri);
    if (cached) return Promise.resolve(cached.slice(0));
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Bridge is disconnected'));
    return new Promise((resolve, reject) => {
      this.assetQueue.push({ uri, resolve, reject });
      this.pumpAssetQueue();
    });
  }

  pumpAssetQueue() {
    while (this.activeAssetRequests < 4 && this.assetQueue.length && this.ws?.readyState === WebSocket.OPEN) {
      const item = this.assetQueue.shift();
      const requestId = this.nextAssetRequestId++ >>> 0;
      const timeout = setTimeout(() => {
        const pending = this.assetRequests.get(requestId);
        if (!pending) return;
        this.assetRequests.delete(requestId);
        this.activeAssetRequests--;
        pending.reject(new Error(`fetchAsset timed out for ${pending.uri}`));
        this.pumpAssetQueue();
      }, config.urdf?.assetTimeoutMs ?? 10_000);
      this.assetRequests.set(requestId, { ...item, timeout });
      this.activeAssetRequests++;
      this.sendJson({ op: 'fetchAsset', uri: item.uri, requestId });
    }
  }

  handleFetchAssetResponse(buffer) {
    if (buffer.byteLength < 10) return;
    const view = new DataView(buffer);
    const requestId = view.getUint32(1, true);
    const status = view.getUint8(5);
    const errorLength = view.getUint32(6, true);
    const errorStart = 10;
    if (errorLength > buffer.byteLength - errorStart) return;
    const errorMessage = new TextDecoder().decode(new Uint8Array(buffer, errorStart, errorLength));
    const pending = this.assetRequests.get(requestId);
    if (!pending) return;
    this.assetRequests.delete(requestId);
    clearTimeout(pending.timeout);
    this.activeAssetRequests = Math.max(0, this.activeAssetRequests - 1);
    if (status !== 0) pending.reject(new Error(errorMessage || `fetchAsset failed with status ${status}`));
    else {
      const data = buffer.slice(errorStart + errorLength);
      this.assetCache.set(pending.uri, data.slice(0));
      pending.resolve(data);
    }
    this.pumpAssetQueue();
  }

  rejectAssetRequests(reason) {
    for (const pending of this.assetRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    for (const pending of this.assetQueue) pending.reject(new Error(reason));
    this.assetRequests.clear();
    this.assetQueue.length = 0;
    this.activeAssetRequests = 0;
  }

  routeTopicMessage(topic, data) {
    if (store.mode !== 'live') return;

    const now = Date.now();
    const previous = this.topicRates.get(topic);
    const hz = previous ? 1000 / Math.max(1, now - previous) : 0;
    this.topicRates.set(topic, now);

    // Apply TF directly to transform tree (O(1) Map update, no DOM or store notify)
    if (topic === '/tf' || topic === '/tf_static') {
      if (data && Array.isArray(data.transforms)) {
        tfTree.addTransforms(data);
      }
      return;
    }

    // Write LATEST value into per-topic slot (Map)
    this.topicSlots.set(topic, { data, hz, time: now });
  }

  drainSlotsToStore() {
    if (this.topicSlots.size === 0) return;

    let odomUpdated = false;

    for (const [topic, slot] of this.topicSlots.entries()) {
      const { data, hz, time } = slot;

      if (topic === config.topics.scan && data.ranges) {
        // ranges / intensities may be Float32Array (CDR fast path) or plain Array
        const ranges = data.ranges;
        const nRanges = ranges.length;
        store.updateComponent('rplidar', {
          rate: hz,
          samples: nRanges,
          rangeMin: `${data.range_min.toFixed(2)} m`,
          rangeMax: `${data.range_max.toFixed(2)} m`
        });
        const points = [];
        const angleMin = data.angle_min || 0;
        const angleInc = data.angle_increment || (Math.PI / 180);
        const rMin = data.range_min || 0.15;
        const rMax = data.range_max || 12.0;
        const hasIntensities = data.intensities && data.intensities.length > 0;
        // Decimate by 2 for rendering performance — full resolution in Float32Array
        for (let i = 0; i < nRanges; i += 2) {
          const r = ranges[i];
          if (r >= rMin && r <= rMax) {
            const a = angleMin + i * angleInc;
            points.push({
              x: r * Math.cos(a),
              y: r * Math.sin(a),
              range: r,
              angle: a,
              intensity: hasIntensities ? (data.intensities[i] || 150) : 150
            });
          }
        }
        store.lidarPoints = points;
        store.pipeline.perception.diagnostic = `${nRanges} LiDAR returns`;
        store.pipeline.perception.hz = hz;
        if (store.pipeline.perception.status !== 'warn') store.pipeline.perception.status = 'nominal';
        store.dirtyPanels.health = true;
        store.dirtyPanels.pipeline = true;
      }
      else if (topic === '/robot_description' && typeof data.data === 'string') {
        if (store.robotDescription !== data.data) {
          store.robotDescription = data.data;
          store.dirtyPanels.scene3D = true;
        }
      }
      else if (topic === config.topics.camera && data.data && data.width && data.height) {
        store.cameraFrame = data;
        store.updateComponent('camera', {
          rate: hz,
          fps: hz,
          res: `${data.width} × ${data.height}`,
          status: 'nominal'
        });
        store.dirtyPanels.camera = true;
      }
      else if (topic === '/fix' && data.latitude !== undefined) {
        store.updateComponent('gps', {
          lat: data.latitude,
          lon: data.longitude,
          alt: `${data.altitude.toFixed(1)} m`,
          fixType: data.status?.status >= 0 ? `Fix ${data.status.status}` : 'No fix',
          status: data.status?.status >= 0 ? 'nominal' : 'fault',
          rate: hz
        });
        store.dirtyPanels.health = true;
      }
      else if ((topic === '/odometry/global' || topic === '/wheel/odom') && data.pose?.pose) {
        const pos = data.pose.pose.position;
        const q = data.pose.pose.orientation;
        const siny_cosp = 2 * (q.w * q.z + q.x * q.y);
        const cosy_cosp = 1 - 2 * (q.y * q.y + q.z * q.z);
        const yaw = Math.atan2(siny_cosp, cosy_cosp);

        if (topic === '/odometry/global') {
          store.vehicle.x = pos.x;
          store.vehicle.y = pos.y;
          store.vehicle.z = pos.z || 0;
          store.vehicle.orientation = q;
          store.vehicle.yaw = yaw;
          store.vehicle.poseSource = 'ODOM';
          store.hasGlobalOdom = true;
          store.odomHistory.push({ x: pos.x, y: pos.y, yaw });
          if (store.odomHistory.length > store.maxOdomHistory) store.odomHistory.shift();

          store.updateComponent('pi5', { rate: hz });
          store.pipeline.localization.diagnostic = 'Global EKF odometry received';
          store.pipeline.localization.hz = hz;
          store.pipeline.localization.status = 'nominal';

          store.dirtyPanels.header = true;
          store.dirtyPanels.telemetry = true;
          store.dirtyPanels.health = true;
          store.dirtyPanels.pipeline = true;
          odomUpdated = true;
        }
        if (data.twist?.twist?.linear) {
          store.vehicle.vx = data.twist.twist.linear.x;
          if (topic === '/odometry/global') odomUpdated = true;
        }
      }
      else if (topic === '/imu/data' && data.angular_velocity) {
        const yawRateDeg = (data.angular_velocity.z * 180) / Math.PI;
        const latAcc = data.linear_acceleration?.y || 0;
        store.updateComponent('imu', {
          yawRate: yawRateDeg,
          lateralAcc: latAcc,
          rate: hz
        });
        store.vehicle.yawRate = data.angular_velocity.z;
        store.vehicle.accelY = latAcc;
        store.dirtyPanels.health = true;
      }
      else if (topic === '/esp32/encoder') {
        store.updateComponent('esp32', { encoderTicks: data.data, rate: hz });
        store.dirtyPanels.health = true;
      }
      else if (topic === '/joint_states') {
        const names = data.name || [], positions = data.position || [];
        const at = (name) => positions[names.indexOf(name)];
        const leftSteer = at('front_left_steer_joint'), rightSteer = at('front_right_steer_joint');
        if (Number.isFinite(leftSteer) && Number.isFinite(rightSteer)) store.vehicle.steering = (leftSteer + rightSteer) / 2;
        const leftWheel = at('rear_left_wheel_joint'), rightWheel = at('rear_right_wheel_joint');
        if (this.lastJointPositions && Number.isFinite(leftWheel) && Number.isFinite(rightWheel)) {
          const dt = (time - this.lastJointPositions.time) / 1000;
          if (dt > 0) {
            const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
            store.vehicle.encLeft = wrapAngle(leftWheel - this.lastJointPositions.left) / dt;
            store.vehicle.encRight = wrapAngle(rightWheel - this.lastJointPositions.right) / dt;
          }
        }
        if (Number.isFinite(leftWheel) && Number.isFinite(rightWheel)) this.lastJointPositions = { left: leftWheel, right: rightWheel, time };
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
        store.dirtyPanels.waypoints = true;
      }
      else if (topic === '/waypoints/markers' && data.markers) {
        const markers = data.markers.filter((marker) => marker.action === 0 && marker.type === 2 && marker.ns === 'waypoints');
        store.trackWaypoints = markers.map((marker, index) => ({
          waypointIndex: marker.id >= 1000 ? marker.id - 1000 : index,
          id: `WP${String(marker.id >= 1000 ? marker.id - 999 : index + 1).padStart(2, '0')}`,
          name: `Waypoint ${marker.id >= 1000 ? marker.id - 999 : index + 1}`,
          x: marker.pose.position.x, y: marker.pose.position.y, z: marker.pose.position.z,
          frameId: marker.header?.frame_id || config.frames.worldFrame
        }));
        const line = data.markers.find((marker) => marker.action === 0 && marker.type === 4 && marker.ns === 'waypoints' && marker.points?.length > 1);
        const flat = line?.points instanceof Float64Array;
        const count = !line ? 0 : flat ? line.points.length / 3 : line.points.length;
        store.trackWaypointLine = line ? Array.from({ length: count }, (_, i) => flat
          ? ({ x: line.points[i * 3], y: line.points[i * 3 + 1], z: line.points[i * 3 + 2], frameId: line.header?.frame_id || config.frames.worldFrame })
          : ({ ...line.points[i], frameId: line.header?.frame_id || config.frames.worldFrame })) : [];
        store.dirtyPanels.waypoints = true;
      }
      else if (topic === '/planner/markers' && data.markers) {
        const lines = data.markers.filter((marker) => marker.action === 0 && marker.type === 4 && marker.points?.length > 1);
        const line = lines.find((marker) => marker.color?.r > 0.9 && marker.color?.g > 0.75) || lines.find((marker) => marker.color?.g > 0.75);
        if (!line) store.plannedPath = [];
        else {
          const flat = line.points instanceof Float64Array;
          const pointCount = flat ? line.points.length / 3 : line.points.length;
          const at = (i) => flat
            ? { x: line.points[i * 3], y: line.points[i * 3 + 1] }
            : line.points[i];
          const relative = line.header?.frame_id === 'base_link' || line.header?.frame_id === 'base_footprint';
          const c = Math.cos(store.vehicle.yaw), s = Math.sin(store.vehicle.yaw);
          const path = new Array(pointCount);
          for (let i = 0; i < pointCount; i++) {
            const { x, y } = at(i);
            path[i] = relative
              ? { x: store.vehicle.x + x * c - y * s, y: store.vehicle.y + x * s + y * c }
              : { x, y };
          }
          store.plannedPath = path;
        }
      }
      else if (topic === '/planner/status') {
        store.pipeline.planning.diagnostic = data.data || 'No planner status';
        store.pipeline.planning.hz = hz;
        store.pipeline.planning.status = /NO_|STALE|ERROR|FAIL/.test(data.data || '') ? 'warn' : 'nominal';
        store.dirtyPanels.pipeline = true;
      }
      else if (topic === '/safety/gate_status') {
        store.pipeline.control.diagnostic = data.data || 'No safety-gate status';
        store.pipeline.control.hz = hz;
        store.pipeline.control.status = /BLOCK|FAIL|ERROR/.test(data.data || '') ? 'warn' : 'nominal';
        store.dirtyPanels.pipeline = true;
      }
      else if (topic === '/obstacle_stop') {
        store.pipeline.perception.diagnostic = data.data ? 'Obstacle stop active' : 'Obstacle stop clear';
        store.pipeline.perception.status = data.data ? 'warn' : 'nominal';
        store.dirtyPanels.pipeline = true;
      }
    }

    if (odomUpdated) {
      this.appendLiveTelemetry(Date.now());
    }

    this.topicSlots.clear();
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
    this.clientPublishAdvertised = false;
    this.rejectAssetRequests('Bridge disconnected while fetching an asset');
    store.connection.status = 'DISCONNECTED';
    store.connection.protocol = '';
    window.__foxgloveProtocol = '';
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
