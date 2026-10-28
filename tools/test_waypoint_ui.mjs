#!/usr/bin/env node
// Integration check for the four Trigger buttons and PointStamped click path.
// Requires system Chrome, Playwright from the sibling Lichtblick checkout, and Python.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(root, '..', 'lichtblick', 'node_modules', 'playwright'));
const children = [];
let mockOutput = '';
let staticServer;
function start(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (chunk) => { const s = chunk.toString(); mockOutput += s; process.stdout.write(s); });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}
async function waitPort(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1', resolve); s.once('error', reject); s.once('connect', () => s.destroy()); }); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(`Port ${port} did not open`);
}

let browser;
try {
  start(process.execPath, [path.join(root, 'tools', 'mock_bridge.mjs'), '--port', '8879', '--waypoint-markers-hz', '1']);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.sdf': 'application/xml', '.dae': 'model/vnd.collada+xml', '.stl': 'model/stl' };
  staticServer = http.createServer((request, response) => {
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
  staticServer.listen(8089, '127.0.0.1');
  await Promise.all([waitPort(8879), waitPort(8089)]);
  browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', (error) => { console.error('[page error]', error.message); mockOutput += `[page error] ${error.message}\n`; });
  page.on('console', (message) => { if (message.type() === 'error') { console.error('[page console]', message.text()); mockOutput += `[page console] ${message.text()}\n`; } });
  page.on('requestfailed', (request) => console.error('[request failed]', request.url(), request.failure()?.errorText));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('http://127.0.0.1:8089/?bridge=ws%3A%2F%2F127.0.0.1%3A8879', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  if (await page.locator('#btn-mode-live').count() === 0) throw new Error(`Dashboard failed to mount; title=${await page.title()} body=${(await page.locator('body').innerText()).slice(0, 300)}`);
  await page.locator('#btn-mode-live').click();
  await page.waitForFunction(() => window.__foxgloveProtocol && document.querySelector('[data-waypoint-action="start"]')?.disabled === false, null, { timeout: 12_000 });
  const results = [];
  for (const action of ['start', 'add', 'undo', 'clear']) {
    const button = page.locator(`[data-waypoint-action="${action}"]`);
    await button.click();
    const serviceName = `/waypoints/${action === 'add' ? 'add_here' : action}`;
    await page.waitForFunction((name) => document.querySelector('.waypoint-action-result')?.textContent.includes(`ok (Mock accepted ${name})`), serviceName, { timeout: 4000 });
    const result = await page.locator('.waypoint-action-result').textContent();
    const latencyMs = await page.evaluate(async (name) => {
      const { store } = await import('/src/state.js');
      return Number(store.events.find((event) => event.source === 'WAYPOINT_SERVICE' && event.message.startsWith(`${name}:`))?.message.match(/\(([\d.]+) ms\)/)?.[1] ?? NaN);
    }, serviceName);
    results.push({ action, result, latencyMs });
  }
  await page.locator('#btn-cam-topdown').click();
  await page.evaluate(() => { window.__waypointClickSeen = false; document.querySelector('#btn-add-waypoint-mode').addEventListener('click', () => { window.__waypointClickSeen = true; }); });
  await page.locator('#btn-add-waypoint-mode').click();
  console.log('[test] click mode', await page.evaluate(async () => { const { rosBridge } = await import('/src/rosBridge.js'); const { store } = await import('/src/state.js'); return { clickSeen: window.__waypointClickSeen, mode: window.__scene3D?.addWaypointMode, button: document.querySelector('#btn-add-waypoint-mode')?.className, status: store.connection.status, storeMode: store.mode, wsState: rosBridge.ws?.readyState, capabilities: [...rosBridge.capabilities], events: store.events?.slice?.(0, 3), canvas: document.querySelector('#scene3d-canvas')?.getBoundingClientRect().toJSON() }; }));
  await page.locator('#scene3d-canvas').click({ position: { x: 300, y: 220 } });
  await page.waitForTimeout(300);
  const pointCountAfterClick = (mockOutput.match(/\[clientPublish\] \/clicked_point/g) || []).length;
  await page.locator('#btn-add-waypoint-mode').click();
  const box = await page.locator('#scene3d-canvas').boundingBox();
  await page.mouse.move(box.x + 400, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 430, box.y + 330, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  if ((mockOutput.match(/\[clientPublish\] \/clicked_point/g) || []).length !== pointCountAfterClick) throw new Error('Orbit drag incorrectly published a waypoint');
  if (!(await page.evaluate(() => window.__scene3D?.addWaypointMode))) throw new Error('Waypoint click mode ended after an orbit drag');
  await page.locator('#btn-add-waypoint-mode').click();
  console.log('[test] after click', await page.evaluate(() => ({ mode: window.__scene3D?.addWaypointMode, preview: window.__scene3D?.waypointPreview?.visible, position: window.__scene3D?.waypointPreview?.position.toArray(), faults: window.__store?.faults?.slice?.(0, 3) })));
  await page.waitForTimeout(300);
  for (const needle of ['/waypoints/start', '/waypoints/add_here', '/waypoints/undo', '/waypoints/clear', '[clientPublish] /clicked_point']) {
    if (!mockOutput.includes(needle)) throw new Error(`Mock did not observe ${needle}`);
  }
  const pointLine = mockOutput.split(/\r?\n/).find((line) => line.includes('[clientPublish] /clicked_point'));
  if (!pointLine?.includes('frame_id=map')) throw new Error(`Unexpected clicked-point output: ${pointLine}`);
  const coordinates = pointLine.match(/x=([^ ]+) y=([^ ]+)/);
  if (!coordinates || !Number.isFinite(Number(coordinates[1])) || !Number.isFinite(Number(coordinates[2]))) throw new Error(`Mock decoded non-finite click coordinates: ${pointLine}`);
  console.log(JSON.stringify({ results, clickedPoint: pointLine }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
  for (const child of children) child.kill('SIGTERM');
}
