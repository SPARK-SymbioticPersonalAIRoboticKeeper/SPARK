import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createManagedCommandRuntime } from '../src/managed-command-runtime.mjs';

test('managed command yields working state and resumes the same process to completion',async()=>{
  const runtime=createManagedCommandRuntime({
    maxOutputBytes:4096,
    heartbeatIntervalMs:10,
    initialWaitMs:25,
    requestSegmentMs:40,
  });
  const first=await runtime.startAndWait({
    command:process.execPath,
    args:['-e','process.stdout.write(String(process.pid));setTimeout(()=>process.exit(0),140)'],
    cwd:os.tmpdir(),
  });
  assert.equal(first.ok,true);
  assert.equal(first.inProgress,true);
  assert.equal(first.status,'working');
  assert.match(first.resumeId,/^cmd_/);
  const pid=first.pid;

  let current=first;
  while(current.inProgress){
    current=await runtime.resume(first.resumeId);
  }
  assert.equal(current.ok,true);
  assert.equal(current.status,'completed');
  assert.equal(current.resumeId,first.resumeId);
  assert.equal(current.exitCode,0);
  assert.match(current.stdout,new RegExp(String(pid)));
  assert.equal(runtime.activity().activeCount,0);
});

test('request abort detaches only the waiter and does not kill the managed process',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'spark-managed-detach-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const marker=path.join(dir,'survived.txt');
  const runtime=createManagedCommandRuntime({
    maxOutputBytes:4096,
    heartbeatIntervalMs:10,
    initialWaitMs:20,
    requestSegmentMs:200,
  });
  const first=await runtime.startAndWait({
    command:process.execPath,
    args:['-e',`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)),80);setTimeout(()=>process.exit(0),180)`],
    cwd:dir,
  });
  assert.equal(first.inProgress,true);
  const controller=new AbortController();
  setTimeout(()=>controller.abort(),15);
  const detached=await runtime.resume(first.resumeId,{}, {signal:controller.signal});
  assert.equal(detached.ok,true);
  assert.equal(detached.inProgress,true);
  assert.equal(detached.requestDetached,true);
  assert.ok(detached.warnings.includes('REQUEST_SEGMENT_DETACHED'));

  await new Promise((resolve)=>setTimeout(resolve,220));
  const markerPid=await fs.readFile(marker,'utf8');
  assert.equal(markerPid,String(first.pid));
  const final=await runtime.resume(first.resumeId);
  assert.equal(final.ok,true);
  assert.equal(final.status,'completed');
});

test('explicit managed cancel kills the owned process tree',async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'spark-managed-cancel-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const marker=path.join(dir,'orphan.txt');
  const childScript=`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),700);setInterval(()=>{},1000);`;
  const parentScript=`const{spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const runtime=createManagedCommandRuntime({
    maxOutputBytes:4096,
    heartbeatIntervalMs:10,
    initialWaitMs:25,
    requestSegmentMs:100,
  });
  const first=await runtime.startAndWait({
    command:process.execPath,
    args:['-e',parentScript],
    cwd:dir,
  });
  assert.equal(first.inProgress,true);
  const cancelled=await runtime.resume(first.resumeId,{cancel:true});
  assert.equal(cancelled.ok,false);
  assert.equal(cancelled.status,'cancelled');
  assert.equal(cancelled.error.code,'COMMAND_CANCELLED_BY_USER');
  await new Promise((resolve)=>setTimeout(resolve,900));
  await assert.rejects(()=>fs.access(marker),error=>error?.code==='ENOENT');
});
