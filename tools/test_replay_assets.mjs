#!/usr/bin/env node
// Verify replay_bridge fetchAsset responses using a real SDK-v1 WebSocket client.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8877;
const child = spawn(process.execPath, [path.join(root, 'tools/replay_bridge.mjs'), `--capture=${path.join(root, 'tools/captures/real_20261020T050317Z.jsonl')}`, `--port=${port}`], { cwd: root, stdio: 'inherit' });
let socket;
async function waitPort() {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    try { await new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1', resolve); s.once('error', reject); s.once('connect', () => s.destroy()); }); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('Replay server did not listen');
}
try {
  await waitPort();
  socket = new WebSocket(`ws://127.0.0.1:${port}`, ['foxglove.sdk.v1']);
  socket.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const requestId = 7001;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fetchAsset response timed out')), 5000);
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') return;
      const bytes = new Uint8Array(event.data);
      if (bytes[0] !== 4 || new DataView(bytes.buffer).getUint32(1, true) !== requestId) return;
      clearTimeout(timer);
      const view = new DataView(bytes.buffer);
      resolve({ status: view.getUint8(5), errorLength: view.getUint32(6, true), assetBytes: bytes.byteLength - 10 - view.getUint32(6, true) });
    });
  });
  socket.send(JSON.stringify({ op: 'fetchAsset', uri: 'package://vehicle_description/meshes/body_shell.dae', requestId }));
  const result = await response;
  if (result.status !== 0 || result.errorLength !== 0 || result.assetBytes < 1000) throw new Error(`Invalid asset response: ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ protocol: socket.protocol, uri: 'package://vehicle_description/meshes/body_shell.dae', ...result }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill('SIGTERM');
}
