/* ==========================================================================
   ENIMIA Dashboard — 3D Scene & Chase Camera Visualizer
   Loads car URDF, handles TF/ODOM pose updates, chase/orbit/top-down camera,
   debug axes helper, SDF world loader with drag-and-drop + auto-load,
   and centerline publication to store.
   ========================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { config } from '/config.js';
import { store } from '../state.js';
import { rosBridge } from '../rosBridge.js';
import { tfTree } from '../tf/transformTree.js';
import { parseUrdf } from '../urdf/urdfParser.js';
import { UrdfBuilder } from '../urdf/urdfBuilder.js';
import { SdfRenderer } from '../sdf/sdfRenderer.js';
import { cacheGet, cachePut, makeCacheKey } from '../sdf/sdfCache.js';
import { parseSdfXml } from '../sdf/sdfParser.js';
import { WorldProvider } from '../world/worldProvider.js';

export class Scene3DComponent {
  constructor(containerEl) {
    this.container = containerEl;
    window.__scene3D = this;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.orbitControls = null;
    this.rosRoot = null;
    this.carGroup = null;
    this.gridHelper = null;
    this.axesHelper = null;
    this.sdfGroup = null;
    this.sdfRenderer = new SdfRenderer();
    this.worldProviders = new WorldProvider();
    this.worldProviderId = null;
    this.mapStats = null;
    this.sdfWorker = null;
    this.sdfLoaded = false;
    this.lastMode = store.mode;
    this.localCarLoaded = false;
    this.liveDescriptionHash = null;
    this.pendingLiveDescriptionHash = null;
    this.liveDescriptionBuilds = 0;
    this.urdfWaitTimer = null;
    this.waypointObjects = null;
    this.waypointPreview = null;
    this.addWaypointMode = false;
    this.waypointRaycaster = new THREE.Raycaster();
    this.waypointNdc = new THREE.Vector2();
    this.waypointGround = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.mapGroundPlane = this.waypointGround;
    this.waypointPointerDown = null;
    store.subscribe((state, dirty) => {
      if (dirty?.waypoints) this.updateWaypointObjects();
      if (dirty?.scene3D && state.robotDescription) this.loadLiveRobotDescription(state.robotDescription);
      if (state.mode !== this.lastMode) this.onModeChange(state.mode);
    });

    // Camera settings
    this.cameraMode = config.camera.defaultMode || 'chase';
    this.chasePos = new THREE.Vector3(0, 0, 2);
    this.chaseLook = new THREE.Vector3(0, 0, 0);

    // Preallocated scratch vectors for camera update (Fix Group 3 — no per-frame GC)
    this._camForward   = new THREE.Vector3();
    this._camUp        = new THREE.Vector3(0, 1, 0);
    this._camTargetPos = new THREE.Vector3();
    this._camTargetAim = new THREE.Vector3();
    this._carWorldPos  = new THREE.Vector3();

    // Active pose state
    this.currentPose = { x: 0, y: 0, z: 0, yaw: 0, source: 'INIT' };

    // Cached centerline AABB (recomputed only when centerline changes)
    this._trackBoundsVersion = -1;
    this._trackBounds = null;

    // Performance telemetry
    this.lastFrameTime = performance.now();
    this.frameCount = 0;
    this.fps = 60;
    this.fpsTimer = performance.now();
    this.drawCalls = 0;

    this.isRunning = false;
    this.animFrameId = null;

    this.init();
  }

  async init() {
    this.container.innerHTML = `
      <div class="panel-header">
        <div class="panel-title-group">
          <span class="panel-title">3D VEHICLE &amp; ENVIRONMENT</span>
          <span class="panel-badge" id="scene3d-urdf-status">URDF WAITING</span>
          <span class="panel-badge" id="scene3d-sdf-status">SDF NOT LOADED</span>
          <span class="panel-badge" id="scene3d-map-status">MAP IDLE</span>
          <span class="panel-badge tabular-nums" id="scene3d-fps">60 FPS</span>
          <span class="panel-badge" id="scene3d-pose-source">POSE: INIT</span>
        </div>
        <div class="panel-controls">
          <button class="icon-btn active" id="btn-cam-chase" title="Chase Camera">CHASE</button>
          <button class="icon-btn" id="btn-cam-orbit" title="Free Orbit Camera">ORBIT</button>
          <button class="icon-btn" id="btn-cam-topdown" title="Top-Down Overhead Camera">TOP-DOWN</button>
          <button class="icon-btn" id="btn-toggle-view-mode" title="Toggle 2D / 3D">SWITCH TO 2D</button>
          <button class="icon-btn" id="btn-add-waypoint-mode" title="Add waypoint by click (W)">ADD WAYPOINT BY CLICK</button>
          <label class="tech-label" for="world-provider-select">WORLD</label>
          <select class="icon-btn world-provider-select" id="world-provider-select" aria-label="World provider"><option value="xyz-osm">MAP</option><option value="sdf">SDF</option><option value="grid">GRID</option></select>
        </div>
      </div>

      <div class="sensor-canvas-wrapper" id="scene3d-wrapper" style="position: relative; width: 100%; height: calc(100% - 38px); overflow: hidden;">
        <canvas id="scene3d-canvas" style="display: block; width: 100%; height: 100%;"></canvas>
        <a id="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>

        <!-- SDF progress overlay -->
        <div id="sdf-progress" style="display:none; position:absolute; top:50px; left:50%; transform:translateX(-50%); background:rgba(10,15,22,0.92); border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:10px 18px; z-index:11; font:600 11px var(--font-mono,monospace); color:#38bdf8; white-space:nowrap;"></div>

        <!-- Debug On-Screen Pose & Telemetry Line -->
        <div class="canvas-cursor-readout mono" id="scene3d-debug-overlay" style="left: 14px; top: 14px; right: auto; background: rgba(14, 17, 23, 0.85); border: 1px solid rgba(255,255,255,0.15); padding: 6px 10px; border-radius: 4px; pointer-events: none; font-size: 11px;">
          <span id="scene3d-dbg-source" style="color: #248eff; font-weight: 600;">[POSE: INIT]</span>
          <span id="scene3d-dbg-coords">X: +0.00m  Y: +0.00m  Z: +0.00m  Yaw: +0.0°</span>
          <span id="scene3d-dbg-calls" style="color: #999; margin-left: 10px;">Draw Calls: 0</span>
        </div>

        <!-- Legend / Axis Helper Card -->
        <div class="canvas-legend" style="bottom: 14px; left: 14px; font-size: 10px;">
          <div class="legend-item"><span style="display:inline-block; width:10px; height:3px; background:#ff4444; margin-right:6px;"></span><span>+X Forward (Red)</span></div>
          <div class="legend-item"><span style="display:inline-block; width:10px; height:3px; background:#44cc44; margin-right:6px;"></span><span>+Y Left (Green)</span></div>
          <div class="legend-item"><span style="display:inline-block; width:10px; height:3px; background:#4488ff; margin-right:6px;"></span><span>+Z Up (Blue)</span></div>
        </div>
      </div>
    `;

    this.canvas = this.container.querySelector('#scene3d-canvas');
    this.wrapper = this.container.querySelector('#scene3d-wrapper');

    this.setupThree();
    this.setupControls();
    this.setupResizeObserver();

    // Load car model
    if (this.lastMode === 'demo') {
      await this.loadCarModel();
      this.localCarLoaded = true;
    } else {
      const statusEl = this.container.querySelector('#scene3d-urdf-status');
      statusEl.textContent = 'WAITING FOR /robot_description';
      statusEl.title = `Waiting up to ${config.urdf.waitSec ?? 10} seconds for the live robot model`;
      this.urdfWaitTimer = setTimeout(() => {
        if (!this.liveDescriptionHash && statusEl.isConnected) statusEl.textContent = 'WAITING FOR /robot_description';
      }, (config.urdf.waitSec ?? 10) * 1000);
      if (store.robotDescription) this.loadLiveRobotDescription(store.robotDescription);
    }

    this.container.querySelector('#world-provider-select')?.addEventListener('change', (event) => this.requestWorldProvider(event.target.value, '', true));
    this.requestWorldProvider(this.lastMode === 'demo' ? 'sdf' : config.map.defaultProvider);

    // Start render loop
    this.start();
  }

  async onModeChange(mode) {
    this.lastMode = mode;
    if (mode === 'demo') {
      if (this.liveDescriptionHash && !this.localCarLoaded) {
        this.disposeCarModel();
        this.liveDescriptionHash = null;
      }
      if (!this.localCarLoaded) { await this.loadCarModel(); this.localCarLoaded = true; }
      this.requestWorldProvider('sdf');
      return;
    }
    if (this.localCarLoaded) this.disposeCarModel();
    this.localCarLoaded = false;
    store.trackCenterline = [];
    store.notify();
    if (this.urdfWaitTimer) clearTimeout(this.urdfWaitTimer);
    const statusEl = this.container.querySelector('#scene3d-urdf-status');
    if (!this.liveDescriptionHash && statusEl) statusEl.textContent = 'WAITING FOR /robot_description';
    if (store.robotDescription) await this.loadLiveRobotDescription(store.robotDescription);
    this.requestWorldProvider(config.map.defaultProvider);
  }

  async requestWorldProvider(id, statusMessage = '', forceRetry = false) {
    this.lastWorldProviderRequest = id;
    (this.worldProviderRequests ||= []).push({ id, statusMessage, at: performance.now() });
    const xyz = this.worldProviders.providers.get('xyz-osm');
    if (id === 'xyz-osm' && xyz?.blocked && this.worldProviderId === 'grid' && !forceRetry) return;
    if (id === 'xyz-osm' && forceRetry && xyz) {
      xyz.blocked = false;
      xyz.offline = false;
      for (const tile of xyz.tiles.values()) {
        if (tile.status === 'failed') { tile.status = 'idle'; tile.retries = 0; tile.error = undefined; tile.retryAt = 0; }
      }
    }
    try {
      await this.worldProviders.load(this, id);
      this.lastWorldProviderLoaded = id;
      const select = this.container.querySelector('#world-provider-select');
      if (select && select.value !== id) select.value = id;
      const attribution = this.container.querySelector('#map-attribution');
      const item = this.worldProviders.attribution();
      if (attribution) {
        attribution.hidden = !item;
        if (item) { attribution.textContent = item.text; attribution.href = item.url; }
      }
      if (statusMessage) this.setMapStatus(statusMessage, 'fault');
    } catch (error) { this.worldProviderError = error.message; store.addFault('WORLD', `Could not select ${id}: ${error.message}`); }
  }

  setMapStatus(text, kind = 'nominal') {
    const el = this.container.querySelector('#scene3d-map-status');
    if (el) { el.textContent = text; el.dataset.status = kind; }
  }

  hashDescription(xml) {
    let hash = 2166136261;
    for (let i = 0; i < xml.length; i++) { hash ^= xml.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16);
  }

  async loadLiveRobotDescription(xml) {
    if (!xml || store.mode !== 'live') return;
    const hash = this.hashDescription(xml);
    if (hash === this.liveDescriptionHash || hash === this.pendingLiveDescriptionHash) return;
    this.pendingLiveDescriptionHash = hash;
    if (this.urdfWaitTimer) { clearTimeout(this.urdfWaitTimer); this.urdfWaitTimer = null; }
    const statusEl = this.container.querySelector('#scene3d-urdf-status');
    try {
      const parseStart = performance.now();
      const robotDef = parseUrdf(xml);
      const parseMs = performance.now() - parseStart;
      if (!robotDef.links.size) throw new Error('URDF contains no links');
      statusEl.textContent = `BUILDING ${robotDef.name.toUpperCase()}...`;
      const builder = new UrdfBuilder(config.urdf.meshBaseUrl, { assetResolver: (uri) => rosBridge.fetchAsset(uri) });
      const buildStart = performance.now();
      const newCar = await builder.build(robotDef);
      const buildMs = performance.now() - buildStart;
      if (store.mode !== 'live' || hash !== this.hashDescription(store.robotDescription || '')) { this.disposeObject(newCar); return; }
      this.disposeCarModel();
      this.carGroup = newCar;
      this.rosRoot.add(this.carGroup);
      this.liveDescriptionHash = hash;
      this.pendingLiveDescriptionHash = null;
      this.liveDescriptionBuilds++;
      this.carGroup.userData.liveMetrics = { parseMs, buildMs, buildCount: this.liveDescriptionBuilds, rootLink: robotDef.rootLink, assets: builder.assetMetrics };
      statusEl.textContent = `CAR: ${robotDef.name.toUpperCase()} (LIVE)`;
      statusEl.title = `root=${robotDef.rootLink}; parse=${parseMs.toFixed(1)} ms; build=${buildMs.toFixed(1)} ms; builds=${this.liveDescriptionBuilds}`;
      store.addEvent('URDF', 'info', `Built /robot_description (${robotDef.rootLink}) in ${buildMs.toFixed(1)} ms after ${parseMs.toFixed(1)} ms parse; build #${this.liveDescriptionBuilds}`);
    } catch (error) {
      this.pendingLiveDescriptionHash = null;
      statusEl.textContent = 'URDF ERROR';
      store.addFault('URDF', `Could not build /robot_description: ${error.message}`);
    }
  }

  disposeObject(root) {
    if (!root) return;
    root.traverse((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose?.();
    });
  }

  disposeCarModel() {
    if (!this.carGroup) return;
    this.disposeObject(this.carGroup);
    this.carGroup.parent?.remove(this.carGroup);
    this.carGroup = null;
  }

  setupThree() {
    const width = this.wrapper.clientWidth || 600;
    const height = this.wrapper.clientHeight || 400;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c0f14);

    this.camera = new THREE.PerspectiveCamera(
      config.camera.fov || 55,
      width / height,
      config.camera.near || 0.3,
      config.camera.far || 4000
    );

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.orbitControls = new OrbitControls(this.camera, this.canvas);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.05;
    this.orbitControls.maxDistance = config.camera.orbit.maxDistance || 800;
    this.orbitControls.minDistance = config.camera.orbit.minDistance || 0.5;
    this.orbitControls.enabled = (this.cameraMode === 'orbit');

    // Lights — strong enough to render MeshStandardMaterial on dark Collada meshes
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x556677, 1.4);
    hemiLight.position.set(0, 50, 0);
    this.scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight.position.set(30, 60, 40);
    this.scene.add(dirLight);

    const dirLight2 = new THREE.DirectionalLight(0x99aacc, 0.8);
    dirLight2.position.set(-30, 20, -30);
    this.scene.add(dirLight2);

    /*
     * ROS to Three.js coordinate system transformation:
     * ROS:      +X forward, +Y left,  +Z up
     * Three.js: +X right,   +Y up,    +Z towards viewer
     *
     * Rotating -90 deg on X:
     *   (x, y, z)_ros -> (x, z, -y)_three
     * All entities inside rosRoot use native ROS REP-103 coordinates directly.
     */
    this.rosRoot = new THREE.Group();
    this.rosRoot.name = 'ros_root_coordinate_transform';
    this.rosRoot.rotation.x = -Math.PI / 2;
    this.scene.add(this.rosRoot);
    this.waypointObjects = new THREE.Group();
    this.waypointObjects.name = 'waypoint_markers';
    this.rosRoot.add(this.waypointObjects);
    this.waypointPreview = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshBasicMaterial({ color: 0x26c6da, transparent: true, opacity: 0.72 }));
    this.waypointPreview.visible = false;
    this.scene.add(this.waypointPreview);

    // Temporary flat ground grid (removed when SDF world loads)
    this.gridHelper = new THREE.GridHelper(200, 200, 0x334466, 0x1a2230);
    this.gridHelper.name = 'temporary_ground_grid';
    // rosRoot maps its local ROS X/Y plane to Three.js X/Z.
    this.rosRoot.add(this.gridHelper);
  }

  setupControls() {
    const btnChase   = this.container.querySelector('#btn-cam-chase');
    const btnOrbit   = this.container.querySelector('#btn-cam-orbit');
    const btnTopDown = this.container.querySelector('#btn-cam-topdown');
    const btnWaypoint = this.container.querySelector('#btn-add-waypoint-mode');

    const setMode = (mode) => {
      this.cameraMode = mode;
      btnChase.classList.toggle('active', mode === 'chase');
      btnOrbit.classList.toggle('active', mode === 'orbit');
      btnTopDown.classList.toggle('active', mode === 'top-down');
      this.orbitControls.enabled = (mode === 'orbit');
      if (mode === 'orbit' && this.carGroup) {
        const carWorldPos = new THREE.Vector3();
        this.carGroup.getWorldPosition(carWorldPos);
        this.orbitControls.target.copy(carWorldPos);
      }
    };

    btnChase?.addEventListener('click', () => setMode('chase'));
    btnOrbit?.addEventListener('click', () => setMode('orbit'));
    btnTopDown?.addEventListener('click', () => setMode('top-down'));
    btnWaypoint?.addEventListener('click', () => this.setWaypointMode(!this.addWaypointMode));
    this.canvas.addEventListener('pointermove', (event) => this.updateWaypointPreview(event));
    this.canvas.addEventListener('pointerdown', (event) => {
      if (event.button === 0) this.waypointPointerDown = { x: event.clientX, y: event.clientY };
    });
    this.canvas.addEventListener('pointerup', (event) => {
      const down = this.waypointPointerDown; this.waypointPointerDown = null;
      if (!this.addWaypointMode || event.button !== 0 || !down || Math.hypot(event.clientX - down.x, event.clientY - down.y) >= 4) return;
      this.addWaypointAt(event);
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === '1' || e.key === 'c' || e.key === 'C') setMode('chase');
      if (e.key === '2' || e.key === 'o' || e.key === 'O') setMode('orbit');
      if (e.key === '3' || e.key === 't' || e.key === 'T') setMode('top-down');
      if (e.key === 'w' || e.key === 'W') this.setWaypointMode(!this.addWaypointMode);
    });



    // View mode switch button (2D / 3D toggle)
    const btnToggle = this.container.querySelector('#btn-toggle-view-mode');
    btnToggle?.addEventListener('click', () => {
      const sfContainer = document.querySelector('#sensor-fusion-mount');
      if (sfContainer) {
        const is3D = this.container.style.display !== 'none';
        this.container.style.display = is3D ? 'none' : 'block';
        sfContainer.style.display = is3D ? 'block' : 'none';
        btnToggle.textContent = is3D ? 'SWITCH TO 3D' : 'SWITCH TO 2D';
        if (is3D) this.stop(); else this.start();
      }
    });
  }

  setWaypointMode(enabled) {
    const button = this.container.querySelector('#btn-add-waypoint-mode');
    if (enabled && (store.mode !== 'live' || store.connection.status !== 'CONNECTED')) {
      store.addFault('WAYPOINTS', 'Connect the Foxglove bridge in LIVE mode before adding a waypoint.');
      return;
    }
    if (enabled) {
      try { rosBridge.advertiseClickedPoint(); }
      catch (error) { store.addFault('WAYPOINTS', error.message); return; }
    }
    this.addWaypointMode = enabled;
    if (button) button.classList.toggle('active', enabled);
    this.canvas.style.cursor = enabled ? 'crosshair' : '';
    if (!enabled && this.waypointPreview) this.waypointPreview.visible = false;
  }

  updateWaypointPreview(event) {
    if (!this.addWaypointMode || !this.camera || !this.waypointPreview) return;
    const rect = this.canvas.getBoundingClientRect();
    this.waypointNdc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.waypointRaycaster.setFromCamera(this.waypointNdc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.waypointRaycaster.ray.intersectPlane(this.waypointGround, hit)) { this.waypointPreview.visible = false; return; }
    this.waypointPreview.position.copy(hit);
    this.waypointPreview.visible = true;
  }

  addWaypointAt(event) {
    this.updateWaypointPreview(event);
    if (!this.waypointPreview?.visible) return;
    const point = this.rosRoot.worldToLocal(this.waypointPreview.position.clone());
    const offset = config.world.originOffset || { x: 0, y: 0, yaw: 0 };
    const c = Math.cos(offset.yaw || 0), s = Math.sin(offset.yaw || 0);
    const mapPoint = { x: c * point.x - s * point.y + (offset.x || 0), y: s * point.x + c * point.y + (offset.y || 0), z: point.z };
    try {
      rosBridge.publishClickedPoint(mapPoint, config.frames.worldFrame);
      const message = `Waypoint added at (${mapPoint.x.toFixed(2)}, ${mapPoint.y.toFixed(2)})`;
      store.addEvent('WAYPOINTS', 'info', message);
      store.dirtyPanels.waypoints = true;
      this.setWaypointMode(false);
    } catch (error) { store.addFault('WAYPOINTS', error.message); }
  }

  updateWaypointObjects() {
    if (!this.waypointObjects) return;
    const dispose = (object) => { if (object.geometry) object.geometry.dispose(); if (object.material) object.material.dispose(); };
    // Children are disposed before rebuilding; this runs only when marker/guidance data changes.
    this.waypointObjects.traverse(dispose);
    this.waypointObjects.clear();
    const toMap = (point) => {
      if (!point.frameId || point.frameId === config.frames.worldFrame) return new THREE.Vector3(point.x, point.y, point.z || 0);
      const tf = tfTree.lookup(config.frames.worldFrame, point.frameId);
      if (!tf?.valid) return null;
      const q = new THREE.Quaternion(tf.orientation.x, tf.orientation.y, tf.orientation.z, tf.orientation.w);
      return new THREE.Vector3(point.x, point.y, point.z || 0).applyQuaternion(q).add(new THREE.Vector3(tf.position.x, tf.position.y, tf.position.z));
    };
    const linePoints = (store.trackWaypointLine || []).map(toMap).filter(Boolean);
    if (linePoints.length > 1) {
      const geometry = new THREE.BufferGeometry().setFromPoints(linePoints);
      this.waypointObjects.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x36b7a2, linewidth: 2 })));
    }
    (store.trackWaypoints || []).forEach((waypoint, index) => {
      const position = toMap(waypoint); if (!position) return;
      const active = (waypoint.waypointIndex ?? index) === store.vehicle.activeWaypointIndex;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(active ? 0.34 : 0.24, 12, 8), new THREE.MeshStandardMaterial({ color: active ? 0xffb300 : 0x36b7a2, emissive: active ? 0x553300 : 0x003322 }));
      mesh.position.copy(position); this.waypointObjects.add(mesh);
    });
  }

  setupResizeObserver() {
    const ro = new ResizeObserver(() => {
      if (!this.wrapper || !this.renderer || !this.camera) return;
      const width = this.wrapper.clientWidth;
      const height = this.wrapper.clientHeight;
      if (width === 0 || height === 0) return;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    });
    ro.observe(this.wrapper);
  }



  setSdfStatus(msg, color = '#38bdf8') {
    const el = this.container.querySelector('#scene3d-sdf-status');
    if (el) { el.textContent = msg; el.style.color = color; }
  }

  showProgress(msg) {
    const el = this.container.querySelector('#sdf-progress');
    if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
  }

  async loadSdfFile(file) {
    const cacheKey = makeCacheKey(file.name, file.size, file.lastModified);
    this.setSdfStatus('CHECKING CACHE...', '#f59e0b');
    const t0 = performance.now();

    // Try cache first
    const cached = await cacheGet(cacheKey);
    if (cached) {
      const cacheLoadMs = (performance.now() - t0).toFixed(1);
      console.info(`[Scene3D] SDF cache hit for "${file.name}" in ${cacheLoadMs} ms`);
      store.addEvent('WORLD', 'info', `SDF "${file.name}" loaded from cache in ${cacheLoadMs} ms`);
      this._applyWorldResult(cached, file.name, cacheLoadMs, true);
      return;
    }

    // Parse via worker
    this.showProgress('READING FILE...');
    this.setSdfStatus('PARSING SDF...', '#f59e0b');
    const xmlText = await file.text();
    this._parseWithWorker(xmlText, cacheKey, file.name);
  }

  async loadSdfUrl(url, name, fileSize = 0, lastModified = 0) {
    const cacheKey = makeCacheKey(name, fileSize, lastModified);
    const t0 = performance.now();

    // Try cache first (for URL loads we use name+0+0 as key unless headers available)
    const cached = await cacheGet(cacheKey);
    if (cached) {
      const cacheLoadMs = (performance.now() - t0).toFixed(1);
      console.info(`[Scene3D] SDF cache hit for "${name}" in ${cacheLoadMs} ms`);
      this._applyWorldResult(cached, name, cacheLoadMs, true);
      return;
    }

    this.setSdfStatus('FETCHING SDF...', '#f59e0b');
    this.showProgress(`Fetching ${url}…`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xmlText = await res.text();
      // Re-key with actual content length if available
      const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
      const realKey = makeCacheKey(name, contentLength || xmlText.length, lastModified);
      this._parseWithWorker(xmlText, realKey, name);
    } catch (err) {
      this.showProgress('');
      this.setSdfStatus('SDF FETCH ERROR', '#f87171');
      store.addEvent('WORLD', 'warn', `SDF fetch failed: ${err.message}`);
      console.error('[Scene3D] SDF fetch failed:', err);
    }
  }

  _parseWithWorker(xmlText, cacheKey, name) {
    // Terminate any previous worker
    if (this.sdfWorker) { this.sdfWorker.terminate(); this.sdfWorker = null; }

    this.showProgress('PARSING SDF (XML)...');
    this.setSdfStatus('PARSING...', '#f59e0b');

    let models;
    try {
      models = parseSdfXml(xmlText);
    } catch (err) {
      this.showProgress('');
      this.setSdfStatus('SDF XML ERROR', '#f87171');
      store.addEvent('WORLD', 'warn', `SDF XML parse failed: ${err.message}`);
      console.error('[Scene3D] SDF XML parse failed:', err);
      return;
    }

    this.showProgress('COMPUTING GEOMETRY (worker)...');

    const worker = new Worker('/src/sdf/sdfWorker.js');
    this.sdfWorker = worker;

    worker.onmessage = async (evt) => {
      const { type, message, ...result } = evt.data;
      if (type === 'error') {
        this.showProgress('');
        this.setSdfStatus('SDF PARSE ERROR', '#f87171');
        store.addEvent('WORLD', 'warn', `SDF parse error: ${message}`);
        console.error('[Scene3D] SDF worker error:', message);
        worker.terminate();
        this.sdfWorker = null;
        return;
      }

      if (type === 'result') {
        // Cache for next time
        await cachePut(cacheKey, { batchArray: result.batchArray, centerline: result.centerline, meta: result });
        this._applyWorldResult({ batchArray: result.batchArray, centerline: result.centerline, meta: result }, name, null, false, result);
        worker.terminate();
        this.sdfWorker = null;
      }
    };

    worker.onerror = (err) => {
      this.showProgress('');
      this.setSdfStatus('WORKER ERROR', '#f87171');
      store.addEvent('WORLD', 'warn', `SDF worker crashed: ${err.message}`);
      console.error('[Scene3D] SDF worker crashed:', err);
      this.sdfWorker = null;
    };

    worker.postMessage({
      type: 'process',
      models,
      centerlineSpacing: config.world?.centerlineSpacing ?? 0.5
    });
  }

  _applyWorldResult(payload, name, cacheLoadMs, fromCache, meta) {
    const { batchArray, centerline } = payload;
    const m = meta || payload.meta || {};
    this.showProgress('');

    // Build and add Three.js world
    const worldGroup = this.sdfRenderer.build(batchArray);
    if (this.sdfGroup && this.sdfGroup.parent) {
      // Fix Group 3: dispose all geometry and materials before removing
      this.sdfGroup.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) m.dispose();
        }
      });
      this.rosRoot.remove(this.sdfGroup);
    }
    this.sdfGroup = worldGroup;
    this.rosRoot.add(this.sdfGroup);
    this.sdfGroup.visible = this.worldProviderId === 'sdf';

    // Keep the fallback grid available to the map provider.
    if (this.worldProviderId === 'sdf' && this.gridHelper && this.gridHelper.parent) {
      if (this.gridHelper.geometry) this.gridHelper.geometry.dispose();
      if (this.gridHelper.material) this.gridHelper.material.dispose();
      this.rosRoot.remove(this.gridHelper);
      this.gridHelper = null;
    }

    // Publish centerline to store for demo + minimap
    store.trackCenterline = centerline || [];
    store.trackWidth = centerline?.[0]?.trackWidth ?? (config.world?.trackWidth ?? 12.0);
    store.dirtyPanels.waypoints = true;

    this.sdfLoaded = true;

    const totalLen = m.totalLength ? Number(m.totalLength).toFixed(0) : '?';
    const pts = centerline ? centerline.length : 0;
    const parseMs = m.parseTimeMs || '?';
    const extractMs = m.extractTimeMs || '?';
    const skipMesh = m.skippedMesh ?? '?';

    const cacheInfo = fromCache ? ` [cache: ${cacheLoadMs}ms]` : ` [parse: ${parseMs}ms, extract: ${extractMs}ms]`;
    const statusTxt = `${name.replace(/\.sdf$/i, '').toUpperCase()} (OK)`;
    this.setSdfStatus(statusTxt, '#4ade80');

    const msg = `SDF world "${name}" loaded${cacheInfo}. ${m.segmentCount ?? '?'} track segments, ${pts} centerline pts, ${totalLen}m total. Skipped ${skipMesh} mesh refs.`;
    store.addEvent('WORLD', 'info', msg);
    console.info(`[Scene3D] ${msg}`);

    if (m.gaps && m.gaps.length > 0) {
      console.warn('[Scene3D] Centerline gaps:', m.gaps);
      store.addEvent('WORLD', 'warn', `Centerline: ${m.gaps.length} gap(s) > 2× segment length. Nearest-neighbor NOT applied (segments are sequential by index, continuous).`);
    }
    if (m.closureGap) {
      console.info(`[Scene3D] Loop closure gap: ${m.closureGap}m`);
    }

    // Emit to notify demo provider and minimap
    store.notify();
  }

  async loadCarModel() {
    const statusEl = this.container.querySelector('#scene3d-urdf-status');
    const startMeshTime = performance.now();

    try {
      statusEl.textContent = 'FETCHING URDF...';
      const res = await fetch(config.urdf.url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${config.urdf.url}`);

      const urdfXml = await res.text();
      const robotDef = parseUrdf(urdfXml);

      statusEl.textContent = 'BUILDING MESHES...';
      const builder = new UrdfBuilder(config.urdf.meshBaseUrl);
      this.carGroup = await builder.build(robotDef);

      this.meshLoadTimeMs = (performance.now() - startMeshTime).toFixed(1);
      this.rosRoot.add(this.carGroup);

      statusEl.textContent = `CAR: ${robotDef.name.toUpperCase()} (OK)`;
      statusEl.style.borderColor = 'rgba(74, 222, 128, 0.3)';
      statusEl.style.color = '#4ade80';

      console.info(`[Scene3D] URDF loaded in ${this.meshLoadTimeMs} ms.`);
    } catch (err) {
      console.error('[Scene3D] Failed to load car URDF:', err);
      statusEl.textContent = 'URDF ERROR';
      statusEl.style.color = '#f87171';
      store.addFault('URDF', `Failed to load car URDF: ${err.message}`);

      // Fallback simple car box
      this.carGroup = new THREE.Group();
      this.carGroup.name = 'fallback_car_model';
      const fallbackMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.4, 0.25),
        new THREE.MeshStandardMaterial({ color: 0x248eff, roughness: 0.3 })
      );
      fallbackMesh.position.z = 0.125;
      this.carGroup.add(fallbackMesh);
      this.carGroup.add(new THREE.AxesHelper(0.5));
      this.rosRoot.add(this.carGroup);
    }
  }

  updateVehiclePose() {
    // Fix Group 3: poseSource config gates TF vs ODOM
    const poseSource = config.tf?.poseSource || 'tf';

    let x = 0, y = 0, z = 0, yaw = 0, source = 'INIT';
    let quat = null;
    let tfResult = null;

    if (poseSource === 'tf') {
      tfResult = tfTree.lookup(config.frames.worldFrame, config.frames.carFrame);
    }

    if (tfResult && tfResult.valid) {
      x = tfResult.position.x;
      y = tfResult.position.y;
      z = tfResult.position.z;
      yaw = tfResult.yaw;
      quat = tfResult.orientation;
      source = `TF (${config.frames.worldFrame} -> ${config.frames.carFrame})`;
    } else if (store.hasGlobalOdom || store.vehicle.x !== 0 || store.vehicle.y !== 0) {
      // 2. Fallback: /odometry/global or demo
      x = store.vehicle.x || 0;
      y = store.vehicle.y || 0;
      z = store.vehicle.z || 0;
      yaw = store.vehicle.yaw || 0;
      quat = store.vehicle.orientation || null;
      source = store.mode === 'demo' ? 'DEMO' : 'ODOM (/odometry/global)';
    }

    this.currentPose = { x, y, z, yaw, source };

    // Update 3D car position & orientation
    if (this.carGroup) {
      this.carGroup.position.set(x, y, z);
      if (quat) {
        this.carGroup.quaternion.set(quat.x, quat.y, quat.z, quat.w);
      } else {
        this.carGroup.rotation.set(0, 0, yaw);
      }
    }

    // Update on-screen debug readout
    const dbgSource = this.container.querySelector('#scene3d-dbg-source');
    const dbgCoords = this.container.querySelector('#scene3d-dbg-coords');
    const dbgCalls  = this.container.querySelector('#scene3d-dbg-calls');
    const badgeSource = this.container.querySelector('#scene3d-pose-source');

    if (dbgSource) dbgSource.textContent = `[${source}]`;
    if (dbgCoords) {
      const yawDeg = ((yaw * 180) / Math.PI).toFixed(1);
      dbgCoords.textContent = `X: ${x >= 0 ? '+' : ''}${x.toFixed(2)}m  Y: ${y >= 0 ? '+' : ''}${y.toFixed(2)}m  Z: ${z >= 0 ? '+' : ''}${z.toFixed(2)}m  Yaw: ${yawDeg >= 0 ? '+' : ''}${yawDeg}°`;
    }
    if (dbgCalls && this.renderer) {
      dbgCalls.textContent = `Draw Calls: ${this.renderer.info.render.calls}`;
    }
    if (badgeSource) {
      badgeSource.textContent = source.startsWith('TF') ? 'POSE: TF OK' : `POSE: ${source.split(' ')[0]}`;
      badgeSource.style.color = source.startsWith('TF') ? '#4ade80' : '#38bdf8';
    }
  }

  updateCamera(dt) {
    if (!this.carGroup) return;

    // Reuse preallocated scratch vector (Fix Group 3)
    this.carGroup.getWorldPosition(this._carWorldPos);
    const carPos = this._carWorldPos;
    const yaw = this.currentPose.yaw;

    if (this.cameraMode === 'chase') {
      const cfg = config.camera.chase;
      const d = cfg.distance || 2.2;
      const h = cfg.height || 1.0;
      const lookAhead = cfg.lookAhead || 1.5;
      const k = cfg.smoothFactor || 5.0;

      // In Three.js world space (rosRoot rotated -PI/2 on X):
      // +X_ros -> +X_world, +Y_ros -> -Z_world, +Z_ros -> +Y_world
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      this._camForward.set(cosYaw, 0, -sinYaw); // already unit length

      this._camTargetPos.copy(carPos)
        .addScaledVector(this._camForward, -d)
        .addScaledVector(this._camUp, h);

      this._camTargetAim.copy(carPos)
        .addScaledVector(this._camForward, lookAhead);

      const alpha = 1 - Math.exp(-k * dt);
      this.chasePos.lerp(this._camTargetPos, alpha);
      this.chaseLook.lerp(this._camTargetAim, alpha);

      this.camera.position.copy(this.chasePos);
      this.camera.lookAt(this.chaseLook);
    } else if (this.cameraMode === 'top-down') {
      const h = config.camera.topDown.height || 25.0;
      this.camera.position.set(carPos.x, h, carPos.z);
      this.camera.lookAt(carPos);
    } else if (this.cameraMode === 'orbit') {
      this.orbitControls.update();
    }
  }

  render() {
    if (!this.isRunning) return;

    const now = performance.now();
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    // Measure FPS
    this.frameCount++;
    if (now - this.fpsTimer >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / (now - this.fpsTimer));
      this.frameCount = 0;
      this.fpsTimer = now;
      const fpsEl = this.container.querySelector('#scene3d-fps');
      if (fpsEl) fpsEl.textContent = `${this.fps} FPS`;
    }

    this.updateVehiclePose();
    this.updateCamera(dt);
    this.worldProviders.update(this.currentPose, dt);

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
      this.drawCalls = this.renderer.info.render.calls;
    }

    this.animFrameId = requestAnimationFrame(() => this.render());
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastFrameTime = performance.now();
    this.animFrameId = requestAnimationFrame(() => this.render());
  }

  stop() {
    this.isRunning = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  dispose() {
    this.stop();
    if (this.sdfWorker) { this.sdfWorker.terminate(); this.sdfWorker = null; }
    if (this.orbitControls) this.orbitControls.dispose();
    this.worldProviders.dispose(this);
    if (this.renderer) this.renderer.dispose();
    this.sdfRenderer.dispose();
  }
}
