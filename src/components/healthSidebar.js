/* ==========================================================================
   ENIMIA Dashboard — System Health Sidebar Component
   Monitors Raspberry Pi 5, ESP32, RPLIDAR, GPS, IMU, Camera, Power System
   ========================================================================== */

import { store } from '../state.js';

export class HealthSidebarComponent {
  constructor(containerEl) {
    this.container = containerEl;
    this.expandedId = 'pi5'; // default expanded
    this.init();
    this.powerSummaryMarkup = this.container.querySelector('.power-summary-box').innerHTML;
    store.subscribe(() => this.render());
  }

  init() {
    this.container.innerHTML = `
      <aside class="health-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-header-title">SUBSYSTEM DIAGNOSTICS</span>
          <span class="panel-badge tabular-nums" id="sb-comp-count">LIVE TOPICS</span>
        </div>

        <div class="sidebar-content" id="sb-items-list">
          <!-- Rendered dynamically -->
        </div>

        <div class="sidebar-footer">
          <div class="power-summary-box">
            <div class="power-main-row">
              <span class="tech-label">TRACTION POWER (24V)</span>
              <span class="power-soc-pill tabular-nums" id="sb-power-soc">88.4% SOC</span>
            </div>
            <div style="display: flex; align-items: baseline; gap: 8px;">
              <span class="power-voltage-large tabular-nums" id="sb-power-volt">26.42 V</span>
              <span class="telemetry-val" style="font-size: 11px; color: var(--text-secondary);" id="sb-power-amp">4.18 A</span>
              <span class="telemetry-val" style="font-size: 11px; color: var(--accent-olive); margin-left: auto;" id="sb-power-watt">110.4 W</span>
            </div>
            <div class="power-metrics-grid">
              <div class="detail-row">
                <span class="detail-label">5V Compute Rail:</span>
                <span class="detail-value" id="sb-rail-5v">5.06 V</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">12V Servo Rail:</span>
                <span class="detail-value" id="sb-rail-12v">12.04 V</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Pack Temperature:</span>
                <span class="detail-value" id="sb-power-temp">26.8 °C</span>
              </div>
              <div class="detail-row">
                <span class="detail-label">Cell Delta:</span>
                <span class="detail-value">8 mV</span>
              </div>
            </div>
          </div>
        </div>
      </aside>
    `;

    this.render();
  }

  render() {
    const listEl = this.container.querySelector('#sb-items-list');
    if (!listEl) return;

    const components = store.mode === 'live' ? [
      store.components.pi5,
      store.components.rplidar,
      store.components.gps,
      store.components.imu,
      store.components.esp32
    ] : [
      store.components.pi5,
      store.components.esp32,
      store.components.rplidar,
      store.components.gps,
      store.components.imu,
      store.components.camera,
      store.components.power
    ];

    const now = Date.now();

    listEl.innerHTML = components.map(c => {
      const isExpanded = this.expandedId === c.id;
      const ageMs = c.lastMsgTime ? now - c.lastMsgTime : Infinity;
      const ageText = !Number.isFinite(ageMs) ? 'NO DATA' : ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`;

      let freshnessClass = '';
      if (ageMs > 2500) freshnessClass = 'critical';
      else if (ageMs > 800) freshnessClass = 'stale';

      let statusBadgeClass = 'nominal';
      let statusLabel = c.status === 'disconnected' ? 'NO DATA' : 'HEALTHY';
      if (c.status === 'stale') {
        statusBadgeClass = 'warn';
        statusLabel = 'STALE';
      } else if (c.status === 'fault') {
        statusBadgeClass = 'fault';
        statusLabel = 'FAULT';
      } else if (c.status === 'disconnected') {
        statusBadgeClass = 'disconnected';
        statusLabel = 'DISCONN';
      }

      return `
        <div class="health-item ${isExpanded ? 'active-item' : ''}" data-id="${c.id}">
          <div class="health-item-summary">
            <div class="health-item-left">
              <span class="status-pill ${statusBadgeClass}" style="padding: 1px 4px;">
                <span class="status-indicator-dot"></span>
              </span>
              <div>
                <div class="health-name">${c.name}</div>
                <div class="health-topic">${c.topic}</div>
              </div>
            </div>
            <div class="health-item-right">
              <span class="health-rate tabular-nums">${Number(c.rate || 0).toFixed(1)} Hz</span>
              <span class="health-freshness tabular-nums ${freshnessClass}">${ageText}</span>
            </div>
          </div>

          ${isExpanded ? this.renderDetails(c) : ''}
        </div>
      `;
    }).join('');

    const countEl = this.container.querySelector('#sb-comp-count');
    if (countEl && store.mode === 'live') {
      const active = components.filter((component) => component.lastMsgTime && now - component.lastMsgTime < 3000).length;
      countEl.textContent = `${active} / ${components.length} TOPICS`;
    }

    // Attach click listeners for accordion
    listEl.querySelectorAll('.health-item-summary').forEach(el => {
      el.addEventListener('click', (e) => {
        const parent = el.closest('.health-item');
        const id = parent.getAttribute('data-id');
        this.expandedId = this.expandedId === id ? null : id;
        this.render();
      });
    });

    // Update power block
    const p = store.components.power;
    if (store.mode === 'live') {
      const box = this.container.querySelector('.power-summary-box');
      if (box && !box.dataset.livePlaceholder) {
        box.innerHTML = '<div class="tech-label">BATTERY / POWER</div><div class="detail-label" style="margin-top:8px">No battery or power telemetry topic is published by the current ROS 2 project.</div>';
        box.dataset.livePlaceholder = 'true';
      }
    } else if (p) {
      const box = this.container.querySelector('.power-summary-box');
      if (box?.dataset.livePlaceholder) {
        box.innerHTML = this.powerSummaryMarkup;
        delete box.dataset.livePlaceholder;
      }
      const socEl = this.container.querySelector('#sb-power-soc');
      const voltEl = this.container.querySelector('#sb-power-volt');
      const ampEl = this.container.querySelector('#sb-power-amp');
      const wattEl = this.container.querySelector('#sb-power-watt');
      const tempEl = this.container.querySelector('#sb-power-temp');
      if (socEl) socEl.textContent = `${p.soc.toFixed(1)}% SOC`;
      if (voltEl) voltEl.textContent = `${p.voltage.toFixed(2)} V`;
      if (ampEl) ampEl.textContent = `${p.current.toFixed(2)} A`;
      if (wattEl) wattEl.textContent = `${p.powerDraw.toFixed(1)} W`;
      if (tempEl) tempEl.textContent = `${p.temp.toFixed(1)} °C`;
    }
  }

  renderDetails(c) {
    if (store.mode === 'live') {
      const rows = c.id === 'pi5'
        ? `<div class="detail-row"><span class="detail-label">Source:</span><span class="detail-value">/odometry/global</span></div><div class="detail-row"><span class="detail-label">Position:</span><span class="detail-value">${store.hasGlobalOdom ? `${store.vehicle.x.toFixed(2)}, ${store.vehicle.y.toFixed(2)} m` : '—'}</span></div><div class="detail-row"><span class="detail-label">Speed:</span><span class="detail-value">${store.hasGlobalOdom ? `${store.vehicle.vx.toFixed(2)} m/s` : '—'}</span></div>`
        : c.id === 'gps'
          ? `<div class="detail-row"><span class="detail-label">Fix status:</span><span class="detail-value">${c.lastMsgTime ? c.fixType : 'No fix received'}</span></div><div class="detail-row"><span class="detail-label">Coordinates:</span><span class="detail-value">${c.lastMsgTime ? `${Number(c.lat).toFixed(6)}, ${Number(c.lon).toFixed(6)}` : '—'}</span></div><div class="detail-row"><span class="detail-label">Altitude:</span><span class="detail-value">${c.lastMsgTime ? c.alt : '—'}</span></div>`
          : c.id === 'imu'
            ? `<div class="detail-row"><span class="detail-label">Yaw rate:</span><span class="detail-value">${c.lastMsgTime ? `${Number(c.yawRate).toFixed(2)} °/s` : '—'}</span></div><div class="detail-row"><span class="detail-label">Lateral acceleration:</span><span class="detail-value">${c.lastMsgTime ? `${Number(c.lateralAcc).toFixed(2)} m/s²` : '—'}</span></div>`
            : c.id === 'rplidar'
              ? `<div class="detail-row"><span class="detail-label">Returns:</span><span class="detail-value">${c.samples ?? '—'}</span></div><div class="detail-row"><span class="detail-label">Range bounds:</span><span class="detail-value">${c.rangeMin || '—'} – ${c.rangeMax || '—'}</span></div>`
              : `<div class="detail-row"><span class="detail-label">Encoder ticks:</span><span class="detail-value">${c.encoderTicks ?? '—'}</span></div>`;
      return `<div class="health-item-details">${rows}</div>`;
    }
    let rows = '';
    if (c.id === 'pi5') {
      rows = `
        <div class="detail-row"><span class="detail-label">CPU Load:</span><span class="detail-value tabular-nums">${c.cpu.toFixed(1)}% (4 Cores)</span></div>
        <div class="detail-row"><span class="detail-label">RAM Usage:</span><span class="detail-value">${c.mem}</span></div>
        <div class="detail-row"><span class="detail-label">SoC Temp:</span><span class="detail-value tabular-nums">${c.temp.toFixed(1)} °C</span></div>
        <div class="detail-row"><span class="detail-label">OS & ROS:</span><span class="detail-value">${c.os}</span></div>
      `;
    } else if (c.id === 'esp32') {
      rows = `
        <div class="detail-row"><span class="detail-label">Free Heap:</span><span class="detail-value">${c.heap}</span></div>
        <div class="detail-row"><span class="detail-label">micro-ROS RTT:</span><span class="detail-value tabular-nums">${c.rtt.toFixed(1)} ms</span></div>
        <div class="detail-row"><span class="detail-label">Publish Jitter:</span><span class="detail-value tabular-nums">${c.jitter.toFixed(2)} ms</span></div>
        <div class="detail-row"><span class="detail-label">Transport:</span><span class="detail-value">${c.baud}</span></div>
      `;
    } else if (c.id === 'rplidar') {
      rows = `
        <div class="detail-row"><span class="detail-label">Motor Speed:</span><span class="detail-value tabular-nums">${c.rpm} RPM</span></div>
        <div class="detail-row"><span class="detail-label">Samples / Scan:</span><span class="detail-value">${c.samples}</span></div>
        <div class="detail-row"><span class="detail-label">Range Bounds:</span><span class="detail-value">${c.rangeMin} – ${c.rangeMax}</span></div>
        <div class="detail-row"><span class="detail-label">Device Health:</span><span class="detail-value">${c.health}</span></div>
      `;
    } else if (c.id === 'gps') {
      rows = `
        <div class="detail-row"><span class="detail-label">Fix Quality:</span><span class="detail-value">${c.fixType}</span></div>
        <div class="detail-row"><span class="detail-label">SVs & HDOP:</span><span class="detail-value tabular-nums">${c.sats} Sats (HDOP ${c.hdop})</span></div>
        <div class="detail-row"><span class="detail-label">Coordinates:</span><span class="detail-value tabular-nums">${c.lat.toFixed(5)}°N, ${c.lon.toFixed(5)}°E</span></div>
        <div class="detail-row"><span class="detail-label">Altitude:</span><span class="detail-value tabular-nums">${c.alt}</span></div>
      `;
    } else if (c.id === 'imu') {
      rows = `
        <div class="detail-row"><span class="detail-label">Calibration:</span><span class="detail-value">${c.calib}</span></div>
        <div class="detail-row"><span class="detail-label">Yaw Rate:</span><span class="detail-value tabular-nums">${c.yawRate.toFixed(2)} °/s</span></div>
        <div class="detail-row"><span class="detail-label">Lateral Acc:</span><span class="detail-value tabular-nums">${c.lateralAcc.toFixed(2)} m/s²</span></div>
        <div class="detail-row"><span class="detail-label">Sensor Temp:</span><span class="detail-value tabular-nums">${c.temp.toFixed(1)} °C</span></div>
      `;
    } else if (c.id === 'camera') {
      rows = `
        <div class="detail-row"><span class="detail-label">Resolution:</span><span class="detail-value">${c.res}</span></div>
        <div class="detail-row"><span class="detail-label">Frame Rate:</span><span class="detail-value tabular-nums">${c.fps.toFixed(1)} FPS</span></div>
        <div class="detail-row"><span class="detail-label">Pipeline Latency:</span><span class="detail-value tabular-nums">${c.latency.toFixed(1)} ms</span></div>
        <div class="detail-row"><span class="detail-label">Exposure:</span><span class="detail-value">${c.exposure}</span></div>
      `;
    } else if (c.id === 'power') {
      rows = `
        <div class="detail-row"><span class="detail-label">Bus Voltage:</span><span class="detail-value tabular-nums">${c.voltage.toFixed(2)} V</span></div>
        <div class="detail-row"><span class="detail-label">Bus Current:</span><span class="detail-value tabular-nums">${c.current.toFixed(2)} A</span></div>
        <div class="detail-row"><span class="detail-label">Power Draw:</span><span class="detail-value tabular-nums">${c.powerDraw.toFixed(1)} W</span></div>
        <div class="detail-row"><span class="detail-label">Logic Rails:</span><span class="detail-value">${c.rail12v} / ${c.rail5v}</span></div>
      `;
    }

    return `<div class="health-item-details">${rows}</div>`;
  }
}
