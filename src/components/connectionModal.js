/* ==========================================================================
   ENIMIA Dashboard — Connection & ROS Bridge Settings Modal
   Configuration for Foxglove WebSocket & ROSBridge protocol endpoints
   ========================================================================== */

import { store } from '../state.js';
import { rosBridge } from '../rosBridge.js';

export class ConnectionModalComponent {
  constructor(containerEl) {
    this.container = containerEl;
    this.isOpen = false;
    this.init();
  }

  init() {
    this.container.innerHTML = `
      <div class="modal-overlay" id="modal-conn-overlay">
        <div class="modal-dialog">
          <div class="modal-header">
            <span class="modal-title">ROS 2 JAZZY BRIDGE CONFIGURATION</span>
            <button class="icon-btn" id="modal-btn-close">✕</button>
          </div>

          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">WebSocket Bridge Endpoint</label>
              <input type="text" class="form-input" id="inp-bridge-url" value="${store.connection.endpoint}">
              <span class="form-help">Default: ws://127.0.0.1:8765 (Foxglove Bridge) or ws://127.0.0.1:9090 (ROSBridge)</span>
            </div>

            <div class="form-group">
              <label class="form-label">Transport Protocol</label>
              <select class="form-input" id="inp-bridge-proto">
                <option value="foxglove" ${store.connection.bridgeType === 'foxglove' ? 'selected' : ''}>Foxglove WebSocket Protocol (v1)</option>
                <option value="rosbridge" ${store.connection.bridgeType === 'rosbridge' ? 'selected' : ''}>ROSBridge WebSocket Protocol (v2.0 JSON)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Subscribed Vehicle Topics</label>
              <div style="background: var(--bg-app); border: 1px solid var(--border-color); border-radius: 3px; padding: 6px 8px; font-size: 11px; font-family: var(--font-mono); display: grid; grid-template-columns: 1fr 1fr; gap: 4px; max-height: 132px; overflow: auto;">
                ${rosBridge.targetTopics.map((item) => `<div>✓ ${item.topic} (${item.type.split('/').at(-1)})</div>`).join('')}
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Bridge Status Diagnostics</label>
              <div id="modal-conn-status-text" class="mono" style="font-size: 11px; padding: 6px 8px; border-radius: 3px; background: var(--bg-subtle);">
                Status: ${store.connection.status} | Total Packets: ${store.connection.totalPackets} | RTT: ${store.connection.rtt}ms
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn" id="modal-btn-disconnect">Disconnect</button>
            <button class="btn btn-primary" id="modal-btn-connect">Connect Live Bridge</button>
          </div>
        </div>
      </div>
    `;

    // Bind controls
    this.overlay = this.container.querySelector('#modal-conn-overlay');
    this.container.querySelector('#modal-btn-close').addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    this.container.querySelector('#modal-btn-connect').addEventListener('click', () => {
      const url = this.container.querySelector('#inp-bridge-url').value.trim();
      const proto = this.container.querySelector('#inp-bridge-proto').value;
      if (!url) {
        this.container.querySelector('#modal-conn-status-text').textContent = 'Enter a WebSocket endpoint first.';
        return;
      }
      this.close();
      store.connection.endpoint = url;
      store.connection.bridgeType = proto;
      store.setMode('live');
      rosBridge.connect(url);
    });

    this.container.querySelector('#modal-btn-disconnect').addEventListener('click', () => {
      rosBridge.disconnect();
      this.updateStatus();
    });

    // Listen to header button open
    document.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'btn-open-settings') {
        this.open();
      }
    });

    if (window.location.search.includes('settings=1')) {
      this.open();
    }
  }

  open() {
    this.isOpen = true;
    this.overlay.classList.add('active');
    this.updateStatus();
  }

  close() {
    this.isOpen = false;
    this.overlay.classList.remove('active');
  }

  updateStatus() {
    const el = this.container.querySelector('#modal-conn-status-text');
    if (el) {
      const detail = store.connection.errorMsg ? ` | ${store.connection.errorMsg}` : '';
      el.textContent = `Status: ${store.connection.status} | Packets: ${store.connection.totalPackets} | Latency: ${store.connection.rtt}ms${detail}`;
    }
  }
}
