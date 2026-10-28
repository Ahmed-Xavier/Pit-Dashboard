/* ==========================================================================
   ENIMIA Dashboard — Track & Navigation Schematic Component
   Circuit schematic drawn from SDF centerline (store.trackCenterline).
   Falls back to "WORLD NOT LOADED" message until the SDF is available.
   ========================================================================== */

import { store } from '../state.js';

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
          <span class="panel-title">CIRCUIT SCHEMATIC &amp; NAVIGATION</span>
          <span class="panel-badge" id="nav-mode-badge">LOADING WORLD…</span>
        </div>
        <div class="panel-controls">
          <span class="tech-label" id="nav-lap-counter">WAITING FOR ODOMETRY</span>
        </div>
      </div>

      <div class="waypoint-control-bar"></div>
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
  }

  resize() {
    const rect = this.wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = rect.width  * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.displayWidth  = rect.width;
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

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    // Get centerline from store (set by scene3D after SDF loads)
    const hasSdfTrack = store.trackCenterline && store.trackCenterline.length >= 3;
    const liveTrail = store.mode === 'live' && !hasSdfTrack;
    const dense = hasSdfTrack ? store.trackCenterline : (liveTrail ? store.odomHistory : []);
    const trackWidth = store.trackWidth ?? 3.16;

    if (!dense || dense.length < 3) {
      // World not yet loaded — draw waiting message
      ctx.fillStyle = '#CCCCCC';
      ctx.font = '600 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(liveTrail ? 'WAITING FOR ODOMETRY' : 'WORLD NOT LOADED', w / 2, h / 2 - 8);
      ctx.font = '400 9px "JetBrains Mono", monospace';
      ctx.fillText(liveTrail ? 'Live path appears as data arrives' : 'Select SDF to load the circuit', w / 2, h / 2 + 8);
      ctx.textAlign = 'left';

      const modeBadge = this.container.querySelector('#nav-mode-badge');
      if (modeBadge) modeBadge.textContent = liveTrail ? 'LIVE TRACK' : 'WORLD NOT LOADED';
      return;
    }

    // Calculate bounding box
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of dense) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }

    const pad = 20;
    const trackW = Math.max(0.01, maxX - minX);
    const trackH = Math.max(0.01, maxY - minY);
    const scale = Math.min((w - pad * 2) / trackW, (h - pad * 2 - 24) / trackH);

    const offsetX = (w - trackW * scale) / 2 - minX * scale;
    const offsetY = (h - 24 - trackH * scale) / 2 + maxY * scale;

    // ROS +Y is "left" on screen when heading +X → canvas: x=+X, y=−Y_ros
    const toScreen = (x, y) => ({
      x: offsetX + x * scale,
      y: offsetY - y * scale
    });
    const ribbonPxW = Math.max(4, trackWidth * scale);

    // 1. Track surface ribbon (asphalt width), when the SDF is selected.
    if (!liveTrail) {
    ctx.strokeStyle = '#DDDDD8';
    ctx.lineWidth = ribbonPxW;
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
    }

    // 2. Centerline dashed
    if (!liveTrail) {
    ctx.strokeStyle = '#BBBBBB';
    ctx.lineWidth = 0.8;
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
    } else {
      ctx.strokeStyle = '#9AA88C';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      dense.forEach((pt, i) => { const p = toScreen(pt.x, pt.y); if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.stroke();
    }

    // 3. Start/Finish line (segment 0 approximate)
    if (!liveTrail) {
    const startPt = toScreen(dense[0].x, dense[0].y);
    ctx.strokeStyle = '#248eff';
    ctx.lineWidth = 2;
    const yawAt0 = dense[0].yaw ?? 0;
    const perpX = Math.cos(yawAt0 + Math.PI / 2);
    const perpY = Math.sin(yawAt0 + Math.PI / 2);
    const halfW = ribbonPxW / 2;
    ctx.beginPath();
    ctx.moveTo(startPt.x - perpX * halfW, startPt.y + perpY * halfW);
    ctx.lineTo(startPt.x + perpX * halfW, startPt.y - perpY * halfW);
    ctx.stroke();
    }

    // 4. Waypoints
    const wps = store.trackWaypoints || [];
    const activeIdx = store.vehicle.activeWaypointIndex ?? -1;
    ctx.font = '8px "JetBrains Mono", monospace';
    for (let i = 0; i < wps.length; i++) {
      const wp = wps[i];
      const p = toScreen(wp.x, wp.y);
      const isActive = ((wp.waypointIndex ?? i) === activeIdx);
      if (isActive) {
        ctx.fillStyle = '#68785A';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(104,120,90,0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#888880';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // 5. Vehicle dot + heading arrow
    const v = store.vehicle;
    if (store.mode === 'demo' || store.hasGlobalOdom) {
      const vp = toScreen(v.x, v.y);
      ctx.save();
      ctx.translate(vp.x, vp.y);
      // In toScreen: x maps +X forward, y maps -Y_ros → we rotate by -yaw
      ctx.rotate(-v.yaw);
      ctx.fillStyle = '#292B27';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();
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

    // 6. HUD overlay updates
    const activeWpObj = wps[activeIdx];
    const activeWpEl  = this.container.querySelector('#nav-active-wp');
    const distEl      = this.container.querySelector('#nav-wp-dist');
    const cteEl       = this.container.querySelector('#nav-cte');
    const progEl      = this.container.querySelector('#nav-progress');
    const lapEl       = this.container.querySelector('#nav-lap-counter');
    const modeBadge   = this.container.querySelector('#nav-mode-badge');

    if (modeBadge) modeBadge.textContent = store.mode === 'demo' ? 'DEMO NAVIGATION' : (store.guidance ? `ROUTE ACTIVE · ${wps.length} WPS` : `COLLECTING · ${wps.length} WPS`);
    if (activeWpEl) activeWpEl.textContent = activeWpObj ? `${activeWpObj.id}` : 'No active waypoint';
    if (distEl) distEl.textContent = Number.isFinite(v.distToNextWp) ? `${v.distToNextWp.toFixed(1)} m` : '—';
    if (cteEl) {
      const cte = store.mode === 'live' && store.hasGlobalOdom
        ? this.trackOffset(v.x, v.y, dense)
        : v.crossTrackError;
      cteEl.textContent = Number.isFinite(cte) ? `${cte >= 0 ? '+' : ''}${cte.toFixed(3)} m` : '—';
    }
    if (progEl) progEl.textContent = Number.isFinite(v.lapProgress) ? `${(v.lapProgress * 100).toFixed(1)}%` : '—';
    if (lapEl) lapEl.textContent = store.mode === 'live' ? (store.guidance ? `ROUTE ${store.guidance[2] + 1} / ${store.guidance[3]}` : 'LIVE TRACK') : `LAP ${v.currentLap ?? 1} / ∞`;
  }

  trackOffset(x, y, points) {
    if (!points || points.length < 2) return null;
    let bestDist = Infinity, signedOffset = null;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (!lenSq) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lenSq));
      const ex = x - (a.x + t * dx), ey = y - (a.y + t * dy);
      const dist = Math.hypot(ex, ey);
      if (dist < bestDist) {
        bestDist = dist;
        signedOffset = Math.sign(dx * ey - dy * ex) * dist;
      }
    }
    return signedOffset;
  }
}
