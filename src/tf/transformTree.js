/* ==========================================================================
   ENIMIA Dashboard — Transform Tree (TF / TF2)
   Fix Group 3:
   - One-parent-wins: if a different parent arrives for a known child, log ONE
     warning and ignore the update (prevents map/odom position jumps).
   - Chain-based lookup: uses config.tf.chain to walk an explicit list instead
     of an arbitrary graph traversal (no unbounded while-loop).
   - Depth guard (config.tf.maxDepth, default 16) as a belt-and-suspenders
     cycle guard for the common-ancestor walk.
   - Preallocated scratch THREE objects reused across lookup() calls to avoid
     per-frame GC pressure.
   ========================================================================== */

import * as THREE from 'three';
import { config } from '/config.js';
import { debugInstrumentation } from '../debugInstrumentation.js';

// Scratch objects — reused every lookup() call, never escaped outside
const _scratchVec   = new THREE.Vector3();
const _scratchQuat  = new THREE.Quaternion();
const _scratchScale = new THREE.Vector3(1, 1, 1);
const _scratchMat   = new THREE.Matrix4();
const _scratchMatB  = new THREE.Matrix4();
const _scratchEuler = new THREE.Euler();

export class TransformTree {
  constructor() {
    // Map of child_frame_id -> { parent_id, translation, rotation, stamp }
    this.transforms = new Map();
    // One-time parent-conflict warnings: Set of "child:badParent" strings
    this._parentConflicts = new Set();
  }

  /**
   * Normalize frame ID: strip leading slash, e.g. "/map" -> "map"
   */
  normalizeFrame(frameId) {
    if (!frameId) return '';
    return frameId.startsWith('/') ? frameId.slice(1) : frameId;
  }

  /**
   * Add a single geometry_msgs/msg/TransformStamped.
   * One-parent-wins: if the child already has a recorded parent, and the
   * incoming parent differs, log once and drop the update.
   */
  addTransform(transformStamped) {
    if (!transformStamped || !transformStamped.child_frame_id) return;

    const child  = this.normalizeFrame(transformStamped.child_frame_id);
    const parent = this.normalizeFrame(transformStamped.header?.frame_id);

    if (!child || !parent || child === parent) return;

    const existing = this.transforms.get(child);
    if (existing && existing.parent !== parent) {
      const key = `${child}:${parent}`;
      if (!this._parentConflicts.has(key)) {
        this._parentConflicts.add(key);
        console.warn(
          `[TF] Parent conflict for "${child}": recorded="${existing.parent}", ` +
          `incoming="${parent}". Keeping first parent. (logged once)`
        );
      }
      return; // drop the conflicting update
    }

    debugInstrumentation.recordTfParentChange(child, parent);

    this.transforms.set(child, {
      parent,
      translation: transformStamped.transform.translation,
      rotation:    transformStamped.transform.rotation,
      stamp:       transformStamped.header?.stamp || null
    });
  }

  /**
   * Add transforms from a tf2_msgs/msg/TFMessage
   */
  addTransforms(tfMessage) {
    if (!tfMessage || !Array.isArray(tfMessage.transforms)) return;
    for (const t of tfMessage.transforms) {
      this.addTransform(t);
    }
  }

  /**
   * Clear all transforms (and conflict log, so re-logging is possible)
   */
  clear() {
    this.transforms.clear();
    this._parentConflicts.clear();
  }

  /**
   * Lookup the pose of sourceFrame expressed in targetFrame.
   *
   * Strategy (Fix Group 3):
   * 1. Walk config.tf.chain explicitly: if targetFrame and sourceFrame are both
   *    in the chain, compose the transforms between them directly — O(depth).
   * 2. Fallback: generic parent-walk with depth guard (config.tf.maxDepth).
   *
   * Returns { position, orientation, yaw, valid } or { valid: false, reason }.
   */
  lookup(targetFrame, sourceFrame) {
    const target = this.normalizeFrame(targetFrame);
    const source = this.normalizeFrame(sourceFrame);

    if (!target || !source) return { valid: false, reason: 'Empty frame ID' };
    if (target === source) {
      return {
        position: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        yaw: 0,
        valid: true
      };
    }

    const chain     = (config.tf?.chain || []).map(f => this.normalizeFrame(f));
    const maxDepth  = config.tf?.maxDepth || 16;

    const tIdx = chain.indexOf(target);
    const sIdx = chain.indexOf(source);

    if (tIdx !== -1 && sIdx !== -1) {
      // Both frames are in the known chain — compose along the chain segment
      return this._lookupViaChain(chain, tIdx, sIdx);
    }

    // Generic fallback: walk parents with depth guard
    return this._lookupGeneric(target, source, maxDepth);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Compose transforms from chain[sIdx] up to chain[tIdx].
   * chain is ordered parent→child (e.g. ['map','odom','base_footprint']).
   */
  _lookupViaChain(chain, tIdx, sIdx) {
    if (tIdx === sIdx) {
      return { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, yaw: 0, valid: true };
    }

    // source must be a descendant of target in the chain
    if (sIdx <= tIdx) {
      return { valid: false, reason: `"${chain[sIdx]}" is an ancestor of "${chain[tIdx]}" in chain` };
    }

    // Walk from sIdx down to tIdx (child → parent direction), composing
    const mat = _scratchMat.identity();
    for (let i = sIdx; i > tIdx; i--) {
      const childFrame = chain[i];
      const edge = this.transforms.get(childFrame);
      if (!edge) {
        return { valid: false, reason: `No TF edge for "${childFrame}"` };
      }
      const p = edge.translation;
      const q = edge.rotation;
      _scratchVec.set(p.x, p.y, p.z);
      _scratchQuat.set(q.x, q.y, q.z, q.w);
      _scratchMatB.compose(_scratchVec, _scratchQuat, _scratchScale.set(1, 1, 1));
      mat.premultiply(_scratchMatB);
    }

    return this._decomposeResult(mat);
  }

  /**
   * Generic lookup with depth guard (fallback for frames not in config.tf.chain).
   */
  _lookupGeneric(target, source, maxDepth) {
    // Build source-to-root path with cycle guard
    const sourcePath = [];
    let curr = source;
    let depth = 0;
    const visited = new Set();
    while (curr && !visited.has(curr) && depth < maxDepth) {
      sourcePath.push(curr);
      visited.add(curr);
      if (curr === target) break;
      curr = this.transforms.get(curr)?.parent ?? null;
      depth++;
    }

    if (sourcePath[sourcePath.length - 1] === target) {
      return this._composePath(sourcePath);
    }

    // Build target-to-root path
    const targetPath = [];
    curr = target;
    depth = 0;
    visited.clear();
    while (curr && !visited.has(curr) && depth < maxDepth) {
      targetPath.push(curr);
      visited.add(curr);
      curr = this.transforms.get(curr)?.parent ?? null;
      depth++;
    }

    // Find lowest common ancestor
    const targetSet = new Set(targetPath);
    let lca = null;
    for (const s of sourcePath) {
      if (targetSet.has(s)) { lca = s; break; }
    }

    if (!lca) {
      return { valid: false, reason: `No TF path between "${target}" and "${source}"` };
    }

    const matSourceToLca = this._matrixForSubpath(
      sourcePath.slice(0, sourcePath.indexOf(lca) + 1)
    );
    const matTargetToLca = this._matrixForSubpath(
      targetPath.slice(0, targetPath.indexOf(lca) + 1)
    );

    // target→source = (target→LCA)⁻¹ · (source→LCA)
    _scratchMatB.copy(matTargetToLca).invert();
    _scratchMat.multiplyMatrices(_scratchMatB, matSourceToLca);
    return this._decomposeResult(_scratchMat);
  }

  _matrixForSubpath(chain) {
    const mat = new THREE.Matrix4().identity();
    for (let i = 0; i < chain.length - 1; i++) {
      const edge = this.transforms.get(chain[i]);
      if (!edge) break;
      const p = edge.translation;
      const q = edge.rotation;
      _scratchVec.set(p.x, p.y, p.z);
      _scratchQuat.set(q.x, q.y, q.z, q.w);
      _scratchMatB.compose(_scratchVec, _scratchQuat, _scratchScale.set(1, 1, 1));
      mat.premultiply(_scratchMatB);
    }
    return mat;
  }

  _composePath(chain) {
    return this._decomposeResult(this._matrixForSubpath(chain));
  }

  _decomposeResult(mat) {
    mat.decompose(_scratchVec, _scratchQuat, _scratchScale);
    _scratchEuler.setFromQuaternion(_scratchQuat, 'ZYX');
    return {
      position:    { x: _scratchVec.x,  y: _scratchVec.y,  z: _scratchVec.z  },
      orientation: { x: _scratchQuat.x, y: _scratchQuat.y, z: _scratchQuat.z, w: _scratchQuat.w },
      yaw: _scratchEuler.z,
      valid: true
    };
  }
}

export const tfTree = new TransformTree();
