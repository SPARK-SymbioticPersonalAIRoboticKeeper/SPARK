import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runProcess } from '../src/command-runner.mjs';

test('runProcess captures stdout/stderr/exit code',async()=>{
  const r=await runProcess({command:process.execPath,args:['-e','console.log("OUT");console.error("ERR")'],cwd:os.tmpdir(),timeoutMs:5000});
  assert.equal(r.ok,true);
  assert.match(r.stdout,/OUT/);
  assert.match(r.stderr,/ERR/);
  assert.equal(r.exitCode,0);
  assert.equal(r.stdoutTruncated,false);
  assert.equal(r.stderrTruncated,false);
});

test('runProcess reports nonzero and timeout',async()=>{
  let r=await runProcess({command:process.execPath,args:['-e','process.exit(7)'],cwd:os.tmpdir(),timeoutMs:5000});
  assert.equal(r.ok,false);
  assert.equal(r.exitCode,7);
  assert.equal(r.error.code,'COMMAND_FAILED');
  r=await runProcess({command:process.execPath,args:['-e','setTimeout(()=>{},5000)'],cwd:os.tmpdir(),timeoutMs:50});
  assert.equal(r.ok,false);
  assert.equal(r.error.code,'COMMAND_TIMEOUT');
});

test('runProcess bounds stdout and stderr independently',async()=>{
  const r=await runProcess({
    command:process.execPath,
    args:['-e',"process.stdout.write('x'.repeat(200000));process.stderr.write('y'.repeat(200000));"],
    cwd:os.tmpdir(),
    timeoutMs:5000,
    maxOutputBytes:4096,
  });
  assert.equal(r.ok,true);
  assert.equal(Buffer.byteLength(r.stdout),4096);
  assert.equal(Buffer.byteLength(r.stderr),4096);
  assert.equal(r.stdoutTruncated,true);
  assert.equal(r.stderrTruncated,true);
});

test('timeout terminates child process tree',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'spark-tree-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const marker=path.join(dir,'orphan-marker.txt');
  const childScript=`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),1000);setInterval(()=>{},1000);`;
  const parentScript=`const{spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const r=await runProcess({command:process.execPath,args:['-e',parentScript],cwd:dir,timeoutMs:250,maxOutputBytes:4096});
  assert.equal(r.ok,false);
  assert.equal(r.error.code,'COMMAND_TIMEOUT');
  assert.ok(r.durationMs<5000,`timeout result exceeded hard cleanup bound: ${r.durationMs}ms`);
  await new Promise(resolve=>setTimeout(resolve,1200));
  await assert.rejects(()=>fs.access(marker),error=>error?.code==='ENOENT');
});

test('parent exit does not wait forever for descendant-inherited stdio',async()=>{
  const childScript='setTimeout(()=>process.exit(0),1500);';
  const parentScript=`const{spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:['ignore','inherit','inherit']});c.unref();`;
  const started=Date.now();
  const r=await runProcess({command:process.execPath,args:['-e',parentScript],cwd:os.tmpdir(),timeoutMs:5000,maxOutputBytes:4096});
  const elapsed=Date.now()-started;
  assert.equal(r.ok,true);
  assert.ok(elapsed<1200,`parent result waited on descendant-held stdio for ${elapsed}ms`);
});


test('runProcess emits measured heartbeats while one command keeps running',async()=>{
  const beats=[];
  const r=await runProcess({
    command:process.execPath,
    args:['-e','process.stdout.write("A");setTimeout(()=>{process.stdout.write("B");},45);setTimeout(()=>process.exit(0),130);'],
    cwd:os.tmpdir(),
    timeoutMs:2000,
    heartbeatIntervalMs:25,
    onHeartbeat:(heartbeat)=>beats.push(heartbeat),
  });
  assert.equal(r.ok,true);
  assert.ok(beats.length>=3,`expected multiple heartbeats, got ${beats.length}`);
  assert.equal(beats[0].kind,'started');
  assert.ok(beats.some((heartbeat)=>heartbeat.kind==='heartbeat'));
  assert.ok(beats.every((heartbeat)=>Number.isInteger(heartbeat.pid)&&heartbeat.pid>0));
  assert.ok(beats.some((heartbeat)=>heartbeat.stdoutBytes>0));
  assert.ok(beats.some((heartbeat)=>heartbeat.outputAdvanced===true));
  assert.ok(beats.every((heartbeat)=>heartbeat.processAlive===true));
  assert.ok(beats.every((heartbeat)=>heartbeat.deadlineMs===2000));
  assert.ok(beats.every((heartbeat)=>heartbeat.warnings.includes('EXPLICIT_DEADLINE_ACTIVE')));
  assert.ok(beats.every((heartbeat)=>Number.isInteger(heartbeat.remainingMs)&&heartbeat.remainingMs>=0));
});

test('runProcess has no default absolute deadline and reports output-stall warning without killing the process',async()=>{
  const beats=[];
  const r=await runProcess({
    command:process.execPath,
    args:['-e','setTimeout(()=>process.exit(0),140)'],
    cwd:os.tmpdir(),
    heartbeatIntervalMs:25,
    onHeartbeat:(heartbeat)=>beats.push(heartbeat),
  });
  assert.equal(r.ok,true);
  assert.ok(beats.length>=3);
  assert.ok(beats.every((heartbeat)=>heartbeat.deadlineMs===null));
  assert.ok(beats.every((heartbeat)=>heartbeat.remainingMs===null));
  assert.ok(beats.some((heartbeat)=>heartbeat.warnings.includes('NO_OBSERVABLE_OUTPUT_CHANGE')));
  assert.ok(beats.some((heartbeat)=>heartbeat.noOutputForMs>0));
  assert.ok(beats.every((heartbeat)=>!heartbeat.warnings.includes('EXPLICIT_DEADLINE_ACTIVE')));
});

test('runProcess cancellation terminates the owned process tree',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'spark-cancel-tree-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const marker=path.join(dir,'cancel-orphan-marker.txt');
  const childScript=`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),900);setInterval(()=>{},1000);`;
  const parentScript=`const{spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const controller=new AbortController();
  setTimeout(()=>controller.abort(),120);
  const started=Date.now();
  const r=await runProcess({
    command:process.execPath,
    args:['-e',parentScript],
    cwd:dir,
    timeoutMs:5000,
    heartbeatIntervalMs:25,
    signal:controller.signal,
  });
  assert.equal(r.ok,false);
  assert.equal(r.error.code,'COMMAND_CANCELLED');
  assert.ok(Date.now()-started<3000);
  await new Promise(resolve=>setTimeout(resolve,1100));
  await assert.rejects(()=>fs.access(marker),error=>error?.code==='ENOENT');
});
