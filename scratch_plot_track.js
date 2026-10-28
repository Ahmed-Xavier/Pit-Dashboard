const fs = require('fs');

const text = fs.readFileSync('c:/My files/Lichtblick-ENIMIA/Pit-dashboard/world/silesia_ring.sdf', 'utf8');
const modelRegex = /<model name="track_segment_(\d+)">[\s\S]*?<pose>([^<]+)<\/pose>/g;
let m;
const pts = [];
while ((m = modelRegex.exec(text)) !== null) {
  const idx = parseInt(m[1], 10);
  const parts = m[2].trim().split(/\s+/).map(Number);
  pts.push({ idx, x: parts[0], y: parts[1] });
}

pts.sort((a,b) => a.idx - b.idx);

let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const p of pts) {
  if (p.x < minX) minX = p.x;
  if (p.x > maxX) maxX = p.x;
  if (p.y < minY) minY = p.y;
  if (p.y > maxY) maxY = p.y;
}

const w = 800, h = 500;
const scale = Math.min((w - 40) / (maxX - minX), (h - 40) / (maxY - minY));
const ox = (w - (maxX - minX) * scale) / 2 - minX * scale;
const oy = (h - (maxY - minY) * scale) / 2 + maxY * scale;

// In ROS: +X forward (right), +Y left (up in ROS, but in screen down vs up?)
const svgPts = pts.map(p => `${(ox + p.x * scale).toFixed(1)},${(oy - p.y * scale).toFixed(1)}`).join(' ');

console.log('SVG polyline points count:', pts.length);
console.log('Sample first 5 svg pts:', pts.slice(0, 5).map(p => `${(ox + p.x * scale).toFixed(1)},${(oy - p.y * scale).toFixed(1)}`));

// Check distance between consecutive points:
let maxGap = 0;
for (let i = 1; i < pts.length; i++) {
  const d = Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
  if (d > maxGap) maxGap = d;
}
console.log('Max gap between consecutive segments:', maxGap);
console.log('Gap between last and first segment:', Math.hypot(pts[0].x - pts[pts.length-1].x, pts[0].y - pts[pts.length-1].y));
