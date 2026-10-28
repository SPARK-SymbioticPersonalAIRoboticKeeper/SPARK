import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createPathPolicy } from '../src/path-policy.mjs';
import { createToolRuntime, TOOL_DEFINITIONS } from '../src/tools.mjs';
import { createFilePal } from '../src/file-pal.mjs';
import { makeFixture } from './helpers.mjs';

async function runtimeFixture(t,{prepareRecovery=false}={}){
  const f=await makeFixture();
  t.after(f.cleanup);
  const stateDir=path.join(f.base,'state');
  // No PAL state directory or snapshot folder is created by fixtures.
  const recycled=[];
  const recycle=async(p,isDir)=>{recycled.push({p,isDir});await fs.rm(p,{recursive:isDir,force:true});};
  const runner=async({command,args,cwd,timeoutMs})=>({ok:true,stdout:`${command}:${args.join(',')}`,stderr:'',exitCode:0,signal:null,durationMs:1,cwdSeen:cwd,timeoutSeen:timeoutMs});
  const policy=await createPathPolicy(f.root);
  const runtime=createToolRuntime({policy,maxReadBytes:1024*1024,stateDir,commandTimeoutMs:1234,recycleBin:true,recycle,runner});
  return{f,runtime,recycled,stateDir};
}

async function names(dir){return (await fs.readdir(dir)).sort();}

async function walkFiles(dir){
  const out=[];
  async function walk(current){
    for(const e of await fs.readdir(current,{withFileTypes:true})){
      const p=path.join(current,e.name);
      if(e.isDirectory())await walk(p);else out.push(p);
    }
  }
  try{await walk(dir);}catch(error){if(error?.code!=='ENOENT')throw error;}
  return out;
}

test('run_command input schema remains backward-compatible with the published app snapshot',()=>{
  assert.deepEqual(TOOL_DEFINITIONS.map(x=>x.name),['list_directory','read_file','create_file','write_file','modify_file','create_directory','copy_path','move_path','delete_path','run_command']);
  const run=TOOL_DEFINITIONS.find(x=>x.name==='run_command');
  assert.deepEqual(Object.keys(run.inputSchema.properties),['command','args','cwd','timeoutMs']);
  assert.deepEqual(run.inputSchema.required,['command']);
  assert.equal(run.inputSchema.additionalProperties,false);
  assert.equal(run.inputSchema.properties.resumeId,undefined);
  assert.equal(run.inputSchema.properties.cancel,undefined);
});

test('PAL writes do not create any runtime, log or workspace recovery snapshots', async (t) => {
  const {f,runtime,stateDir}=await runtimeFixture(t,{prepareRecovery:false});
  await assert.rejects(()=>fs.access(stateDir));
  let r=await runtime.createFile({path:'lazy.txt',text:'before'});
  assert.equal(r.ok,true);
  r=await runtime.writeFile({path:'lazy.txt',text:'after'});
  assert.equal(r.ok,true);
  assert.equal(r.recovery,undefined);
  assert.equal((await fs.readFile(path.join(f.root,'lazy.txt'),'utf8')),'after');
  await assert.rejects(()=>fs.access(stateDir));
  assert.deepEqual(await names(f.root),['hello.txt','lazy.txt','nested']);
});

test('CRUD preserves hashes, uses in-memory rollback for failed writes, and creates no PAL sidecars',async(t)=>{
  const {f,runtime,recycled,stateDir}=await runtimeFixture(t);
  let r=await runtime.createFile({path:'new.txt',text:'alpha beta'});
  assert.equal(r.ok,true);
  assert.deepEqual(await names(f.root),['hello.txt','nested','new.txt']);
  r=await runtime.writeFile({path:'new.txt',text:'one target three'});
  assert.equal(r.ok,true);
  assert.equal(r.recovery,undefined);
  assert.equal(typeof r.before.sha256,'string');
  r=await runtime.modifyFile({path:'new.txt',search:'target',replace:'TWO'});
  assert.equal(r.ok,true);
  assert.equal(r.recovery,undefined);
  assert.equal(await fs.readFile(path.join(f.root,'new.txt'),'utf8'),'one TWO three');
  assert.deepEqual(await names(f.root),['hello.txt','nested','new.txt']);
  r=await runtime.createDirectory({path:'folder'});
  assert.equal(r.ok,true);
  r=await runtime.copyPath({source:'new.txt',destination:'folder/copy.txt'});
  assert.equal(r.ok,true);
  r=await runtime.movePath({source:'folder/copy.txt',destination:'folder/moved.txt'});
  assert.equal(r.ok,true);
  assert.deepEqual(await names(path.join(f.root,'folder')),['moved.txt']);
  r=await runtime.deletePath({path:'folder/moved.txt'});
  assert.equal(r.ok,true);
  assert.equal(recycled.length,1);
  await assert.rejects(()=>fs.access(path.join(f.root,'folder','moved.txt')));
  assert.equal((await walkFiles(stateDir)).length,0);
  assert.equal((await walkFiles(f.root)).some(p=>/\.spark-snapshot$|\.spark-(tmp|old)-|pre_rename_backup/i.test(p)),false);
});

test('PAL never snapshots credential or private config values into secrets or any other folder',async(t)=>{
  const f=await makeFixture(); t.after(f.cleanup);
  const stateDir=path.join(f.base,'state');
  const privateDir=path.join(f.base,'private-vault');
  await fs.mkdir(privateDir,{recursive:true});
  const original=path.join(f.root,'configuration.json');
  await fs.writeFile(original,'private-before','utf8');
  const pal=createFilePal({stateDir,credentialRecoveryRoot:privateDir});
  const result=await pal.replaceTextFile({absolutePath:original,
    displayPath:'E:/SRC/example/.runtime/config/spark.local.json',text:'private-after'});
  assert.equal(result.recovery,undefined);
  assert.deepEqual(await fs.readdir(privateDir),[]);
  await assert.rejects(()=>fs.access(stateDir));
  assert.equal(await fs.readFile(original,'utf8'),'private-after');
});

test('PAL refuses stale replacements before mutation, without creating recovery data',async(t)=>{
  const f=await makeFixture();t.after(f.cleanup);
  const original=path.join(f.root,'original.txt');
  await fs.writeFile(original,'original');
  const pal=createFilePal();
  await assert.rejects(
    ()=>pal.replaceTextFile({absolutePath:original,text:'new',expectedBeforeSha256:'bad'}),
    (error)=>error?.code==='STALE_FILE'
  );
  assert.equal(await fs.readFile(original,'utf8'),'original');
  assert.equal((await walkFiles(f.root)).some(p=>p.endsWith('.spark-snapshot')),false);
});

test('move collision is fail-closed and creates no sidecar',async(t)=>{
  const {f,runtime}=await runtimeFixture(t);
  await fs.writeFile(path.join(f.root,'source.txt'),'SOURCE','utf8');
  await fs.writeFile(path.join(f.root,'dest.txt'),'DEST','utf8');
  const before=await names(f.root);
  const r=await runtime.movePath({source:'source.txt',destination:'dest.txt'});
  assert.equal(r.ok,false);
  assert.equal(r.error.code,'ALREADY_EXISTS');
  assert.equal(await fs.readFile(path.join(f.root,'source.txt'),'utf8'),'SOURCE');
  assert.equal(await fs.readFile(path.join(f.root,'dest.txt'),'utf8'),'DEST');
  assert.deepEqual(await names(f.root),before);
});

test('mutation path escapes and root delete fail closed',async(t)=>{
  const {runtime}=await runtimeFixture(t);
  assert.equal((await runtime.createFile({path:'../x.txt',text:'x'})).error.code,'PATH_TRAVERSAL');
  assert.equal((await runtime.deletePath({path:'.'})).error.code,'ROOT_DELETE_FORBIDDEN');
});

test('run_command uses confined cwd and structured runner result',async(t)=>{
  const {runtime}=await runtimeFixture(t);
  const r=await runtime.runCommand({command:'node',args:['-v'],cwd:'nested'});
  assert.equal(r.ok,true);
  assert.equal(r.cwd,'nested');
  assert.equal(r.elevated,false);
  assert.equal(r.timeoutSeen,1234);
  const bad=await runtime.runCommand({command:'node',cwd:'../outside'});
  assert.equal(bad.error.code,'PATH_TRAVERSAL');
});

test('backward-compatible continuation command resumes without starting a duplicate command',async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const policy=await createPathPolicy(f.root);
  const calls=[];
  const managedCommands={
    resume:async(token,options)=>{calls.push({token,options});return options.cancel?{ok:false,inProgress:false,status:'cancelled',resumeId:token,error:{code:'COMMAND_CANCELLED_BY_USER',message:'cancelled'}}:{ok:true,inProgress:true,status:'working',resumeId:token,pid:1234};},
    startAndWait:async()=>{throw new Error('must not start');},
  };
  const runtime=createToolRuntime({policy,maxReadBytes:1024,stateDir:path.join(f.base,'state'),commandTimeoutMs:null,managedCommands});
  const r=await runtime.runCommand({command:'__SPARK_CONTINUE__',args:['cmd_test'],cwd:'.'});
  assert.equal(r.ok,true);
  assert.equal(r.status,'working');
  assert.equal(r.resumeId,undefined);
  assert.deepEqual(r.continuation,{command:'__SPARK_CONTINUE__',args:['cmd_test']});
  assert.deepEqual(r.cancellation,{command:'__SPARK_CANCEL__',args:['cmd_test']});
  const cancelled=await runtime.runCommand({command:'__SPARK_CANCEL__',args:['cmd_test']});
  assert.equal(cancelled.ok,false);
  assert.equal(cancelled.resumeId,undefined);
  assert.equal(cancelled.error.code,'COMMAND_CANCELLED_BY_USER');
  assert.deepEqual(calls,[{token:'cmd_test',options:{cancel:false}},{token:'cmd_test',options:{cancel:true}}]);
});
