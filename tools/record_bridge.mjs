import fs from 'node:fs';
import path from 'node:path';

const endpoint = process.argv.find((arg) => arg.startsWith('--url='))?.slice(6) ?? 'ws://127.0.0.1:8765';
const durationSeconds = Number(process.argv.find((arg) => arg.startsWith('--seconds='))?.slice(10) ?? 30);
const outputArg = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
const outputDir = path.resolve('tools/captures');
fs.mkdirSync(outputDir, { recursive: true });
const date = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const outputPath = outputArg ? path.resolve(outputArg) : path.join(outputDir, `real_${date}.jsonl`);
const stream = fs.createWriteStream(outputPath, { flags: 'wx' });
const startedAt = Date.now();
const channels = new Map();
const subscriptions = new Map();
const stats = new Map();
let gotServerInfo = false;
let gotAdvertise = false;
let nextSubscriptionId = 1;
let timer;
let finished = false;

function write(row) { stream.write(`${JSON.stringify(row)}\n`); }
function stop(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try { socket.close(); } catch {}
  stream.end(() => {
    if (error) {
      console.error(`Capture stopped: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    const rows = [...stats.entries()].map(([topic, value]) => ({ topic, ...value }))
      .sort((a, b) => a.topic.localeCompare(b.topic));
    console.log(JSON.stringify({ outputPath, durationSeconds, channels: channels.size, topics: rows }, null, 2));
  });
}

if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('--seconds must be positive');
write({ kind: 'capture', format: 'pit-dashboard-foxglove-jsonl-v1', endpoint, startedAt: new Date(startedAt).toISOString(), durationSeconds });
// Current Foxglove Bridge (SDK-backed v3.x) requires sdk.v1; older bridges use
// websocket.v1. Offering both lets the server select the protocol it supports.
const socket = new WebSocket(endpoint, ['foxglove.sdk.v1', 'foxglove.websocket.v1']);
socket.binaryType = 'arraybuffer';
const connectTimer = setTimeout(() => stop(new Error(`No Foxglove handshake from ${endpoint} within 5 seconds`)), 5000);

socket.addEventListener('open', () => {
  clearTimeout(connectTimer);
  write({ kind: 'handshake', receivedAt: Date.now(), protocol: socket.protocol });
  console.log(`Connected to ${endpoint} using ${socket.protocol}; waiting for serverInfo and channel advertisements...`);
});

socket.addEventListener('message', (event) => {
  const receivedAt = Date.now();
  if (typeof event.data === 'string') {
    const rawBytes = Buffer.from(event.data, 'utf8');
    let message;
    try { message = JSON.parse(event.data); } catch {
      write({ kind: 'text', receivedAt, byteLength: rawBytes.length, rawBase64: rawBytes.toString('base64'), text: event.data });
      return;
    }
    write({ kind: 'json', receivedAt, byteLength: rawBytes.length, rawBase64: rawBytes.toString('base64'), message });
    if (message.op === 'serverInfo') gotServerInfo = true;
    if (message.op === 'advertise' && Array.isArray(message.channels)) {
      gotAdvertise = true;
      const subscriptionsToSend = [];
      for (const channel of message.channels) {
        channels.set(channel.id, channel);
        const id = nextSubscriptionId++;
        subscriptions.set(id, channel);
        subscriptionsToSend.push({ id, channelId: channel.id });
      }
      if (subscriptionsToSend.length) {
        socket.send(JSON.stringify({ op: 'subscribe', subscriptions: subscriptionsToSend }));
        console.log(`Subscribed to ${subscriptionsToSend.length} advertised channels.`);
      }
    }
    return;
  }
  const raw = Buffer.from(event.data);
  const opcode = raw[0];
  let subscriptionId;
  let timestampNs;
  let payloadOffset = raw.length;
  let channel;
  if (opcode === 1 && raw.length >= 13) {
    subscriptionId = raw.readUInt32LE(1);
    timestampNs = raw.readBigUInt64LE(5).toString();
    payloadOffset = 13;
    channel = subscriptions.get(subscriptionId);
  }
  const row = {
    kind: 'binary', receivedAt, elapsedMs: receivedAt - startedAt, opcode,
    subscriptionId: subscriptionId ?? null, channelId: channel?.id ?? null,
    topic: channel?.topic ?? null, timestampNs: timestampNs ?? null,
    byteLength: raw.length, payloadByteLength: raw.length - payloadOffset,
    rawBase64: raw.toString('base64'), payloadBase64: raw.subarray(payloadOffset).toString('base64'),
  };
  write(row);
  if (channel) {
    const value = stats.get(channel.topic) ?? { count: 0, bytes: 0, largestBytes: 0, largestAt: null };
    value.count += 1;
    value.bytes += raw.length;
    if (raw.length > value.largestBytes) { value.largestBytes = raw.length; value.largestAt = receivedAt; }
    stats.set(channel.topic, value);
  }
});

socket.addEventListener('error', () => {
  if (!finished) stop(new Error(`WebSocket error connecting to ${endpoint}`));
});
socket.addEventListener('close', (event) => {
  if (!finished) stop(new Error(`WebSocket closed before capture completed (code ${event.code})`));
});

const handshakeCheck = setInterval(() => {
  if (Date.now() - startedAt > 5000 && (!gotServerInfo || !gotAdvertise)) {
    clearInterval(handshakeCheck);
    stop(new Error(`Connected but handshake incomplete (serverInfo=${gotServerInfo}, advertise=${gotAdvertise})`));
  }
}, 250);
timer = setTimeout(() => { clearInterval(handshakeCheck); stop(); }, durationSeconds * 1000);
