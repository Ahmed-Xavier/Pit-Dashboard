/* ==========================================================================
   ENIMIA Dashboard — Chronological Event Log Component
   Chronological telemetry & fault recorder with category and severity filters
   ========================================================================== */

import { store } from '../state.js';

export class EventLogComponent {
  constructor(containerEl) {
    this.container = containerEl;
    this.currentFilter = 'all'; // 'all' | 'warn' | 'fault'
    this.init();
    store.subscribe(() => this.render());
  }

  init() {
    this.container.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-group">
          <span class="panel-title">CHRONOLOGICAL EVENT LOG</span>
          <span class="panel-badge tabular-nums" id="evt-count">5 EVENTS</span>
        </div>
        <div class="panel-controls">
          <button class="log-filter-btn active" id="filter-all">ALL</button>
          <button class="log-filter-btn" id="filter-warn">WARN</button>
          <button class="log-filter-btn" id="filter-fault">FAULT</button>
          <button class="icon-btn" id="btn-export-log" title="Export event log to JSON">EXPORT</button>
        </div>
      </div>

      <div class="event-log-list" id="evt-list">
        <!-- Rendered dynamically -->
      </div>
    `;

    // Filter buttons
    const setFilter = (f, id) => {
      this.currentFilter = f;
      ['#filter-all', '#filter-warn', '#filter-fault'].forEach(btnId => {
        this.container.querySelector(btnId).classList.toggle('active', btnId === id);
      });
      this.render();
    };

    this.container.querySelector('#filter-all').addEventListener('click', () => setFilter('all', '#filter-all'));
    this.container.querySelector('#filter-warn').addEventListener('click', () => setFilter('warn', '#filter-warn'));
    this.container.querySelector('#filter-fault').addEventListener('click', () => setFilter('fault', '#filter-fault'));

    // Export button
    this.container.querySelector('#btn-export-log').addEventListener('click', () => {
      const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(store.events, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', dataStr);
      downloadAnchor.setAttribute('download', `enimia_events_${Date.now()}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    });

    this.render();
  }

  render() {
    const listEl = this.container.querySelector('#evt-list');
    const countEl = this.container.querySelector('#evt-count');
    if (!listEl) return;

    let filtered = store.events;
    if (this.currentFilter === 'warn') {
      filtered = filtered.filter(e => e.severity === 'warn' || e.severity === 'fault');
    } else if (this.currentFilter === 'fault') {
      filtered = filtered.filter(e => e.severity === 'fault');
    }

    if (countEl) {
      countEl.textContent = `${filtered.length} EVENTS`;
    }

    listEl.innerHTML = filtered.map(e => `
      <div class="event-row ${e.severity}">
        <span class="event-time mono">${e.timeStr}</span>
        <span class="event-source">${e.source}</span>
        <span class="event-message">${e.message}</span>
      </div>
    `).join('');
  }
}
