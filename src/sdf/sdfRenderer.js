/* ==========================================================================
   ENIMIA Dashboard — SDF World Three.js Renderer
   Consumes parsed batch data from sdfWorker.
   Creates one InstancedMesh per (geometry-type, color) batch.
   Uses polygonOffset to prevent z-fighting. No shadows.
   ========================================================================== */

import * as THREE from 'three';

export class SdfRenderer {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'sdf_world';
    this._meshes = [];
  }

  /**
   * Build the world from worker result data.
   * @param {Array} batchArray  — from sdfWorker result
   * @returns {THREE.Group}
   */
  build(batchArray) {
    // Dispose old
    this.dispose();
    this.group = new THREE.Group();
    this.group.name = 'sdf_world';
    this._meshes = [];

    for (const batch of batchArray) {
      const { geomType, size, count, matrices, r, g, b } = batch;
      if (count === 0) continue;

      const geom = this._makeGeometry(geomType, size);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(r, g, b),
        roughness: 0.85,
        metalness: 0.0,
        // Polygon offset to prevent z-fighting between coplanar boxes
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
      });

      const mesh = new THREE.InstancedMesh(geom, mat, count);
      mesh.name = `sdf_batch_${batch.key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;

      // Apply pre-computed instance matrices from worker
      const m4 = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        const offset = i * 16;
        m4.fromArray(matrices, offset);
        mesh.setMatrixAt(i, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;

      this.group.add(mesh);
      this._meshes.push(mesh);
    }

    console.info(`[SdfRenderer] Built ${this._meshes.length} instanced mesh batches, ${batchArray.reduce((s, b) => s + b.count, 0)} total instances`);
    return this.group;
  }

  _makeGeometry(geomType, size) {
    const [sx, sy, sz] = size;
    switch (geomType) {
      case 'box':
        return new THREE.BoxGeometry(1, 1, 1); // scaled by matrix
      case 'cylinder': {
        // SDF cylinder is along Z; Three.js CylinderGeometry along Y. Rotate in geom.
        const g = new THREE.CylinderGeometry(1, 1, 1, 24);
        g.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
        return g;
      }
      case 'sphere':
        return new THREE.SphereGeometry(1, 16, 10);
      default:
        return new THREE.BoxGeometry(1, 1, 1);
    }
  }

  dispose() {
    for (const mesh of this._meshes) {
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(m => m.dispose());
      } else {
        mesh.material.dispose();
      }
      if (mesh.parent) mesh.parent.remove(mesh);
    }
    this._meshes = [];
  }
}
