import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { decodeRosMessage, validateDecodedMessage } from '../src/cdr.js';

const capturePath = path.resolve(process.argv[2] ?? 'tools/captures/real_20261020T050317Z.jsonl');
const lichtblickModules = path.resolve(process.cwd(), '..', 'lichtblick', 'node_modules');
const require = createRequire(import.meta.url);
const parse = require(path.join(lichtblickModules, '@lichtblick/rosmsg/dist/index.js')).parse;
const MessageReader = require(path.join(lichtblickModules, '@lichtblick/rosmsg2-serialization/dist/index.js')).MessageReader;
const rows = fs.readFileSync(capturePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const channels = new Map();
for (const row of rows) {
  if (row.kind === 'json' && row.message?.op === 'advertise') {
    for (const channel of row.message.channels ?? []) channels.set(channel.id, channel);
  }
}

function canonical(value, pathName = '') {
  if (value == null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
  if (ArrayBuffer.isView(value)) return canonical(Array.from(value), pathName);
  if (Array.isArray(value)) {
    const arr = value.map((item) => canonical(item, pathName));
    if (pathName.endsWith('.points') && arr.length && typeof arr[0] === 'number') {
      const points = [];
      for (let i = 0; i < arr.length; i += 3) points.push({ x: arr[i], y: arr[i + 1], z: arr[i + 2] });
      return points;
    }
    return arr;
  }
  if (typeof value.toJSON === 'function') return canonical(value.toJSON(), pathName);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const normalizedKey = key === 'nsec' ? 'nanosec' : key;
    out[normalizedKey] = canonical(value[key], pathName ? `${pathName}.${normalizedKey}` : normalizedKey);
  }
  return out;
}

function firstDifference(a, b, at = '$') {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null) return `${at}: own=${JSON.stringify(a)} independent=${JSON.stringify(b)}`;
  if (typeof a !== 'object') return `${at}: own=${String(a)} independent=${String(b)}`;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    if (!(key in a) || !(key in b)) return `${at}.${key}: ${key in a ? 'missing independent field' : 'missing dashboard field'}`;
    const difference = firstDifference(a[key], b[key], `${at}.${key}`);
    if (difference) return difference;
  }
  return null;
}

const readers = new Map();
const stats = new Map();
const decodeErrors = [];
let checked = 0;
for (const row of rows) {
  if (row.kind !== 'binary' || row.opcode !== 1 || row.channelId == null) continue;
  const channel = channels.get(row.channelId);
  if (!channel) { decodeErrors.push({ topic: row.topic, error: 'capture references an unknown advertised channel id' }); continue; }
  const stat = stats.get(channel.topic) ?? { messages: 0, mismatches: 0, errors: 0, invalidValues: 0 };
  stat.messages++;
  try {
    const payload = Buffer.from(row.payloadBase64, 'base64');
    const independentPayload = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    let independent;
    if (channel.encoding === 'json') {
      independent = JSON.parse(payload.toString('utf8'));
    } else {
      let reader = readers.get(channel.id);
      if (!reader) {
        reader = new MessageReader(parse(channel.schema, { ros2: true }));
        readers.set(channel.id, reader);
      }
      independent = reader.readMessage(new Uint8Array(independentPayload));
    }
    const own = channel.encoding === 'cdr'
      ? decodeRosMessage(independentPayload, channel.schemaName)
      : JSON.parse(payload.toString('utf8'));
    const invalidReason = channel.encoding === 'cdr' ? validateDecodedMessage(channel.topic, channel.schemaName, own) : null;
    if (invalidReason) {
      stat.invalidValues++;
      if (stat.firstInvalid == null) stat.firstInvalid = { timestamp: row.receivedAt, reason: invalidReason };
    }
    const difference = firstDifference(canonical(own), canonical(independent));
    checked++;
    if (difference) {
      stat.mismatches++;
      if (stat.firstMismatch == null) stat.firstMismatch = { timestamp: row.receivedAt, difference };
    }
  } catch (error) {
    stat.errors++;
    if (decodeErrors.length < 40) decodeErrors.push({ topic: channel.topic, schemaName: channel.schemaName, message: error.message });
  }
  stats.set(channel.topic, stat);
}

const result = {
  capturePath,
  decoder: '@lichtblick/rosmsg2-serialization from sibling lichtblick/node_modules (read-only)',
  checkedMessages: checked,
  channels: channels.size,
  totals: [...stats.values()].reduce((total, stat) => ({
    messages: total.messages + stat.messages,
    mismatches: total.mismatches + stat.mismatches,
    errors: total.errors + stat.errors,
    invalidValues: total.invalidValues + stat.invalidValues,
  }), { messages: 0, mismatches: 0, errors: 0, invalidValues: 0 }),
  topics: [...stats.entries()].map(([topic, value]) => ({ topic, ...value })).sort((a, b) => a.topic.localeCompare(b.topic)),
  decodeErrors,
};
console.log(JSON.stringify(result, null, 2));
if (decodeErrors.length || [...stats.values()].some((stat) => stat.mismatches || stat.errors)) process.exitCode = 1;
