const fs = require('fs');

// Simple DOM-less extractor or use jsdom / regex to simulate
const text = fs.readFileSync('c:/My files/Lichtblick-ENIMIA/Pit-dashboard/world/silesia_ring.sdf', 'utf8');

// Let's check what models are in silesia_ring.sdf and what processSdf does
console.log('Testing silesia_ring.sdf models extraction...');
const modelRegex = /<model name="([^"]+)">([\s\S]*?)<\/model>/g;
let m;
let trackCount = 0;
const trackSegs = [];
while ((m = modelRegex.exec(text)) !== null) {
  const name = m[1];
  const body = m[2];
  if (/^track_segment_(\d+)$/.test(name)) {
    trackCount++;
    const poseM = body.match(/<pose>([^<]+)<\/pose>/);
    const pose = poseM ? poseM[1].trim().split(/\s+/).map(Number) : [0,0,0,0,0,0];
    
    // visuals
    const visRegex = /<visual name="([^"]+)">([\s\S]*?)<\/visual>/g;
    let vm;
    while ((vm = visRegex.exec(body)) !== null) {
      const vname = vm[1];
      const vbody = vm[2];
      if (vname === 'asphalt') {
        const sizeM = vbody.match(/<size>([^<]+)<\/size>/);
        const size = sizeM ? sizeM[1].trim().split(/\s+/).map(Number) : [3.16, 15, 0.006];
        trackSegs.push({ name, pose, vname, size });
      }
    }
  }
}

console.log('Found track segments with asphalt visual:', trackSegs.length);
if (trackSegs.length > 0) {
  console.log('Sample segment 0:', trackSegs[0]);
  console.log('Sample segment 100:', trackSegs[100]);
  console.log('Sample segment 600:', trackSegs[600]);
}
