#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';

const endpoint = process.argv.find((value) => value.startsWith('--url='))?.slice(6) ?? 'ws://127.0.0.1:8765';
for (const protocol of ['foxglove.sdk.v1', 'foxglove.websocket.v1']) {
  const socket = new WebSocket(endpoint, [protocol]);
  let sawServerInfo = false;
  let sawAdvertise = false;
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      const message = JSON.parse(event.data);
      if (message.op === 'serverInfo') sawServerInfo = true;
      if (message.op === 'advertise') sawAdvertise = true;
    } catch {}
  });
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`${protocol}: handshake error`)), { once: true });
      socket.addEventListener('close', (event) => reject(new Error(`${protocol}: closed (${event.code})`)), { once: true });
    }),
    delay(3000).then(() => { throw new Error(`${protocol}: handshake timeout`); }),
  ]);
  await delay(250);
  if (socket.protocol !== protocol || !sawServerInfo || !sawAdvertise) throw new Error(`${protocol}: protocol=${socket.protocol}, serverInfo=${sawServerInfo}, advertise=${sawAdvertise}`);
  console.log(`${protocol}: negotiated; serverInfo and channel advertise received`);
  socket.close();
}
