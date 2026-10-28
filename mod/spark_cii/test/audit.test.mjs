import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CiiAudit, safeAuditRecord, failureCode, readAuditTail } from "../src/audit.mjs";
import { persistCiiTraces, runWatcher, executeOnce } from "../src/cli.mjs";
import { observeCiiReadiness } from "../../spark_ui/src/watch.mjs";

const PREFIX = "반말 절대 금지";
const MESSAGE = "실제 사용자 대화 원문 - 기록 금지";

test("audit schema allowlists metadata and rejects text, paths, secrets", () => {
 const r=safeAuditRecord("MESSAGE_BLOCKED", {attemptId:4,reason:"MISSING_EDITOR",
  userText:MESSAGE, prefix:PREFIX, url:"https://chatgpt.com/c/secret",
  configPath:"E:/secret",channel:"CLICK",targetKind:"desktop",status:"MISSING",
  occurredAt:"2026-10-26T07:48:00.000Z"},{pid:777});
 assert.equal(r.event,"MESSAGE_BLOCKED");
 assert.equal(r.attemptId,4);
 assert.equal(r.occurredAt,"2026-10-26T07:48:00.000Z");
 assert.equal(r.reason,"MISSING_EDITOR");
 assert.equal(r.targetKind,"desktop");
 assert.equal(r.pid,777);
 const text=JSON.stringify(r);
 for(const disallowed of [MESSAGE,PREFIX,"E:/secret","https://","userText","configPath"]) {
  assert.equal(text.includes(disallowed),false,disallowed);
 }
 assert.throws(()=>safeAuditRecord("ANY_ARBITRARY_EVENT",{content:MESSAGE}),/Invalid CII audit/);
 assert.equal(safeAuditRecord("WATCHER_FAILURE",{reason:"secret/path;TOKEN"}).reason,undefined);
 assert.equal(failureCode(new Error("CDP connection failed: confidential payload")),"CDP_UNAVAILABLE");
});

test("audit writes append-only outside source, preserves old bytes and rejects missing directory",async t=>{
 const base=await mkdtemp(path.join(os.tmpdir(),"spark-cii-audit-test-"));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const dir=path.join(base,"audit");
 await mkdir(dir);
 const file=path.join(dir,"cii-events.jsonl");
 await writeFile(file,"PREEXISTING_RECORD\n");
 const audit=new CiiAudit({filePath:file,now:()=>new Date("2026-10-26T07:55:49.000Z")});
 await audit.write("WATCHER_STARTED",{status:"STARTED", userText:MESSAGE});
 const data=await readFile(file,"utf8");
 assert.ok(data.startsWith("PREEXISTING_RECORD\n"));
 assert.equal(data.split("\n").filter(Boolean).length,2);
 const record=JSON.parse(data.trim().split("\n")[1]);
 assert.equal(record.at,"2026-10-26T07:55:49.000Z");
 assert.equal(data.includes(MESSAGE),false);
 const broken=new CiiAudit({filePath:path.join(base,"missing","data.jsonl")});
 await assert.rejects(broken.write("WATCHER_STARTED"),{code:"ENOENT"});
});

test("DOM trace persists before ACK; audit failure leaves events unacknowledged",async()=>{
 const targets=[{url:"app://-/index.html"}];
 const ev={event:"MESSAGE_INTERCEPTED",attemptId:1,seq:3,
  at:"2026-10-26T07:55:50.000Z",channel:"CLICK",reason:""};
 const saved=[];const acks=[];
 await persistCiiTraces(targets,{write:async(e,d)=>saved.push({e,d})},{
  inspectTrace:async()=>({events:[ev],overflow:0}),
  acknowledge:async(_,seq)=>{acks.push(seq);return true;}
 });
 assert.equal(saved[0].e,"MESSAGE_INTERCEPTED");
 assert.equal(saved[0].d.occurredAt,ev.at);
 assert.deepEqual(acks,[3]);
 await assert.rejects(persistCiiTraces(targets,{write:async()=>{throw new Error("disk unavailable")}},{
  inspectTrace:async()=>({events:[ev],overflow:0}),
  acknowledge:async()=>{throw new Error("must not ack");}
 }),/disk unavailable/);
});

test("watcher logs lifecycle, no-target gap and stop without touching live CDP",async()=>{
 const events=[];const reports=[];let rounds=0;
 await runWatcher({port:9230,intervalMs:250,configPath:"ignored"},v=>reports.push(v),{
  resolvePort:async()=>9230, matchingTargets:async()=>[],
  loadPrefix:async()=>PREFIX,install:async()=>[],
  disable:async()=>[],
  audit:{write:async(e,d)=>events.push({e,d})},
  pause:async()=>{rounds+=1;},
  shouldStop:()=>rounds>=1
 });
 assert.deepEqual(events.map(x=>x.e),["WATCHER_STARTED","WATCHER_STATE","WATCHER_STOPPED"]);
 assert.equal(events[1].d.status,"NO_TARGET");
 assert.equal(reports[0].status,"NO_TARGET");
});

test("Cii watcher installs independently into each newly opened chat window",async()=>{
 const t1={url:"app://-/index.html",type:"page",webSocketDebuggerUrl:"ws://localhost:9230/devtools/page/first"};
 const t2={url:"app://-/index.html",type:"page",webSocketDebuggerUrl:"ws://localhost:9230/devtools/page/second"};
 let cycle=0;
 const reports=[];
 const installs=[];
 await runWatcher({port:9230,intervalMs:250,configPath:"fixture"},v=>reports.push(v),{
   resolvePort:async()=>9230,
   matchingTargets:async()=>cycle===0?[t1]:[t1,t2],
   install:async(targets,prefix)=>{
     assert.equal(prefix,"test-prefix");
     installs.push(targets.map(t=>t.webSocketDebuggerUrl));
     return targets.map(()=>({active:true,result:"SPARK_CII_READY"}));
   },
   disable:async(targets)=>targets.map(()=>({disabled:true})),
   loadPrefix:async()=>"test-prefix",
   persistTraces:async()=>{},
   audit:{write:async()=>{}},
   pause:async()=>{cycle+=1},
   shouldStop:()=>cycle>=2
 });
 assert.equal(reports.length,2);
 assert.equal(reports[0].status,"ACTIVE");
 assert.equal(reports[0].targetCount,1);
 assert.equal(reports[1].status,"ACTIVE");
 assert.equal(reports[1].targetCount,2);
 assert.equal(installs[0].length,1);
 assert.equal(installs[1].length,2);
 assert.notEqual(installs[1][0],installs[1][1]);
});

test("CII watcher reports SUSPECTED_BYPASS without disabling the guarded chat page",async()=>{
  const target={url:"app://-/index.html",type:"page",webSocketDebuggerUrl:"ws://127.0.0.1:9230/devtools/page/1"};
  const reports=[];const events=[];let polls=0;let disabled=0;let persisted=0;
  await runWatcher({port:9230,intervalMs:250,configPath:"fixture"},v=>reports.push(v),{
    resolvePort:async()=>9230,
    matchingTargets:async()=>[target],
    loadPrefix:async()=>"in-memory-prefix",
    install:async()=>[{active:true,suspectedMissingPrefix:2}],
    disable:async()=>{disabled++;return [{disabled:true}]},
    persistTraces:async()=>{persisted++},
    audit:{write:async(e,d)=>events.push({e,d})},
    pause:async()=>{polls++},
    shouldStop:()=>polls>=1
  });
  assert.equal(reports[0].status,"SUSPECTED_BYPASS");
  assert.equal(reports[0].suspectedBypass,2);
  assert.equal(events.find(x=>x.e==="WATCHER_STATE").d.status,"SUSPECTED_BYPASS");
  assert.equal(persisted,1);
  assert.equal(disabled,1,"only final normal shutdown disables the guard");
});

test("independent UI watcher traces missing, active, stale CII and deduplicates status",async()=>{
 const target={url:"app://-/index.html",type:"page",webSocketDebuggerUrl:"ws://127.0.0.1:9230/devtools/page/1"};
 const events=[];const audit={write:async(e,d)=>events.push({e,d})};
 const state={last:null,lastAt:0};let time=100000;
 let status=await observeCiiReadiness([target],state,{audit,now:()=>time,inspect:async()=>null});
 assert.equal(status,"MISSING");
 assert.deepEqual(events.map(x=>x.d.status),["MISSING"]);
 time+=1000;
 status=await observeCiiReadiness([target],state,{audit,now:()=>time,
  inspect:async()=>({enabled:true,refreshedAt:time})});
 assert.equal(status,"ACTIVE");
 assert.deepEqual(events.map(x=>x.d.status),["MISSING","ACTIVE"]);
 time+=1000;
 await observeCiiReadiness([target],state,{audit,now:()=>time,
  inspect:async()=>({enabled:true,refreshedAt:time})});
 assert.equal(events.length,2);
 time+=11000;
 status=await observeCiiReadiness([target],state,{audit,now:()=>time,
  inspect:async()=>({enabled:true,refreshedAt:time-11000})});
 assert.equal(status,"STALE");
 assert.deepEqual(events.map(x=>x.d.status),["MISSING","ACTIVE","STALE"]);
});

test("read-only audit tail works without CDP, is bounded and sanitizes tampered records",async t=>{
 const base=await mkdtemp(path.join(os.tmpdir(),"spark-cii-tail-test-"));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const file=path.join(base,"cii-events.jsonl");
 assert.equal((await readAuditTail({filePath:file})).status,"NOT_FOUND");
 const msg={schema:1,at:"2026-10-26T07:48:00.000Z",source:"cii",event:"MESSAGE_BLOCKED",
  reason:"PRIVATE_MESSAGE_CONTENT",untrustedText:MESSAGE};
 const tampered={...msg,reason:MESSAGE,source:"secret/source"};
 await writeFile(file,JSON.stringify(msg)+"\n"+JSON.stringify(tampered)+"\n");
 const result=await readAuditTail({filePath:file,limit:1});
 assert.equal(result.status,"OK");
 assert.equal(result.records.length,1);
 assert.equal(result.records[0].event,"MESSAGE_BLOCKED");
 const read=JSON.stringify(result);
 assert.equal(read.includes(MESSAGE),false);
 assert.equal(read.includes("secret/source"),false);
 await assert.rejects(readAuditTail({filePath:file,limit:1000}),/1..200/);
});

test("watcher refuses to activate when durable startup audit is unavailable",async()=>{
 let called=false;
 await assert.rejects(runWatcher({port:9230,intervalMs:250,configPath:"test"},()=>{},{
  audit:{write:async()=>{throw new Error("CII audit failed")}},
  resolvePort:async()=>{called=true;return 9230}
 }),/CII audit failed/);
 assert.equal(called,false);
});

test("degraded CII window still drains per-stage tracing instead of skipping it", async () => {
  const targets = [
    {url:"app://-/index.html",id:"window-alpha"},
    {url:"app://-/index.html",id:"window-beta"}
  ];
  const events=[];let polls=0;const drained=[];
  await runWatcher({port:9230,intervalMs:250,configPath:"fixture"},()=>{},{
    resolvePort:async()=>9230,
    matchingTargets:async()=>targets,
    loadPrefix:async()=>PREFIX,
    install:async()=>[{active:true},{active:false,blocked:1}],
    disable:async()=>[],
    persistTraces:async(ts)=>{drained.push(ts.map(x=>x.id));},
    audit:{write:async(event,details)=>events.push({event,details})},
    pause:async()=>{polls++;},
    shouldStop:()=>polls>=1
  });
  assert.deepEqual(drained,[["window-alpha","window-beta"]]);
  assert.equal(events.find(x=>x.event==="WATCHER_STATE").details.status,"DEGRADED");
});

test("separate windows persist ordered content-free stage metadata and ACK only after writes", async t => {
  const base=await mkdtemp(path.join(os.tmpdir(),"spark-cii-stage-trace-"));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const dir=path.join(base,"audit");await mkdir(dir);
  const file=path.join(dir,"cii-events.jsonl");
  const audit=new CiiAudit({filePath:file});
  const prefix="TOP_SECRET_PREFIX_NEVER_LOG";
  const message="PRIVATE_CHAT_NEVER_LOG";
  const targets=[
    {url:"app://-/index.html",id:"window-ALPHA",type:"page"},
    {url:"app://-/index.html",id:"window-BETA",type:"page"}
  ];
  const ev=(event,seq,reason="")=>({
    event,seq,attemptId:1,at:"2026-10-27T06:15:50.000Z",
    reason,channel:"CLICK",prefix,message
  });
  const byTarget=[
    {events:[
      ev("SEND_EVENT_SEEN",1),
      ev("PREFIX_PLAN_VERIFIED",2),
      ev("PREFIX_APPLIED",3),
      ev("PREFIX_VERIFIED",4,"EDITOR_READBACK"),
      ev("MESSAGE_REPLAYED_UNCONFIRMED",5,"NETWORK_NOT_OBSERVED")
    ],overflow:0},
    {events:[
      ev("SEND_EVENT_SEEN",1),
      ev("PREFIX_PLAN_FAILED",2,"UNSUPPORTED_EDITOR"),
      ev("MESSAGE_BYPASSED",3,"UNSUPPORTED_EDITOR")
    ],overflow:0}
  ];
  const acks=[];
  await persistCiiTraces(targets,audit,{
    inspectTrace:async(target)=>byTarget[targets.indexOf(target)],
    acknowledge:async(target,seq)=>{
      const lines=(await readFile(file,"utf8")).trim().split("\n");
      assert.ok(lines.some(s=>JSON.parse(s).targetKey),"ACK only after all stages written");
      acks.push([target.id,seq]);return true;
    }
  });
  assert.deepEqual(acks,[["window-ALPHA",5],["window-BETA",3]]);
  const records=(await readAuditTail({filePath:file,limit:30})).records;
  assert.equal(records.length,8);
  assert.equal(new Set(records.map(r=>r.targetKey)).size,2);
  assert.ok(records.every(r=>r.targetKey && /^[A-F0-9]{16}$/.test(r.targetKey)));
  assert.equal(records.find(r=>r.event==="PREFIX_APPLIED").attemptId,1);
  assert.equal(records.find(r=>r.event==="MESSAGE_BYPASSED").reason,"UNSUPPORTED_EDITOR");
  const serialized=JSON.stringify(records);
  for(const privateValue of [prefix,message,"window-ALPHA","window-BETA"])
    assert.equal(serialized.includes(privateValue),false);
});

test("readiness observer labels a bypassed active guard DEGRADED, not ACTIVE",async()=>{
  const target={url:"app://-/index.html",type:"page",
    webSocketDebuggerUrl:"ws://127.0.0.1:9230/devtools/page/spark"};
  const events=[];
  const state={last:null,lastAt:0};
  const status=await observeCiiReadiness([target],state,{
    now:()=>100000,
    inspect:async()=>({enabled:true,stage:"ORIGINAL_EDITOR_INSERT",
      refreshedAt:99999,safeBypass:true,blocked:1}),
    audit:{write:async(e,d)=>events.push({e,d})}
  });
  assert.equal(status,"DEGRADED");
  assert.equal(events[0].d.status,"DEGRADED");
});

test("probe distinguishes installed legacy guard from actual trace capability", async()=>{
  const target={url:"app://-/index.html",type:"page",webSocketDebuggerUrl:"ws://127.0.0.1:9230/devtools/page/trace-ready"};
  const opts={command:"probe",port:9230};
  const deps={resolvePort:async()=>9230,matchingTargets:async()=>[target]};
  const legacy=await executeOnce(opts,{...deps,inspect:async()=>[{
    target:"desktop",active:true,traceReady:false,state:{enabled:true}
  }]});
  assert.equal(legacy.active,true);
  assert.equal(legacy.traceReady,false,"injection armed does not imply diagnostic logging");
  const upgraded=await executeOnce(opts,{...deps,inspect:async()=>[{
    target:"desktop",active:true,traceReady:true,state:{enabled:true}
  }]});
  assert.equal(upgraded.traceReady,true);
});

test("missing renderer trace API is reported with a safe target key and throttled", async()=>{
  const target={id:"DO_NOT_PERSIST_RAW_PAGE_IDENTIFIER",url:"app://-/index.html"};
  const saved=[];
  const args={inspectTrace:async()=>null,acknowledge:async()=>{throw new Error("ACK invalid");}};
  await persistCiiTraces([target],{write:async(e,d)=>saved.push({e,d})},args);
  await persistCiiTraces([target],{write:async(e,d)=>saved.push({e,d})},args);
  assert.equal(saved.length,1);
  assert.equal(saved[0].e,"TARGET_TRACE_UNAVAILABLE");
  assert.equal(saved[0].d.reason,"TRACE_API_MISSING");
  assert.match(saved[0].d.targetKey,/^[A-F0-9]{16}$/);
  assert.equal(JSON.stringify(saved).includes(target.id),false);
});

test("independent UI watcher distinguishes egress armed from verified user request",async()=>{
  const target={type:"page",url:"app://-/index.html",webSocketDebuggerUrl:"ws://127.0.0.1:9230/devtools/page/eligible"};
  const now=Date.now();
  const events=[];
  const status={last:null,lastAt:0};
  const monitor={now:()=>now,inspect:async()=>({
    enabled:true,stage:"EGRESS_SEND_GATE",refreshedAt:now,
    gate:{enabled:true,armed:true},
    displayMask:{enabled:true,version:"CII_DISPLAY_MASK_V1"},
    dispatchBreakpoint:{installed:true,status:"BREAKPOINT_ARMED",forwarded:0}
  }),audit:{write:async(event,data)=>events.push({event,data})}};
  assert.equal(await observeCiiReadiness([target],status,monitor),"ARMED_UNVERIFIED");
  assert.equal(events[0].data.status,"ARMED_UNVERIFIED");
  const verified={...monitor,now:()=>now+200,inspect:async()=>({
    enabled:true,stage:"EGRESS_SEND_GATE",refreshedAt:now+200,
    gate:{enabled:true,armed:true},
    displayMask:{enabled:true,version:"CII_DISPLAY_MASK_V1"},
    dispatchBreakpoint:{installed:true,status:"BREAKPOINT_ARMED",forwarded:1}
  })};
  assert.equal(await observeCiiReadiness([target],status,verified),"ACTIVE");
  assert.equal(events[1].data.status,"ACTIVE");
});
