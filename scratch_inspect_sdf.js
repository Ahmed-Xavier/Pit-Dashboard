const fs = require('fs');
const txt = fs.readFileSync('./world/silesia_ring.sdf', 'utf8');
const includes = [];
const incRegex = /<include>([\s\S]*?)<\/include>/g;
let m;
while ((m = incRegex.exec(txt)) !== null && includes.length < 10) {
  includes.push(m[1].trim());
}
console.log('Includes count:', (txt.match(/<include>/g) || []).length);
console.log('First 5 includes:\n', includes.slice(0, 5).join('\n---\n'));

const models = [];
const modRegex = /<model\s+name="([^"]+)">/g;
while ((m = modRegex.exec(txt)) !== null && models.length < 15) {
  models.push(m[1]);
}
console.log('Models count:', (txt.match(/<model\s+/g) || []).length);
console.log('First 10 models:', models.slice(0, 10));
