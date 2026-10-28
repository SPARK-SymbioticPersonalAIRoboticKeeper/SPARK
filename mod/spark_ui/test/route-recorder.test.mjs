import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RouteRecorder, projectRouteObservation, safeChatTitle } from "../src/route-recorder.mjs";
import { buildRouteOverlayExpression } from "../src/route-overlay.mjs";
import { RouteCollector } from "../src/route-collector.mjs";

const sample = (overrides = {}) => ({
  observedAt: "2026-10-25T14:00:00.000Z",
  title: "SWE4.2 message timeout",
  titleSource: "active-navigation",
  uiErrors: [],
  ui: { model: "gpt-6-thinking", effort: "max" },
  lastSend: { at: "2026-10-25T13:59:58.000Z", type: "composer-send-click",
    model: "gpt-6-thinking", effort: "max" },
  response: {
    status: "observed", model: "gpt-6-thinking", resolvedModel: "gpt-6-thinking",
    effort: "max", resolvedEffort: null, resolvedEffortStatus: "not-reported",
    messageStatus: "finished_successfully", createdAt: "2026-10-25T14:00:00.000Z",
    sourceKind: "live-render",
    source: {model:"assistant.final.metadata.model_slug",effort:"assistant.final.metadata.thinking_effort"},
  },
  metadata: {
    observedFields: 5,redactedFields: 2,
    rows: [
      {field:"model_slug",source:"assistant.final.metadata.model_slug",type:"string",value:"gpt-6-thinking"},
      {field:"request_id",source:"assistant.final.metadata.request_id",type:"string",value:"PRIVATE-REQUEST-ID"},
      {field:"secret_value",source:"assistant.final.metadata.secret_value",type:"string",value:"UNSAFE-VALUE"},
      {field:"is_complete",source:"assistant.final.metadata.is_complete",type:"boolean",value:"true"},
      {field:"reasoning_title",source:"assistant.analysis.metadata.reasoning_title",type:"string",value:"PRIVATE REASONING"},
    ],
  },
  network: {state:"connected",requests:15,chatRequests:0,failures:1,wsFrames:18,
    lastEventAt:"2026-10-25T14:00:00.000Z",
    events:[{method:"POST",responseStatus:504,chatGeneration:true,
      failure:"net::ERR_CONNECTION_RESET",startedAt:"2026-10-25T13:59:59.000Z",
      durationMs:920,bytes:122,canceled:false}]},
  ...overrides,
});

async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),"spark-route-recorder-test-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let current=Date.parse("2026-10-25T14:00:00.000Z");
  const recorder=new RouteRecorder({logDir:dir,now:()=>new Date(current)});
  return {dir,recorder,tick:(millis)=>{current+=millis;}};
}

test("route recording is strictly opt-in and does not create files on observation",async t=>{
  const f=await fixture(t);
  await f.recorder.observe(sample());
  assert.deepEqual(await readdir(f.dir),[]);
  assert.equal(f.recorder.status().active,false);
});

test("start, snapshot, UI timeout, stop and event provenance are persisted as JSONL",async t=>{
  const f=await fixture(t);
  assert.equal(await f.recorder.command({action:"start",sequence:1,instanceId:f.recorder.status().instanceId},sample()),true);
  await f.recorder.observe(sample());
  f.tick(1600);
  await f.recorder.observe(sample({uiErrors:["MESSAGE_DELIVERY_TIMEOUT"]}));
  await f.recorder.command({action:"stop",sequence:2,instanceId:f.recorder.status().instanceId},sample());
  const names=await readdir(f.dir);
  assert.equal(names.length,1);
  assert.match(names[0],/^route-20261025T140000\.000Z-SWE4\.2-message-timeout\.jsonl$/);
  const content=await readFile(path.join(f.dir,names[0]),"utf8");
  const lines=content.trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map(row=>row.event),
    ["recording-start","route-snapshot","ui-error-observation","recording-stop"]);
  assert.equal(lines[2].observation.uiErrors[0],"MESSAGE_DELIVERY_TIMEOUT");
  assert.equal(lines[2].observation.received.messageStatus,"finished_successfully");
  assert.equal(lines[2].observation.received.resolvedEffort,null);
  assert.equal(lines[2].observation.network.events[0].responseStatus,504);
  assert.equal(lines[2].observation.network.events[0].failure,"net::ERR_CONNECTION_RESET");
  assert.equal(f.recorder.status().active,false);
  assert.equal(f.recorder.status().lastCommandSequence,2);
  assert.doesNotMatch(content,/PRIVATE-REQUEST-ID|PRIVATE REASONING|UNSAFE-VALUE/);
  assert.doesNotMatch(content,/"conversation_id"|"message_id"|"rawBody"/);
});

test("unchanged metadata uses low-volume heartbeat while network frame counters progress",async t=>{
  const f=await fixture(t);
  await f.recorder.command({action:"start",sequence:1,instanceId:f.recorder.status().instanceId},sample());
  await f.recorder.observe(sample());
  f.tick(1_500);
  await f.recorder.observe(sample({network:{...sample().network,wsFrames:300,requests:88,
    lastEventAt:"2026-10-25T14:00:01.500Z"}}));
  f.tick(15_000);
  await f.recorder.observe(sample({network:{...sample().network,wsFrames:500,requests:120,
    lastEventAt:"2026-10-25T14:00:16.500Z"}}));
  await f.recorder.command({action:"stop",sequence:2,instanceId:f.recorder.status().instanceId},sample());
  const [name]=await readdir(f.dir);
  const records=(await readFile(path.join(f.dir,name),"utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(record=>record.event),
    ["recording-start","route-snapshot","heartbeat","recording-stop"]);
  assert.deepEqual(records[2].observation.metadata.rows,[]);
  assert.equal(records[2].observation.network.wsFrames,500);
});
test("duplicate commands are idempotent and do not overwrite existing log",async t=>{
  const f=await fixture(t);
  assert.equal(await f.recorder.command({action:"start",sequence:21,instanceId:f.recorder.status().instanceId},sample()),true);
  assert.equal(await f.recorder.command({action:"start",sequence:21,instanceId:f.recorder.status().instanceId},sample()),false);
  assert.equal(await f.recorder.command({action:"stop",sequence:22,instanceId:f.recorder.status().instanceId},sample()),true);
  assert.equal(await f.recorder.command({action:"stop",sequence:22,instanceId:f.recorder.status().instanceId},sample()),false);
  assert.equal((await readdir(f.dir)).length,1);
});

test("changing active chat title rotates to a separate local log without extra folders",async t=>{
  const f=await fixture(t);
  await f.recorder.command({action:"start",sequence:1,instanceId:f.recorder.status().instanceId},sample());
  await f.recorder.observe(sample());
  f.tick(5);
  await f.recorder.observe(sample({title:"Second conversation",titleSource:"active-navigation"}));
  await f.recorder.command({action:"stop",sequence:2,instanceId:f.recorder.status().instanceId},sample());
  const names=await readdir(f.dir);
  assert.equal(names.length,2);
  assert.ok(names.every(name=>name.endsWith(".jsonl")));
  assert.ok(names.some(name=>name.includes("Second-conversation")));
  assert.ok((await Promise.all(names.map(n=>stat(path.join(f.dir,n))))).every(x=>x.isFile()));
});

test("known fields are allowlisted and personal data is withheld",()=>{
  const cleaned=projectRouteObservation(sample({
    title:"billing.user@example.com https://malicious.test/path sk-topsecret1234567890",
    metadata:{rows:[
      {field:"auth_token",source:"assistant.final.metadata.auth_token",type:"string",value:"API-TOKEN-SECRET"},
      {field:"model_slug",source:"assistant.final.metadata.model_slug",type:"string",value:"gpt-6-thinking"},
      {field:"reasoning_title",source:"assistant.analysis.metadata.reasoning_title",type:"string",value:"MY PRIVATE PROMPT"},
    ]},
    network:{events:[{method:"POST",responseStatus:500,failure:"user emailed private-token",
      chatGeneration:true}]},
  }));
  const text=JSON.stringify(cleaned);
  assert.doesNotMatch(text,/billing\.user|malicious\.test|sk-topsecret|API-TOKEN-SECRET|MY PRIVATE PROMPT|emailed private/);
  assert.match(text,/\[EMAIL\]/);
  assert.match(text,/\[URL\]/);
  assert.match(text,/\[SECRET\]/);
  assert.equal(cleaned.metadata.rows.find(x=>x.field==="model_slug").value,"gpt-6-thinking");
  assert.equal(cleaned.metadata.rows.find(x=>x.field==="auth_token").value,"[REDACTED]");
  assert.equal(cleaned.network.events[0].failure,"NETWORK_FAILURE_REPORTED");
  assert.equal(safeChatTitle("   "),"Untitled chat");
});

test("watcher restart refuses stale Record/Stop commands from a previous instance",async t=>{
  const f=await fixture(t);
  const previous=new RouteRecorder({logDir:f.dir});
  const stale={action:"start",sequence:42,instanceId:previous.status().instanceId};
  assert.equal(await f.recorder.command(stale,sample()),false);
  assert.deepEqual(await readdir(f.dir),[]);
  assert.equal(f.recorder.status().active,false);
});
test("unknown log path fails closed without creating a directory",async t=>{
  const f=await fixture(t);
  const missing=path.join(f.dir,"not-approved-dir");
  const recorder=new RouteRecorder({logDir:missing});
  await recorder.command({action:"start",sequence:1,instanceId:recorder.status().instanceId},sample());
  assert.equal(recorder.status().active,false);
  assert.equal(recorder.status().error,"LOG_DIR_NOT_APPROVED");
  assert.equal((await readdir(f.dir)).length,0);
});

test("bounded log size automatically stops recording with an explicit error",async t=>{
  const f=await fixture(t);
  const limited=new RouteRecorder({logDir:f.dir,maxBytes:230,now:()=>new Date("2026-10-25T14:00:00.000Z")});
  await limited.command({action:"start",sequence:1,instanceId:limited.status().instanceId},sample());
  await limited.observe(sample());
  assert.equal(limited.status().active,false);
  assert.equal(limited.status().error,"LOG_SIZE_LIMIT");
});

test("overlay advertises stateful recording and differentiates UI intent from server evidence",()=>{
  const expression=buildRouteOverlayExpression(new RouteCollector().snapshot());
  assert.doesNotThrow(()=>new Function(expression));
  assert.match(expression,/data-route-record/);
  assert.match(expression,/__sparkRouteRecordingCommand/);
  assert.match(expression,/MESSAGE_DELIVERY_TIMEOUT/);
  assert.match(expression,/data-route-overview/);
  assert.match(expression,/data-route-advanced/);
  assert.match(expression,/recordingObservation/);
  assert.match(expression,/송신 의도/);
  assert.match(expression,/서버 메시지/);
  assert.match(expression,/실제 전송 패킷 아님/);
});
