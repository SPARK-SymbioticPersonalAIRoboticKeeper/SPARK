import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOperationLedger } from '../src/ledger.mjs';
import { createOperationRuntime } from '../src/operation-runtime.mjs';

test('ledger state is created lazily when the runtime starts recording operations',async(t)=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'spark-ledger-lazy-'));
  const stateDir=path.join(base,'state');
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  await assert.rejects(()=>fs.access(stateDir));
  const ledger=createOperationLedger({stateDir});
  await ledger.record({operationId:ledger.nextOperationId(),operation:'read_file',status:'success',changed:false,summary:'lazy state test'});
  assert.equal(await fs.readFile(path.join(stateDir,'ledger','operations.jsonl'),'utf8').then(Boolean),true);
});

test('operation runtime normalizes success and persists ledger',async(t)=>{
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'spark-ledger-'));
  t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
  const ledger=createOperationLedger({stateDir});
  const toolRuntime={call:async(name)=>name==='create_file'?{ok:true,path:'a.txt',bytes:1}:{ok:true,path:'a.txt',text:'x'}};
  const runtime=createOperationRuntime({toolRuntime,ledger});
  const created=await runtime.call('create_file',{path:'a.txt'});
  assert.equal(created.ok,true);
  assert.equal(created.changed,true);
  assert.equal(created.operation,'create_file');
  assert.match(created.operationId,/^op-/);
  assert.equal(created.data.path,'a.txt');
  const read=await runtime.call('read_file',{path:'a.txt'});
  assert.equal(read.changed,false);
  const recent=await ledger.recent(10);
  assert.equal(recent.length,2);
  assert.equal(recent[0].operation,'read_file');
  assert.equal(recent[1].operation,'create_file');
});

test('operation activity exposes bounded metadata without target or arguments',async()=>{
  let release;
  const gate=new Promise((resolve)=>{release=resolve;});
  const ledger={nextOperationId:()=> 'op-activity',record:async(entry)=>entry};
  const toolRuntime={call:async()=>{await gate;return{ok:true,path:'secret.txt',text:'x'};}};
  const runtime=createOperationRuntime({toolRuntime,ledger,operationTimeoutMs:1000,ledgerTimeoutMs:100});
  const pending=runtime.call('read_file',{path:'secret.txt'});
  await new Promise((resolve)=>setTimeout(resolve,10));
  const active=runtime.activity();
  assert.equal(active.active.operationId,'op-activity');
  assert.equal(active.active.operation,'read_file');
  assert.equal(active.active.watchdogMs,1000);
  assert.equal(Object.hasOwn(active.active,'path'),false);
  release();
  await pending;
  const done=runtime.activity();
  assert.equal(done.active,null);
  assert.equal(done.last.operation,'read_file');
  assert.equal(done.last.status,'success');
});

test('operation runtime makes permission failure explicit',async(t)=>{
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'spark-ledger-'));
  t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
  const ledger=createOperationLedger({stateDir});
  const toolRuntime={call:async()=>({ok:false,error:{code:'ELEVATION_REQUIRED_OR_PERMISSION_DENIED',message:'denied'}})};
  const runtime=createOperationRuntime({toolRuntime,ledger});
  const result=await runtime.call('run_command',{command:'restricted.exe'});
  assert.equal(result.ok,false);
  assert.equal(result.changed,false);
  assert.equal(result.requiresElevation,true);
  assert.equal(result.error.code,'ELEVATION_REQUIRED_OR_PERMISSION_DENIED');
  const [entry]=await ledger.recent(1);
  assert.equal(entry.status,'failed');
  assert.equal(entry.errorCode,'ELEVATION_REQUIRED_OR_PERMISSION_DENIED');
});

test('operation watchdog bounds a hung read-only tool call',async()=>{
  const records=[];
  const ledger={nextOperationId:()=> 'op-read-watchdog',record:async(entry)=>{records.push(entry);return entry;}};
  const toolRuntime={call:async()=>new Promise(()=>{})};
  const runtime=createOperationRuntime({toolRuntime,ledger,operationTimeoutMs:50,ledgerTimeoutMs:50});
  const started=Date.now();
  const result=await runtime.call('read_file',{path:'hung.txt'});
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'OPERATION_TIMEOUT');
  assert.equal(result.retryable,true);
  assert.equal(result.data.stateUncertain,false);
  assert.ok(Date.now()-started<500);
  assert.equal(records.length,1);
});

test('operation watchdog marks timed-out mutations uncertain and blocks overlapping mutation',async()=>{
  let seq=0;
  const ledger={nextOperationId:()=> `op-write-watchdog-${++seq}`,record:async(entry)=>entry};
  const toolRuntime={call:async()=>new Promise(()=>{})};
  const runtime=createOperationRuntime({toolRuntime,ledger,operationTimeoutMs:50,ledgerTimeoutMs:50});
  const result=await runtime.call('create_file',{path:'hung.txt'});
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'OPERATION_TIMEOUT');
  assert.equal(result.retryable,false);
  assert.equal(result.data.stateUncertain,true);
  assert.equal(result.data.pendingOperationId,'op-write-watchdog-1');
  const blocked=await runtime.call('write_file',{path:'other.txt',text:'x'});
  assert.equal(blocked.ok,false);
  assert.equal(blocked.error.code,'UNCERTAIN_MUTATION_IN_FLIGHT');
  assert.equal(blocked.retryable,false);
  assert.equal(blocked.data.stateUncertain,true);
  assert.equal(blocked.data.pendingOperationId,'op-write-watchdog-1');
});

test('run_command without explicit or configured deadline is not killed by the generic operation watchdog',async()=>{
  const records=[];
  const ledger={nextOperationId:()=> 'op-long-command-no-deadline',record:async(entry)=>{records.push(entry);return entry;}};
  const toolRuntime={call:async()=>{await new Promise((resolve)=>setTimeout(resolve,120));return{ok:true,exitCode:0,stdout:'done',stderr:'',durationMs:120};}};
  const runtime=createOperationRuntime({toolRuntime,ledger,operationTimeoutMs:25,commandTimeoutMs:null,ledgerTimeoutMs:50});
  const pending=runtime.call('run_command',{command:'long.exe'});
  await new Promise((resolve)=>setTimeout(resolve,20));
  assert.equal(runtime.activity().active.watchdogMs,null);
  const result=await pending;
  assert.equal(result.ok,true);
  assert.equal(result.error,undefined);
  assert.equal(records[0].status,'success');
});

test('run_command backward-compatible continuation is recorded as working, not terminal success',async()=>{
  const records=[];
  let seq=0;
  const ledger={nextOperationId:()=> `op-working-${++seq}`,record:async(entry)=>{records.push(entry);return entry;}};
  const toolRuntime={call:async()=>({ok:true,inProgress:true,status:'working',continuation:{command:'__SPARK_CONTINUE__',args:['cmd_test']},pid:1234})};
  const runtime=createOperationRuntime({toolRuntime,ledger,operationTimeoutMs:25,commandTimeoutMs:null,ledgerTimeoutMs:50});
  const result=await runtime.call('run_command',{command:'__SPARK_CONTINUE__',args:['cmd_test']});
  assert.equal(result.ok,true);
  assert.equal(result.changed,false);
  assert.equal(result.data.status,'working');
  assert.deepEqual(result.data.continuation,{command:'__SPARK_CONTINUE__',args:['cmd_test']});
  assert.equal(result.retryable,false);
  assert.match(result.summary,/still running/i);
  assert.equal(records[0].status,'working');
  assert.equal(records[0].target,'__SPARK_CONTINUE__');
  assert.equal(runtime.activity().last.status,'working');
});

test('operation result is not blocked forever by a hung ledger write',async()=>{
  const ledger={nextOperationId:()=> 'op-ledger-watchdog',record:async()=>new Promise(()=>{})};
  const toolRuntime={call:async()=>({ok:true,path:'a.txt',text:'x'})};
  const runtime=createOperationRuntime({toolRuntime,ledger,operationTimeoutMs:100,ledgerTimeoutMs:50});
  const started=Date.now();
  const result=await runtime.call('read_file',{path:'a.txt'});
  assert.equal(result.ok,true);
  assert.match(result.data.ledgerWarning,/watchdog/);
  assert.ok(Date.now()-started<500);
});
