import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { DEFAULT_LEDGER_STATUS_LIMIT } from './constants.mjs';
import { createOperationLedger } from './ledger.mjs';
import { terminateProcessTree } from './command-runner.mjs';
import { createSparkServer, ensureStateDir } from './server.mjs';

const SELF=fileURLToPath(import.meta.url);
function print(v){process.stdout.write(`${JSON.stringify(v)}\n`);}
async function readPid(f){try{const p=Number((await fsp.readFile(f,'utf8')).trim());return Number.isInteger(p)&&p>0?p:null;}catch{return null;}}
function processExists(pid){if(!pid)return false;try{process.kill(pid,0);return true;}catch{return false;}}
async function health(config,timeoutMs=750){const c=new AbortController();const timer=setTimeout(()=>c.abort(),timeoutMs);try{const r=await fetch(`http://${config.host}:${config.port}${config.healthPath}`,{signal:c.signal});return r.ok?await r.json():null;}catch{return null;}finally{clearTimeout(timer);}}

async function serve(){
  const config=loadConfig();
  const state=await ensureStateDir(config);
  const existing=await readPid(state.pidFile);
  if(existing&&existing!==process.pid&&processExists(existing))throw new Error(`SPARK already appears to be running as PID ${existing}`);
  await fsp.writeFile(state.pidFile,`${process.pid}\n`,'utf8');
  const runtime=await createSparkServer(config);
  const address=await runtime.listen();
  print({status:'started',pid:process.pid,host:config.host,port:address.port,mcp:config.mcpPath,config:config.configPath});
  let closing=false;
  const shutdown=async()=>{if(closing)return;closing=true;await runtime.close().catch(()=>{});if(await readPid(state.pidFile)===process.pid)await fsp.rm(state.pidFile,{force:true}).catch(()=>{});process.exit(0);};
  process.on('SIGINT',shutdown);
  process.on('SIGTERM',shutdown);
}

async function start(){
  const config=loadConfig();
  const state=await ensureStateDir(config);
  const existing=await readPid(state.pidFile);
  if(existing&&processExists(existing)){print({status:'already-running',pid:existing,healthy:Boolean(await health(config))});return;}
  await fsp.rm(state.pidFile,{force:true}).catch(()=>{});
  const logFd=fs.openSync(state.logFile,'a');
  const child=spawn(process.execPath,[SELF,'serve'],{detached:true,stdio:['ignore',logFd,logFd],cwd:process.cwd(),env:process.env,windowsHide:true});
  child.unref();
  fs.closeSync(logFd);
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){const info=await health(config,500);const pid=await readPid(state.pidFile);if(info&&pid){print({status:'started',pid,healthy:true,host:config.host,port:config.port});return;}await new Promise(r=>setTimeout(r,100));}
  await terminateProcessTree(child.pid,child).catch(()=>{});
  await fsp.rm(state.pidFile,{force:true}).catch(()=>{});
  throw new Error(`SPARK did not become healthy within startup timeout; child cleanup attempted; inspect ${state.logFile}`);
}

async function status(){
  const config=loadConfig();
  const state=await ensureStateDir(config);
  const pid=await readPid(state.pidFile);
  const running=processExists(pid);
  const info=running?await health(config):null;
  const ledger=createOperationLedger({stateDir:config.stateDir});
  const recentOperations=await ledger.recent(DEFAULT_LEDGER_STATUS_LIMIT).catch(()=>[]);
  const authMode=info?.authMode??(running&&info?'unknown':config.auth?.mode??'missing');
  print({status:running&&info?'running':running?'running-unhealthy':'stopped',pid:running?pid:null,healthy:Boolean(info),authMode,recentOperations});
  process.exitCode=running&&info?0:1;
}

async function stop(){
  const config=loadConfig();
  const state=await ensureStateDir(config);
  const pid=await readPid(state.pidFile);
  if(!pid||!processExists(pid)){await fsp.rm(state.pidFile,{force:true}).catch(()=>{});print({status:'stopped',pid:null});return;}
  process.kill(pid,'SIGTERM');
  const deadline=Date.now()+5000;
  while(Date.now()<deadline&&processExists(pid))await new Promise(r=>setTimeout(r,100));
  if(processExists(pid)){
    await terminateProcessTree(pid).catch(()=>{});
    const forceDeadline=Date.now()+1000;
    while(Date.now()<forceDeadline&&processExists(pid))await new Promise(r=>setTimeout(r,50));
  }
  if(processExists(pid))throw new Error(`PID ${pid} did not stop after bounded graceful + forced cleanup`);
  await fsp.rm(state.pidFile,{force:true}).catch(()=>{});
  print({status:'stopped',pid});
}

const command=process.argv[2]??'serve';
try{if(command==='serve')await serve();else if(command==='start')await start();else if(command==='status')await status();else if(command==='stop')await stop();else throw new Error(`unknown command: ${command}`);}catch(error){process.stderr.write(`${error?.message??error}\n`);process.exitCode=1;}
