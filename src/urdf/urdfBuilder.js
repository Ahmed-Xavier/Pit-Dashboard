/* ==========================================================================
   ENIMIA Dashboard — Three.js URDF Builder
   Constructs THREE.Group hierarchy from parsed URDF with mesh loading,
   Collada Z_UP correction, canopy transparency, and resilient fallbacks.
   ========================================================================== */

import * as THREE from 'three';
import { ColladaLoader } from 'three/addons/ColladaLoader.js';
import { STLLoader } from 'three/addons/STLLoader.js';
import { store } from '../state.js';

export class UrdfBuilder {
  constructor(meshBaseUrl = './assets/meshes', { assetResolver = null } = {}) {
    this.meshBaseUrl = meshBaseUrl;
    this.assetResolver = assetResolver;
    this.colladaLoader = new ColladaLoader();
    this.stlLoader = new STLLoader();
    this.meshCache = new Map(); // url -> THREE.Object3D cloneable template
    this.assetMetrics = [];
  }

  /**
   * Resolves a mesh URI to a local URL.
   * Handles:
   *  - package://vehicle_description/meshes/body_shell.dae
   *  - ./assets/meshes/body_shell.dae
   *  - C:\some\windows\path\body_shell.dae
   */
  resolveMeshUrl(rawUri) {
    if (!rawUri) return '';

    // Extract filename from package://, windows path, or unix path
    let filename = rawUri;
    if (filename.includes('package://')) {
      const match = filename.match(/package:\/\/[^/]+\/(?:meshes\/)?(.*)/);
      if (match && match[1]) filename = match[1];
    }

    // Strip any preceding directory path components
    filename = filename.replace(/^.*[\\/]/, '');

    return `${this.meshBaseUrl.replace(/\/+$/, '')}/${filename}`;
  }

  /**
   * Build complete robot THREE.Group from parsed URDF description.
   */
  async build(robotDef) {
    const startTime = performance.now();
    const rootGroup = new THREE.Group();
    rootGroup.name = `urdf_${robotDef.name}`;

    // Debug axes helper at car root: Red = +X, Green = +Y, Blue = +Z (0.5m length)
    const axesHelper = new THREE.AxesHelper(0.5);
    axesHelper.name = 'car_axes_helper';
    rootGroup.add(axesHelper);

    // Build link objects
    const linkGroups = new Map();
    for (const [linkName, linkDef] of robotDef.links.entries()) {
      const linkGroup = new THREE.Group();
      linkGroup.name = `link_${linkName}`;

      for (const visual of linkDef.visuals) {
        const visualObject = await this.createVisualObject(visual, robotDef.materials);
        if (visualObject) {
          linkGroup.add(visualObject);
        }
      }
      linkGroups.set(linkName, linkGroup);
    }

    // Assemble joint hierarchy
    const jointOrigins = new Map();
    for (const [jointName, jointDef] of robotDef.joints.entries()) {
      const parentGroup = linkGroups.get(jointDef.parent);
      const childGroup = linkGroups.get(jointDef.child);

      if (parentGroup && childGroup) {
        // Joint pivot container
        const jointPivot = new THREE.Group();
        jointPivot.name = `joint_${jointName}`;

        const [ox, oy, oz] = jointDef.origin.xyz;
        const [rr, rp, ry] = jointDef.origin.rpy;

        jointPivot.position.set(ox, oy, oz);
        jointPivot.rotation.set(rr, rp, ry, 'ZYX');

        jointPivot.add(childGroup);
        parentGroup.add(jointPivot);

        jointOrigins.set(jointName, { pivot: jointPivot, axis: jointDef.axis, type: jointDef.type });
      }
    }

    // Mount root link into main group
    const rootLinkGroup = linkGroups.get(robotDef.rootLink);
    if (rootLinkGroup) {
      rootGroup.add(rootLinkGroup);
    } else if (linkGroups.size > 0) {
      rootGroup.add(linkGroups.values().next().value);
    }

    const buildTimeMs = (performance.now() - startTime).toFixed(1);
    console.info(`[URDF] Built robot "${robotDef.name}" in ${buildTimeMs} ms (${linkGroups.size} links, ${robotDef.joints.size} joints)`);

    rootGroup.userData = {
      robotName: robotDef.name,
      rootLink: robotDef.rootLink,
      linkGroups,
      jointOrigins,
      buildTimeMs
    };

    return rootGroup;
  }

  async createVisualObject(visual, materialsMap) {
    const visualGroup = new THREE.Group();

    // Visual origin transform relative to link
    const [ox, oy, oz] = visual.origin.xyz;
    const [rr, rp, ry] = visual.origin.rpy;
    visualGroup.position.set(ox, oy, oz);
    visualGroup.rotation.set(rr, rp, ry, 'ZYX');

    // Material setup
    const mat = this.resolveMaterial(visual.material, materialsMap);

    const geom = visual.geometry;
    if (geom.type === 'box') {
      const [bx, by, bz] = geom.size;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(bx, by, bz), mat);
      visualGroup.add(mesh);
    } else if (geom.type === 'cylinder') {
      // Three.js CylinderGeometry is along Y axis; URDF cylinder is along Z axis.
      const cylinderGeom = new THREE.CylinderGeometry(geom.radius, geom.radius, geom.length, 32);
      cylinderGeom.rotateX(Math.PI / 2); // align with ROS Z-axis
      const mesh = new THREE.Mesh(cylinderGeom, mat);
      visualGroup.add(mesh);
    } else if (geom.type === 'sphere') {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(geom.radius, 24, 24), mat);
      visualGroup.add(mesh);
    } else if (geom.type === 'mesh') {
      const meshObj = await this.loadMeshWithFallback(geom.filename, geom.scale, mat);
      visualGroup.add(meshObj);
    }

    return visualGroup;
  }

  resolveMaterial(materialDef, materialsMap) {
    if (!materialDef) {
      return new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.5, metalness: 0.2 });
    }

    let rgba = materialDef.color;
    if (!rgba && materialDef.name && materialsMap.has(materialDef.name)) {
      rgba = materialsMap.get(materialDef.name).color;
    }

    if (!rgba) rgba = [0.75, 0.75, 0.75, 1.0];

    const [r, g, b, a] = rgba;
    const isTransparent = a < 0.99 || materialDef.name === 'glass';

    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(r, g, b),
      opacity: a,
      transparent: isTransparent,
      depthWrite: !isTransparent,
      roughness: 0.4,
      metalness: 0.2
    });
  }

  async loadMeshWithFallback(rawUri, scale = [1, 1, 1], defaultMaterial) {
    const meshUrl = this.resolveMeshUrl(rawUri);

    // Check cache
    const cacheKey = this.assetResolver ? rawUri : meshUrl;
    if (this.meshCache.has(cacheKey)) {
      const cached = this.meshCache.get(cacheKey).clone(true);
      cached.scale.set(...scale);
      return cached;
    }

    if (this.assetResolver) {
      let objectUrl;
      try {
        const fetchStart = performance.now();
        const bytes = await this.assetResolver(rawUri);
        const fetchMs = performance.now() - fetchStart;
        const extensionHint = rawUri.split(/[?#]/, 1)[0];
        const blob = new Blob([bytes], { type: extensionHint.toLowerCase().endsWith('.stl') ? 'model/stl' : 'model/vnd.collada+xml' });
        objectUrl = URL.createObjectURL(blob);
        const parseStart = performance.now();
        const obj = await this.loadMeshDirect(objectUrl, defaultMaterial, rawUri);
        const parseMs = performance.now() - parseStart;
        this.meshCache.set(cacheKey, obj);
        const instance = obj.clone(true);
        instance.scale.set(...scale);
        this.assetMetrics.push({ uri: rawUri, bytes: bytes.byteLength, fetchMs: Number(fetchMs.toFixed(2)), parseMs: Number(parseMs.toFixed(2)) });
        console.info(`[URDF] Bridge asset ${rawUri} fetched in ${fetchMs.toFixed(1)} ms and parsed in ${parseMs.toFixed(1)} ms`);
        return instance;
      } catch (error) {
        console.warn(`[URDF] Bridge asset fetch failed for "${rawUri}": ${error.message}; trying local mesh copy.`);
        store.addEvent('URDF', 'warn', `Bridge asset failed for ${rawUri}; trying local mesh copy.`);
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    }

    // Try loading primary mesh (DAE or STL)
    try {
      const obj = await this.loadMeshDirect(meshUrl, defaultMaterial, rawUri);
      this.meshCache.set(cacheKey, obj);
      const instance = obj.clone(true);
      instance.scale.set(...scale);
      return instance;
    } catch (err) {
      console.warn(`[URDF] Primary mesh failed for "${meshUrl}": ${err.message}. Trying STL fallback.`);

      // Try STL fallback from meshes/stl/<name>.stl if primary was .dae
      if (meshUrl.toLowerCase().endsWith('.dae')) {
        const filename = meshUrl.replace(/^.*[\\/]/, '').replace(/\.dae$/i, '.stl');
        const stlFallbackUrl = `${this.meshBaseUrl.replace(/\/+$/, '')}/stl/${filename}`;
        try {
          const stlObj = await this.loadMeshDirect(stlFallbackUrl, defaultMaterial);
          this.meshCache.set(meshUrl, stlObj);
          const instance = stlObj.clone(true);
          instance.scale.set(...scale);
          console.info(`[URDF] Loaded fallback STL mesh "${stlFallbackUrl}".`);
          return instance;
        } catch (stlErr) {
          console.warn(`[URDF] Fallback STL also failed: ${stlErr.message}`);
        }
      }

      // Record non-fatal warning in faults panel and render placeholder box
      const shortName = rawUri.replace(/^.*[\\/]/, '');
      store.addFault?.('URDF', `Mesh load failed: ${shortName}`);

      const placeholder = this.createPlaceholderBox(shortName);
      placeholder.scale.set(...scale);
      return placeholder;
    }
  }

  loadMeshDirect(url, defaultMaterial, nameHint = url) {
    const isDae = nameHint.toLowerCase().split(/[?#]/, 1)[0].endsWith('.dae');
    const isStl = nameHint.toLowerCase().split(/[?#]/, 1)[0].endsWith('.stl');
    const isCanopy = nameHint.toLowerCase().includes('canopy');
    const isBody = nameHint.toLowerCase().includes('body_shell');

    return new Promise((resolve, reject) => {
      if (isDae) {
        this.colladaLoader.load(
          url,
          (collada) => {
            const scene = collada.scene;

            /*
             * COLLADA UP-AXIS FIX:
             * Three.js ColladaLoader automatically detects <up_axis>Z_UP</up_axis>
             * and rotates the scene by -90 deg on X. Since our 3D world already
             * has ONE root group converting ROS (Z-up) to Three.js, we cancel this
             * extra rotation so the mesh directly aligns with ROS coordinate axes.
             */
            scene.rotation.set(0, 0, 0);
            scene.quaternion.identity();

            // Configure materials & canopy transparency
            scene.traverse((child) => {
              if (child.isMesh) {
                if (isCanopy) {
                  // Transparent glass canopy: depthWrite = false, renderOrder = 1
                  child.material = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(0.20, 0.32, 0.40),
                    transparent: true,
                    opacity: 0.35,
                    depthWrite: false,
                    roughness: 0.1,
                    metalness: 0.1
                  });
                  child.renderOrder = 1;
                } else if (isBody) {
                  // Opaque dark carbon shell – explicitly lit dark metallic grey
                  child.material = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(0.20, 0.20, 0.22),
                    roughness: 0.55,
                    metalness: 0.45,
                    depthWrite: true
                  });
                  child.renderOrder = 0;
                } else {
                  // Other Collada meshes: convert Phong -> Standard so they react to lights
                  const col = child.material && child.material.color
                    ? child.material.color.clone()
                    : new THREE.Color(0.55, 0.55, 0.55);
                  child.material = new THREE.MeshStandardMaterial({
                    color: col,
                    roughness: 0.5,
                    metalness: 0.1,
                    depthWrite: true
                  });
                }
              }
            });

            resolve(scene);
          },
          undefined,
          reject
        );
      } else if (isStl) {
        this.stlLoader.load(
          url,
          (geometry) => {
            const mat = defaultMaterial || new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.5 });
            const mesh = new THREE.Mesh(geometry, mat);
            resolve(mesh);
          },
          undefined,
          reject
        );
      } else {
        reject(new Error(`Unsupported mesh format for "${url}"`));
      }
    });
  }

  createPlaceholderBox(label) {
    const group = new THREE.Group();
    const boxGeom = new THREE.BoxGeometry(0.35, 0.20, 0.15);
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0xff6600,
      wireframe: true,
      roughness: 0.5
    });
    const mesh = new THREE.Mesh(boxGeom, boxMat);
    group.add(mesh);
    return group;
  }
}
