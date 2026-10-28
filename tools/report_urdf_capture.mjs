#!/usr/bin/env node
import fs from 'node:fs';
import { decodeRosMessage } from '../src/cdr.js';

const capture = process.argv[2] || 'tools/captures/real_20261020T050317Z.jsonl';
const rows = fs.readFileSync(capture, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const record = rows.find((row) => row.kind === 'binary' && row.topic === '/robot_description');
if (!record) throw new Error(`${capture} does not contain /robot_description`);
const bytes = Buffer.from(record.payloadBase64, 'base64');
const xml = decodeRosMessage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'std_msgs/msg/String').data;
const meshUris = [...xml.matchAll(/filename\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]).filter((uri) => /\.(dae|stl)$/i.test(uri));
console.log(JSON.stringify({ capture, wireBytes: record.byteLength, xmlBytes: Buffer.byteLength(xml), robotName: xml.match(/<robot\s+name=["']([^"']+)/)?.[1] ?? null,
  rootLinks: [...xml.matchAll(/<link\s+name=["']([^"']+)/g)].map((match) => match[1]).filter((name) => !new RegExp(`<joint[^>]*>[\\s\\S]*?<child\\s+link=["']${name}["']`).test(xml)),
  meshUris: [...new Set(meshUris)] }, null, 2));
