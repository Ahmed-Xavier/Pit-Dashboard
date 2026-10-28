/* ==========================================================================
   ENIMIA Dashboard — SDF World Parser Worker
   Receives pre-parsed model records (structured JS objects) from the main
   thread (scene3D.js) — DOMParser is NOT used here since it is unavailable
   in Web Workers on some browsers.
   Does all the heavy geometry math: pose composition, matrix building,
   instanced-mesh batching, and centerline extraction.
   ========================================================================== */

/* --------------------------------------------------------------------------
   Quaternion / pose helpers
   -------------------------------------------------------------------------- */

function rpyToQuat(roll, pitch, yaw) {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  return {
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
    w: cr * cp * cy + sr * sp * sy
  };
}

function quatMul(a, b) {
  return {
    x:  a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y:  a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z:  a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w:  a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function quatRotVec(q, vx, vy, vz) {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return {
    x: vx + qw * tx + qy * tz - qz * ty,
    y: vy + qw * ty + qz * tx - qx * tz,
    z: vz + qw * tz + qx * ty - qy * tx
  };
}

/** Compose parent world pose with a child local pose, both as {x,y,z,qx,qy,qz,qw} */
function composePose(parent, child) {
  const pq = { x: parent.qx, y: parent.qy, z: parent.qz, w: parent.qw };
  const cq = { x: child.qx,  y: child.qy,  z: child.qz,  w: child.qw  };
  const r = quatRotVec(pq, child.x, child.y, child.z);
  const rq = quatMul(pq, cq);
  return {
    x: parent.x + r.x, y: parent.y + r.y, z: parent.z + r.z,
    qx: rq.x, qy: rq.y, qz: rq.z, qw: rq.w
  };
}

function poseFromArray(arr) {
  // arr = [x, y, z, roll, pitch, yaw]
  const [px = 0, py = 0, pz = 0, roll = 0, pitch = 0, yaw = 0] = arr || [];
  const q = rpyToQuat(roll, pitch, yaw);
  return { x: px, y: py, z: pz, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
}

function identityPose() { return { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }; }
function normalizeAngle(angle) {
  if (!Number.isFinite(angle)) return 0;
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function colorKey(r, g, b) {
  return `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}`;
}

/** Build column-major 4×4 matrix with scale baked in (for THREE.InstancedMesh) */
function poseToMatrix4(pose, sx, sy, sz) {
  const { x, y, z, qx, qy, qz, qw } = pose;
  const x2 = qx+qx, y2 = qy+qy, z2 = qz+qz;
  const xx = qx*x2, xy = qx*y2, xz = qx*z2;
  const yy = qy*y2, yz = qy*z2, zz = qz*z2;
  const wx = qw*x2, wy = qw*y2, wz = qw*z2;
  return new Float32Array([
    (1-(yy+zz))*sx, (xy+wz)*sx,     (xz-wy)*sx,     0,
    (xy-wz)*sy,     (1-(xx+zz))*sy, (yz+wx)*sy,     0,
    (xz+wy)*sz,     (yz-wx)*sz,     (1-(xx+yy))*sz, 0,
    x, y, z, 1
  ]);
}

/* --------------------------------------------------------------------------
   Main processing function
   Receives models = [{name, pose:[6], visuals:[{name,pose:[6],geomType,size:[3],color:{r,g,b}}]}]
   -------------------------------------------------------------------------- */
function processSdf(models, centerlineSpacing) {
  const t0 = performance.now();

  // Batches keyed by "geomType:r,g,b"
  const batches = new Map();
  const trackSegments = [];
  let totalVisuals = 0, skippedMesh = 0, skippedUnknown = 0;
  let bboxMinX = Infinity, bboxMaxX = -Infinity;
  let bboxMinY = Infinity, bboxMaxY = -Infinity;

  for (const model of models) {
    const modelPose = model.pose ? poseFromArray(model.pose) : identityPose();
    const oldTrackMatch = model.name.match(/^track_segment_(\d+)$/);
    const adcTrackMatch = model.name.match(/^road_(\d+)$/);
    const trackMatch = oldTrackMatch || adcTrackMatch;

    for (const link of (model.links || [])) {
      const linkPose = link.pose ? poseFromArray(link.pose) : identityPose();
      const worldLinkPose = composePose(modelPose, linkPose);

      for (const visual of (link.visuals || [])) {
        const visualPose = visual.pose ? poseFromArray(visual.pose) : identityPose();
        const worldVisualPose = composePose(worldLinkPose, visualPose);

        const { geomType, size, color } = visual;

        if (!geomType || geomType === 'mesh') { skippedMesh++; continue; }
        if (geomType === 'unknown') { skippedUnknown++; continue; }

        totalVisuals++;
        const { r = 0.5, g = 0.5, b = 0.5 } = color || {};

        // Track centerline from main asphalt visual
        if (trackMatch && geomType === 'box' && visual.name === 'asphalt') {
          const idx = parseInt(trackMatch[1], 10);
          const { x, y, z, qx, qy, qz, qw } = worldVisualPose;
          const yaw = Math.atan2(2*(qw*qz + qx*qy), 1 - 2*(qy*qy + qz*qz));
          const isAdc = Boolean(adcTrackMatch);
          trackSegments.push({
            idx, x, y, z, yaw,
            trackWidth: isAdc ? size[1] : size[0],
            segLen: isAdc ? size[0] : size[1]
          });
          if (x < bboxMinX) bboxMinX = x;
          if (x > bboxMaxX) bboxMaxX = x;
          if (y < bboxMinY) bboxMinY = y;
          if (y > bboxMaxY) bboxMaxY = y;
        }

        const bk = `${geomType}:${colorKey(r, g, b)}`;
        if (!batches.has(bk)) batches.set(bk, { r, g, b, geomType, size, matrices: [] });
        const pz = worldVisualPose.z + 0.001; // tiny z-offset vs ground plane
        batches.get(bk).matrices.push(
          poseToMatrix4({ ...worldVisualPose, z: pz }, size[0], size[1], size[2])
        );
      }
    }
  }

  const parseTimeMs = (performance.now() - t0).toFixed(1);

  // ── Centerline extraction ──
  const t1 = performance.now();
  trackSegments.sort((a, b) => a.idx - b.idx);

  const gaps = [];
  for (let i = 1; i < trackSegments.length; i++) {
    const prev = trackSegments[i-1], curr = trackSegments[i];
    const gap = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    if (gap > curr.segLen * 2.5) gaps.push({ from: prev.idx, to: curr.idx, dist: gap.toFixed(2) });
  }

  const requestedSpacing = Number.isFinite(centerlineSpacing) && centerlineSpacing > 0 ? centerlineSpacing : 0.5;
  const centerline = [];

  if (trackSegments.length > 1) {
    const rawPts = trackSegments.map(s => ({ x: s.x, y: s.y, yaw: s.yaw, trackWidth: s.trackWidth }));
    const rawArc = [0];
    for (let i = 1; i < rawPts.length; i++) {
      rawArc.push(rawArc[i-1] + Math.hypot(rawPts[i].x - rawPts[i-1].x, rawPts[i].y - rawPts[i-1].y));
    }
    const totalLength = rawArc[rawArc.length - 1];
    const spacing = Number.isFinite(totalLength) && totalLength > 0
      ? Math.max(requestedSpacing, totalLength / 20_000)
      : requestedSpacing;

    // Resample at fixed spacing
    let ri = 0;
    for (let s = 0; s <= totalLength - spacing * 0.5; s += spacing) {
      while (ri < rawPts.length - 2 && rawArc[ri + 1] <= s) ri++;
      const a = rawPts[ri], b = rawPts[(ri + 1) % rawPts.length];
      const segLen = rawArc[ri + 1] - rawArc[ri];
      const t = segLen > 0 ? (s - rawArc[ri]) / segLen : 0;
      const x = a.x + t * (b.x - a.x);
      const y = a.y + t * (b.y - a.y);
      const dyaw = normalizeAngle(b.yaw - a.yaw);
      const yaw = a.yaw + t * dyaw;
      centerline.push({ x, y, yaw, s, trackWidth: a.trackWidth });
    }

    // Curvature via central differences
    const n = centerline.length;
    for (let i = 0; i < n; i++) {
      const prev = centerline[(i - 1 + n) % n];
      const next = centerline[(i + 1) % n];
      const dyaw = normalizeAngle(next.yaw - prev.yaw);
      const ds = (i === 0 || i === n - 1) ? spacing * 2 : (next.s - prev.s);
      centerline[i].curvature = ds > 0 ? dyaw / ds : 0;
    }

    const extractTimeMs = (performance.now() - t1).toFixed(1);
    const closureGap = Math.hypot(
      rawPts[rawPts.length-1].x - rawPts[0].x,
      rawPts[rawPts.length-1].y - rawPts[0].y
    ).toFixed(2);

    // Pack batches into transferable typed arrays
    const batchArray = [];
    for (const [key, batch] of batches) {
      const all = new Float32Array(batch.matrices.length * 16);
      for (let i = 0; i < batch.matrices.length; i++) all.set(batch.matrices[i], i * 16);
      batchArray.push({ key, r: batch.r, g: batch.g, b: batch.b, geomType: batch.geomType, size: batch.size, count: batch.matrices.length, matrices: all });
    }

    return {
      ok: true, batchArray, centerline, totalLength,
      closureGap, segmentCount: trackSegments.length,
      totalVisuals, skippedMesh, skippedUnknown, gaps,
      parseTimeMs, extractTimeMs,
      bboxMinX, bboxMaxX, bboxMinY, bboxMaxY
    };
  }

  return { ok: true, batchArray: [], centerline: [], totalLength: 0, closureGap: 0, segmentCount: 0, totalVisuals, skippedMesh, skippedUnknown, gaps: [], parseTimeMs, extractTimeMs: '0', bboxMinX: 0, bboxMaxX: 100, bboxMinY: 0, bboxMaxY: 100 };
}

/* --------------------------------------------------------------------------
   Worker message handler — receives structured model data, NOT raw XML
   -------------------------------------------------------------------------- */
self.onmessage = (evt) => {
  const { type, models, centerlineSpacing } = evt.data;
  if (type !== 'process') return;
  try {
    const result = processSdf(models, centerlineSpacing);
    const transfers = result.batchArray.map(b => b.matrices.buffer);
    self.postMessage({ type: 'result', ...result }, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
