import fs from 'node:fs';
const capture = process.argv[2] ?? 'tools/captures/real_20261020T050317Z.jsonl';
const rows = fs.readFileSync(capture, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const channels = rows.find((row) => row.kind === 'json' && row.message.op === 'advertise').message.channels;
for (const topic of ['/planner/markers']) {
  const channel = channels.find((entry) => entry.topic === topic);
  console.log(`### ${topic} ${channel.schemaName} ${channel.encoding}`);
  if (topic === '/planner/markers') console.log(channel.schema.slice(channel.schema.indexOf('MSG: visualization_msgs/Marker')));
  else console.log(channel.schema);
}
