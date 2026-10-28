import fs from 'node:fs';
import readline from 'node:readline';

const [capturePath, wantedTopic = '/joint_states'] = process.argv.slice(2);
if (!capturePath) throw new Error('usage: node tools/inspect_cdr_frame.mjs <capture.jsonl> [topic]');
const input = fs.createReadStream(capturePath);
const lines = readline.createInterface({ input, crlfDelay: Infinity });
for await (const line of lines) {
  const row = JSON.parse(line);
  if (row.kind !== 'binary' || row.topic !== wantedTopic) continue;
  const bytes = Buffer.from(row.payloadBase64, 'base64');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 4;
  const fields = [];
  function align(size) { offset = 4 + Math.ceil((offset - 4) / size) * size; }
  function u32(label) { align(4); const at = offset; const value = view.getUint32(offset, true); offset += 4; fields.push({ label, at, value }); return value; }
  function string(label) { const length = u32(`${label}.length`); const value = new TextDecoder().decode(bytes.subarray(offset, offset + Math.max(0, length - 1))); const at = offset; offset += length; fields.push({ label, at, length, value }); return value; }
  const sec = u32('header.sec');
  const nanosec = u32('header.nanosec');
  const frame = string('header.frame_id');
  if (wantedTopic === '/joint_states') {
    const count = u32('name.length');
    for (let i = 0; i < count; i++) string(`name[${i}]`);
    for (const field of ['position', 'velocity', 'effort']) {
      const count = u32(`${field}.length`);
      align(8);
      const start = offset;
      if (count > Math.floor((bytes.length - offset) / 8)) {
        fields.push({ label: field, start, invalidCount: count, remainingBytes: bytes.length - offset });
        break;
      }
      const values = [];
      for (let i = 0; i < count && i < 32; i++) { values.push(view.getFloat64(offset, true)); offset += 8; }
      fields.push({ label: field, start, values });
    }
  }
  console.log(JSON.stringify({ topic: wantedTopic, sec, nanosec, frame, payloadBytes: bytes.length, offset, fields, prefixHex: bytes.subarray(0, 200).toString('hex') }, null, 2));
  break;
}
