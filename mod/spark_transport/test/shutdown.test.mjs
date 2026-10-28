import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..','..');
const winOnly={skip:process.platform!=='win32'};

function ps(file,more=[],cwd=ROOT){
  return spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...more],{
    cwd,windowsHide:true,encoding:'utf8',timeout:25000,maxBuffer:400000
  });
}
async function fixture(t){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'spark-stop-fixture-'));
  t.after(async()=>fs.rm(home,{recursive:true,force:true}));
  const entry=path.join(home,'out','spark','script','stop-all.ps1');
  const cii=path.join(home,'mod','spark_cii','script','spark-cii.ps1');
  const cli=path.join(home,'mod','spark_cii','src','cli.mjs');
  const bounded=path.join(home,'mod','spark_transport','src','bounded-process-cli.mjs');
  const config=path.join(home,'.runtime','config','spark.local.json');
  for(const f of [entry,cii,cli,bounded,config]){
    await fs.mkdir(path.dirname(f),{recursive:true});
  }
  await fs.mkdir(path.join(home,'log','system'),{recursive:true});
  await fs.copyFile(path.join(ROOT,'out','spark','script','stop-all.ps1'),entry);
  await fs.copyFile(path.join(ROOT,'mod','spark_cii','script','spark-cii.ps1'),cii);
  // Never invoke a real stop: all native worker requests terminate inside this fixture.
  await fs.writeFile(bounded,"console.log('SAFE_FAKE_BOUNDED');\nprocess.exit(0);\n");
  await fs.writeFile(cli,"if(process.argv[2]==='disable'){console.error('fixture CDP offline');process.exit(3)}\nprocess.exit(0);\n");
  await fs.writeFile(config,JSON.stringify({transport:{host:'127.0.0.1',port:8765,healthPath:'/health'},tunnel:{clientDir:'mod/spark_transport/tool/tunnel_client'}}));
  const wrapper=path.join(home,'run-shutdown-fixture.ps1');
  const lines=[
    'param([string]$Mode)',
    "function Get-Process { param($Name,$Id,$ErrorAction) if($Name -eq 'ChatGPT'){return} throw 'unexpected process lookup in safe fixture' }",
    "function Invoke-RestMethod { param($Uri,$TimeoutSec) if($Mode -eq 'transport'){return [pscustomobject]@{status='ok'}} throw 'fixture Transport absent' }",
    "function Invoke-WebRequest { param($Uri,$TimeoutSec,[switch]$UseBasicParsing) if($Mode -eq 'tunnel'){return [pscustomobject]@{Content='ready'}} throw 'fixture Tunnel absent' }",
    "& '"+entry.replaceAll("'","''")+"'",
  ];
  await fs.writeFile(wrapper,lines.join('\r\n')+'\r\n','utf8');
  return {home,wrapper,cii};
}

test('Stop has explicit process and endpoint postconditions and never kills the Tray',async()=>{
  const source=await fs.readFile(path.join(ROOT,'out','spark','script','stop-all.ps1'),'utf8');
  assert.match(source,/Get-SPARKCiiWatchers/);
  assert.match(source,/Get-SPARKUiWatchers/);
  assert.match(source,/Get-SPARKManagedTunnel/);
  assert.match(source,/ChatGPT.exe processes still running/);
  assert.match(source,/\[S2-STOP-VERIFY\]/);
  assert.match(source,/SPARK stop incomplete/);
  assert.doesNotMatch(source,/Stop-Process\s+-Name\s+(?:spark-tray|powershell)\b/i);
});

test('isolated Stop succeeds only when managed components and endpoints are absent',winOnly,async(t)=>{
  const f=await fixture(t);
  const r=ps(f.wrapper,['stopped'],f.home);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/S2-STOP-VERIFY.*CII=0.*UI=0.*ChatGPT=0.*Tunnel=0/);
  assert.match(r.stdout,/PASS - all managed services stopped/);
});

test('isolated Stop refuses PASS while a Transport health endpoint remains active',winOnly,async(t)=>{
  const f=await fixture(t);
  const r=ps(f.wrapper,['transport'],f.home);
  assert.notEqual(r.status,0);
  assert.match(r.stdout,/TransportHealthy=True/);
  assert.doesNotMatch(r.stdout,/S2-STOP-VERIFY\] PASS/);
});

test('isolated Stop refuses PASS while Tunnel readiness remains active',winOnly,async(t)=>{
  const f=await fixture(t);
  const r=ps(f.wrapper,['tunnel'],f.home);
  assert.notEqual(r.status,0);
  assert.match(r.stdout,/TunnelReady=True/);
  assert.doesNotMatch(r.stdout,/S2-STOP-VERIFY\] PASS/);
});

test('isolated CII stop succeeds with no watcher even when CDP disable is unavailable',winOnly,async(t)=>{
  const f=await fixture(t);
  const r=ps(f.cii,['-Action','stop'],f.home);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/SPARK CII STOPPED/);
});
