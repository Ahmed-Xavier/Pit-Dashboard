/* ==========================================================================
   ENIMIA Dashboard — Track & Navigation Schematic Component
   Circuit schematic with waypoint tracking, cross-track error, and progress
   ========================================================================== */

import { store } from '../state.js';
import { demoProvider } from '../demoProvider.js';

export class TrackNavComponent {
  constructor(containerEl) {
    this.container = containerEl;
    this.canvas = null;
    this.ctx = null;
    this.init();
    this.startRenderLoop();
  }

  init() {
    this.container.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-group">
          <span class="panel-title">CIRCUIT SCHEMATIC & NAVIGATION</span>
          <span class="panel-badge" id="nav-mode-badge">NAV2 ACTIVE</span>
        </div>
        <div class="panel-controls">
          <span class="tech-label" id="nav-lap-counter">LAP 2 / 10</span>
        </div>
      </div>

      <div class="track-canvas-wrapper" id="track-canvas-wrapper">
        <canvas id="track-canvas"></canvas>

        <div class="track-hud-overlay">
          <div class="track-hud-item">
            <span class="hud-key">ACTIVE TARGET</span>
            <span class="hud-val" id="nav-active-wp">WP04 (Apex)</span>
          </div>
          <div class="track-hud-item">
            <span class="hud-key">DIST TO WP</span>
            <span class="hud-val tabular-nums" id="nav-wp-dist">14.6 m</span>
          </div>
          <div class="track-hud-item">
            <span class="hud-key">CROSS-TRACK ERR</span>
            <span class="hud-val tabular-nums" id="nav-cte">+0.04 m</span>
          </div>
          <div class="track-hud-item">
            <span class="hud-key">LAP PROGRESS</span>
            <span class="hud-val tabular-nums" id="nav-progress">34.2%</span>
          </div>
        </div>
      </div>
    `;

    this.canvas = this.container.querySelector('#track-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.wrapper = this.container.querySelector('#track-canvas-wrapper');

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.displayWidth = rect.width;
    this.displayHeight = rect.height;
  }

  startRenderLoop() {
    const render = () => {
      this.draw();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }

  draw() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const w = this.displayWidth;
    const h = this.displayHeight;

    // Clear background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    const spline = demoProvider.trackSpline;
    const dense = demoProvider.denseTrack;
    if (!dense || dense.length === 0) return;

    // Calculate bounding box of track to center and scale perfectly
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of dense) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }

    const pad = 24;
    const trackW = maxX - minX;
    const trackH = maxY - minY;
    const scale = Math.min((w - pad * 2) / trackW, (h - pad * 2 - 28) / trackH);

    const offsetX = (w - trackW * scale) / 2 - minX * scale;
    const offsetY = (h - 28 - trackH * scale) / 2 + maxY * scale;

    const toScreen = (x, y) => ({
      x: offsetX + x * scale,
      y: offsetY - y * scale
    });

    // 1. Draw Track Surface Ribbon (Roadbed)
    ctx.strokeStyle = '#EEEEE8';
    ctx.lineWidth = Math.max(6, 5.0 * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < dense.length; i++) {
      const p = toScreen(dense[i].x, dense[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();

    // 2. Draw Track Centerline
    ctx.strokeStyle = '#DADBD4';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let i = 0; i < dense.length; i++) {
      const p = toScreen(dense[i].x, dense[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // 3. Draw Waypoint Nodes
    const wps = store.trackWaypoints;
    const activeIdx = store.vehicle.activeWaypointIndex;

    ctx.font = '8px "JetBrains Mono", monospace';
    for (let i = 0; i < wps.length; i++) {
      const wp = wps[i];
      const p = toScreen(wp.x, wp.y);
      const isActive = (i === activeIdx);

      if (isActive) {
        ctx.fillStyle = '#68785A';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(104, 120, 90, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#777970';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // 4. Draw Vehicle Position and Heading Vector
    const v = store.vehicle;
    const vp = toScreen(v.x, v.y);

    ctx.save();
    ctx.translate(vp.x, vp.y);
    ctx.rotate(-v.yaw);

    // Vehicle point
    ctx.fillStyle = '#292B27';
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();

    // Heading arrow
    ctx.strokeStyle = '#292B27';
    ctx.fillStyle = '#292B27';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(10, 0);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(7, -3);
    ctx.lineTo(7, 3);
    ctx.fill();

    ctx.restore();

    // Update HUD Overlay text
    const activeWpObj = wps[activeIdx];
    const activeWpEl = this.container.querySelector('#nav-active-wp');
    const distEl = this.container.querySelector('#nav-wp-dist');
    const cteEl = this.container.querySelector('#nav-cte');
    const progEl = this.container.querySelector('#nav-progress');

    if (activeWpEl && activeWpObj) {
      activeWpEl.textContent = `${activeWpObj.id} (${activeWpObj.name.split(' ')[0]})`;
    }
    if (distEl) {
      distEl.textContent = `${v.distToNextWp.toFixed(1)} m`;
    }
    if (cteEl) {
      const cteVal = v.crossTrackError;
      cteEl.textContent = `${cteVal >= 0 ? '+' : ''}${cteVal.toFixed(2)} m`;
    }
    if (progEl) {
      progEl.textContent = `${(v.lapProgress * 100).toFixed(1)}%`;
    }
  }
}
