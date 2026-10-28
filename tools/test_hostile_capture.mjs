#!/usr/bin/env node
// Offline hostile-value checks built from real captured messages. The browser
// replay/long-task gate is tools/test_replay_browser.mjs and must run headed.
import fs from 'node:fs';
import path from 'node:path';
import { decodeRosMessage, validateDecodedMessage } from '../src/cdr.js';

const capturePath = path.resolve(process.argv[2] ?? 'tools/captures/real_20261020T050317Z.jsonl');
const rows = fs.readFileSync(capturePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const channels = new Map();
for (const row of rows) if (row.kind === 'json' && row.message?.op === 'advertise') {
  for (const channel of row.message.channels ?? []) channels.set(channel.id, channel);
}
const samples = new Map();
for (const row of rows) {
  if (row.kind !== 'binary' || row.opcode !== 1 || row.channelId == null) continue;
  const channel = channels.get(row.channelId);
  if (channel && !samples.has(channel.topic)) samples.set(channel.topic, { row, channel });
}
function fresh(topic) {
  const sample = samples.get(topic);
  if (!sample) throw new Error(`Missing ${topic} sample in ${capturePath}`);
  const bytes = Buffer.from(sample.row.payloadBase64, 'base64');
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { channel: sample.channel, data: decodeRosMessage(buffer, sample.channel.schemaName) };
}
function expectRejected(name, reason, actual) {
  if (!actual || !actual.includes(reason)) throw new Error(`${name}: expected rejection containing "${reason}", got ${actual}`);
  console.log(`PASS ${name}: ${actual}`);
}

let sample = fresh('/odometry/global');
sample.data.pose.pose.position.y = 1e220;
expectRejected('Odometry huge position', 'exceeds 1e7 m', validateDecodedMessage('/odometry/global', sample.channel.schemaName, sample.data));
sample = fresh('/odometry/global');
sample.data.pose.pose.orientation = { x: 0, y: 0, z: 0, w: 0 };
expectRejected('Odometry zero quaternion', 'quaternion norm', validateDecodedMessage('/odometry/global', sample.channel.schemaName, sample.data));

sample = fresh('/tf');
sample.data.transforms[0].transform.rotation = { x: 0, y: 0, z: 0, w: 0 };
expectRejected('TF zero quaternion', 'quaternion norm', validateDecodedMessage('/tf', sample.channel.schemaName, sample.data));

sample = fresh('/scan');
sample.data.ranges[0] = NaN;
expectRejected('LaserScan NaN range', 'non-finite', validateDecodedMessage('/scan', sample.channel.schemaName, sample.data));
sample = fresh('/scan');
sample.data.ranges[0] = Infinity;
if (validateDecodedMessage('/scan', sample.channel.schemaName, sample.data) !== null) throw new Error('LaserScan +Infinity sentinel was rejected');
console.log('PASS LaserScan +Infinity no-return sentinel retained');
sample.data.angle_increment = 0;
expectRejected('LaserScan zero increment', 'angle_increment is zero', validateDecodedMessage('/scan', sample.channel.schemaName, sample.data));

sample = fresh('/world_markers');
sample.data.markers[0].pose.position.x = 1e220;
expectRejected('Marker huge position', 'exceeds 1e7 m', validateDecodedMessage('/world_markers', sample.channel.schemaName, sample.data));

const hostileSequence = new Uint8Array([0, 1, 0, 0, 0xff, 0xff, 0xff, 0xff]);
try {
  decodeRosMessage(hostileSequence.buffer, 'std_msgs/msg/Float32MultiArray');
  throw new Error('Oversized sequence was accepted');
} catch (error) {
  if (!String(error.message).includes('Invalid CDR sequence length')) throw error;
  console.log(`PASS huge CDR sequence length rejected before allocation (${error.message})`);
}

console.log(JSON.stringify({ capturePath, hostileCasesPassed: 8, browserLongTaskGate: 'not run by this offline script' }, null, 2));
