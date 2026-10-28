#!/usr/bin/env node
// Headed browser check for tile loading, request bounds, and visible attribution.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(root, '..', 'lichtblick', 'node_modules', 'playwright'));
const png = fs.readFileSync(path.join(root, '_archive/initial-artifact/enimia-dashboard/dashboard_main.png'));
let active = 0, maxActive = 0, requests = 0;
const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, body) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': path.extname(file) === '.html' ? 'text/html' : path.extname(file) === '.js' ? 'text/javascript' : path.extname(file) === '.css' ? 'text/css' : 'application/octet-stream' });
    res.end(body);
  });
});
async function waitPort(port) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    try { await new Promise((resolve, reject) => { const socket = net.connect(port, '127.0.0.1', resolve); socket.once('error', reject); socket.once('connect', () => socket.destroy()); }); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('Dashboard HTTP server did not start');
}
let browser;
try {
  server.listen(8092, '127.0.0.1'); await waitPort(8092);
  browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  page.on('pageerror', (error) => console.error('[page error]', error.message));
  page.on('console', (message) => { if (message.type() === 'error') console.error('[browser console]', message.text()); });
  await page.route('https://tile.openstreetmap.org/**', async (route) => {
    requests++; active++; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 80));
    active--; await route.fulfill({ status: 200, contentType: 'image/png', body: png, headers: { 'Cache-Control': 'public, max-age=3600' } });
  });
  await page.goto('http://127.0.0.1:8092/', { waitUntil: 'domcontentloaded' });
  await page.locator('#world-provider-select').waitFor();
  await page.locator('#world-provider-select').selectOption('xyz-osm');
  await page.waitForFunction(() => window.__scene3D?.mapStats?.requestsPerSession >= 1, null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const result = await page.evaluate(async () => {
    const provider = window.__scene3D.worldProviders.providers.get('xyz-osm');
    const { store } = await import('/src/state.js');
    return { selected: window.__scene3D.worldProviderId, requests: provider.requestCount,
      visibleTiles: [...provider.tiles.values()].filter((tile) => tile.mesh?.visible).length,
      tiles: [...provider.tiles].map(([key, tile]) => ({ key, status: tile.status, retries: tile.retries, error: tile.error })),
      attributionVisible: !document.querySelector('#map-attribution').hidden,
      attribution: document.querySelector('#map-attribution').textContent,
      gridVisible: window.__scene3D.gridHelper.visible,
      liveMinimapBadge: document.querySelector('#nav-mode-badge').textContent,
      sdfCenterlinePoints: store.trackCenterline.length };
  });
  if (result.selected !== 'xyz-osm' || result.visibleTiles < 1 || !result.attributionVisible || maxActive > 2 || result.liveMinimapBadge !== 'LIVE TRACK' || result.sdfCenterlinePoints) throw new Error(`Map provider check failed: ${JSON.stringify({ result, requests, maxActive })}`);
  const deniedPage = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  let deniedRequests = 0;
  await deniedPage.route('https://tile.openstreetmap.org/**', (route) => { deniedRequests++; return route.fulfill({ status: 429, body: 'rate limited' }); });
  await deniedPage.goto('http://127.0.0.1:8092/', { waitUntil: 'domcontentloaded' });
  await deniedPage.locator('#world-provider-select').waitFor();
  await deniedPage.waitForTimeout(2500);
  const fallback = await deniedPage.evaluate(() => ({ provider: window.__scene3D.worldProviderId, activeProvider: window.__scene3D.worldProviders.active?.id,
    lastRequest: window.__scene3D.lastWorldProviderRequest, lastLoaded: window.__scene3D.lastWorldProviderLoaded, error: window.__scene3D.worldProviderError,
    requests: window.__scene3D.worldProviderRequests, block: window.__scene3D.lastTileBlock,
    status: document.querySelector('#scene3d-map-status').textContent, gridVisible: window.__scene3D.gridHelper.visible,
    attributionVisible: !document.querySelector('#map-attribution').hidden }));
  if (fallback.provider !== 'grid' || !fallback.gridVisible || fallback.attributionVisible) throw new Error(`Map rate-limit fallback failed: ${JSON.stringify({ fallback, deniedRequests })}`);
  await deniedPage.locator('#world-provider-select').selectOption('xyz-osm');
  await deniedPage.waitForFunction(() => window.__scene3D.worldProviderId === 'grid' && document.querySelector('#scene3d-map-status')?.textContent === 'MAP BLOCKED (429)' && window.__scene3D.worldProviders.providers.get('xyz-osm').requestCount >= 2, null, { timeout: 5000 });
  console.log(JSON.stringify({ result, fallback, retryAfterUserSelection: { selected: await deniedPage.evaluate(() => window.__scene3D.worldProviderId), deniedRequests }, interceptedRequests: requests, maxConcurrentRequests: maxActive }, null, 2));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (browser) await browser.close().catch(() => {}); await new Promise((resolve) => server.close(resolve)); }
