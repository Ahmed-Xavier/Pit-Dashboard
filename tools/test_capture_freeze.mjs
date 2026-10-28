import fs from 'node:fs';
import { decodeRosMessage } from '../src/cdr.js';

const capturePath = process.argv[2] ?? 'tools/captures/real_20261020T043910Z.jsonl';
const rows = fs.readFileSync(capturePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
const candidates = rows.filter((entry) => entry.kind === 'binary' && entry.topic === '/odometry/global');
if (!candidates.length) throw new Error('capture has no /odometry/global message');

function decodeOldAlignment(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 4;
  const align = (size) => { offset = Math.ceil(offset / size) * size; };
  const i32 = () => { align(4); const value = view.getInt32(offset, true); offset += 4; return value; };
  const u32 = () => { align(4); const value = view.getUint32(offset, true); offset += 4; return value; };
  const f64 = () => { align(8); const value = view.getFloat64(offset, true); offset += 8; return value; };
  const string = () => { const length = u32(); const value = new TextDecoder().decode(bytes.subarray(offset, offset + Math.max(0, length - 1))); offset += length; return value; };
  i32(); u32(); string(); string();
  return { x: f64(), y: f64(), z: f64() };
}

function gridLoopWouldProgress(y, width = 0, height = 0, scale = 28) {
  const step = 2;
  const pixelStep = step * scale;
  const panY = y * scale;
  const originY = height / 2 + panY;
  const minY = Math.floor(-(height - originY) / pixelStep) * step;
  const maxY = Math.ceil(originY / pixelStep) * step;
  const progresses = minY + step !== minY;
  const guardSkips = !Number.isFinite(pixelStep) || pixelStep <= 0 || ![minY, maxY].every(Number.isFinite) ||
    (maxY - minY) / step > 1000 || (minY <= maxY && !progresses);
  return { minY, maxY, next: minY + step, progresses, guardSkips };
}

const samples = candidates.map((entry) => {
  const payload = Buffer.from(entry.payloadBase64, 'base64');
  return { entry, payload, oldPosition: decodeOldAlignment(payload), decoded: decodeRosMessage(Uint8Array.from(payload).buffer, 'nav_msgs/msg/Odometry') };
});
const sample = samples.reduce((largest, current) => Math.abs(current.oldPosition.y) > Math.abs(largest.oldPosition.y) ? current : largest);
const { oldPosition, decoded } = sample;
const correctedPosition = decoded.pose.pose.position;
const oldGrid = gridLoopWouldProgress(oldPosition.y);
const correctedGrid = gridLoopWouldProgress(correctedPosition.y);
const result = { capturePath, sampleElapsedMs: sample.entry.elapsedMs, oldAlignmentPosition: oldPosition, oldAlignmentGrid: oldGrid,
  correctedPosition, correctedGrid };
console.log(JSON.stringify(result, null, 2));
if (oldGrid.progresses || !correctedGrid.progresses) throw new Error('Expected capture to reproduce the float-step stall only with old CDR alignment');
if (!oldGrid.guardSkips || correctedGrid.guardSkips) throw new Error('Expected the grid guard to skip only the bad old-alignment bounds');
