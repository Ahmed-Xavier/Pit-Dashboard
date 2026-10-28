/* ==========================================================================
   ENIMIA Dashboard — Pure JS URDF XML Parser
   Ported from lichtblick/packages/den/urdf/parser.ts
   Parses robot description, joints, materials, and ONLY <visual> geometries.
   ========================================================================== */

function parseVec3(str, defaultVal = [0, 0, 0]) {
  if (!str) return defaultVal;
  const parts = str.trim().split(/\s+/).map(Number);
  return parts.length === 3 && !parts.some(isNaN) ? parts : defaultVal;
}

function parseRgba(str, defaultVal = [0.8, 0.8, 0.8, 1.0]) {
  if (!str) return defaultVal;
  const parts = str.trim().split(/\s+/).map(Number);
  return parts.length === 4 && !parts.some(isNaN) ? parts : defaultVal;
}

export function parseUrdf(xml) {
  const doc = typeof xml === 'string' ? new DOMParser().parseFromString(xml, 'text/xml') : xml;

  let robotEl = null;
  for (let i = 0; i < doc.childNodes.length; i++) {
    const node = doc.childNodes[i];
    if (node.nodeType === 1 && node.nodeName === 'robot') {
      robotEl = node;
      break;
    }
  }

  if (!robotEl) {
    throw new Error('Invalid URDF: No <robot> root tag found.');
  }

  const robotName = robotEl.getAttribute('name') || 'unnamed_robot';
  const materials = new Map();
  const links = new Map();
  const joints = new Map();

  for (let i = 0; i < robotEl.children.length; i++) {
    const child = robotEl.children[i];
    const nodeName = child.nodeName;

    if (nodeName === 'material') {
      const mat = parseMaterial(child);
      if (mat) materials.set(mat.name, mat);
    } else if (nodeName === 'link') {
      const link = parseLink(child);
      if (link) links.set(link.name, link);
    } else if (nodeName === 'joint') {
      const joint = parseJoint(child);
      if (joint) joints.set(joint.name, joint);
    }
  }

  // Find root link: a link that is never the child of any joint
  const childLinks = new Set();
  for (const joint of joints.values()) {
    if (joint.child) childLinks.add(joint.child);
  }

  let rootLink = null;
  for (const linkName of links.keys()) {
    if (!childLinks.has(linkName)) {
      rootLink = linkName;
      break;
    }
  }

  return {
    name: robotName,
    rootLink: rootLink || (links.keys().next().value || 'base_footprint'),
    links,
    joints,
    materials
  };
}

function parseMaterial(el) {
  const name = el.getAttribute('name');
  if (!name) return null;

  let color = null;
  const colorEl = el.querySelector('color');
  if (colorEl && colorEl.getAttribute('rgba')) {
    color = parseRgba(colorEl.getAttribute('rgba'));
  }

  let texture = null;
  const textureEl = el.querySelector('texture');
  if (textureEl && textureEl.getAttribute('filename')) {
    texture = textureEl.getAttribute('filename');
  }

  return { name, color, texture };
}

function parseLink(el) {
  const name = el.getAttribute('name');
  if (!name) return null;

  const visuals = [];
  // RULE: Render ONLY <visual>. NEVER parse or store <collision> geometry.
  const visualEls = el.querySelectorAll(':scope > visual');
  for (let i = 0; i < visualEls.length; i++) {
    const visEl = visualEls[i];

    let origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
    const originEl = visEl.querySelector('origin');
    if (originEl) {
      origin = {
        xyz: parseVec3(originEl.getAttribute('xyz')),
        rpy: parseVec3(originEl.getAttribute('rpy'))
      };
    }

    let geometry = null;
    const geomEl = visEl.querySelector('geometry');
    if (geomEl) {
      const boxEl = geomEl.querySelector('box');
      const cylinderEl = geomEl.querySelector('cylinder');
      const sphereEl = geomEl.querySelector('sphere');
      const meshEl = geomEl.querySelector('mesh');

      if (boxEl) {
        geometry = {
          type: 'box',
          size: parseVec3(boxEl.getAttribute('size'), [1, 1, 1])
        };
      } else if (cylinderEl) {
        geometry = {
          type: 'cylinder',
          radius: parseFloat(cylinderEl.getAttribute('radius') || '0.1'),
          length: parseFloat(cylinderEl.getAttribute('length') || '0.2')
        };
      } else if (sphereEl) {
        geometry = {
          type: 'sphere',
          radius: parseFloat(sphereEl.getAttribute('radius') || '0.1')
        };
      } else if (meshEl) {
        geometry = {
          type: 'mesh',
          filename: meshEl.getAttribute('filename') || '',
          scale: parseVec3(meshEl.getAttribute('scale'), [1, 1, 1])
        };
      }
    }

    let material = null;
    const matEl = visEl.querySelector('material');
    if (matEl) {
      material = parseMaterial(matEl);
    }

    if (geometry) {
      visuals.push({ origin, geometry, material });
    }
  }

  return { name, visuals };
}

function parseJoint(el) {
  const name = el.getAttribute('name');
  if (!name) return null;

  const type = el.getAttribute('type') || 'fixed';
  const parentEl = el.querySelector('parent');
  const childEl = el.querySelector('child');

  const parent = parentEl ? parentEl.getAttribute('link') : null;
  const child = childEl ? childEl.getAttribute('link') : null;

  let origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
  const originEl = el.querySelector('origin');
  if (originEl) {
    origin = {
      xyz: parseVec3(originEl.getAttribute('xyz')),
      rpy: parseVec3(originEl.getAttribute('rpy'))
    };
  }

  let axis = [1, 0, 0];
  const axisEl = el.querySelector('axis');
  if (axisEl) {
    axis = parseVec3(axisEl.getAttribute('xyz'), [1, 0, 0]);
  }

  return { name, type, parent, child, origin, axis };
}
