/* ==========================================================================
   ENIMIA Dashboard — Camera & Perception View Component
   Displays forward track feed with perception bounding boxes & lane overlays
   Honest fallback when topic is inactive in live mode
   ========================================================================== */

import { store } from '../state.js';

export class CameraPanelComponent {
  constructor(containerEl) {
    this.container = containerEl;
    this.canvas = null;
    this.ctx = null;
    this.showOverlays = true;
    this.init();
    this.startRenderLoop();
  }

  init() {
    this.container.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-group">
          <span class="panel-title">CAMERA & PERCEPTION INFERENCE</span>
          <span class="panel-badge tabular-nums" id="cam-fps-badge">30.1 FPS</span>
        </div>
        <div class="panel-controls">
          <button class="icon-btn active" id="btn-toggle-cam-overlays" title="Toggle AI bounding boxes and lane overlays">OVERLAYS</button>
        </div>
      </div>

      <div class="camera-wrapper" id="cam-wrapper">
        <canvas id="camera-canvas"></canvas>

        <!-- Disconnected Honest Placeholder -->
        <div class="camera-disconnected-placeholder" id="cam-placeholder">
          <div class="camera-placeholder-title">CAMERA STREAM INACTIVE</div>
          <div class="camera-placeholder-desc">
            No camera image publisher is configured in the current Autonomous-outdoor-RC ROS 2 project.
          </div>
        </div>

        <!-- Camera HUD Metadata -->
        <div class="camera-overlay-info" id="cam-info">
          <span>640×480</span>
          <span>|</span>
          <span id="cam-latency-tag">22ms LATENCY</span>
        </div>

        <!-- Perception Tag -->
        <div class="camera-overlay-tags" id="cam-tags">
          <span class="perception-tag">YOLOv8-TINY</span>
        </div>
      </div>
    `;

    this.canvas = this.container.querySelector('#camera-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.wrapper = this.container.querySelector('#cam-wrapper');
    this.placeholder = this.container.querySelector('#cam-placeholder');

    this.resize();
    window.addEventListener('resize', () => this.resize());

    // Toggle overlay button
    const toggleBtn = this.container.querySelector('#btn-toggle-cam-overlays');
    toggleBtn.addEventListener('click', () => {
      this.showOverlays = !this.showOverlays;
      toggleBtn.classList.toggle('active', this.showOverlays);
    });
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

    const isLiveDisconnected = store.mode === 'live';

    if (isLiveDisconnected) {
      this.placeholder.classList.add('active');
      this.canvas.style.display = 'none';
      this.container.querySelector('#cam-fps-badge').textContent = 'NO CAMERA TOPIC';
      this.container.querySelector('#cam-info').style.display = 'none';
      this.container.querySelector('#cam-tags').style.display = 'none';
      return;
    } else {
      this.placeholder.classList.remove('active');
      this.canvas.style.display = 'block';
      this.container.querySelector('#cam-info').style.display = '';
      this.container.querySelector('#cam-tags').style.display = '';
    }

    // 1. Synthetic forward perspective rendering (Shell Eco-marathon test track)
    ctx.fillStyle = '#C2C4B8'; // Sky / horizon neutral tone
    ctx.fillRect(0, 0, w, h);

    const horizonY = h * 0.42;

    // Distant background hills / pit wall
    ctx.fillStyle = '#ADB0A2';
    ctx.fillRect(0, horizonY - 14, w, 14);

    // Track asphalt (warm charcoal)
    ctx.fillStyle = '#3A3B35';
    ctx.beginPath();
    ctx.moveTo(w * 0.38, horizonY);
    ctx.lineTo(w * 0.62, horizonY);
    ctx.lineTo(w * 0.95, h);
    ctx.lineTo(w * 0.05, h);
    ctx.closePath();
    ctx.fill();

    // Grass / run-off verge
    ctx.fillStyle = '#68785A'; // Muted olive track verge
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    ctx.lineTo(w * 0.38, horizonY);
    ctx.lineTo(w * 0.05, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(w, horizonY);
    ctx.lineTo(w * 0.62, horizonY);
    ctx.lineTo(w * 0.95, h);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();

    // Curbs (White & Red alternating motorsport curbs)
    const timeOffset = (store.vehicle.lapProgress * 200) % 20;
    ctx.strokeStyle = '#D9822B'; // Burnt orange motorsport curb accent
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w * 0.38, horizonY);
    ctx.lineTo(w * 0.05, h);
    ctx.stroke();

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w * 0.62, horizonY);
    ctx.lineTo(w * 0.95, h);
    ctx.stroke();

    // Track Centerline (Dashed white line)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 12]);
    ctx.lineDashOffset = -timeOffset * 2;
    ctx.beginPath();
    ctx.moveTo(w * 0.5, horizonY);
    ctx.lineTo(w * 0.5, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Draw 3D road obstacles matching detections
    for (const det of store.perceptionDetections) {
      const scaleX = w / 640;
      const scaleY = h / 480;
      const bx = det.x * scaleX;
      const by = det.y * scaleY;
      const bw = det.w * scaleX;
      const bh = det.h * scaleY;
      const cx = bx + bw / 2;
      const cy = by + bh;

      if (det.type === 'TRAFFIC_CONE') {
        // Orange motorsport traffic cone
        ctx.fillStyle = '#C77C4A';
        ctx.beginPath();
        ctx.moveTo(cx, by);
        ctx.lineTo(cx + bw * 0.45, cy);
        ctx.lineTo(cx - bw * 0.45, cy);
        ctx.closePath();
        ctx.fill();

        // White reflective band
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(cx - bw * 0.22, by + bh * 0.5);
        ctx.lineTo(cx + bw * 0.22, by + bh * 0.5);
        ctx.lineTo(cx + bw * 0.3, by + bh * 0.7);
        ctx.lineTo(cx - bw * 0.3, by + bh * 0.7);
        ctx.closePath();
        ctx.fill();

        // Base plate
        ctx.fillStyle = '#292B27';
        ctx.fillRect(cx - bw * 0.5, cy - bh * 0.08, bw, bh * 0.08);
      } else if (det.type === 'STOP_SIGN') {
        // Octagonal Red/Orange Stop Sign on post
        ctx.fillStyle = '#777970';
        ctx.fillRect(cx - 2, by + bh * 0.6, 4, bh * 0.9);

        ctx.fillStyle = '#BD3838'; // Muted red stop sign
        const r = bw * 0.48;
        const cyCenter = by + bh * 0.48;
        ctx.beginPath();
        for (let a = 0; a < 8; a++) {
          const ang = (a * Math.PI) / 4 + Math.PI / 8;
          const px = cx + r * Math.cos(ang);
          const py = cyCenter + r * Math.sin(ang);
          if (a === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();

        // White border
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${Math.max(7, Math.round(bw * 0.24))}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('STOP', cx, cyCenter);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    }

    // 3. Perception AI Overlays (Bounding Boxes, Confidences, Lane boundaries)
    if (this.showOverlays) {
      // Lane Boundary Polynomials (Olive Green lines)
      ctx.strokeStyle = '#8A9A7B';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);

      // Left lane line
      ctx.beginPath();
      ctx.moveTo(w * 0.40, horizonY);
      ctx.quadraticCurveTo(w * 0.28, h * 0.7, w * 0.12, h);
      ctx.stroke();

      // Right lane line
      ctx.beginPath();
      ctx.moveTo(w * 0.60, horizonY);
      ctx.quadraticCurveTo(w * 0.72, h * 0.7, w * 0.88, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // Bounding Boxes for detected objects
      for (const det of store.perceptionDetections) {
        const scaleX = w / 640;
        const scaleY = h / 480;
        const bx = det.x * scaleX;
        const by = det.y * scaleY;
        const bw = det.w * scaleX;
        const bh = det.h * scaleY;

        // Bounding box: Burnt Orange thin stroke
        ctx.strokeStyle = '#C77C4A';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bx, by, bw, bh);

        // Technical Label Badge
        ctx.fillStyle = '#C77C4A';
        ctx.fillRect(bx, by - 14, bw, 14);

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '8px "JetBrains Mono", monospace';
        ctx.fillText(`${det.type} ${(det.conf * 100).toFixed(0)}%`, bx + 3, by - 4);
      }

      // Camera boresight crosshair (optical center)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w * 0.5 - 8, horizonY);
      ctx.lineTo(w * 0.5 + 8, horizonY);
      ctx.moveTo(w * 0.5, horizonY - 8);
      ctx.lineTo(w * 0.5, horizonY + 8);
      ctx.stroke();
    }
  }
}
