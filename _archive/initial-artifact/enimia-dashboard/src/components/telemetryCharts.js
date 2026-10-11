/* ==========================================================================
   ENIMIA Dashboard — Live Engineering Telemetry Charts Component
   High-precision Canvas charts for Speed, Steer, Encoders, IMU Yaw Rate
   ========================================================================== */

import { store } from '../state.js';

export class TelemetryChartsComponent {
  constructor(containerEl) {
    this.container = containerEl;
    this.windowSeconds = 30; // default 30s
    this.hoverIndex = -1;
    this.init();
    this.startRenderLoop();
  }

  init() {
    this.container.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-group">
          <span class="panel-title">VEHICLE DYNAMICS TELEMETRY</span>
          <span class="panel-badge tabular-nums" id="telem-sample-rate">50 HZ LOG</span>
        </div>
        <div class="panel-controls">
          <button class="icon-btn" id="btn-win-10">10S</button>
          <button class="icon-btn active" id="btn-win-30">30S</button>
          <button class="icon-btn" id="btn-win-60">60S</button>
        </div>
      </div>

      <div class="telemetry-charts-wrapper" id="charts-wrapper">
        <!-- 1. Velocity (Actual vs Target) -->
        <div class="telemetry-chart-cell">
          <div class="chart-header">
            <span class="chart-title">SPEED <span style="font-size: 8px; color: var(--text-muted); font-weight: normal;">(M/S)</span></span>
            <span class="chart-current-val tabular-nums" id="val-speed">0.00 m/s</span>
          </div>
          <div class="chart-canvas-box">
            <canvas id="chart-canvas-speed" class="telemetry-canvas"></canvas>
          </div>
        </div>

        <!-- 2. Steering Angle (Command vs Measured) -->
        <div class="telemetry-chart-cell">
          <div class="chart-header">
            <span class="chart-title">STEERING <span style="font-size: 8px; color: var(--text-muted); font-weight: normal;">(DEG)</span></span>
            <span class="chart-current-val tabular-nums" id="val-steer">0.0°</span>
          </div>
          <div class="chart-canvas-box">
            <canvas id="chart-canvas-steer" class="telemetry-canvas"></canvas>
          </div>
        </div>

        <!-- 3. Wheel Encoders (Left vs Right) -->
        <div class="telemetry-chart-cell">
          <div class="chart-header">
            <span class="chart-title">ENCODERS <span style="font-size: 8px; color: var(--text-muted); font-weight: normal;">(RAD/S)</span></span>
            <span class="chart-current-val tabular-nums" id="val-enc">0.0 / 0.0</span>
          </div>
          <div class="chart-canvas-box">
            <canvas id="chart-canvas-enc" class="telemetry-canvas"></canvas>
          </div>
        </div>

        <!-- 4. IMU Yaw Rate -->
        <div class="telemetry-chart-cell">
          <div class="chart-header">
            <span class="chart-title">YAW RATE <span style="font-size: 8px; color: var(--text-muted); font-weight: normal;">(°/S)</span></span>
            <span class="chart-current-val tabular-nums" id="val-yaw">0.0 °/s</span>
          </div>
          <div class="chart-canvas-box">
            <canvas id="chart-canvas-yaw" class="telemetry-canvas"></canvas>
          </div>
        </div>
      </div>
    `;

    // Time window toggles
    const setWin = (s, btnId) => {
      this.windowSeconds = s;
      ['#btn-win-10', '#btn-win-30', '#btn-win-60'].forEach(id => {
        this.container.querySelector(id).classList.toggle('active', id === btnId);
      });
    };

    this.container.querySelector('#btn-win-10').addEventListener('click', () => setWin(10, '#btn-win-10'));
    this.container.querySelector('#btn-win-30').addEventListener('click', () => setWin(30, '#btn-win-30'));
    this.container.querySelector('#btn-win-60').addEventListener('click', () => setWin(60, '#btn-win-60'));

    this.canvases = {
      speed: this.container.querySelector('#chart-canvas-speed'),
      steer: this.container.querySelector('#chart-canvas-steer'),
      enc: this.container.querySelector('#chart-canvas-enc'),
      yaw: this.container.querySelector('#chart-canvas-yaw')
    };

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    for (const key of Object.keys(this.canvases)) {
      const c = this.canvases[key];
      const rect = c.parentElement.getBoundingClientRect();
      c.width = rect.width * dpr;
      c.height = rect.height * dpr;
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      c._width = rect.width;
      c._height = rect.height;
    }
  }

  startRenderLoop() {
    const render = () => {
      this.draw();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }

  draw() {
    const t = store.telemetry;
    const n = t.timestamps.length;
    if (n < 2) return;

    const latestTime = t.timestamps[n - 1];
    const startTime = latestTime - this.windowSeconds;

    // Filter points in time window
    let startIdx = 0;
    while (startIdx < n && t.timestamps[startIdx] < startTime) {
      startIdx++;
    }

    const windowCount = n - startIdx;
    if (windowCount < 2) return;

    // 1. Draw Speed Chart
    this.drawSingleChart({
      canvas: this.canvases.speed,
      series: [
        { data: t.speedActual.slice(startIdx), color: '#292B27', width: 1.5, name: 'Actual' },
        { data: t.speedTarget.slice(startIdx), color: '#68785A', width: 1.2, dashed: [3, 3], name: 'Target' }
      ],
      minY: 0,
      maxY: 8.0,
      unit: 'm/s',
      valEl: this.container.querySelector('#val-speed'),
      formatVal: (val) => `${val.toFixed(2)} m/s`
    });

    // 2. Draw Steering Angle Chart
    this.drawSingleChart({
      canvas: this.canvases.steer,
      series: [
        { data: t.steerActual.slice(startIdx), color: '#292B27', width: 1.5, name: 'Meas' },
        { data: t.steerTarget.slice(startIdx), color: '#68785A', width: 1.2, dashed: [3, 3], name: 'Cmd' }
      ],
      minY: -25,
      maxY: 25,
      unit: '°',
      valEl: this.container.querySelector('#val-steer'),
      formatVal: (val) => `${val >= 0 ? '+' : ''}${val.toFixed(1)}°`
    });

    // 3. Draw Encoders Chart
    this.drawSingleChart({
      canvas: this.canvases.enc,
      series: [
        { data: t.encLeft.slice(startIdx), color: '#292B27', width: 1.5, name: 'L' },
        { data: t.encRight.slice(startIdx), color: '#777970', width: 1.5, name: 'R' }
      ],
      minY: 10,
      maxY: 50,
      unit: 'rad/s',
      valEl: this.container.querySelector('#val-enc'),
      formatVal: (v1, v2) => `${v1.toFixed(1)} / ${v2.toFixed(1)}`
    });

    // 4. Draw IMU Yaw Rate Chart
    this.drawSingleChart({
      canvas: this.canvases.yaw,
      series: [
        { data: t.imuYawRate.slice(startIdx), color: '#C77C4A', width: 1.5, name: 'Yaw Rate' }
      ],
      minY: -20,
      maxY: 20,
      unit: '°/s',
      valEl: this.container.querySelector('#val-yaw'),
      formatVal: (val) => `${val >= 0 ? '+' : ''}${val.toFixed(1)} °/s`
    });
  }

  drawSingleChart({ canvas, series, minY, maxY, unit, valEl, formatVal }) {
    if (!canvas || !canvas._width) return;
    const ctx = canvas.getContext('2d');
    const w = canvas._width;
    const h = canvas._height;

    // Clear background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, w, h);

    const padTop = 6;
    const padBottom = 16;
    const padLeft = 24;
    const padRight = 6;
    const chartW = w - padLeft - padRight;
    const chartH = h - padTop - padBottom;

    // Horizontal baseline and zero-line
    ctx.strokeStyle = '#EEEEE8';
    ctx.lineWidth = 1;

    // Grid lines (3 horizontal)
    ctx.fillStyle = '#9E9F97';
    ctx.font = '8px "JetBrains Mono", monospace';

    const yLevels = [minY, (minY + maxY) / 2, maxY];
    for (const lvl of yLevels) {
      const yNorm = (lvl - minY) / (maxY - minY);
      const yPix = padTop + chartH * (1 - yNorm);
      ctx.beginPath();
      ctx.moveTo(padLeft, yPix);
      ctx.lineTo(w - padRight, yPix);
      ctx.stroke();

      ctx.fillText(`${lvl.toFixed(0)}`, 2, yPix + 3);
    }

    // Zero-line if spanned
    if (minY < 0 && maxY > 0) {
      const zeroNorm = (0 - minY) / (maxY - minY);
      const zeroY = padTop + chartH * (1 - zeroNorm);
      ctx.strokeStyle = '#DADBD4';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, zeroY);
      ctx.lineTo(w - padRight, zeroY);
      ctx.stroke();
    }

    // Draw lines
    const len = series[0].data.length;
    if (len < 2) return;

    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.2;
      if (s.dashed) ctx.setLineDash(s.dashed);
      else ctx.setLineDash([]);

      ctx.beginPath();
      for (let i = 0; i < len; i++) {
        const xPix = padLeft + (i / (len - 1)) * chartW;
        const val = s.data[i];
        const yNorm = Math.max(0, Math.min(1, (val - minY) / (maxY - minY)));
        const yPix = padTop + chartH * (1 - yNorm);

        if (i === 0) ctx.moveTo(xPix, yPix);
        else ctx.lineTo(xPix, yPix);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Update Header Metric text
    if (valEl && formatVal) {
      if (series.length === 2 && series[0].name === 'L') {
        const v1 = series[0].data[len - 1] || 0;
        const v2 = series[1].data[len - 1] || 0;
        valEl.textContent = formatVal(v1, v2);
      } else {
        const v1 = series[0].data[len - 1] || 0;
        valEl.textContent = formatVal(v1);
      }
    }
  }
}
