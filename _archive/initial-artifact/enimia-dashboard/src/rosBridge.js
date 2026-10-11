/* ==========================================================================
   ENIMIA Dashboard — ROS 2 Live Bridge Client
   Supports both Foxglove WebSocket protocol and ROSBridge v2.0 protocol
   Subscribes to actual vehicle topics from ROS 2 Jazzy & ESP32 micro-ROS
   ========================================================================== */

import { store } from './state.js';

export class RosBridgeClient {
  constructor() {
    this.ws = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastPingTime = 0;
    this.channels = new Map(); // Foxglove channelId -> metadata
    this.subscriptions = new Map(); // topic -> subId

    // Target vehicle topics
    this.targetTopics = [
      { topic: '/scan', type: 'sensor_msgs/msg/LaserScan', compId: 'rplidar' },
      { topic: '/fix', type: 'sensor_msgs/msg/NavSatFix', compId: 'gps' },
      { topic: '/wheel/odom', type: 'nav_msgs/msg/Odometry', compId: null },
      { topic: '/esp32/imu', type: 'sensor_msgs/msg/Imu', compId: 'imu' },
      { topic: '/esp32/encoder', type: 'std_msgs/msg/Float32MultiArray', compId: 'esp32' },
      { topic: '/esp32/motor_cmd', type: 'std_msgs/msg/Float32', compId: null },
      { topic: '/esp32/servo_cmd', type: 'std_msgs/msg/Float32', compId: null },
      { topic: '/diagnostics/pi5', type: 'diagnostic_msgs/msg/DiagnosticArray', compId: 'pi5' },
      { topic: '/power/battery', type: 'sensor_msgs/msg/BatteryState', compId: 'power' },
      { topic: '/camera/image_raw', type: 'sensor_msgs/msg/CompressedImage', compId: 'camera' }
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
      this.ws = new WebSocket(url);
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
      message: `WebSocket bridge transport established with ${store.connection.endpoint}. Initiating topic subscriptions.`
    });

    // Start RTT ping heartbeat
    this.pingTimer = setInterval(this.measurePing, 2000);

    // Protocol Handshake
    if (store.connection.bridgeType === 'rosbridge') {
      this.subscribeRosbridge();
    } else {
      // Foxglove protocol: send client info
      this.sendJson({
        op: 'clientInfo',
        name: 'ENIMIA-PitMonitor',
        supportedMsgEncodings: ['json', 'cdr']
      });
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
      } else {
        // Foxglove or standard ping
        this.sendJson({ op: 'ping', timestamp: Date.now() });
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
          const subId = this.channels.size + 1;
          this.subscriptions.set(ch.topic, subId);
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
    // Binary foxglove message decoding
    const view = new DataView(buffer);
    const op = view.getUint8(0);
    if (op === 1) { // Foxglove message data
      const subId = view.getUint32(1, true);
      // Process payload
    }
  }

  routeTopicMessage(topic, data) {
    if (store.mode !== 'live') return;

    const now = Date.now();

    // RPLIDAR: /scan
    if (topic === '/scan' && data.ranges) {
      store.updateComponent('rplidar', { rate: 10.0, lastMsgTime: now });
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

    // GNSS / GPS: /fix
    else if (topic === '/fix' && data.latitude !== undefined) {
      store.updateComponent('gps', {
        lat: data.latitude,
        lon: data.longitude,
        alt: `${(data.altitude || 0).toFixed(1)} m`,
        status: data.status?.status >= 0 ? 'nominal' : 'warn'
      });
    }

    // Wheel Odometry: /wheel/odom
    else if (topic === '/wheel/odom' && data.pose?.pose) {
      const pos = data.pose.pose.position;
      const q = data.pose.pose.orientation;
      // Convert quaternion to yaw
      const siny_cosp = 2 * (q.w * q.z + q.x * q.y);
      const cosy_cosp = 1 - 2 * (q.y * q.y + q.z * q.z);
      const yaw = Math.atan2(siny_cosp, cosy_cosp);

      store.vehicle.x = pos.x;
      store.vehicle.y = pos.y;
      store.vehicle.yaw = yaw;
      if (data.twist?.twist?.linear) {
        store.vehicle.vx = data.twist.twist.linear.x;
      }
    }

    // IMU: /esp32/imu
    else if (topic === '/esp32/imu' && data.angular_velocity) {
      const yawRateDeg = (data.angular_velocity.z * 180) / Math.PI;
      const latAcc = data.linear_acceleration?.y || 0;
      store.updateComponent('imu', {
        yawRate: yawRateDeg,
        lateralAcc: latAcc
      });
      store.vehicle.yawRate = data.angular_velocity.z;
    }

    // Battery / Power: /power/battery
    else if (topic === '/power/battery' && data.voltage !== undefined) {
      store.updateComponent('power', {
        voltage: data.voltage,
        current: data.current || 0,
        soc: data.percentage ? data.percentage * 100 : 0,
        powerDraw: (data.voltage || 0) * (data.current || 0)
      });
    }

    store.checkFreshness();
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
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (store.mode === 'live') {
      store.addEvent({
        source: 'ROS2_BRIDGE',
        severity: 'warn',
        message: `Bridge disconnected (Code: ${event.code || '1006'}). Attempting automatic reconnect in 4s...`
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
