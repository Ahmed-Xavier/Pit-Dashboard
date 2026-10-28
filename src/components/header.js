/* ==========================================================================
   ENIMIA Dashboard — Top Header Component
   Aesthetic: Warm minimal motorsport editorial styling
   ========================================================================== */

import { store } from '../state.js';
import { rosBridge } from '../rosBridge.js';

export class HeaderComponent {
  constructor(containerEl) {
    this.container = containerEl;
    this.init();
    store.subscribe((s, dirtyPanels) => this.render(dirtyPanels));
  }

  init() {
    this.container.innerHTML = `
      <header class="top-header">
        <div class="header-left">
          <div class="brand-group">
            <span class="brand-title">ENIMIA</span>
            <span class="brand-badge">PROTOTYPE</span>
            <span class="tech-label" style="margin-left: 4px;">AUTONOMOUS STAND MONITOR</span>
          </div>

          <div class="header-divider"></div>

          <div class="session-metadata">
            <div class="meta-item">
              <span class="meta-key">SESSION</span>
              <span class="meta-value tabular-nums" id="hdr-session-id">SEM26-DYN-T04</span>
            </div>
            <div class="meta-item">
              <span class="meta-key">LOCATION</span>
              <span class="meta-value" id="hdr-track-name">VALENCE STAND 03</span>
            </div>
          </div>
        </div>

        <div class="header-center">
          <div class="status-pill nominal" id="hdr-system-health">
            <span class="status-indicator-dot"></span>
            <span id="hdr-health-text">SYSTEM NOMINAL</span>
          </div>

          <div class="mode-switch-group">
            <button class="mode-btn active demo-mode" id="btn-mode-demo" title="Deterministic physics simulation of the vehicle and sensors">
              <span class="mode-dot"></span>
              <span>DEMO DATA</span>
            </button>
            <button class="mode-btn" id="btn-mode-live" title="Connect to real ROS 2 Jazzy vehicle bridge topics">
              <span class="mode-dot"></span>
              <span>LIVE FEED</span>
            </button>
          </div>
        </div>

        <div class="header-right">
          <div class="meta-item" style="text-align: right;">
            <span class="meta-key">BRIDGE STATUS</span>
            <span class="meta-value mono" id="hdr-bridge-status" style="font-size: 10px;">IDLE (DEMO ACTIVE)</span>
          </div>

          <div class="meta-item" style="text-align: right;">
            <span class="meta-key">SESSION ELAPSED</span>
            <span class="meta-value mono" id="hdr-session-elapsed">00:00:00</span>
          </div>

          <div class="meta-item" style="text-align: right;">
            <span class="meta-key">UTC TIME</span>
            <span class="meta-value mono" id="hdr-utc-clock">00:00:00.0</span>
          </div>

          <div class="header-divider"></div>

          <button class="icon-btn" id="btn-open-settings" title="Connection & WebSocket Settings">
            SETTINGS
          </button>
        </div>
      </header>
    `;

    // Mode button event listeners
    this.container.querySelector('#btn-mode-demo').addEventListener('click', () => {
      store.setMode('demo');
    });

    this.container.querySelector('#btn-mode-live').addEventListener('click', () => {
      store.setMode('live');
      if (store.connection.status === 'DISCONNECTED') {
        rosBridge.connect(store.connection.endpoint);
      }
    });

    // Start live clock ticker
    setInterval(() => this.updateClock(), 100);
  }

  updateClock() {
    const now = new Date();
    const clockEl = this.container.querySelector('#hdr-utc-clock');
    if (clockEl) {
      const utcStr = now.toISOString().substring(11, 21);
      clockEl.textContent = utcStr;
    }

    const elapsedEl = this.container.querySelector('#hdr-session-elapsed');
    if (elapsedEl && store.session.startTime) {
      const diffMs = Date.now() - store.session.startTime;
      const s = Math.floor(diffMs / 1000) % 60;
      const m = Math.floor(diffMs / 60000) % 60;
      const h = Math.floor(diffMs / 3600000);
      elapsedEl.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
  }

  render(dirtyPanels) {
    if (dirtyPanels && !dirtyPanels.header) return;

    const sessionEl = this.container.querySelector('#hdr-session-id');
    const trackEl = this.container.querySelector('#hdr-track-name');
    if (sessionEl) sessionEl.textContent = store.session.id;
    if (trackEl) trackEl.textContent = store.session.track;
    // Mode buttons
    const demoBtn = this.container.querySelector('#btn-mode-demo');
    const liveBtn = this.container.querySelector('#btn-mode-live');
    if (store.mode === 'demo') {
      demoBtn.className = 'mode-btn active demo-mode';
      liveBtn.className = 'mode-btn';
    } else {
      demoBtn.className = 'mode-btn';
      liveBtn.className = 'mode-btn active live-mode';
    }

    // Health pill
    const healthEl = this.container.querySelector('#hdr-system-health');
    const healthTextEl = this.container.querySelector('#hdr-health-text');
    if (healthEl && healthTextEl) {
      if (store.systemHealth === 'NOMINAL') {
        healthEl.className = 'status-pill nominal';
        healthTextEl.textContent = 'SYSTEM NOMINAL';
      } else if (store.systemHealth === 'DEGRADED') {
        healthEl.className = 'status-pill warn';
        healthTextEl.textContent = 'TELEMETRY DEGRADED';
      } else {
        healthEl.className = 'status-pill fault';
        healthTextEl.textContent = 'SUBSYSTEM FAULT';
      }
    }

    // Bridge Status
    const bridgeEl = this.container.querySelector('#hdr-bridge-status');
    if (bridgeEl) {
      if (store.mode === 'demo') {
        bridgeEl.textContent = 'SIM ACTIVE (COORDINATED)';
        bridgeEl.style.color = 'var(--accent-orange)';
      } else {
        if (store.connection.status === 'CONNECTED') {
          bridgeEl.textContent = `LIVE WS (${store.connection.rtt}ms RTT)`;
          bridgeEl.style.color = 'var(--accent-olive)';
        } else if (store.connection.status === 'CONNECTING') {
          bridgeEl.textContent = 'CONNECTING...';
          bridgeEl.style.color = 'var(--status-warn)';
        } else {
          bridgeEl.textContent = 'DISCONNECTED (NO BRIDGE)';
          bridgeEl.style.color = 'var(--status-fault)';
        }
      }
    }
  }
}
