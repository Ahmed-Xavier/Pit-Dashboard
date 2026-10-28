/* ==========================================================================
   ENIMIA Dashboard — Temporary Debug Instrumentation & Watchdog
   Removable module activated only when config.debug is true.
   Tracks per-topic decode & update timing, TF frame parent flips,
   logs frames > 100ms, outputs 5s console summary, and renders in-page overlay.
   ========================================================================== */

import { config } from '/config.js';
import { store } from './state.js';

class DebugInstrumentation {
  constructor() {
    this.enabled = !!config.debug;
    this.topicStats = new Map();
    this.uiTickStats = { count: 0, totalMs: 0, maxMs: 0 };
    this.parentHistory = new Map(); // child -> { currentParent, changes: [] }
    this.recentTopics = []; // last 5 topics handled
    this.lastTopicTime = 0;
    this.watchdogTimer = null;
    this.lastWatchdogTick = performance.now();
    this.lastLoggedLongFrame = 0;
    this.startTime = performance.now();
    this.interval5sTimer = null;
    this.overlayEl = null;

    if (this.enabled) {
      console.warn('[DebugInstrumentation] Activated (config.debug = true). Starting 5s metrics & watchdog...');
      this.initOverlay();
      this.startWatchdog();
      this.start5sReporter();
    }
  }

  recordMessage(topic, byteSize, decodeMs, storeMs = 0) {
    if (!this.enabled) return;
    const now = performance.now();
    this.recentTopics.push(topic);
    if (this.recentTopics.length > 5) this.recentTopics.shift();
    this.lastTopicTime = now;

    const totalMs = decodeMs + storeMs;
    let stat = this.topicStats.get(topic);
    if (!stat) {
      stat = {
        count: 0,
        totalBytes: 0,
        totalDecodeMs: 0,
        totalStoreMs: 0,
        totalMs: 0,
        maxMs: 0,
        firstTime: now,
        lastTime: now
      };
      this.topicStats.set(topic, stat);
    }

    stat.count++;
    stat.totalBytes += byteSize;
    stat.totalDecodeMs += decodeMs;
    stat.totalStoreMs += storeMs;
    stat.totalMs += totalMs;
    if (totalMs > stat.maxMs) stat.maxMs = totalMs;
    stat.lastTime = now;
  }

  recordUiTick(elapsedMs) {
    if (!this.enabled) return;
    this.uiTickStats.count++;
    this.uiTickStats.totalMs += elapsedMs;
    this.uiTickStats.maxMs = Math.max(this.uiTickStats.maxMs, elapsedMs);
  }

  recordTfParentChange(child, newParent) {
    if (!this.enabled) return;
    let entry = this.parentHistory.get(child);
    if (!entry) {
      entry = { currentParent: newParent, count: 0, history: [newParent] };
      this.parentHistory.set(child, entry);
      return;
    }

    if (entry.currentParent !== newParent) {
      entry.count++;
      entry.history.push(newParent);
      console.warn(`[TF Watchdog] Frame "${child}" parent CHANGED from "${entry.currentParent}" to "${newParent}"! Total changes: ${entry.count}`);
      entry.currentParent = newParent;
    }
  }

  logLongFrame(source, durationMs) {
    if (!this.enabled) return;
    const now = performance.now();
    // Debounce logging to at most once per 500ms
    if (now - this.lastLoggedLongFrame < 500) return;
    this.lastLoggedLongFrame = now;

    const camMode = window.__scene3D?.cameraMode || 'unknown';
    console.warn(`[Watchdog Guard] ${source} took ${durationMs.toFixed(1)}ms (>100ms)! Recent topics: [${this.recentTopics.join(', ')}], Cam: ${camMode}`);
  }

  startWatchdog() {
    this.lastWatchdogTick = performance.now();

    const check = () => {
      const now = performance.now();
      const elapsed = now - this.lastWatchdogTick;
      this.lastWatchdogTick = now;

      if (elapsed > 100) {
        this.logLongFrame('RAF/Main-Thread', elapsed);
      }

      this.watchdogTimer = requestAnimationFrame(check);
    };

    this.watchdogTimer = requestAnimationFrame(check);
  }

  start5sReporter() {
    if (this.interval5sTimer) clearInterval(this.interval5sTimer);
    this.interval5sTimer = setInterval(() => {
      this.print5sSummary();
      this.updateOverlay();
    }, 5000);
  }

  getMetricsSummary() {
    const elapsedSec = Math.max(0.1, (performance.now() - this.startTime) / 1000);
    const rows = [];

    for (const [topic, s] of this.topicStats.entries()) {
      const activeSec = s.count > 1 ? Math.max(0.001, (s.lastTime - s.firstTime) / 1000) : elapsedSec;
      const hz = (s.count > 1 ? (s.count - 1) / activeSec : s.count / activeSec).toFixed(1);
      const avgDecode = (s.totalDecodeMs / Math.max(1, s.count)).toFixed(3);
      const avgTotal = (s.totalMs / Math.max(1, s.count)).toFixed(3);
      const avgBytes = Math.round(s.totalBytes / Math.max(1, s.count));

      rows.push({
        topic,
        count: s.count,
        hz: parseFloat(hz),
        avgMs: parseFloat(avgTotal),
        maxMs: parseFloat(s.maxMs.toFixed(2)),
        avgDecodeMs: parseFloat(avgDecode),
        avgBytes,
        totalKb: parseFloat((s.totalBytes / 1024).toFixed(1))
      });
    }

    rows.sort((a, b) => b.hz - a.hz);
    const uiTick = {
      count: this.uiTickStats.count,
      avgMs: this.uiTickStats.count ? this.uiTickStats.totalMs / this.uiTickStats.count : 0,
      maxMs: this.uiTickStats.maxMs
    };
    return { elapsedSec: elapsedSec.toFixed(1), rows, uiTick };
  }

  print5sSummary() {
    const { elapsedSec, rows } = this.getMetricsSummary();
    console.log(`%c[DebugInstrumentation 5s Summary — ${elapsedSec}s elapsed]`, 'color: #38bdf8; font-weight: bold;');
    if (rows.length > 0) {
      console.table(rows.map(r => ({
        Topic: r.topic,
        Count: r.count,
        'Rate (Hz)': r.hz,
        'Avg (ms)': r.avgMs,
        'Max (ms)': r.maxMs,
        'Avg Bytes': r.avgBytes,
        'Total (KB)': r.totalKb
      })));
    } else {
      console.log('No topic messages received yet.');
    }
  }

  initOverlay() {
    if (document.getElementById('debug-metrics-overlay')) return;
    const div = document.createElement('div');
    div.id = 'debug-metrics-overlay';
    div.style.cssText = `
      position: fixed;
      bottom: 12px;
      left: 12px;
      z-index: 99999;
      background: rgba(18, 20, 24, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 8px 12px;
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      color: #e2e8f0;
      max-width: 480px;
      max-height: 280px;
      overflow-y: auto;
      pointer-events: none;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    `;
    div.innerHTML = `<div style="font-weight: bold; color: #38bdf8; margin-bottom: 4px;">LIVE METRICS MONITOR (config.debug)</div><div id="debug-overlay-content">Waiting for messages...</div>`;
    document.body.appendChild(div);
    this.overlayEl = div;
  }

  updateOverlay() {
    const content = document.getElementById('debug-overlay-content');
    if (!content) return;
    const { elapsedSec, rows } = this.getMetricsSummary();
    const fps = window.__scene3D?.fps ?? '--';
    const topRows = rows.slice(0, 8);

    const protocol = store.connection?.protocol || 'not connected';
    let html = `<div style="margin-bottom: 6px; color: #94a3b8;">Elapsed: ${elapsedSec}s | Protocol: ${protocol} | 3D FPS: <span style="color:#4ade80;">${fps}</span> | Topics: ${rows.length}</div>`;
    html += `<table style="width:100%; border-collapse: collapse; font-size: 9px; text-align: left;">`;
    html += `<tr style="border-bottom: 1px solid #334155; color: #64748b;"><th>TOPIC</th><th>HZ</th><th>AVG MS</th><th>BYTES</th></tr>`;
    for (const r of topRows) {
      html += `<tr><td style="color:#cbd5e1;">${r.topic}</td><td style="color:#38bdf8;">${r.hz}</td><td>${r.avgMs}</td><td>${r.avgBytes}</td></tr>`;
    }
    html += `</table>`;
    content.innerHTML = html;
  }
}

export const debugInstrumentation = new DebugInstrumentation();
