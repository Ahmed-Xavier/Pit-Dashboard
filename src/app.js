/* ==========================================================================
   ENIMIA Dashboard — Main Application Orchestrator
   ========================================================================== */

import { store } from './state.js';
import { demoProvider } from './demoProvider.js';
import { rosBridge } from './rosBridge.js';

import { HeaderComponent } from './components/header.js';
import { HealthSidebarComponent } from './components/healthSidebar.js';
import { Scene3DComponent } from './components/scene3D.js';
import { SensorFusionComponent } from './components/sensorFusion.js';
import { TrackNavComponent } from './components/trackNav.js';
import { CameraPanelComponent } from './components/cameraPanel.js';
import { PipelinePanelComponent } from './components/pipelinePanel.js';
import { TelemetryChartsComponent } from './components/telemetryCharts.js';
import { EventLogComponent } from './components/eventLog.js';
import { ConnectionModalComponent } from './components/connectionModal.js';
import { WaypointControlsComponent } from './components/waypointControls.js';

document.addEventListener('DOMContentLoaded', () => {
  const demoRequested = new URLSearchParams(window.location.search).get('mode') === 'demo';
  if (!demoRequested) store.setMode('live');

  // Initialize UI Components
  const header = new HeaderComponent(document.getElementById('header-mount'));
  const healthSidebar = new HealthSidebarComponent(document.getElementById('sidebar-mount'));
  const scene3D = new Scene3DComponent(document.getElementById('scene3d-mount'));
  const sensorFusion = new SensorFusionComponent(document.getElementById('sensor-fusion-mount'));
  const trackNav = new TrackNavComponent(document.getElementById('track-nav-mount'));
  new WaypointControlsComponent(trackNav.container);
  const cameraPanel = new CameraPanelComponent(document.getElementById('camera-mount'));
  const pipelinePanel = new PipelinePanelComponent(document.getElementById('pipeline-mount'));
  const telemetryCharts = new TelemetryChartsComponent(document.getElementById('telemetry-mount'));
  const eventLog = new EventLogComponent(document.getElementById('event-log-mount'));
  const connectionModal = new ConnectionModalComponent(document.getElementById('modal-mount'));

  // Wire slot drain to UI tick
  store.registerDrainCallback(() => rosBridge.drainSlotsToStore());

  // Live ROS data is the default. Demo motion is an explicit opt-in.
  if (demoRequested) {
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
