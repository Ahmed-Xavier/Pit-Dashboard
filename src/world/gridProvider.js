import * as THREE from 'three';

export class GridProvider {
  id = 'grid';
  attribution() { return ''; }
  load(scene) {
    if (!scene.gridHelper) {
      scene.gridHelper = new THREE.GridHelper(200, 200, 0x334466, 0x1a2230);
      scene.gridHelper.name = 'temporary_ground_grid';
      scene.rosRoot.add(scene.gridHelper);
    }
    scene.gridHelper.visible = true;
  }
  update() {}
  dispose() {}
}
