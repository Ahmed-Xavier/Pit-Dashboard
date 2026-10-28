#!/usr/bin/env node
// Verify the dashboard PointStamped CDR encoder with Lichtblick's independent ROS 2 reader.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { encodePointStamped } from '../src/cdr.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const modules = path.resolve(root, '..', 'lichtblick', 'node_modules');
const parse = require(path.join(modules, '@lichtblick/rosmsg/dist/index.js')).parse;
const MessageReader = require(path.join(modules, '@lichtblick/rosmsg2-serialization/dist/index.js')).MessageReader;
const schema = config.definitions.clickedPoint;
const reader = new MessageReader(parse(schema, { ros2: true }));
const expected = { x: 1.25, y: -2.5, z: 0, frame_id: 'map' };
const payload = encodePointStamped({ x: expected.x, y: expected.y, z: expected.z }, expected.frame_id, new Date(1_700_000_000_123));
const decoded = reader.readMessage(payload);
if (decoded.header.frame_id !== expected.frame_id || decoded.point.x !== expected.x || decoded.point.y !== expected.y || decoded.point.z !== expected.z) {
  throw new Error(`Independent CDR decode mismatch: ${JSON.stringify(decoded)}`);
}
console.log(JSON.stringify({ payloadBytes: payload.byteLength, decoded }, null, 2));
