/* ==========================================================================
   ENIMIA Dashboard — Autonomy Pipeline Strip Component
   LOCALIZATION → PERCEPTION → PLANNING → CONTROL
   ========================================================================== */

import { store } from '../state.js';

export class PipelinePanelComponent {
  constructor(containerEl) {
    this.container = containerEl;
    this.lastSig = '';
    this.init();
    store.subscribe((s, dirtyPanels) => this.render(dirtyPanels));
  }

  init() {
    this.container.innerHTML = `
      <div class="pipeline-track" id="pipeline-stages-container">
        <!-- Stages rendered dynamically -->
      </div>
    `;
    this.render();
  }

  render(dirtyPanels) {
    if (dirtyPanels && !dirtyPanels.pipeline) return;

    const stagesEl = this.container.querySelector('#pipeline-stages-container');
    if (!stagesEl) return;

    const p = store.pipeline;
    const stages = [
      { key: 'localization', num: '01', name: 'LOCALIZATION', data: p.localization },
      { key: 'perception', num: '02', name: 'PERCEPTION', data: p.perception },
      { key: 'planning', num: '03', name: 'PLANNING', data: p.planning },
      { key: 'control', num: '04', name: 'CONTROL', data: p.control }
    ];

    const sig = stages.map(s => `${s.data.status}:${Number(s.data.hz || 0).toFixed(0)}:${s.data.diagnostic}`).join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    stagesEl.innerHTML = stages.map((s, idx) => {
      let statusClass = 'active';
      if (s.data.status === 'warn') statusClass = 'warn';
      else if (s.data.status === 'fault') statusClass = 'fault';

      const arrow = idx < stages.length - 1 ? '<div class="pipeline-arrow">→</div>' : '';

      return `
        <div class="pipeline-stage ${statusClass}">
          <span class="stage-num">${s.num}</span>
          <div class="stage-info">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <span class="stage-name">${s.name}</span>
              <span class="tabular-nums mono" style="font-size: 9px; color: var(--text-secondary);">${Number(s.data.hz || 0).toFixed(1)} Hz · ${store.mode === 'live' ? 'latency —' : `${s.data.latencyMs.toFixed(1)}ms`}</span>
            </div>
            <div class="stage-diag">${s.data.diagnostic}</div>
          </div>
        </div>
        ${arrow}
      `;
    }).join('');
  }
}
