import { config } from '/config.js';

export class SdfProvider {
  id = 'sdf';
  attribution() { return ''; }
  load(scene) {
    if (scene.gridHelper) scene.gridHelper.visible = false;
    if (!scene.sdfLoaded && !scene.sdfLoadStarted) {
      scene.sdfLoadStarted = true;
      scene.loadSdfUrl(config.world.defaultSdfUrl, 'adc_course', 0, 0);
    }
    if (scene.sdfGroup) scene.sdfGroup.visible = true;
  }
  update() {}
  dispose(scene) { if (scene.sdfGroup) scene.sdfGroup.visible = false; }
}
