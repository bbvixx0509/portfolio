// Local HTTP servers, real Cloud SQL, enforced read-only DB sessions.
// --baseline-dir points to a separate checkout of the previous revision.
// Writes aggregate performance evidence only, never row data or credentials.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const value=(name) => process.argv[process.argv.indexOf(name)+1];
if (!process.argv.includes('--production-readonly') || !process.argv.includes('--baseline-dir')) throw new Error('Pass --production-readonly --baseline-dir PATH');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const secret=JSON.parse(execFileSync('kubectl', ['--context=gke_example-gcp-project_asia-northeast3_foodiguard-cluster',
  'get','secret','foodiguard-db-secret','-o','json'],{encoding:'utf8'})).data;
const decode=(key) => Buffer.from(secret[key],'base64').toString();
const scenarios=[
  {name:'catalogue',path:'/api/products?display=48'},
  {name:'keyword',path:'/api/products?display=48&query='+encodeURIComponent('냉면')},
  {name:'allergen-exclusion',path:'/api/products?display=48&excludeAllergens='+encodeURIComponent('메밀')},
];
const percentile=(samples,p) => [...samples].sort((a,b)=>a-b)[Math.min(samples.length-1,Math.ceil(samples.length*p)-1)] || 0;
const results=[];
for (const [variant,directory] of [['baseline',path.resolve(value('--baseline-dir'))],['candidate',root]]) {
  const port=variant==='baseline'?28080:28081;
  const boot=`const db=await import(process.env.BENCH_DB_MODULE);
    for(const p of new Set([db.pool,db.readinessPool].filter(Boolean))) {
      p.options.options += ' -c default_transaction_read_only=on';
      const r=await p.query("SHOW transaction_read_only");
      if(r.rows[0].transaction_read_only!=='on') throw new Error('read-only enforcement failed');
    }
    await import(process.env.BENCH_SERVER_MODULE);`;
  const child=spawn(process.execPath,['--input-type=module','-e',boot],{
    cwd:directory,stdio:['ignore','ignore','pipe'],env:{...process.env,
      DB_HOST:'127.0.0.1',DB_PORT:'15432',DB_NAME:decode('DB_NAME'),DB_USER:decode('DB_USER'),DB_PASSWORD:decode('DB_PASSWORD'),
      DATABASE_URL:'',LOCAL_PGLITE:'false',PORT:String(port),AUTH_TOKEN_SECRET:crypto.randomBytes(32).toString('hex'),
      BENCH_DB_MODULE:pathToFileURL(path.join(directory,'backend/server/db.js')).href,
      BENCH_SERVER_MODULE:pathToFileURL(path.join(directory,'backend/server/index.js')).href,
    },
  });
  let childError=''; child.stderr.on('data',(chunk)=>{ childError+=chunk; });
  const base=`http://127.0.0.1:${port}`;
  try {
    let ready=false;
    for(let n=0;n<50;n++) {
      if(child.exitCode!==null) throw new Error('HTTP server failed to start');
      try {const r=await fetch(base+'/api/health/ready',{signal:AbortSignal.timeout(1000)}); if(r.ok) {ready=true;break;} } catch {}
      await sleep(200);
    }
    if(!ready) throw new Error('HTTP server not ready');
    for(const scenario of scenarios) for(const concurrency of [1,10]) {
      const samples=[],readiness=[],errors={}; let healthFailures=0;
      const began=performance.now(),until=began+3000;
      const worker=async()=>{while(performance.now()<until){
        const start=performance.now();
        try {
          const r=await fetch(base+scenario.path,{signal:AbortSignal.timeout(12000)});
          const body=await r.json();
          if(!r.ok) errors[r.status]=(errors[r.status]||0)+1;
          else if(!Array.isArray(body.products)) throw new Error('Invalid response');
        } catch {errors.transport=(errors.transport||0)+1;}
        samples.push(performance.now()-start);
      }};
      const health=async()=>{while(performance.now()<until){
        const start=performance.now();
        try {const r=await fetch(base+'/api/health/ready',{signal:AbortSignal.timeout(3000)}); await r.text(); if(!r.ok)healthFailures++;}
        catch {healthFailures++;}
        readiness.push(performance.now()-start); await sleep(100);
      }};
      await Promise.all([health(),...Array.from({length:concurrency},worker)]);
      const elapsed=(performance.now()-began)/1000;
      const result={variant,scenario:scenario.name,concurrency,requests:samples.length,elapsedSeconds:elapsed,
        rps:samples.length/elapsed,p50Ms:percentile(samples,.5),p95Ms:percentile(samples,.95),errors,
        readinessP95Ms:percentile(readiness,.95),healthFailures};
      results.push(result); console.log(JSON.stringify(result));
    }
  } finally {
    if(child.exitCode===null) {const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
  }
}
if(process.argv.includes('--output')) await fs.writeFile(value('--output'),JSON.stringify({
  at:new Date().toISOString(),scope:'local HTTP, remote Cloud SQL; read-only; 3s windows; not GKE ingress or capacity certification',results,
},null,2)+'\n');
