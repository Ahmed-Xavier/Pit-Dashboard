const fs = require('fs');
const text = fs.readFileSync('c:/My files/Lichtblick-ENIMIA/Pit-dashboard/world/silesia_ring.sdf', 'utf8');
const regex = /<model name="track_segment_(\d+)">[\s\S]*?<pose>([^<]+)<\/pose>/g;
let m;
let count = 0;
const pts = [];
while ((m = regex.exec(text)) !== null) {
  const idx = parseInt(m[1], 10);
  const parts = m[2].trim().split(/\s+/).map(Number);
  pts.push({ idx, x: parts[0], y: parts[1], z: parts[2], yaw: parts[5] });
  count++;
}
console.log('Total track segments found:', count);
console.log('First 3:', pts.slice(0, 3));
console.log('Last 3:', pts.slice(-3));
console.log('Min/Max X:', Math.min(...pts.map(p=>p.x)), Math.max(...pts.map(p=>p.x)));
console.log('Min/Max Y:', Math.min(...pts.map(p=>p.y)), Math.max(...pts.map(p=>p.y)));
