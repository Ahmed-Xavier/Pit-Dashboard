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
          <span class="tech-label" id="nav-lap-counter">WAITING FOR ODOMETRY</span>
        </div>
      </div>

      <div class="track-canvas-wrapper" id="track-canvas-wrapper">
        <canvas id="track-canvas"></canvas>

        <div class="track-hud-overlay">
          <div class="track-hud-item">
            <span class="hud-key">ACTIVE TARGET</span>
            <span class="hud-val" id="nav-active-wp">No active waypoint</span>
          </div>
          <div class="track-hud-item">
            <span class="hud-key">DIST TO WP</span>
            <span class="hud-val tabular-nums" id="nav-wp-dist">—</span>
          </div>
          <div class="track-hud-item">
            <span class="hud-key">CROSS-TRACK ERR</span>
            <span class="hud-val tabular-nums" id="nav-cte">—</span>
          </div>
          <div class="track-hud-item">
            <span class="hud-key">LAP PROGRESS</span>
            <span class="hud-val tabular-nums" id="nav-progress">—</span>
          </div>
        </div>
      </div>
    `;

    this.canvas = this.container.querySelector('#track-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.wrapper = this.container.querySelector('#track-canvas-wrapper');

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loadTrack();
  }

  async loadTrack() {
    try {
      const [trackResponse, transformResponse] = await Promise.all([
        fetch(new URL('../../config/track.json', import.meta.url)),
        fetch(new URL('../../config/track-transform.json', import.meta.url))
      ]);
      if (!trackResponse.ok || !transformResponse.ok) throw new Error('Track configuration could not be loaded');
      const track = await trackResponse.json();
      const transform = await transformResponse.json();
      const [cx, cy] = transform.sourceCenterPx || [300, 300];
      const scale = Number(transform.metersPerPixel || 1);
      store.trackCenterline = (track.points || []).map(([x, y]) => ({ x: (x - cx) * scale, y: (cy - y) * scale }));
    } catch (error) {
      console.warn('Pit dashboard track map unavailable:', error);
    }
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
    let lastRender = 0;
    const render = (now) => {
      if (!document.hidden && now - lastRender >= 1000 / 30) {
        this.draw();
        lastRender = now;
      }
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

    const dense = store.mode === 'live' ? store.trackCenterline : demoProvider.denseTrack;
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
    const trackW = Math.max(0.01, maxX - minX);
    const trackH = Math.max(0.01, maxY - minY);
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
    const modeBadge = this.container.querySelector('#nav-mode-badge');
    if (modeBadge) modeBadge.textContent = store.mode === 'live'
      ? (store.guidance ? `ROUTE ACTIVE · ${wps.length} WPS` : `COLLECTING · ${wps.length} WPS`)
      : 'DEMO NAVIGATION';

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

    // 4. Draw the measured vehicle pose only after global odometry arrives.
    const v = store.vehicle;
    if (store.mode === 'demo' || store.hasGlobalOdom) {
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
    }

    // Update HUD Overlay text
    const activeWpObj = wps[activeIdx];
    const activeWpEl = this.container.querySelector('#nav-active-wp');
    const distEl = this.container.querySelector('#nav-wp-dist');
    const cteEl = this.container.querySelector('#nav-cte');
    const progEl = this.container.querySelector('#nav-progress');

    if (activeWpEl) {
      activeWpEl.textContent = activeWpObj ? `${activeWpObj.id} (${activeWpObj.name.split(' ')[0]})` : 'No active waypoint';
    }
    if (distEl) {
      distEl.textContent = Number.isFinite(v.distToNextWp) ? `${v.distToNextWp.toFixed(1)} m` : '—';
    }
    if (cteEl) {
      const cteVal = store.mode === 'live' && store.hasGlobalOdom ? this.trackOffset(v.x, v.y, dense) : v.crossTrackError;
      cteEl.textContent = Number.isFinite(cteVal) ? `${cteVal >= 0 ? '+' : ''}${cteVal.toFixed(2)} m` : '—';
    }
    if (progEl) {
      progEl.textContent = Number.isFinite(v.lapProgress) ? `${(v.lapProgress * 100).toFixed(1)}%` : '—';
    }
    const lapEl = this.container.querySelector('#nav-lap-counter');
    if (lapEl) lapEl.textContent = store.mode === 'live' ? (store.guidance ? `ROUTE ${store.guidance[2] + 1} / ${store.guidance[3]}` : 'LIVE TRACK') : `LAP ${v.currentLap} / 10`;
  }

  trackOffset(x, y, points) {
    if (!points || points.length < 2) return null;
    let bestDistance = Infinity, signedOffset = null;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const lengthSq = dx * dx + dy * dy;
      if (!lengthSq) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq));
      const ex = x - (a.x + t * dx), ey = y - (a.y + t * dy);
      const distance = Math.hypot(ex, ey);
      if (distance < bestDistance) {
        bestDistance = distance;
        signedOffset = Math.sign(dx * ey - dy * ex) * distance;
      }
    }
    return signedOffset;
  }
}
