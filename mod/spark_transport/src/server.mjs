import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { APP_NAME, APP_VERSION, DEFAULT_COMMAND_INITIAL_WAIT_MS, DEFAULT_COMMAND_REQUEST_SEGMENT_MS, DEFAULT_HTTP_REQUEST_TIMEOUT_MS, DEFAULT_SERVER_CLOSE_TIMEOUT_MS, MAX_REQUEST_BYTES, MCP_PROTOCOL_VERSION } from './constants.mjs';
import { createOperationLedger } from './ledger.mjs';
import { createMcpDispatcher, validateModernRequest } from './mcp.mjs';
import { createOperationRuntime } from './operation-runtime.mjs';
import { createPathPolicy } from './path-policy.mjs';
import { runProcess } from './command-runner.mjs';
import { createManagedCommandRuntime } from './managed-command-runtime.mjs';
import { createToolRuntime } from './tools.mjs';

function isLoopbackHost(value){if(!value)return true;let host=String(value).toLowerCase();try{if(host.includes(':')&&!host.startsWith('[')&&host!=='::1')host=new URL(`http://${host}`).hostname;else if(host.startsWith('['))host=new URL(`http://${host}`).hostname;}catch{return false;}host=host.replace(/^\[/,'').replace(/\]$/,'');return host==='127.0.0.1'||host==='localhost'||host==='::1';}
function validateOrigin(req){const host=req.headers.host;if(host&&!isLoopbackHost(host))return false;const origin=req.headers.origin;if(!origin)return true;try{return isLoopbackHost(new URL(origin).hostname);}catch{return false;}}
function sendJson(res,status,payload,extraHeaders={}){const body=JSON.stringify(payload);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store',...extraHeaders});res.end(body);}
function beginSse(res){res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store, no-transform','connection':'keep-alive'});res.flushHeaders?.();}
function writeSseJson(res,payload){if(res.destroyed||res.writableEnded)return false;return res.write(`data: ${JSON.stringify(payload)}\n\n`);}
function writeSseComment(res,text){if(res.destroyed||res.writableEnded)return false;const safe=String(text).replace(/[\r\n]+/g,' ');return res.write(`: ${safe}\n\n`);}
function acceptsSse(req){const accept=String(req.headers.accept??'').toLowerCase();return accept.includes('text/event-stream');}
function isMcpAuthorized(req,auth){
  if(!auth||auth.mode!=='bearer'||typeof auth.bearerTokenSha256!=='string')return false;
  const header=Array.isArray(req.headers.authorization)?req.headers.authorization[0]:req.headers.authorization;
  const match=/^Bearer[\t ]+(.+)$/i.exec(String(header??''));
  const token=match?.[1]?.trim();
  if(!token)return false;
  const expected=Buffer.from(auth.bearerTokenSha256,'hex');
  const actual=crypto.createHash('sha256').update(token,'utf8').digest();
  return expected.length===actual.length&&crypto.timingSafeEqual(expected,actual);
}
function sendUnauthorized(res){sendJson(res,401,{jsonrpc:'2.0',id:null,error:{code:-32001,message:'Unauthorized'}},{'www-authenticate':'Bearer realm="SPARK"'});}
async function readJsonBody(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_REQUEST_BYTES){const e=new Error('request too large');e.code='REQUEST_TOO_LARGE';throw e;}chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}

export async function createSparkServer(config,injections={}){
  if(!['127.0.0.1','localhost','::1'].includes(config.host))throw new Error('server must bind to a loopback host');
  if(config.auth?.mode!=='bearer'||typeof config.auth.bearerTokenSha256!=='string'||config.auth.bearerTokenSha256.length!==64)throw new Error('Access_token Bearer authentication is required');
  const httpRequestTimeoutMs=config.httpRequestTimeoutMs??DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
  const serverCloseTimeoutMs=config.serverCloseTimeoutMs??DEFAULT_SERVER_CLOSE_TIMEOUT_MS;
  const policy=await createPathPolicy(config.rootPolicies??config.roots??config.root);
  const {ledger:injectedLedger,runner:injectedRunner,...toolInjections}=injections;
  const ledger=injectedLedger??createOperationLedger({stateDir:config.stateDir,durableLedgerDir:config.durableLedgerDir});
  const runner=injectedRunner??((options)=>runProcess({...options,maxOutputBytes:config.maxCommandOutputBytes}));
  const managedCommands=createManagedCommandRuntime({
    maxOutputBytes:config.maxCommandOutputBytes,
    heartbeatIntervalMs:config.commandHeartbeatMs,
    initialWaitMs:config.commandInitialWaitMs??DEFAULT_COMMAND_INITIAL_WAIT_MS,
    requestSegmentMs:config.commandRequestSegmentMs??DEFAULT_COMMAND_REQUEST_SEGMENT_MS,
  });
  const rawToolRuntime=createToolRuntime({policy,maxReadBytes:config.maxReadBytes,stateDir:config.stateDir,commandTimeoutMs:config.commandTimeoutMs,commandHeartbeatMs:config.commandHeartbeatMs,recycleBin:config.recycleBin,runner,managedCommands,...toolInjections});
  const toolRuntime=createOperationRuntime({toolRuntime:rawToolRuntime,ledger,operationTimeoutMs:config.operationTimeoutMs,commandTimeoutMs:config.commandTimeoutMs});
  const dispatcher=createMcpDispatcher({toolRuntime});
  const server=http.createServer(async(req,res)=>{
    if(!validateOrigin(req)){sendJson(res,403,{error:'invalid host/origin'});return;}
    const url=new URL(req.url??'/',`http://${req.headers.host??'127.0.0.1'}`);
    if(url.pathname===config.healthPath){
      if(req.method!=='GET'){res.writeHead(405,{allow:'GET'});res.end();return;}
      sendJson(res,200,{status:'ok',name:APP_NAME,version:APP_VERSION,protocol:MCP_PROTOCOL_VERSION,mode:'mutation-execution',authMode:config.auth?.mode??'missing',activity:toolRuntime.activity?.()??null,managedCommands:managedCommands.activity()});return;
    }
    if(url.pathname!==config.mcpPath){res.writeHead(404);res.end();return;}
    if(req.method!=='POST'){res.writeHead(405,{allow:'POST'});res.end();return;}
    if(!isMcpAuthorized(req,config.auth)){sendUnauthorized(res);return;}
    const contentType=String(req.headers['content-type']??'').toLowerCase();
    if(!contentType.startsWith('application/json')){sendJson(res,415,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Content-Type must be application/json'}});return;}
    let body;
    try{body=await readJsonBody(req);}catch(error){sendJson(res,error?.code==='REQUEST_TOO_LARGE'?413:400,{jsonrpc:'2.0',id:null,error:{code:error?.code==='REQUEST_TOO_LARGE'?-32600:-32700,message:error?.code==='REQUEST_TOO_LARGE'?'Request body too large':'Parse error'}});return;}
    const headers=Object.fromEntries(Object.entries(req.headers).map(([k,v])=>[k.toLowerCase(),Array.isArray(v)?v[0]:v]));
    const validation=validateModernRequest({headers,body});
    if(validation.notification){res.writeHead(202);res.end();return;}
    if(!validation.ok){sendJson(res,validation.status??400,validation.error);return;}
    const streamLongCommand=body.method==='tools/call'&&body.params?.name==='run_command'&&acceptsSse(req);
    if(streamLongCommand){
      const controller=new AbortController();
      let finished=false;
      let progressSequence=0;
      const progressToken=validation.params?._meta?.progressToken;
      const abort=()=>{if(!finished&&!controller.signal.aborted)controller.abort();};
      res.once('close',abort);
      beginSse(res);
      const onProgress=(heartbeat)=>{
        progressSequence+=1;
        const deadline=heartbeat.deadlineMs===null?'none':`${heartbeat.deadlineMs}ms; remaining=${heartbeat.remainingMs}ms; at=${heartbeat.deadlineAt}`;
        const warnings=Array.isArray(heartbeat.warnings)&&heartbeat.warnings.length?heartbeat.warnings.join(','):'none';
        const message=`run_command ${heartbeat.kind}; elapsed=${heartbeat.elapsedMs}ms; pid=${heartbeat.pid}; alive=${heartbeat.processAlive}; stdout=${heartbeat.stdoutBytes}B; stderr=${heartbeat.stderrBytes}B; outputAdvanced=${heartbeat.outputAdvanced}; noOutputFor=${heartbeat.noOutputForMs}ms; deadline=${deadline}; warnings=${warnings}`;
        if(progressToken!==undefined){
          writeSseJson(res,{jsonrpc:'2.0',method:'notifications/progress',params:{progressToken,progress:progressSequence,message}});
        }else{
          writeSseComment(res,`SPARK heartbeat; ${message}`);
        }
      };
      try{
        const result=await dispatcher.dispatch(body,{signal:controller.signal,onProgress});
        if(!res.destroyed&&!res.writableEnded){
          finished=true;
          res.off('close',abort);
          writeSseJson(res,result);
          res.end();
        }else{
          finished=true;
        }
      }catch{
        const error={jsonrpc:'2.0',id:body.id??null,error:{code:-32603,message:'Internal error'}};
        if(!res.destroyed&&!res.writableEnded){
          finished=true;
          res.off('close',abort);
          writeSseJson(res,error);
          res.end();
        }else{
          finished=true;
        }
      }
      return;
    }
    try{const result=await dispatcher.dispatch(body);sendJson(res,result?.error?.code===-32601?404:200,result);}catch{sendJson(res,200,{jsonrpc:'2.0',id:body.id??null,error:{code:-32603,message:'Internal error'}});}
  });
  server.requestTimeout=httpRequestTimeoutMs;
  server.headersTimeout=httpRequestTimeoutMs;
  return{policy,rawToolRuntime,toolRuntime,managedCommands,ledger,server,async listen(){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,()=>{server.off('error',reject);resolve();});});return server.address();},async close(){await managedCommands.closeAll();if(!server.listening)return;await new Promise((resolve,reject)=>{let settled=false;let timer;const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};try{server.close(error=>finish(error));}catch(error){finish(error);return;}timer=setTimeout(()=>{try{server.closeAllConnections?.();}catch{}finish();},serverCloseTimeoutMs);});}};
}

export async function ensureStateDir(config){
  await fs.mkdir(config.stateDir, { recursive: true });
  await fs.mkdir(config.logDir, { recursive: true });
  return { pidFile: path.join(config.stateDir, 'spark.pid'), logFile: path.join(config.logDir, 'spark.log') };
}
