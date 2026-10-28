#!/usr/bin/env node
// Full local load run. Requires `npm install --save-dev playwright` and Chrome.
// Examples: node tools/measure_dashboard.mjs --duration-sec 300 --topics all
//           node tools/measure_dashboard.mjs --duration-sec 25 --topics scan
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith('--')) continue;
  args[process.argv[i].slice(2)] = process.argv[i + 1];
  i++;
}
const durationSec = Number(args['duration-sec'] || 300);
const topicSet = args.topics || 'all';
const port = Number(args['web-port'] || 8080), mockPort = Number(args['mock-port'] || 8766);
const outDir = path.join(root,'tools','results'); mkdirSync(outDir,{recursive:true});
const stamp = new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
const reportPath = path.join(outDir,`measure-${topicSet.replaceAll('/','_')}-${stamp}.json`);
const tracePath = path.join(outDir,`chrome-trace-${topicSet.replaceAll('/','_')}-${stamp}.json`);
const children=[];
function start(command,argv) { const child=spawn(command,argv,{cwd:root,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',b=>process.stdout.write(b));child.stderr.on('data',b=>process.stderr.write(b));return child; }
async function waitPort(p) { const until=Date.now()+12000;while(Date.now()<until){try{await new Promise((resolve,reject)=>{const s=net.connect(p,'127.0.0.1',resolve);s.once('error',reject);s.once('connect',()=>s.destroy());});return;}catch{await new Promise(r=>setTimeout(r,200));}}throw Error(`Port ${p} did not open`); }
let browser;
try {
  start(process.execPath,[path.join(root,'tools','mock_bridge.mjs'),'--port',String(mockPort)]);
  start(process.platform==='win32'?'python':'python3',['-m','http.server',String(port),'--bind','127.0.0.1']);
  await Promise.all([waitPort(mockPort),waitPort(port)]);
  browser=await chromium.launch({headless:true,args:['--enable-precise-memory-info','--use-angle=swiftshader','--disable-gpu-sandbox']});
  const context=await browser.newContext(); const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.addInitScript(()=>{window.__longTasks=[];try{new PerformanceObserver(l=>window.__longTasks.push(...l.getEntries().map(e=>({startTime:e.startTime,duration:e.duration,name:e.name})))).observe({type:'longtask',buffered:true})}catch{}});
  const session=await context.newCDPSession(page); const trace=[];
  session.on('Tracing.dataCollected',e=>trace.push(...e.value));
  const tracingDone=once(session,'Tracing.tracingComplete');
  await session.send('Tracing.start',{categories:'devtools.timeline,v8,blink,disabled-by-default-v8.gc,disabled-by-default-devtools.timeline',options:'sampling-frequency=10000',transferMode:'ReportEvents'});
  await page.goto(`http://127.0.0.1:${port}/?topics=${encodeURIComponent(topicSet)}`,{waitUntil:'domcontentloaded'});
  await page.locator('#btn-mode-live').click();
  const samples=[]; const marks=new Set([1,3,5]);
  for(let sec=1;sec<=durationSec;sec++) {
    await page.waitForTimeout(1000);
    if(marks.has(sec) || sec===durationSec) samples.push(await page.evaluate(async at=>{
      const {debugInstrumentation}=await import('./src/debugInstrumentation.js');
      return {elapsedSec:at,heapBytes:performance.memory?.usedJSHeapSize||null,
        topicMetrics:debugInstrumentation.getMetricsSummary(),fps:window.__scene3D?.fps??null,
        connection:document.querySelector('#hdr-conn-status')?.textContent||null};
    },sec));
  }
  const longTasks=await page.evaluate(()=>window.__longTasks||[]);
  await session.send('Tracing.end'); await tracingDone;
  writeFileSync(tracePath,JSON.stringify({traceEvents:trace,displayTimeUnit:'ms'}));
  const result={url:`http://127.0.0.1:${port}/?topics=${topicSet}`,durationSec,topicSet,
    generatedAt:new Date().toISOString(),samples,longTasks,
    longTaskCount:longTasks.length,longTasksOver100ms:longTasks.filter(t=>t.duration>100),errors,
    chromeTrace:tracePath};
  writeFileSync(reportPath,JSON.stringify(result,null,2));
  console.log(JSON.stringify({reportPath,tracePath,durationSec,longTaskCount:result.longTaskCount,
    maxLongTaskMs:Math.max(0,...longTasks.map(t=>t.duration)),samples,errors},null,2));
  await browser.close();
} catch(error) { console.error(error); process.exitCode=1; }
finally { if(browser)await browser.close().catch(()=>{});for(const child of children){child.kill('SIGTERM');} }
