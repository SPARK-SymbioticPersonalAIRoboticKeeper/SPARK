import test from "node:test";
import assert from "node:assert/strict";
import { executeOnce, evaluateCiiReadiness, runWatcher } from "../src/cli.mjs";
import { CiiBreakpointInterceptor, prefixRequestCopy } from "../src/breakpoint.mjs";

const TARGET={type:"page",url:"app://-/index.html",
  id:"private-cdp-test-id",webSocketDebuggerUrl:"ws://127.0.0.1:9230/devtools/page/test"};
const PREFIX="존댓말 응답 필수\n인젝션 검증";
function good(now=Date.now(),forwarded=0) {
  return {enabled:true,stage:"EGRESS_REQUEST_BOUNDARY",displayScriptReady:true,
    gate:{enabled:true,armed:true,stage:"EGRESS_SEND_GATE",
      revision:"EGRESS_SEND_GATE_V3"},
    displayMask:{enabled:true,version:"CII_DISPLAY_MASK_V1"},
    dispatchBreakpoint:{implementation:"0.0.2-dispatch-breakpoint",
      installed:true,heartbeatAt:now,forwarded,status:"BREAKPOINT_ARMED"}};
}
test("egress readiness requires real send gate and a fresh debugger-boundary heartbeat",()=>{
  const now=1234567;
  assert.deepEqual(evaluateCiiReadiness(TARGET,good(now),now),{
    active:true,mode:"EGRESS_BOUNDARY_ARMED_UNVERIFIED"
  });
  assert.deepEqual(evaluateCiiReadiness(TARGET,good(now,1),now),{
    active:true,mode:"EGRESS_REQUEST_PREFIX_VERIFIED_LOCAL"
  });
  const missingGate=good(now);missingGate.gate.armed=false;
  assert.equal(evaluateCiiReadiness(TARGET,missingGate,now).active,false);
  const missingMask=good(now);missingMask.displayMask.enabled=false;
  assert.equal(evaluateCiiReadiness(TARGET,missingMask,now).mode,"DISPLAY_MASK_MISSING");
  const missingScript=good(now);missingScript.displayScriptReady=false;
  assert.equal(evaluateCiiReadiness(TARGET,missingScript,now).mode,"DISPLAY_MASK_DOCUMENT_START_MISSING");
  const stale=good(now-12000);
  assert.equal(evaluateCiiReadiness(TARGET,stale,now).active,false);
  const broken=good(now);broken.dispatchBreakpoint.status="ERROR";
  assert.equal(evaluateCiiReadiness(TARGET,broken,now).active,false);
});
test("probe never labels an armed but untested egress breakpoint as healthy",async()=>{
  const deps={resolvePort:async()=>9230,matchingTargets:async()=>[TARGET]};
  const value=await executeOnce({command:"probe",port:9230},{...deps,
    inspect:async()=>[{target:"desktop",active:true,traceReady:true,
      state:good(),requestBoundaryVerified:false,
      actualNetworkSubmitObserved:false}]});
  assert.equal(value.active,true);
  assert.equal(value.healthy,false);
  assert.equal(value.actualSubmitObserved,false);
  const verified=await executeOnce({command:"probe",port:9230},{...deps,
    inspect:async()=>[{target:"desktop",active:true,traceReady:true,
      state:good(Date.now(),1),requestBoundaryVerified:true,
      actualNetworkSubmitObserved:false}]});
  assert.equal(verified.healthy,true);
  assert.equal(verified.actualSubmitObserved,false);
});
test("one-shot CII cannot claim persistent protection after the process exits",async()=>{
  await assert.rejects(executeOnce({command:"once",port:9230},{
    resolvePort:async()=>9230,matchingTargets:async()=>[TARGET],
    loadPrefix:async()=>PREFIX}),/EGRESS_REQUIRES_PERSISTENT_WATCHER/);
});
test("watcher distinguishes ARMED_UNVERIFIED from actually observed request rewrite",async()=>{
  const events=[],status=[];let count=0;
  await runWatcher({port:9230,intervalMs:250,configPath:"ignored"},r=>status.push(r),{
    resolvePort:async()=>9230,matchingTargets:async()=>[TARGET],
    loadPrefix:async()=>PREFIX,
    install:async()=>[{target:"desktop",stage:"EGRESS_REQUEST_BOUNDARY",
      active:true,requestBoundaryVerified:false}],
    disable:async()=>[],persistTraces:async()=>{},
    audit:{write:async(e,detail)=>events.push({e,detail})},
    pause:async()=>{count++},shouldStop:()=>count>=1
  });
  assert.equal(status[0].status,"ARMED_UNVERIFIED");
  assert.equal(events.find(e=>e.e==="WATCHER_STATE").detail.status,"ARMED_UNVERIFIED");
});
test("request copy prefixes image-only input without mutating attachment metadata",()=>{
  const before={messages:[{author:{role:"user"},
    content:{content_type:"multimodal_text",parts:[{type:"image",asset_pointer:"private"}]}}]};
  const original=structuredClone(before);
  const result=prefixRequestCopy(before,PREFIX);
  assert.equal(result.ok,true);
  assert.equal(result.attachmentOnly,true);
  assert.equal(result.request.messages[0].content.parts[0],PREFIX);
  assert.deepEqual(result.request.messages[0].content.parts[1],original.messages[0].content.parts[0]);
  assert.deepEqual(before,original);
  const second=prefixRequestCopy(result.request,PREFIX);
  assert.equal(second.alreadyPrefixed,true);
  assert.equal(second.request.messages[0].content.parts.length,2);
});
test("breakpoint collects ordered metadata-only intercept, validation and resume events",async()=>{
  const b=new CiiBreakpointInterceptor(TARGET,PREFIX);
  b.installed=true;b.breakpointId="id-1";
  const sent=[];
  b.client.send=async(method,args={})=>{
    sent.push(method);
    if(method==="Debugger.evaluateOnCallFrame")
      return {result:{value:{verified:true,originalChars:12,mergedChars:36}}};
    return {};
  };
  await b.onEvent({method:"Debugger.paused",params:{
    hitBreakpoints:["id-1"],callFrames:[{callFrameId:"frame-1"}]}});
  assert.deepEqual(b.peekTrace().events.map(e=>e.event),[
    "MESSAGE_INTERCEPTED","PREFIX_VERIFIED","MESSAGE_REPLAYED_UNCONFIRMED"]);
  assert.equal(b.forwarded,1);
  assert.equal(b.lastOutbound.prefixVerified,true);
  assert.ok(!JSON.stringify(b.snapshot()).includes("PRIVATE_USER"));
  assert.ok(!JSON.stringify(b.snapshot()).includes(PREFIX));
  assert.equal(sent.filter(m=>m==="Debugger.resume").length,1);
  const last=b.peekTrace().events.at(-1).seq;
  assert.equal(b.ackTrace(last),true);
  assert.equal(b.peekTrace().events.length,0);
});
test("breakpoint blocks malformed user payload and retains the error code",async()=>{
  const b=new CiiBreakpointInterceptor(TARGET,PREFIX);
  b.installed=true;b.breakpointId="id-1";
  let resumed=0;
  b.client.send=async(method,args={})=>{
    if(method==="Debugger.evaluateOnCallFrame")
      return {result:{value:{ok:false,blocked:true,reason:"NO_USER_PARTS"}}};
    if(method==="Debugger.resume")resumed++;
    return {};
  };
  await b.onEvent({method:"Debugger.paused",params:{
    hitBreakpoints:["id-1"],callFrames:[{callFrameId:"frame-1"}]}});
  assert.equal(b.forwarded,0);
  assert.equal(b.blocked,1);
  assert.equal(b.lastError,"NO_USER_PARTS");
  assert.equal(b.peekTrace().events.at(-1).event,"MESSAGE_BLOCKED");
  assert.equal(resumed,1);
});

test("new app script invalidates old debugger breakpoint instead of silently bypassing",async()=>{
  const b=new CiiBreakpointInterceptor(TARGET,PREFIX);
  b.installed=true;b.script={scriptId:"script-old"};
  b.onEvent({method:"Debugger.scriptParsed",params:{
    scriptId:"script-new",url:"app://-/assets/app-initial-test.js"
  }});
  assert.equal(b.installed,false);
  assert.equal(b.lastError,"RELOAD_REARM_REQUIRED");
  assert.equal(b.peekTrace().events.at(-1).reason,"RELOAD_REARM_REQUIRED");
});
test("runtime context loss invalidates breakpoint state until watcher reattaches",async()=>{
  const b=new CiiBreakpointInterceptor(TARGET,PREFIX);
  b.installed=true;
  await b.onEvent({method:"Runtime.executionContextsCleared",params:{}});
  assert.equal(b.installed,false);
  assert.equal(b.lastError,"RELOAD_REARM_REQUIRED");
  assert.equal(await b.heartbeat(),false);
});
