import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createSparkServer } from '../src/server.mjs';
import { freePort, headersFor, makeFixture, requestEnvelope } from './helpers.mjs';

const TEST_TOKEN='spk_test_0123456789abcdef';
const TEST_AUTH={mode:'bearer',bearerTokenSha256:crypto.createHash('sha256').update(TEST_TOKEN,'utf8').digest('hex')};
function authHeaders(body){return {...headersFor(body),authorization:`Bearer ${TEST_TOKEN}`};}

test('server discover/list/call smoke exposes Sprint-2 tool set',async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const port=await freePort();
  const config={root:f.root,host:'127.0.0.1',port,mcpPath:'/mcp',healthPath:'/health',maxReadBytes:1024*1024,commandTimeoutMs:1000,maxCommandOutputBytes:4096,stateDir:path.join(f.base,'state'),recycleBin:true,auth:TEST_AUTH};
  const runtime=await createSparkServer(config,{recycle:async()=>{},runner:async()=>({ok:true,stdout:'',stderr:'',exitCode:0,durationMs:1})});
  await runtime.listen();
  t.after(()=>runtime.close());
  for(const body of [requestEnvelope('server/discover'),requestEnvelope('tools/list')]){
    const res=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:authHeaders(body),body:JSON.stringify(body)});
    assert.equal(res.status,200);
    const json=await res.json();
    assert.equal(json.result.resultType,'complete');
    assert.equal(json.result._meta['io.modelcontextprotocol/serverInfo'].name,'SPARK');
    if(body.method==='tools/list')assert.equal(json.result.tools.length,10);
  }
  const call=requestEnvelope('tools/call',{name:'read_file',arguments:{path:'hello.txt'}});
  const res=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:authHeaders(call),body:JSON.stringify(call)});
  const json=await res.json();
  const result=json.result.structuredContent;
  assert.equal(result.ok,true);
  assert.equal(result.operation,'read_file');
  assert.equal(result.changed,false);
  assert.match(result.operationId,/^op-/);
  assert.equal(result.data.text,'hello\n');
  const recent=await runtime.ledger.recent(5);
  assert.equal(recent.length,1);
  assert.equal(recent[0].operation,'read_file');
  assert.equal(recent[0].status,'success');
});

test('modern header mismatch rejected and GET SSE absent',async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const port=await freePort();
  const config={root:f.root,host:'127.0.0.1',port,mcpPath:'/mcp',healthPath:'/health',maxReadBytes:1024,stateDir:path.join(f.base,'state'),commandTimeoutMs:1000,maxCommandOutputBytes:4096,recycleBin:true,auth:TEST_AUTH};
  const rt=await createSparkServer(config);
  await rt.listen();
  t.after(()=>rt.close());
  const body=requestEnvelope('tools/list');
  const h=authHeaders(body);
  h['mcp-method']='tools/call';
  let res=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:h,body:JSON.stringify(body)});
  assert.equal(res.status,400);
  res=await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(res.status,405);
  assert.equal(res.headers.get('mcp-session-id'),null);
});

test('bearer auth denies unauthenticated MCP calls and accepts the configured token',async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const port=await freePort();
  const token='spk_test_0123456789abcdef';
  const bearerTokenSha256=crypto.createHash('sha256').update(token,'utf8').digest('hex');
  const config={root:f.root,host:'127.0.0.1',port,mcpPath:'/mcp',healthPath:'/health',maxReadBytes:1024,stateDir:path.join(f.base,'state'),commandTimeoutMs:1000,maxCommandOutputBytes:4096,recycleBin:true,auth:{mode:'bearer',bearerTokenSha256}};
  const rt=await createSparkServer(config);
  await rt.listen();
  t.after(()=>rt.close());

  let res=await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status,200);
  const health=await res.json();
  assert.equal(health.version,'0.0.3');
  assert.equal(health.authMode,'bearer');
  assert.equal(health.activity.active,null);
  assert.equal(health.activity.pendingUncertainMutation,null);

  const body=requestEnvelope('tools/list');
  res=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:headersFor(body),body:JSON.stringify(body)});
  assert.equal(res.status,401);
  assert.equal(res.headers.get('www-authenticate'),'Bearer realm="SPARK"');

  res=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{...headersFor(body),authorization:'Bearer wrong'},body:JSON.stringify(body)});
  assert.equal(res.status,401);

  res=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{...headersFor(body),authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  assert.equal(res.status,200);
  const json=await res.json();
  assert.equal(json.result.tools.length,10);
});

test('server refuses to start without Access_token bearer authentication',async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const port=await freePort();
  const config={root:f.root,host:'127.0.0.1',port,mcpPath:'/mcp',healthPath:'/health',maxReadBytes:1024,stateDir:path.join(f.base,'state'),commandTimeoutMs:1000,maxCommandOutputBytes:4096,recycleBin:true};
  await assert.rejects(()=>createSparkServer(config),/Access_token Bearer authentication is required/);
});

test('HTTP receive and server shutdown waits are explicitly bounded',async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const port=await freePort();
  const config={root:f.root,host:'127.0.0.1',port,mcpPath:'/mcp',healthPath:'/health',maxReadBytes:1024,stateDir:path.join(f.base,'state'),commandTimeoutMs:1000,operationTimeoutMs:100,httpRequestTimeoutMs:250,serverCloseTimeoutMs:100,maxCommandOutputBytes:4096,recycleBin:true,auth:TEST_AUTH};
  const rt=await createSparkServer(config);
  await rt.listen();
  assert.equal(rt.server.requestTimeout,250);
  assert.equal(rt.server.headersTimeout,250);
  const socket=net.createConnection({host:'127.0.0.1',port});
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TEST_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  const started=Date.now();
  await rt.close();
  assert.ok(Date.now()-started<1000);
  socket.destroy();
});




test('SSE response disconnect detaches request and backward-compatible continuation completes the same process',async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const port=await freePort();
  const marker=path.join(f.root,'managed-survived.txt');
  const config={
    root:f.root,
    host:'127.0.0.1',
    port,
    mcpPath:'/mcp',
    healthPath:'/health',
    maxReadBytes:1024,
    stateDir:path.join(f.base,'state'),
    commandTimeoutMs:null,
    commandHeartbeatMs:25,
    operationTimeoutMs:500,
    maxCommandOutputBytes:4096,
    recycleBin:true,
    auth:TEST_AUTH,
  };
  const rt=await createSparkServer(config);
  await rt.listen();
  t.after(()=>rt.close());

  const start=requestEnvelope('tools/call',{
    name:'run_command',
    arguments:{
      command:process.execPath,
      args:['-e',`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)),500);setTimeout(()=>process.exit(0),4000);`],
      cwd:'.',
    },
  });
  start.params._meta.progressToken='disconnect-start';
  let res=await fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST',
    headers:{...authHeaders(start),accept:'text/event-stream'},
    body:JSON.stringify(start),
  });
  let stream=await res.text();
  let events=stream.split(/\n\n/).filter(Boolean).map((frame)=>{
    const data=frame.split(/\n/).find((line)=>line.startsWith('data: '));
    return data?JSON.parse(data.slice(6)):null;
  }).filter(Boolean);
  const startFinal=events.at(-1);
  assert.equal(startFinal.result.structuredContent.data.status,'working');
  const continuation=startFinal.result.structuredContent.data.continuation;
  assert.equal(startFinal.result.structuredContent.data.resumeId,undefined);
  assert.equal(continuation.command,'__SPARK_CONTINUE__');
  assert.equal(continuation.args.length,1);
  assert.match(continuation.args[0],/^cmd_/);

  const resume=requestEnvelope('tools/call',{name:'run_command',arguments:{command:continuation.command,args:continuation.args}});
  resume.params._meta.progressToken='disconnect-resume';
  const controller=new AbortController();
  res=await fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST',
    headers:{...authHeaders(resume),accept:'text/event-stream'},
    body:JSON.stringify(resume),
    signal:controller.signal,
  });
  const reader=res.body.getReader();
  const first=await reader.read();
  assert.equal(first.done,false);
  controller.abort();
  try{await reader.cancel();}catch{}

  await new Promise((resolve)=>setTimeout(resolve,2300));
  const markerPid=await fs.readFile(marker,'utf8');
  assert.match(markerPid,/^\d+$/);

  const finish=requestEnvelope('tools/call',{name:'run_command',arguments:{command:continuation.command,args:continuation.args}});
  finish.params._meta.progressToken='disconnect-finish';
  res=await fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST',
    headers:{...authHeaders(finish),accept:'text/event-stream'},
    body:JSON.stringify(finish),
  });
  stream=await res.text();
  events=stream.split(/\n\n/).filter(Boolean).map((frame)=>{
    const data=frame.split(/\n/).find((line)=>line.startsWith('data: '));
    return data?JSON.parse(data.slice(6)):null;
  }).filter(Boolean);
  const final=events.at(-1).result.structuredContent;
  assert.equal(final.ok,true);
  assert.equal(final.data.status,'completed');
  assert.equal(final.data.resumeId,undefined);
  assert.equal(final.data.continuation,undefined);

  const recent=await rt.ledger.recent(10);
  assert.ok(recent.some((entry)=>entry.operation==='run_command'&&entry.status==='working'));
  assert.ok(recent.some((entry)=>entry.operation==='run_command'&&entry.status==='success'));
});

test('long run_command streams request-scoped progress and final result over SSE',async(t)=>{
  const f=await makeFixture();
  t.after(f.cleanup);
  const port=await freePort();
  const config={
    root:f.root,
    host:'127.0.0.1',
    port,
    mcpPath:'/mcp',
    healthPath:'/health',
    maxReadBytes:1024,
    stateDir:path.join(f.base,'state'),
    commandTimeoutMs:null,
    commandHeartbeatMs:25,
    operationTimeoutMs:500,
    maxCommandOutputBytes:4096,
    recycleBin:true,
    auth:TEST_AUTH,
  };
  const rt=await createSparkServer(config);
  await rt.listen();
  t.after(()=>rt.close());

  const body=requestEnvelope('tools/call',{
    name:'run_command',
    arguments:{
      command:process.execPath,
      args:['-e','process.stdout.write("one");setTimeout(()=>{process.stdout.write("two");process.exit(0);},130)'],
      cwd:'.',
    },
  });
  body.params._meta.progressToken='progress-test-1';
  const res=await fetch(`http://127.0.0.1:${port}/mcp`,{
    method:'POST',
    headers:{...authHeaders(body),accept:'application/json, text/event-stream'},
    body:JSON.stringify(body),
  });
  assert.equal(res.status,200);
  assert.match(res.headers.get('content-type')??'',/^text\/event-stream/);
  const stream=await res.text();
  const events=stream.split(/\n\n/).filter(Boolean).map((frame)=>{
    const data=frame.split(/\n/).find((line)=>line.startsWith('data: '));
    return data?JSON.parse(data.slice(6)):null;
  }).filter(Boolean);
  const progress=events.filter((event)=>event.method==='notifications/progress');
  assert.ok(progress.length>=2,`expected multiple progress events, got ${progress.length}`);
  assert.equal(progress[0].params.progressToken,'progress-test-1');
  assert.ok(progress.every((event,index)=>event.params.progress===index+1));
  assert.ok(progress.every((event)=>/elapsed=\d+ms/.test(event.params.message)));
  assert.ok(progress.every((event)=>/deadline=none/.test(event.params.message)));
  assert.ok(progress.some((event)=>/warnings=NO_OBSERVABLE_OUTPUT_CHANGE/.test(event.params.message)));
  const final=events.at(-1);
  assert.equal(final.id,body.id);
  assert.equal(final.result.resultType,'complete');
  assert.equal(final.result.structuredContent.ok,true);
  assert.equal(final.result.structuredContent.operation,'run_command');
  assert.match(final.result.structuredContent.data.stdout,/onetwo/);
});
