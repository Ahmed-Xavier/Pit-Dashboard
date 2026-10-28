#!/usr/bin/env node
// Headed, GPU-backed replay regression. Requires system Chrome, Playwright,
// Python 3, and a desktop session. Does not add SwiftShader flags.
// Usage: node tools/test_replay_browser.mjs [--duration-sec=60] [--topics=all]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
  const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)];
}));
const durationSec = Number(options['duration-sec'] ?? 60);
const topics = options.topics ?? 'all';
const webPort = Number(options['web-port'] ?? 8088);
const replayPort = Number(options['replay-port'] ?? 8878);
const bridgeUrl = options['bridge-url'] ?? `ws://127.0.0.1:${replayPort}`;
const outDir = path.join(root, 'tools', 'results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const reportPath = path.join(outDir, `replay-browser-${stamp}.json`);
const stackPath = path.join(outDir, 'freeze_stack.json');
const children = [];
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(root, '..', 'lichtblick', 'node_modules', 'playwright'));

function start(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}
async function waitPort(port) {
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', resolve);
        socket.once('error', reject);
        socket.once('connect', () => socket.destroy());
      });
      return;
    } catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  throw new Error(`Port ${port} did not open`);
}
async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}

let browser, page, session, watchdogTimer;
let firstLongTask500ms = null;
const longTasks = [];
const watchdog = { fires: 0, details: null };
try {
  if (!options['bridge-url']) {
    start(process.execPath, [path.join(root, 'tools', 'replay_bridge.mjs'), `--capture=${path.join(root, 'tools', 'captures', 'real_20261020T050317Z.jsonl')}`, `--port=${replayPort}`]);
  }
  start(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'http.server', String(webPort), '--bind', '127.0.0.1']);
  await Promise.all([waitPort(replayPort), waitPort(webPort)]);
  // No --use-angle=swiftshader or headless flags: use the desktop Chrome GPU path.
  browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext();
  page = await context.newPage();
  page.on('console', (message) => { if (message.type() === 'error') console.error(`[page console] ${message.text()}`); });
  page.on('pageerror', (error) => console.error(`[page error] ${error}`));
  await page.addInitScript(() => {
    window.__longTasks = [];
    try { new PerformanceObserver((list) => window.__longTasks.push(...list.getEntries().map((entry) => ({ startTime: entry.startTime, duration: entry.duration, name: entry.name }))))
      .observe({ type: 'longtask', buffered: true }); } catch {}
  });
  session = await context.newCDPSession(page);
  await session.send('Debugger.enable');
  let pausedResolve;
  const paused = new Promise((resolve) => { pausedResolve = resolve; });
  session.on('Debugger.paused', (event) => pausedResolve(event));
  await page.goto(`http://127.0.0.1:${webPort}/?bridge=${encodeURIComponent(bridgeUrl)}&topics=${encodeURIComponent(topics)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#btn-mode-live').click();
  const liveAt = Date.now();
  const livePerfAt = await page.evaluate(() => performance.now());

  watchdogTimer = setInterval(async () => {
    if (watchdog.fires) return;
    try {
      await withTimeout(session.send('Runtime.evaluate', { expression: '1', returnByValue: true }), 1500, 'Runtime.evaluate watchdog timeout');
    } catch (error) {
      watchdog.fires++;
      watchdog.details = { atMs: Date.now() - liveAt, error: error.message };
      try {
        await session.send('Debugger.pause');
        const pauseEvent = await withTimeout(paused, 3000, 'Debugger.pause did not arrive');
        const frames = [];
        for (const frame of (pauseEvent.callFrames ?? []).slice(0, 3)) {
          let locals = [];
          const localScope = frame.scopeChain?.find((scope) => scope.type === 'local');
          if (localScope) {
            const properties = await session.send('Runtime.getProperties', { objectId: localScope.object.objectId, ownProperties: true });
            locals = (properties.result ?? []).map((item) => ({ name: item.name, value: item.value?.value ?? item.value?.description ?? item.value?.type }));
          }
          frames.push({ functionName: frame.functionName, url: frame.url, line: frame.location.lineNumber + 1, column: frame.location.columnNumber + 1, locals });
        }
        fs.writeFileSync(stackPath, JSON.stringify({ capturedAt: new Date().toISOString(), reason: 'Runtime.evaluate watchdog timeout', frames }, null, 2));
      } catch (pauseError) {
        watchdog.details.pause = pauseError.message;
        try {
          await session.send('Profiler.enable');
          await session.send('Profiler.start');
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const profile = await session.send('Profiler.stop');
          fs.writeFileSync(path.join(outDir, 'freeze_profile.json'), JSON.stringify(profile.profile));
          watchdog.details.profile = path.join(outDir, 'freeze_profile.json');
          watchdog.details.interpretation = 'Debugger.pause did not arrive; stall may be outside JavaScript.';
        } catch (profileError) { watchdog.details.profileError = profileError.message; }
      }
    }
  }, 500);

  const heapSamples = [];
  const sampleSeconds = new Set([1, 60, 180, 300, durationSec]);
  for (let second = 1; second <= durationSec && !watchdog.fires; second++) {
    await page.waitForTimeout(1000);
    if (sampleSeconds.has(second)) {
      try {
        heapSamples.push(await withTimeout(page.evaluate(async at => {
          const { debugInstrumentation } = await import('./src/debugInstrumentation.js');
          return { second: at, usedHeapBytes: performance.memory?.usedJSHeapSize ?? null,
            topicMetrics: debugInstrumentation.getMetricsSummary(), protocol: window.__foxgloveProtocol ?? null };
        }, second), 1500, 'heap sample timed out'));
      } catch (error) { heapSamples.push({ second, error: error.message }); }
    }
  }
  clearInterval(watchdogTimer);
  const observations = watchdog.fires ? [] : await page.evaluate(() => window.__longTasks ?? []);
  longTasks.push(...observations);
  const afterThreeSeconds = longTasks.filter((task) => task.startTime > livePerfAt + 3000);
  const over200ms = afterThreeSeconds.filter((task) => task.duration > 200);
  const firstOver500 = longTasks.find((task) => task.duration > 500 && task.startTime >= livePerfAt);
  firstLongTask500ms = firstOver500 ? firstOver500.startTime - livePerfAt : null;
  const result = { generatedAt: new Date().toISOString(), durationSec, bridgeUrl, topics, liveToFirstLongTaskOver500Ms: firstLongTask500ms,
    longTaskCount: longTasks.length, afterThreeSeconds: afterThreeSeconds.length, over200ms: over200ms.length,
    maxLongTaskAfterThreeSecondsMs: Math.max(0, ...afterThreeSeconds.map((task) => task.duration)), watchdog,
    heapSamples, browser: await browser.version(), negotiatedProtocol: heapSamples.find((sample) => sample.protocol)?.protocol ?? null,
    longTasks, reportPath, freezeStackPath: fs.existsSync(stackPath) ? stackPath : null };
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (watchdog.fires || over200ms.length) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearInterval(watchdogTimer);
  if (browser) await browser.close().catch(() => {});
  for (const child of children) child.kill('SIGTERM');
}
