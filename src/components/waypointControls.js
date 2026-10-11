import { store } from '../state.js';
import { rosBridge } from '../rosBridge.js';

export class WaypointControlsComponent {
  constructor(trackNavContainer) {
    this.container = trackNavContainer;
    this.services = null;
    this.inFlight = false;
    this.result = 'LIVE FEED required';
    this.resultKind = '';
    this.init();
    store.subscribe(() => this.render());
    this.loadConfig();
  }

  init() {
    const controls = this.container.querySelector('.panel-controls');
    if (!controls) return;
    controls.insertAdjacentHTML('beforeend', `
      <div class="waypoint-controls" role="group" aria-label="Waypoint controls">
        <button class="waypoint-btn" data-waypoint-action="start" disabled>START</button>
        <button class="waypoint-btn" data-waypoint-action="add" disabled>ADD</button>
        <button class="waypoint-btn" data-waypoint-action="undo" disabled>UNDO</button>
        <button class="waypoint-btn waypoint-clear" data-waypoint-action="clear" disabled>CLEAR</button>
      </div>
      <span class="waypoint-action-result" aria-live="polite">${this.result}</span>
    `);
    this.resultEl = controls.querySelector('.waypoint-action-result');
    controls.querySelectorAll('[data-waypoint-action]').forEach((button) => {
      button.addEventListener('click', () => this.run(button.dataset.waypointAction));
    });
  }

  async loadConfig() {
    try {
      const response = await fetch('./config/topics.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.services = (await response.json()).services;
      this.render();
    } catch (err) {
      this.setResult(`Could not load waypoint service config: ${err.message}`, 'error');
    }
  }

  canCall(key) {
    const service = this.services?.[key];
    return Boolean(service && store.mode === 'live' &&
      store.connection.bridgeType === 'foxglove' &&
      store.connection.status === 'CONNECTED' &&
      rosBridge.services.has(service.name) &&
      rosBridge.capabilities.has('services') && !this.inFlight);
  }

  render() {
    if (!this.resultEl) return;
    this.container.querySelectorAll('[data-waypoint-action]').forEach((button) => {
      button.disabled = !this.canCall(button.dataset.waypointAction);
    });
    this.resultEl.textContent = this.result;
    this.resultEl.className = `waypoint-action-result ${this.resultKind}`;
  }

  setResult(message, kind = '') {
    this.result = message;
    this.resultKind = kind;
    this.render();
  }

  async run(key) {
    if (key === 'clear' && !window.confirm('Clear all waypoints and stop the active route?')) return;
    const service = this.services?.[key];
    if (!service) return this.setResult(`Missing service config for ${key}`, 'error');
    this.inFlight = true;
    this.setResult(`Calling ${service.name}…`);
    try {
      const response = await rosBridge.callTrigger(service.name);
      this.setResult(response.message || (response.success ? 'Success' : 'Service returned failure'),
        response.success ? 'success' : 'error');
    } catch (err) {
      this.setResult(err.message, 'error');
    } finally {
      this.inFlight = false;
      this.render();
    }
  }
}
