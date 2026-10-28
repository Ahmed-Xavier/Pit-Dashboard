import fs from 'node:fs';
import { decodeRosMessage } from '../src/cdr.js';

const capturePath = process.argv[2] ?? 'tools/captures/real_20261020T043910Z.jsonl';
const rows = fs.readFileSync(capturePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
const channelById = new Map();
const stats = new Map();
const anomalies = { scan: [], odom: [], tf: [], marker: [], jointStates: [], decodeErrors: [] };
let largestJson = { topic: null, op: null, bytes: 0 };
let largestBinary = { topic: null, bytes: 0 };
const nonFiniteFields = (value, path = '') => {
  const bad = [];
  if (typeof value === 'number' && !Number.isFinite(value)) return [path];
  if (ArrayBuffer.isView(value)) {
    for (let i = 0; i < value.length; i++) if (!Number.isFinite(value[i])) bad.push(`${path}[${i}]`);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) bad.push(...nonFiniteFields(child, path ? `${path}.${key}` : key));
  }
  return bad;
};
const stampInfo = (header) => ({ sec: header?.stamp?.sec, nanosec: header?.stamp?.nanosec, frame: header?.frame_id ?? '' });
const isZeroQuaternion = (q) => q && q.x === 0 && q.y === 0 && q.z === 0 && q.w === 0;

for (const row of rows) {
  if (row.kind === 'json') {
    const msg = row.message;
    const byteLength = Buffer.byteLength(JSON.stringify(msg));
    if (byteLength > largestJson.bytes) largestJson = { topic: null, op: msg.op, bytes: byteLength };
    if (msg.op === 'advertise') for (const channel of msg.channels ?? []) channelById.set(channel.id, channel);
    continue;
  }
  if (row.kind !== 'binary') continue;
  const channel = channelById.get(row.channelId);
  const topic = channel?.topic ?? row.topic ?? '<unmapped>';
  const schemaName = channel?.schemaName;
  const bytes = Buffer.from(row.payloadBase64 ?? '', 'base64');
  if (row.byteLength > largestBinary.bytes) largestBinary = { topic, bytes: row.byteLength };
  const st = stats.get(topic) ?? { count: 0, totalBytes: 0, largestBytes: 0 };
  st.count++; st.totalBytes += row.byteLength; st.largestBytes = Math.max(st.largestBytes, row.byteLength); stats.set(topic, st);
  if (!['sensor_msgs/msg/LaserScan', 'nav_msgs/msg/Odometry', 'tf2_msgs/msg/TFMessage', 'visualization_msgs/msg/MarkerArray', 'sensor_msgs/msg/JointState'].includes(schemaName)) continue;
  try {
    const data = Uint8Array.from(bytes).buffer;
    const message = decodeRosMessage(data, schemaName);
    const bad = nonFiniteFields(message);
    if (schemaName === 'sensor_msgs/msg/LaserScan') {
      const ranges = message.ranges;
      const info = {
        topic, stamp: stampInfo(message.header), rangeCount: ranges.length,
        nanRanges: ranges.reduce((n, v) => n + Number(Number.isNaN(v)), 0),
        infiniteRanges: ranges.reduce((n, v) => n + Number(!Number.isFinite(v) && !Number.isNaN(v)), 0),
        angle_min: message.angle_min, angle_max: message.angle_max, angle_increment: message.angle_increment,
        range_min: message.range_min, range_max: message.range_max,
        badFields: bad,
      };
      if (bad.length || !message.header.frame_id || !Number.isFinite(message.angle_increment) || message.angle_increment === 0) anomalies.scan.push(info);
      stats.get(topic).lastScan = info;
    } else if (schemaName === 'nav_msgs/msg/Odometry') {
      const q = message.pose.pose.orientation;
      const info = { topic, stamp: stampInfo(message.header), child_frame_id: message.child_frame_id,
        position: message.pose.pose.position, quaternion: q, zeroQuaternion: isZeroQuaternion(q), badFields: bad };
      if (bad.length || info.zeroQuaternion || !info.stamp.frame || !info.child_frame_id) anomalies.odom.push(info);
      stats.get(topic).lastOdometry = info;
    } else if (schemaName === 'tf2_msgs/msg/TFMessage') {
      for (const tf of message.transforms) {
        const q = tf.transform.rotation;
        const info = { topic, stamp: stampInfo(tf.header), child_frame_id: tf.child_frame_id,
          translation: tf.transform.translation, quaternion: q, zeroQuaternion: isZeroQuaternion(q), badFields: nonFiniteFields(tf) };
        if (info.badFields.length || info.zeroQuaternion || !info.stamp.frame || !info.child_frame_id) anomalies.tf.push(info);
      }
      stats.get(topic).lastTransformCount = message.transforms.length;
    } else if (schemaName === 'visualization_msgs/msg/MarkerArray') {
      const points = message.markers.reduce((sum, marker) => sum + marker.points.length / 3, 0);
      const info = { topic, stamp: message.markers.map((m) => stampInfo(m.header)), markerCount: message.markers.length,
        pointCount: points, meshResources: message.markers.map((m) => m.mesh_resource).filter(Boolean),
        markerDetails: message.markers.map(({ ns, id, type, action, mesh_resource, points, text }) => ({ ns, id, type, action, mesh_resource, pointCount: points.length / 3, text })),
        badFields: bad };
      if (bad.length || message.markers.some((m) => !m.header.frame_id)) anomalies.marker.push(info);
      stats.get(topic).lastMarkers = info;
    } else if (schemaName === 'sensor_msgs/msg/JointState') {
      const lens = [message.name.length, message.position.length, message.velocity.length, message.effort.length];
      const info = { topic, stamp: stampInfo(message.header), sequenceLengths: { name: lens[0], position: lens[1], velocity: lens[2], effort: lens[3] }, badFields: bad };
      if (new Set(lens.filter((n) => n !== 0)).size > 1 || bad.length || !info.stamp.frame) anomalies.jointStates.push(info);
      stats.get(topic).lastJointState = info;
    }
  } catch (error) {
    anomalies.decodeErrors.push({ topic, schemaName, error: String(error), payloadBytes: bytes.length, payloadPrefixHex: bytes.subarray(0, 96).toString('hex') });
  }
}

const selected = Object.fromEntries([...stats.entries()].filter(([topic]) => ['/scan', '/tf', '/tf_static', '/odom', '/wheel/odom', '/odometry/global', '/odometry/local', '/planner/markers', '/waypoints/markers', '/world_markers'].includes(topic)));
function compact(value) {
  if (Array.isArray(value)) return value.slice(0, 5).map(compact);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'badFields') { result.badFieldCount = child.length; result.firstBadFields = child.slice(0, 5); }
    else result[key] = compact(child);
  }
  return result;
}
const decodeErrorGroups = new Map();
for (const error of anomalies.decodeErrors) {
  const key = `${error.topic}|${error.schemaName}`;
  const item = decodeErrorGroups.get(key) ?? { topic: error.topic, schemaName: error.schemaName, count: 0, errors: new Map(), samplePayloadBytes: error.payloadBytes, samplePayloadPrefixHex: error.payloadPrefixHex };
  item.count++;
  item.errors.set(error.error, (item.errors.get(error.error) ?? 0) + 1);
  decodeErrorGroups.set(key, item);
}
const anomalySummary = {
  scan: { frames: stats.get('/scan')?.count ?? 0, anomalousFrames: anomalies.scan.length, samples: anomalies.scan.slice(0, 2).map(compact) },
  odom: { frames: [...stats.keys()].filter((topic) => ['/odom', '/wheel/odom', '/odometry/global', '/odometry/local'].includes(topic)).reduce((n, topic) => n + stats.get(topic).count, 0), anomalousFrames: anomalies.odom.length, samples: anomalies.odom.slice(0, 4).map(compact) },
  tf: { anomalousTransforms: anomalies.tf.length, samples: anomalies.tf.slice(0, 4).map(compact) },
  marker: { anomalousArrays: anomalies.marker.length, samples: anomalies.marker.slice(0, 4).map(compact) },
  jointStates: { anomalousMessages: anomalies.jointStates.length, samples: anomalies.jointStates.slice(0, 4).map(compact) },
  decodeErrors: [...decodeErrorGroups.values()].map(({ errors, ...rest }) => ({ ...rest, errors: [...errors.entries()].slice(0, 5).map(([error, count]) => ({ error, count })) })),
};
console.log(JSON.stringify({ capturePath, jsonFrames: rows.filter((r) => r.kind === 'json').length, binaryFrames: rows.filter((r) => r.kind === 'binary').length,
  advertisedChannels: channelById.size, largestBinary, largestJson, selected: compact(selected), anomalies: anomalySummary }, null, 2));
