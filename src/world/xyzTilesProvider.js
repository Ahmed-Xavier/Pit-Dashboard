import * as THREE from 'three';
import { config } from '/config.js';
import { GeoReference } from '../geo/geoRef.js';
import { GridProvider } from './gridProvider.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function lonToTileX(lon, zoom) { return (lon + 180) / 360 * 2 ** zoom; }
function latToTileY(lat, zoom) {
  const rad = THREE.MathUtils.degToRad(clamp(lat, -85.05112878, 85.05112878));
  return (1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * 2 ** zoom;
}
function tileToLon(x, zoom) { return x / 2 ** zoom * 360 - 180; }
function tileToLat(y, zoom) { return THREE.MathUtils.radToDeg(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom)))); }
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (((a.y > point.y) !== (b.y > point.y)) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y || 1e-30) + a.x) inside = !inside;
  }
  return inside;
}

export class XyzTilesProvider {
  constructor(provider = config.map.providers[0]) {
    this.id = provider.id;
    this.provider = provider;
    this.geoRef = new GeoReference(config.geo);
    this.tiles = new Map();
    this.queue = [];
    this.active = 0;
    this.visibleKeys = new Set();
    this.requests = [];
    this.requestCount = 0;
    this.cacheHits = 0;
    this.blocked = false;
    this.offline = false;
    this.limited = false;
    this.disposed = false;
    this.lastViewAt = 0;
    this.layer = null;
    this.statsEl = null;
  }

  attribution() { return this.provider.attribution; }

  load(scene) {
    this.disposed = false;
    this.scene = scene;
    this.layer = new THREE.Group();
    this.layer.name = 'osm_xyz_tiles';
    scene.rosRoot.add(this.layer);
    new GridProvider().load(scene);
    this.updateStatus();
  }

  getVisiblePolygon() {
    const scene = this.scene;
    const rect = scene.canvas.getBoundingClientRect();
    const corners = [[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]];
    const polygon = [];
    scene.camera.updateMatrixWorld();
    for (const [x, y] of corners) {
      const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, scene.camera);
      const hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(scene.mapGroundPlane, hit)) continue;
      const local = scene.rosRoot.worldToLocal(hit);
      polygon.push({ x: local.x, y: local.y });
    }
    if (polygon.length >= 3) return polygon;
    const p = scene.currentPose;
    const extent = Math.max(10, (scene.camera.position.distanceTo(scene.orbitControls.target) || 25) * 0.7);
    return [{ x: p.x - extent, y: p.y - extent }, { x: p.x + extent, y: p.y - extent }, { x: p.x + extent, y: p.y + extent }, { x: p.x - extent, y: p.y + extent }];
  }

  selectTiles() {
    const polygon = this.getVisiblePolygon();
    const minX = Math.min(...polygon.map((point) => point.x)), maxX = Math.max(...polygon.map((point) => point.x));
    const minY = Math.min(...polygon.map((point) => point.y)), maxY = Math.max(...polygon.map((point) => point.y));
    const widthPx = Math.max(1, this.scene.canvas.clientWidth), heightPx = Math.max(1, this.scene.canvas.clientHeight);
    const metersPerPixel = Math.max((maxX - minX) / widthPx, (maxY - minY) / heightPx);
    const center = this.geoRef.toLatLon((minX + maxX) / 2, (minY + maxY) / 2);
    const zoom = clamp(Math.floor(Math.log2(Math.max(1e-6, Math.cos(THREE.MathUtils.degToRad(center.lat)) * 2 * Math.PI * 6_378_137 / (this.provider.tileSize * metersPerPixel)))), 1, this.provider.maxZoom);
    const geoPolygon = polygon.map((point) => this.geoRef.toLatLon(point.x, point.y));
    const xs = geoPolygon.map(({ lon }) => lonToTileX(lon, zoom));
    const ys = geoPolygon.map(({ lat }) => latToTileY(lat, zoom));
    const n = 2 ** zoom;
    const x0 = clamp(Math.floor(Math.min(...xs)), 0, n - 1), x1 = clamp(Math.floor(Math.max(...xs)), 0, n - 1);
    const y0 = clamp(Math.floor(Math.min(...ys)), 0, n - 1), y1 = clamp(Math.floor(Math.max(...ys)), 0, n - 1);
    const keys = new Set();
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const west = tileToLon(x, zoom), east = tileToLon(x + 1, zoom);
      const north = tileToLat(y, zoom), south = tileToLat(y + 1, zoom);
      const corners = [
        this.geoRef.fromLatLon(north, west), this.geoRef.fromLatLon(north, east),
        this.geoRef.fromLatLon(south, east), this.geoRef.fromLatLon(south, west)
      ];
      const overlap = corners.some((corner) => pointInPolygon(corner, polygon)) || polygon.some((point) => point.x >= Math.min(...corners.map((c) => c.x)) && point.x <= Math.max(...corners.map((c) => c.x)) && point.y >= Math.min(...corners.map((c) => c.y)) && point.y <= Math.max(...corners.map((c) => c.y)));
      if (overlap) keys.add(`${zoom}/${x}/${y}`);
    }
    const cacheLimit = Math.max(1, config.map.tileCacheSize ?? 128);
    if (keys.size <= cacheLimit) return keys;
    const centerX = (x0 + x1) / 2, centerY = (y0 + y1) / 2;
    return new Set([...keys].sort((a, b) => {
      const [za, xa, ya] = a.split('/').map(Number), [zb, xb, yb] = b.split('/').map(Number);
      const da = Math.hypot(xa - centerX, ya - centerY), db = Math.hypot(xb - centerX, yb - centerY);
      return da - db || za - zb;
    }).slice(0, cacheLimit));
  }

  update(_carPose, _dt) {
    const now = performance.now();
    if (this.disposed || this.blocked || this.limited || now - this.lastViewAt < 250) return;
    this.lastViewAt = now;
    const next = this.selectTiles();
    for (const [key, tile] of this.tiles) {
      const visible = next.has(key);
      if (tile.mesh) tile.mesh.visible = visible;
      if (visible) tile.lastUsed = now;
      if (!visible && tile.status === 'loading') {
        tile.controller.abort();
        tile.status = 'idle';
        this.queue = this.queue.filter((queued) => queued !== key);
      }
    }
    for (const key of next) {
      const tile = this.tiles.get(key);
      if (tile?.mesh && !this.visibleKeys.has(key)) this.cacheHits++;
      if (!tile) this.tiles.set(key, { status: 'idle', retries: 0, lastUsed: now });
      this.enqueueIfNeeded(key, Date.now());
    }
    this.visibleKeys = next;
    this.pumpQueue();
    this.evictLru();
    this.updateStatus();
  }

  enqueueIfNeeded(key, now) {
    const tile = this.tiles.get(key);
    if (!tile || tile.mesh || tile.status === 'loading' || tile.status === 'queued' || tile.status === 'failed' || tile.retryAt > now) return;
    tile.status = 'queued';
    this.queue.push(key);
  }

  pumpQueue() {
    while (!this.disposed && !this.blocked && !this.limited && this.active < 2 && this.queue.length) {
      const key = this.queue.shift();
      if (!this.visibleKeys.has(key)) continue;
      if (this.requestCount >= (config.map.maxTilesPerSession ?? 2000)) {
        this.limited = true; this.scene.requestWorldProvider('grid'); this.updateStatus(); return;
      }
      const tile = this.tiles.get(key);
      if (!tile || tile.status !== 'queued') continue;
      this.loadTile(key, tile);
    }
  }

  async loadTile(key, tile) {
    const [z, x, y] = key.split('/').map(Number);
    tile.status = 'loading'; tile.controller = new AbortController(); this.active++;
    const timeoutId = setTimeout(() => tile.controller?.abort(new DOMException('Tile request timed out', 'TimeoutError')), 10_000);
    this.requestCount++; this.requests.push(Date.now());
    const url = this.provider.urlTemplate.replaceAll('{z}', z).replaceAll('{x}', x).replaceAll('{y}', y);
    try {
      const response = await fetch(url, { signal: tile.controller.signal, mode: 'cors', credentials: 'omit' });
      if (response.status === 403 || response.status === 429) {
        this.blocked = true;
        tile.status = 'failed';
        tile.error = `HTTP ${response.status}`;
        const reason = response.status === 403 ? 'MAP BLOCKED (403)' : 'MAP BLOCKED (429)';
        this.scene.lastTileBlock = { status: response.status, reason };
        await this.scene.requestWorldProvider('grid', reason);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob());
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = Math.min(8, this.scene.renderer.capabilities.getMaxAnisotropy()); texture.needsUpdate = true;
      const mesh = this.makeTileMesh(z, x, y, texture);
      mesh.visible = this.visibleKeys.has(key); mesh.userData.tileKey = key;
      this.layer.add(mesh);
      tile.mesh = mesh; tile.texture = texture; tile.bitmap = bitmap; tile.status = 'ready'; tile.lastUsed = performance.now();
      this.offline = false;
    } catch (error) {
      if (error.name !== 'AbortError') {
        tile.error = error.message;
        tile.retries++;
        if (tile.retries <= 3) { tile.status = 'idle'; tile.retryAt = Date.now() + [1000, 5000, 15000][tile.retries - 1]; }
        else {
          tile.status = 'failed'; this.offline = true;
          this.scene.requestWorldProvider('grid', 'MAP OFFLINE');
        }
        this.updateStatus();
      }
    } finally {
      clearTimeout(timeoutId);
      this.active = Math.max(0, this.active - 1); tile.controller = null;
      this.pumpQueue();
    }
  }

  makeTileMesh(z, x, y, texture) {
    const west = tileToLon(x, z), east = tileToLon(x + 1, z);
    const north = tileToLat(y, z), south = tileToLat(y + 1, z);
    const nw = this.geoRef.fromLatLon(north, west), ne = this.geoRef.fromLatLon(north, east);
    const se = this.geoRef.fromLatLon(south, east), sw = this.geoRef.fromLatLon(south, west);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      nw.x, nw.y, -0.035, ne.x, ne.y, -0.035, se.x, se.y, -0.035, sw.x, sw.y, -0.035
    ], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]); geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false }));
  }

  evictLru() {
    const ready = [...this.tiles.entries()].filter(([, tile]) => tile.mesh).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (ready.length > (config.map.tileCacheSize ?? 128)) {
      const [key, tile] = ready.shift();
      if (this.visibleKeys.has(key)) continue;
      tile.mesh.parent?.remove(tile.mesh); tile.mesh.geometry.dispose(); tile.mesh.material.dispose(); tile.texture.dispose(); tile.bitmap?.close?.();
      this.tiles.delete(key);
    }
  }

  updateStatus(forced) {
    const recent = Date.now() - 60_000;
    this.requests = this.requests.filter((time) => time >= recent);
    if (forced) this.scene.setMapStatus(forced, 'fault');
    else if (this.limited) this.scene.setMapStatus('MAP LIMIT', 'warn');
    else if (this.blocked) this.scene.setMapStatus('MAP BLOCKED', 'fault');
    else if (this.offline) this.scene.setMapStatus('MAP OFFLINE', 'warn');
    else this.scene.setMapStatus(`MAP · ${this.requests.length}/min`, 'nominal');
    this.scene.mapStats = { requestsPerMinute: this.requests.length, requestsPerSession: this.requestCount,
      cacheHits: this.cacheHits, activeRequests: this.active, cacheHitRatio: this.cacheHits / Math.max(1, this.cacheHits + this.requestCount) };
  }

  dispose() {
    this.disposed = true; this.queue.length = 0;
    for (const tile of this.tiles.values()) {
      tile.controller?.abort();
      if (tile.mesh) { tile.mesh.parent?.remove(tile.mesh); tile.mesh.geometry.dispose(); tile.mesh.material.dispose(); tile.texture.dispose(); tile.bitmap?.close?.(); }
    }
    this.tiles.clear(); this.layer?.parent?.remove(this.layer); this.layer = null;
  }
}
