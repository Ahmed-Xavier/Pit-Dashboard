import { GridProvider } from './gridProvider.js';
import { SdfProvider } from './sdfProvider.js';
import { XyzTilesProvider } from './xyzTilesProvider.js';

export class WorldProvider {
  constructor() {
    this.providers = new Map([
      ['grid', new GridProvider()],
      ['sdf', new SdfProvider()],
      ['xyz-osm', new XyzTilesProvider()],
    ]);
    this.active = null;
  }

  async load(scene, id) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown world provider: ${id}`);
    if (this.active === provider) return provider;
    this.active?.dispose?.(scene);
    this.active = provider;
    scene.worldProviderId = id;
    await provider.load(scene);
    return provider;
  }

  update(carPose, dt) { this.active?.update?.(carPose, dt); }
  attribution() { return this.active?.attribution?.() ?? ''; }
  dispose(scene) { this.active?.dispose?.(scene); this.active = null; }
}
