/* ==========================================================================
   ENIMIA Dashboard — Main Application Orchestrator
   ========================================================================== */

import { store } from './state.js';
import { demoProvider } from './demoProvider.js';
import { rosBridge } from './rosBridge.js';

import { HeaderComponent } from './components/header.js';
import { HealthSidebarComponent } from './components/healthSidebar.js';
import { SensorFusionComponent } from './components/sensorFusion.js';
import { TrackNavComponent } from './components/trackNav.js';
import { CameraPanelComponent } from './components/cameraPanel.js';
import { PipelinePanelComponent } from './components/pipelinePanel.js';
import { TelemetryChartsComponent } from './components/telemetryCharts.js';
import { EventLogComponent } from './components/eventLog.js';
import { ConnectionModalComponent } from './components/connectionModal.js';

document.addEventListener('DOMContentLoaded', () => {
  // Initialize UI Components
  const header = new HeaderComponent(document.getElementById('header-mount'));
  const healthSidebar = new HealthSidebarComponent(document.getElementById('sidebar-mount'));
  const sensorFusion = new SensorFusionComponent(document.getElementById('sensor-fusion-mount'));
  const trackNav = new TrackNavComponent(document.getElementById('track-nav-mount'));
  const cameraPanel = new CameraPanelComponent(document.getElementById('camera-mount'));
  const pipelinePanel = new PipelinePanelComponent(document.getElementById('pipeline-mount'));
  const telemetryCharts = new TelemetryChartsComponent(document.getElementById('telemetry-mount'));
  const eventLog = new EventLogComponent(document.getElementById('event-log-mount'));
  const connectionModal = new ConnectionModalComponent(document.getElementById('modal-mount'));

  // Start in Demo mode with coordinated kinematics by default
  if (window.location.search.includes('mode=live')) {
    store.setMode('live');
  } else {
    demoProvider.start();
  }

  // Listen to mode changes
  store.subscribe((s) => {
    if (s.mode === 'demo') {
      if (!demoProvider.running) demoProvider.start();
    } else {
      demoProvider.stop();
    }
  });

  console.log('ENIMIA Autonomous Vehicle Engineering Dashboard initialized.');
});
