/* ==========================================================================
   ENIMIA Dashboard — SDF World XML Parser (Main Thread)
   Parses raw SDF XML into lightweight structured model records.
   Runs safely on the main thread where DOMParser is universally available.
   ========================================================================== */

function parseFloats(str, defaultVal = [0, 0, 0]) {
  if (!str) return defaultVal;
  const parts = str.trim().split(/\s+/).map(Number);
  return parts.some(isNaN) ? defaultVal : parts;
}

export function parseSdfXml(xmlText) {
  if (!xmlText || typeof xmlText !== 'string') {
    throw new Error('SDF content is empty or not a string');
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error(`XML parse error: ${parserError.textContent.slice(0, 120)}`);
  }

  // Find all models (children of world or sdf)
  const modelEls = doc.getElementsByTagName('model');
  const models = [];

  for (let i = 0; i < modelEls.length; i++) {
    const mEl = modelEls[i];
    const name = mEl.getAttribute('name') || `model_${i}`;

    let pose = null;
    const links = [];

    for (let c = 0; c < mEl.children.length; c++) {
      const child = mEl.children[c];
      const tag = child.tagName.toLowerCase();

      if (tag === 'pose') {
        pose = parseFloats(child.textContent, [0, 0, 0, 0, 0, 0]);
      } else if (tag === 'link') {
        const linkName = child.getAttribute('name') || `link_${links.length}`;
        let linkPose = null;
        const visuals = [];

        for (let lc = 0; lc < child.children.length; lc++) {
          const lChild = child.children[lc];
          const lTag = lChild.tagName.toLowerCase();

          if (lTag === 'pose') {
            linkPose = parseFloats(lChild.textContent, [0, 0, 0, 0, 0, 0]);
          } else if (lTag === 'visual') {
            const visName = lChild.getAttribute('name') || `visual_${visuals.length}`;
            let visPose = null;
            let geomType = 'unknown';
            let size = [1, 1, 1];
            let color = { r: 0.5, g: 0.5, b: 0.5 };

            for (let vc = 0; vc < lChild.children.length; vc++) {
              const vChild = lChild.children[vc];
              const vTag = vChild.tagName.toLowerCase();

              if (vTag === 'pose') {
                visPose = parseFloats(vChild.textContent, [0, 0, 0, 0, 0, 0]);
              } else if (vTag === 'geometry') {
                for (let gc = 0; gc < vChild.children.length; gc++) {
                  const gChild = vChild.children[gc];
                  const gTag = gChild.tagName.toLowerCase();

                  if (gTag === 'box') {
                    geomType = 'box';
                    const s = gChild.getElementsByTagName('size')[0];
                    if (s) size = parseFloats(s.textContent, [1, 1, 1]);
                  } else if (gTag === 'plane') {
                    geomType = 'box';
                    const s = gChild.getElementsByTagName('size')[0];
                    if (s) {
                      const sz = parseFloats(s.textContent, [100, 100]);
                      size = [sz[0] || 100, sz[1] || 100, 0.01];
                    }
                  } else if (gTag === 'cylinder') {
                    geomType = 'cylinder';
                    const r = gChild.getElementsByTagName('radius')[0];
                    const l = gChild.getElementsByTagName('length')[0];
                    const rad = r ? parseFloat(r.textContent) || 0.5 : 0.5;
                    const len = l ? parseFloat(l.textContent) || 1.0 : 1.0;
                    size = [rad, len, rad];
                  } else if (gTag === 'sphere') {
                    geomType = 'sphere';
                    const r = gChild.getElementsByTagName('radius')[0];
                    const rad = r ? parseFloat(r.textContent) || 0.5 : 0.5;
                    size = [rad, rad, rad];
                  } else if (gTag === 'mesh') {
                    geomType = 'mesh';
                  }
                }
              } else if (vTag === 'material') {
                const diff = vChild.getElementsByTagName('diffuse')[0] || vChild.getElementsByTagName('ambient')[0];
                if (diff) {
                  const c = parseFloats(diff.textContent, [0.5, 0.5, 0.5]);
                  color = { r: c[0] ?? 0.5, g: c[1] ?? 0.5, b: c[2] ?? 0.5 };
                }
              }
            }

            visuals.push({ name: visName, pose: visPose, geomType, size, color });
          }
        }

        links.push({ name: linkName, pose: linkPose, visuals });
      }
    }

    models.push({ name, pose, links });
  }

  return models;
}
