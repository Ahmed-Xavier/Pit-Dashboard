#!/usr/bin/env node
// Headed integration check for LIVE /robot_description and bridge fetchAsset.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(root, '..', 'lichtblick', 'node_modules', 'playwright'));
const children = [];
const start = (cmd, args) => { const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' }); children.push(child); return child; };
async function waitPort(port) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try { await new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1', resolve); s.once('error', reject); s.once('connect', () => s.destroy()); }); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(`Port ${port} did not open`);
}
let web, browser;
try {
  start(process.execPath, [path.join(root, 'tools/replay_bridge.mjs'), `--capture=${path.join(root, 'tools/captures/real_20261020T050317Z.jsonl')}`, '--port=8876']);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.sdf': 'application/xml', '.dae': 'model/vnd.collada+xml', '.stl': 'model/stl' };
  web = http.createServer((request, response) => {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') pathname = '/index.html';
    const file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    fs.readFile(file, (error, content) => {
      if (error) { response.writeHead(404).end('Not found'); return; }
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(content);
    });
  });
  web.listen(8091, '127.0.0.1');
  await Promise.all([waitPort(8876), waitPort(8091)]);
  browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', (error) => console.error('[page error]', error.message));
  await page.goto('http://127.0.0.1:8091/?bridge=ws%3A%2F%2F127.0.0.1%3A8876&topics=robot_description', { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-mode-live').click();
  await page.waitForFunction(() => document.querySelector('#scene3d-urdf-status')?.textContent.includes('(LIVE)'), null, { timeout: 35_000 });
  const first = await page.evaluate(() => ({ status: document.querySelector('#scene3d-urdf-status').textContent,
    localCarLoaded: window.__scene3D.localCarLoaded, sdfLoaded: window.__scene3D.sdfLoaded,
    metrics: window.__scene3D.carGroup.userData.liveMetrics, buildCount: window.__scene3D.liveDescriptionBuilds }));
  if (first.localCarLoaded || first.sdfLoaded || first.buildCount !== 1) throw new Error(`Unexpected LIVE build state: ${JSON.stringify(first)}`);
  await page.evaluate(async () => {
    const { rosBridge } = await import('/src/rosBridge.js');
    const oldSocket = rosBridge.ws;
    rosBridge.disconnect();
    if (oldSocket && oldSocket.readyState !== WebSocket.CLOSED) await new Promise((resolve) => oldSocket.addEventListener('close', resolve, { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    rosBridge.connect();
  });
  await page.waitForFunction(async () => { const { store } = await import('/src/state.js'); const { rosBridge } = await import('/src/rosBridge.js'); return store.connection.status === 'CONNECTED' && rosBridge.ws?.readyState === WebSocket.OPEN && window.__foxgloveProtocol; }, null, { timeout: 12_000 });
  await page.waitForTimeout(1000);
  const afterReconnect = await page.evaluate(() => ({ buildCount: window.__scene3D.liveDescriptionBuilds, status: document.querySelector('#scene3d-urdf-status').textContent }));
  if (afterReconnect.buildCount !== 1) throw new Error(`URDF rebuilt after reconnect: ${JSON.stringify(afterReconnect)}`);
  console.log(JSON.stringify({ firstBuild: first, afterReconnect, protocol: await page.evaluate(() => window.__foxgloveProtocol) }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (web) await new Promise((resolve) => web.close(resolve));
  for (const child of children) child.kill('SIGTERM');
}
