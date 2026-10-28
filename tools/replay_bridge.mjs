#!/usr/bin/env node
// Replays a captured Foxglove session at its recorded timing and loops it.
// Usage: node tools/replay_bridge.mjs --capture tools/captures/real_....jsonl [--port 8765]
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';

const arg = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const capturePath = path.resolve(arg('capture', 'tools/captures/real_20261020T050317Z.jsonl'));
const port = Number(arg('port', '8765'));
const rows = fs.readFileSync(capturePath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const events = rows.filter((row) => row.kind === 'json' || row.kind === 'binary').sort((a, b) => a.receivedAt - b.receivedAt);
if (!events.length) throw new Error(`No replayable frames in ${capturePath}`);
const firstAt = events[0].receivedAt;
const loopMs = Math.max(1, events.at(-1).receivedAt - firstAt);
const protocols = ['foxglove.sdk.v1', 'foxglove.websocket.v1'];

function wsFrame(opcode, body) {
  const payload = Buffer.from(body);
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
}

const clients = new Set();
const socketOpen = (socket) => !socket.destroyed && !socket.writableEnded && socket.writable;
function broadcastJson(client, obj) {
  if (socketOpen(client.socket)) client.socket.write(wsFrame(1, JSON.stringify(obj)));
}
function replayEvent(client, row, loopIndex) {
  if (row.kind === 'json') {
    broadcastJson(client, row.message);
    return;
  }
  if (row.opcode !== 1 || row.channelId == null) return;
  const subscriptionId = client.subscriptions.get(row.channelId);
  if (subscriptionId == null) return;
  const payload = Buffer.from(row.payloadBase64, 'base64');
  const frame = Buffer.alloc(13 + payload.length);
  frame[0] = 1;
  frame.writeUInt32LE(subscriptionId, 1);
  const timestamp = BigInt(row.timestampNs || 0) + BigInt(loopIndex) * BigInt(loopMs) * 1_000_000n;
  frame.writeBigUInt64LE(timestamp, 5);
  payload.copy(frame, 13);
  if (socketOpen(client.socket)) client.socket.write(wsFrame(2, frame));
}

function resolveAssetPath(uri) {
  let name = '';
  try {
    if (uri.startsWith('package://')) name = decodeURIComponent(new URL(uri.replace('package://', 'http://')).pathname.split('/').filter(Boolean).at(-1) || '');
    else name = path.basename(new URL(uri, 'http://localhost').pathname);
  } catch { name = path.basename(uri); }
  if (!name || name !== path.basename(name)) return null;
  const candidate = path.resolve(path.dirname(capturePath), '..', '..', 'assets', 'meshes', name);
  const meshRoot = path.resolve(path.dirname(capturePath), '..', '..', 'assets', 'meshes');
  return candidate.startsWith(meshRoot + path.sep) ? candidate : null;
}

function sendFetchAssetResponse(client, requestId, data, error = '') {
  const errorBytes = Buffer.from(error, 'utf8');
  const payload = Buffer.alloc(10 + errorBytes.length + (data?.length || 0));
  payload[0] = 4;
  payload.writeUInt32LE(requestId >>> 0, 1);
  payload.writeUInt8(error ? 1 : 0, 5);
  payload.writeUInt32LE(errorBytes.length, 6);
  errorBytes.copy(payload, 10);
  if (data?.length) data.copy(payload, 10 + errorBytes.length);
  if (socketOpen(client.socket)) client.socket.write(wsFrame(2, payload));
}

function startReplay(client) {
  const origin = Date.now();
  let index = 0;
  const tick = () => {
    if (!socketOpen(client.socket)) return;
    const elapsed = Date.now() - origin;
    const loopIndex = Math.floor(elapsed / loopMs);
    const inLoop = elapsed % loopMs;
    while (index < events.length && events[index].receivedAt - firstAt <= inLoop) replayEvent(client, events[index++], loopIndex);
    if (index >= events.length) {
      index = 0;
      client.timer = setTimeout(tick, Math.max(1, loopMs - inLoop));
      return;
    }
    const nextTime = events[index].receivedAt - firstAt;
    const wait = Math.max(1, Math.min(50, nextTime - inLoop));
    client.timer = setTimeout(tick, wait);
  };
  tick();
}

const server = net.createServer((socket) => {
  const client = { socket, subscriptions: new Map(), pending: Buffer.alloc(0), upgraded: false, timer: null };
  clients.add(client);
  const parseClientFrames = () => {
    while (client.pending.length >= 2) {
      const opcode = client.pending[0] & 0x0f;
      const masked = !!(client.pending[1] & 0x80);
      let length = client.pending[1] & 0x7f, headerLength = 2;
      if (length === 126) { if (client.pending.length < 4) return; length = client.pending.readUInt16BE(2); headerLength = 4; }
      else if (length === 127) { if (client.pending.length < 10) return; length = Number(client.pending.readBigUInt64BE(2)); headerLength = 10; }
      const maskLength = masked ? 4 : 0;
      if (client.pending.length < headerLength + maskLength + length) return;
      const maskAt = headerLength;
      const bodyAt = headerLength + maskLength;
      let body = client.pending.subarray(bodyAt, bodyAt + length);
      if (masked) {
        body = Buffer.from(body);
        for (let i = 0; i < body.length; i++) body[i] ^= client.pending[maskAt + (i % 4)];
      }
      client.pending = client.pending.subarray(bodyAt + length);
      if (opcode === 8) { socket.end(); return; }
      if (opcode === 9) { socket.write(wsFrame(10, body)); continue; }
      if (opcode !== 1) continue;
      let message;
      try { message = JSON.parse(body.toString('utf8')); } catch { continue; }
      if (message.op === 'subscribe') {
        for (const subscription of message.subscriptions ?? []) client.subscriptions.set(subscription.channelId, subscription.id);
      } else if (message.op === 'unsubscribe') {
        for (const id of message.subscriptionIds ?? []) {
          for (const [channelId, subscriptionId] of client.subscriptions) if (subscriptionId === id) client.subscriptions.delete(channelId);
        }
      } else if (message.op === 'fetchAsset' && Number.isInteger(message.requestId) && typeof message.uri === 'string') {
        const assetPath = resolveAssetPath(message.uri);
        if (!assetPath || !fs.existsSync(assetPath)) sendFetchAssetResponse(client, message.requestId, null, `Asset not found in local assets/meshes: ${message.uri}`);
        else sendFetchAssetResponse(client, message.requestId, fs.readFileSync(assetPath));
      }
    }
  };
  socket.on('data', (chunk) => {
    client.pending = Buffer.concat([client.pending, chunk]);
    if (!client.upgraded) {
      const end = client.pending.indexOf('\r\n\r\n');
      if (end < 0) return;
      const request = client.pending.subarray(0, end).toString('utf8');
      const key = request.match(/Sec-WebSocket-Key:\s*(.+)/i)?.[1]?.trim();
      const offered = request.match(/Sec-WebSocket-Protocol:\s*(.+)/i)?.[1]?.split(',').map((item) => item.trim()) ?? [];
      const protocol = protocols.find((candidate) => offered.includes(candidate));
      if (!key || !protocol) { socket.destroy(); return; }
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`);
      client.pending = client.pending.subarray(end + 4);
      client.upgraded = true;
      console.log(`[replay] client connected using ${protocol}`);
      startReplay(client);
    }
    parseClientFrames();
  });
  socket.on('error', (error) => console.warn(`[replay] socket ${error.code || error.message}`));
  socket.on('close', () => { clearTimeout(client.timer); clients.delete(client); });
});

server.listen(port, '127.0.0.1', () => console.log(`[replay] ${capturePath} (${events.length} frames, ${loopMs} ms loop) on ws://127.0.0.1:${port}; protocols: ${protocols.join(', ')}`));
