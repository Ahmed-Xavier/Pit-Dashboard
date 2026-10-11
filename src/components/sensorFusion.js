/* ==========================================================================
   ENIMIA Dashboard — Main 2D Sensor-Fusion Engineering Visualizer
   High-precision top-down robotics visualizer (LiDAR, Pose, Trajectory, Obstacles)
   ========================================================================== */

import { store } from '../state.js';

export class SensorFusionComponent {
  constructor(containerEl) {
    this.container = containerEl;
    this.canvas = null;
    this.ctx = null;

    // Viewport transform
    this.scale = 28.0; // pixels per meter (default zoom)
    this.panX = 0;
    this.panY = 0;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;

    // Layer toggles
    this.layers = {
      lidar: true,
      plannedPath: true,
      odomHistory: true,
      obstacles: true,
      grid: true,
      rangeRings: true
    };

    this.followVehicle = true;
    this.mouseWorld = { x: 0, y: 0, range: 0, bearing: 0 };

    this.init();
    this.startRenderLoop();
  }

  init() {
    this.container.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-group">
          <span class="panel-title">SENSOR FUSION & SPATIAL ENVIRONMENT</span>
          <span class="panel-badge tabular-nums" id="sf-points-count">360 PTS</span>
          <span class="panel-badge" id="sf-frame-ref">REP-103 BASE_LINK</span>
        </div>
        <div class="panel-controls">
          <button class="icon-btn active" id="btn-toggle-follow" title="Lock camera to vehicle">FOLLOW</button>
          <button class="icon-btn" id="btn-zoom-in" title="Zoom In">+</button>
          <button class="icon-btn" id="btn-zoom-out" title="Zoom Out">−</button>
          <button class="icon-btn" id="btn-zoom-reset" title="Reset View">1:1</button>
        </div>
      </div>

      <div class="sensor-canvas-wrapper" id="sf-canvas-wrapper">
        <canvas id="sensor-fusion-canvas"></canvas>

        <!-- Floating Interactive Toolbar -->
        <div class="canvas-toolbar">
          <button class="icon-btn active" id="layer-btn-lidar" title="Toggle LiDAR point returns">LIDAR</button>
          <button class="icon-btn active" id="layer-btn-plan" title="Toggle planned path">PLAN</button>
          <button class="icon-btn active" id="layer-btn-odom" title="Toggle odometry history">ODOM</button>
          <button class="icon-btn active" id="layer-btn-obs" title="Toggle obstacle bounding boxes">OBSTACLES</button>
          <button class="icon-btn active" id="layer-btn-grid" title="Toggle coordinate grid & range rings">GRID</button>
        </div>

        <!-- Mouse Coordinate Readout -->
        <div class="canvas-cursor-readout mono" id="sf-cursor-pos">
          X: +0.00m  Y: +0.00m  R: 0.00m
        </div>

        <!-- Technical Legend -->
        <div class="canvas-legend">
          <div class="legend-item">
            <span class="legend-swatch lidar"></span>
            <span>Raw LiDAR Returns (RPLIDAR)</span>
          </div>
          <div class="legend-item">
            <span class="legend-swatch planned"></span>
            <span>Planned Trajectory (Nav2 Horizon)</span>
          </div>
          <div class="legend-item">
            <span class="legend-swatch odom"></span>
            <span>Estimated Odometry Trail</span>
          </div>
          <div class="legend-item">
            <span class="legend-swatch obstacle"></span>
            <span>Detected Obstacle / Costmap</span>
          </div>
        </div>

        <!-- Dynamic Metric Scale Ruler -->
        <div class="canvas-scale-bar">
          <span id="sf-scale-label">2.0 m</span>
          <div class="scale-ruler" id="sf-scale-ruler" style="width: 56px;"></div>
        </div>
      </div>
    `;

    this.canvas = this.container.querySelector('#sensor-fusion-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.wrapper = this.container.querySelector('#sf-canvas-wrapper');

    // Handle canvas sizing
    this.resize();
    window.addEventListener('resize', () => this.resize());

    // Setup Canvas interactions
    this.setupInteractions();
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

  setupInteractions() {
    // Pan via Mouse Drag
    this.wrapper.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.dragStartX = e.clientX - this.panX;
      this.dragStartY = e.clientY - this.panY;
      this.followVehicle = false;
      this.container.querySelector('#btn-toggle-follow').classList.remove('active');
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        this.panX = e.clientX - this.dragStartX;
        this.panY = e.clientY - this.dragStartY;
      }

      // Update Cursor World Coordinates
      const rect = this.wrapper.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      const originX = this.displayWidth / 2 + this.panX;
      const originY = this.displayHeight / 2 + this.panY;

      // Invert view transformation: +X right, +Y up in world frame
      const worldX = (screenX - originX) / this.scale;
      const worldY = -(screenY - originY) / this.scale;

      const v = store.vehicle;
      const relX = worldX - v.x;
      const relY = worldY - v.y;
      const range = Math.hypot(relX, relY);
      const bearing = (Math.atan2(relY, relX) * 180) / Math.PI;

      const readout = this.container.querySelector('#sf-cursor-pos');
      if (readout) {
        readout.textContent = `X: ${worldX >= 0 ? '+' : ''}${worldX.toFixed(2)}m  Y: ${worldY >= 0 ? '+' : ''}${worldY.toFixed(2)}m  R: ${range.toFixed(2)}m`;
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    // Zoom via Wheel
    this.wrapper.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
      this.scale = Math.max(8.0, Math.min(120.0, this.scale * zoomFactor));
    }, { passive: false });

    // Toolbar buttons
    this.container.querySelector('#btn-toggle-follow').addEventListener('click', (e) => {
      this.followVehicle = !this.followVehicle;
      e.currentTarget.classList.toggle('active', this.followVehicle);
    });

    this.container.querySelector('#btn-zoom-in').addEventListener('click', () => {
      this.scale = Math.min(120.0, this.scale * 1.25);
    });

    this.container.querySelector('#btn-zoom-out').addEventListener('click', () => {
      this.scale = Math.max(8.0, this.scale * 0.8);
    });

    this.container.querySelector('#btn-zoom-reset').addEventListener('click', () => {
      this.scale = 28.0;
      this.followVehicle = true;
      this.container.querySelector('#btn-toggle-follow').classList.add('active');
    });

    // Layer toggle buttons
    const bindLayerBtn = (id, layerKey) => {
      const btn = this.container.querySelector(id);
      if (btn) {
        btn.addEventListener('click', () => {
          this.layers[layerKey] = !this.layers[layerKey];
          btn.classList.toggle('active', this.layers[layerKey]);
        });
      }
    };

    bindLayerBtn('#layer-btn-lidar', 'lidar');
    bindLayerBtn('#layer-btn-plan', 'plannedPath');
    bindLayerBtn('#layer-btn-odom', 'odomHistory');
    bindLayerBtn('#layer-btn-obs', 'obstacles');
    bindLayerBtn('#layer-btn-grid', 'grid');
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

    const v = store.vehicle;

    // Follow vehicle
    if (this.followVehicle) {
      this.panX = -v.x * this.scale;
      this.panY = v.y * this.scale;
    }

    const originX = w / 2 + this.panX;
    const originY = h / 2 + this.panY;

    // Clear background: warm canvas off-white
    ctx.fillStyle = '#FAF9F5';
    ctx.fillRect(0, 0, w, h);

    // Save transform context
    ctx.save();
    ctx.translate(originX, originY);

    // 1. Draw World Coordinate Grid & Metric Annotations
    if (this.layers.grid) {
      this.drawMetricGrid(ctx, originX, originY, w, h);
    }

    // 2. Draw Range Rings & Axes around vehicle
    if (this.layers.grid) {
      this.drawRangeRingsAndAxes(ctx, v);
    }

    // 3. Draw Odometry Historical Trail
    if (this.layers.odomHistory && store.odomHistory.length > 1) {
      this.drawOdomHistory(ctx);
    }

    // 4. Draw Planned Navigation Path (Olive green)
    if (this.layers.plannedPath && store.plannedPath.length > 1) {
      this.drawPlannedPath(ctx);
    }

    // 5. Draw Detected Obstacles & Costmap Footprints
    if (this.layers.obstacles && store.lidarObstacles.length > 0) {
      this.drawObstacles(ctx, v);
    }

    // 6. Draw LiDAR Point Cloud (Charcoal returns)
    if (this.layers.lidar && store.lidarPoints.length > 0) {
      this.drawLidarPoints(ctx, v);
    }

    // 7. Draw Shell Eco-marathon Vehicle Silhouette
    if (store.mode === 'demo' || store.hasGlobalOdom) this.drawVehicleModel(ctx, v);

    ctx.restore();

    // Update scale ruler at bottom right
    this.updateScaleRuler();

    // Update point count badge
    const ptBadge = this.container.querySelector('#sf-points-count');
    if (ptBadge) {
      ptBadge.textContent = `${store.lidarPoints.length} PTS`;
    }
  }

  drawMetricGrid(ctx, ox, oy, w, h) {
    const step = 2.0; // 2 meters grid
    const pixelStep = step * this.scale;

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#E8E8E2';
    ctx.fillStyle = '#A3A49C';
    ctx.font = '9px "JetBrains Mono", monospace';

    const minX = Math.floor((-ox) / pixelStep) * step;
    const maxX = Math.ceil((w - ox) / pixelStep) * step;
    const minY = Math.floor(-(h - oy) / pixelStep) * step;
    const maxY = Math.ceil(oy / pixelStep) * step;

    // Vertical grid lines
    for (let x = minX; x <= maxX; x += step) {
      const scrX = x * this.scale;
      ctx.beginPath();
      ctx.moveTo(scrX, -oy);
      ctx.lineTo(scrX, h - oy);
      ctx.stroke();

      if (x % 10 === 0 && x !== 0) {
        ctx.fillText(`${x > 0 ? '+' : ''}${x}m`, scrX + 4, -oy + 14);
      }
    }

    // Horizontal grid lines
    for (let y = minY; y <= maxY; y += step) {
      const scrY = -y * this.scale;
      ctx.beginPath();
      ctx.moveTo(-ox, scrY);
      ctx.lineTo(w - ox, scrY);
      ctx.stroke();

      if (y % 10 === 0 && y !== 0) {
        ctx.fillText(`${y > 0 ? '+' : ''}${y}m`, -ox + 4, scrY - 4);
      }
    }

    // World Origin Axes (X east, Y north)
    ctx.strokeStyle = '#DADBD4';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-ox, 0);
    ctx.lineTo(w - ox, 0);
    ctx.moveTo(0, -oy);
    ctx.lineTo(0, h - oy);
    ctx.stroke();
  }

  drawRangeRingsAndAxes(ctx, v) {
    const vx = v.x * this.scale;
    const vy = -v.y * this.scale;

    ctx.save();
    ctx.translate(vx, vy);

    // Range rings at 1m, 2m, 4m, 6m, 8m, 10m
    const rings = [1.0, 2.0, 4.0, 6.0, 8.0, 10.0];
    ctx.strokeStyle = 'rgba(158, 159, 151, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.font = '8px "JetBrains Mono", monospace';
    ctx.fillStyle = '#9E9F97';

    for (const r of rings) {
      const radPix = r * this.scale;
      ctx.beginPath();
      ctx.arc(0, 0, radPix, 0, Math.PI * 2);
      ctx.stroke();

      // Ring label
      ctx.fillText(`${r}m`, radPix + 2, -2);
    }
    ctx.setLineDash([]);

    // Vehicle Reference Frame Axes (REP-103: Forward = +X red/olive, Left = +Y green)
    const axisLen = 1.8 * this.scale;
    ctx.rotate(-v.yaw); // vehicle yaw (canvas Y is inverted)

    // Forward +X axis
    ctx.strokeStyle = '#68785A';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(axisLen, 0);
    ctx.stroke();

    // Forward arrow head
    ctx.fillStyle = '#68785A';
    ctx.beginPath();
    ctx.moveTo(axisLen, 0);
    ctx.lineTo(axisLen - 6, -3);
    ctx.lineTo(axisLen - 6, 3);
    ctx.fill();

    // Left +Y axis
    ctx.strokeStyle = '#8A9A7B';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -axisLen * 0.6); // Inverted canvas coords
    ctx.stroke();

    ctx.restore();
  }

  drawOdomHistory(ctx) {
    const history = store.odomHistory;
    ctx.strokeStyle = '#B3B5AC';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();

    for (let i = 0; i < history.length; i++) {
      const px = history[i].x * this.scale;
      const py = -history[i].y * this.scale;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawPlannedPath(ctx) {
    const path = store.plannedPath;
    ctx.strokeStyle = '#68785A'; // Muted olive green
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    for (let i = 0; i < path.length; i++) {
      const px = path[i].x * this.scale;
      const py = -path[i].y * this.scale;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Draw lookahead target point
    if (path.length > 10) {
      const target = path[10];
      const tx = target.x * this.scale;
      const ty = -target.y * this.scale;
      ctx.fillStyle = '#68785A';
      ctx.beginPath();
      ctx.arc(tx, ty, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawObstacles(ctx, v) {
    const vx = v.x * this.scale;
    const vy = -v.y * this.scale;

    ctx.save();
    ctx.translate(vx, vy);
    ctx.rotate(-v.yaw);

    for (const obs of store.lidarObstacles) {
      const ox = obs.x * this.scale;
      const oy = -obs.y * this.scale;
      const rPix = Math.max(6, (obs.radius || 0.3) * this.scale);

      // Warning circle / bounding box in Burnt Orange
      ctx.strokeStyle = '#C77C4A';
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(199, 124, 74, 0.15)';
      ctx.beginPath();
      ctx.arc(ox, oy, rPix, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Inflation safety circle
      ctx.strokeStyle = 'rgba(199, 124, 74, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(ox, oy, rPix + 0.5 * this.scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label
      ctx.fillStyle = '#C77C4A';
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.fillText(`${obs.type} (${obs.dist.toFixed(1)}m)`, ox - 18, oy - rPix - 3);
    }

    ctx.restore();
  }

  drawLidarPoints(ctx, v) {
    const vx = v.x * this.scale;
    const vy = -v.y * this.scale;

    ctx.save();
    ctx.translate(vx, vy);
    ctx.rotate(-v.yaw);

    // Charcoal color for raw LiDAR returns
    ctx.fillStyle = '#292B27';

    for (const pt of store.lidarPoints) {
      const px = pt.x * this.scale;
      const py = -pt.y * this.scale; // invert canvas Y

      // Draw crisp 2x2 px point
      ctx.fillRect(px - 1, py - 1, 2.2, 2.2);
    }

    ctx.restore();
  }

  drawVehicleModel(ctx, v) {
    const vx = v.x * this.scale;
    const vy = -v.y * this.scale;

    ctx.save();
    ctx.translate(vx, vy);
    ctx.rotate(-v.yaw);

    // Vehicle Specs: Shell Eco-marathon Aerodynamic Prototype
    // Length: 2.2m, Width: 0.68m, Wheelbase: 1.25m
    const lengthPix = 2.2 * this.scale;
    const widthPix = 0.68 * this.scale;
    const halfL = lengthPix / 2;
    const halfW = widthPix / 2;

    // Aerodynamic Teardrop Chassis Silhouette
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#292B27';
    ctx.lineWidth = 1.8;

    ctx.beginPath();
    // Nose cone (front)
    ctx.moveTo(halfL, 0);
    ctx.bezierCurveTo(halfL * 0.7, -halfW * 0.9, 0, -halfW, -halfL * 0.6, -halfW * 0.7);
    // Tail taper (rear)
    ctx.lineTo(-halfL, 0);
    ctx.lineTo(-halfL * 0.6, halfW * 0.7);
    ctx.bezierCurveTo(0, halfW, halfL * 0.7, halfW * 0.9, halfL, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Cockpit Canopy Outline
    ctx.fillStyle = '#EEEEE8';
    ctx.strokeStyle = '#777970';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(halfL * 0.1, 0, halfL * 0.45, halfW * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Wheels: Front Left, Front Right (with steer angle), Rear Center Wheel
    const wheelL = 0.4 * this.scale;
    const wheelW = 0.1 * this.scale;
    const steerRad = -v.steering; // steering angle

    // Front Left Wheel
    ctx.save();
    ctx.translate(halfL * 0.5, -halfW * 0.85);
    ctx.rotate(steerRad);
    ctx.fillStyle = '#292B27';
    ctx.fillRect(-wheelL / 2, -wheelW / 2, wheelL, wheelW);
    ctx.restore();

    // Front Right Wheel
    ctx.save();
    ctx.translate(halfL * 0.5, halfW * 0.85);
    ctx.rotate(steerRad);
    ctx.fillStyle = '#292B27';
    ctx.fillRect(-wheelL / 2, -wheelW / 2, wheelL, wheelW);
    ctx.restore();

    // Rear Center Traction Wheel (Eco-marathon 3-wheel architecture)
    ctx.save();
    ctx.translate(-halfL * 0.75, 0);
    ctx.fillStyle = '#292B27';
    ctx.fillRect(-wheelL / 2, -wheelW / 2, wheelL, wheelW);
    ctx.restore();

    // Sensor Mount (LiDAR Position on Roof)
    ctx.fillStyle = '#68785A';
    ctx.beginPath();
    ctx.arc(halfL * 0.25, 0, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Center of Mass Crosshair
    ctx.strokeStyle = '#777970';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-4, 0);
    ctx.lineTo(4, 0);
    ctx.moveTo(0, -4);
    ctx.lineTo(0, 4);
    ctx.stroke();

    ctx.restore();
  }

  updateScaleRuler() {
    const rulerEl = this.container.querySelector('#sf-scale-ruler');
    const labelEl = this.container.querySelector('#sf-scale-label');
    if (!rulerEl || !labelEl) return;

    // Pick rounded distance in meters that fits ~50-100 pixels
    let meters = 2.0;
    if (this.scale < 15) meters = 5.0;
    else if (this.scale > 50) meters = 1.0;

    const pixels = meters * this.scale;
    rulerEl.style.width = `${Math.round(pixels)}px`;
    labelEl.textContent = `${meters.toFixed(1)} m`;
  }
}
