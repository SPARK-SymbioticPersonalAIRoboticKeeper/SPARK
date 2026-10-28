import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  locateStartCompletionStream,
  prefixRequestCopy,
  buildCallFrameMutationExpression,
  breakpointStateIsFresh,
} from "../src/breakpoint.mjs";

const PREFIX="항상 존댓말 사용, 반말 답변 절대 불허\n먼저 SPARK으로 작업하고, 도저히 안될 경우에만 Work 전환 문의";

function request(text){
  return {
    action:"next",
    messages:[
      {author:{role:"assistant"},content:{parts:["old answer"]}},
      {author:{role:"user"},content:{content_type:"text",parts:[text]}},
    ],
    model:"auto",
  };
}

test("locator finds minified startCompletionStream body and reports line/column",()=>{
  const src="one\nclass X{async startCompletionStream({additionalHeaders:e,request:E,prepared:T}){let O=1;return E}}\nend";
  const found=locateStartCompletionStream(src);
  assert.equal(src.slice(found.absoluteIndex,found.absoluteIndex+6),"let O=");
  assert.equal(found.lineNumber,1);
  assert.ok(found.columnNumber>0);
});

test("request copy prefixes last user text without mutating original request",()=>{
  const original=request("메세지 다시 쳐봐");
  const before=structuredClone(original);
  const result=prefixRequestCopy(original,PREFIX);
  assert.equal(result.ok,true);
  assert.deepEqual(original,before);
  assert.equal(result.request.messages.at(-1).content.parts[0],
    PREFIX+"\n\n메세지 다시 쳐봐");
  assert.equal(result.request.messages[0].content.parts[0],"old answer");
});

test("request copy preserves attachments and is idempotent",()=>{
  const r=request("본문");
  r.messages.at(-1).content.parts=[
    {type:"input_text",text:"본문"},
    {type:"image",url:"fixture://image"},
  ];
  const first=prefixRequestCopy(r,PREFIX);
  const second=prefixRequestCopy(first.request,PREFIX);
  assert.equal(first.ok,true);
  assert.equal(second.ok,true);
  assert.equal(second.request.messages.at(-1).content.parts[0].text,
    PREFIX+"\n\n본문");
  assert.deepEqual(second.request.messages.at(-1).content.parts[1],
    {type:"image",url:"fixture://image"});
  assert.equal(second.request.messages.at(-1).content.parts[0].text.split(PREFIX).length-1,1);
});

test("call-frame expression replaces E copy and invalidates prepared caches",()=>{
  const context={globalThis:null,Date};
  context.globalThis=context;
  const input=request("원문");
  context.run=(E,T,o)=>{
    const expression=buildCallFrameMutationExpression(PREFIX);
    const fn=vm.runInNewContext("(function(E,T,o){const result=eval("+JSON.stringify(expression)+");return {E,T,o,result,state:globalThis.__sparkCiiBreakpointState,last:globalThis.__sparkCiiBreakpointLastOutbound}})",context);
    return fn(E,T,o);
  };
  const prepared={cached:true},inFlight={cached:true};
  const output=context.run(input,prepared,inFlight);
  assert.equal(output.result.verified,true);
  assert.equal(output.T,undefined);
  assert.equal(output.o,undefined);
  assert.notEqual(output.E,input);
  assert.deepEqual(input,request("원문"),"original request must remain unchanged");
  assert.equal(output.E.messages.at(-1).content.parts[0],PREFIX+"\n\n원문");
  assert.equal(output.state.status,"PREFIX_VERIFIED_BEFORE_TRANSPORT");
  assert.equal(output.last.prefixVerified,true);
  assert.equal(output.last.mergedChars,(PREFIX+"\n\n원문").length);
  assert.equal(JSON.stringify(output.last).includes("원문"),false);
  assert.equal(JSON.stringify(output.last).includes(PREFIX),false);
});

test("call-frame expression passes through requests with no user messages",()=>{
  const context={globalThis:null,Date};context.globalThis=context;
  const expression=buildCallFrameMutationExpression(PREFIX);
  const fn=vm.runInNewContext("(function(E,T,o){const result=eval("+JSON.stringify(expression)+");return {E,T,o,result}})",context);
  const req={messages:[{author:{role:"assistant"},content:{parts:["a"]}}]};
  const prepared={cached:true};
  const out=fn(req,prepared,prepared);
  assert.equal(out.result.passthrough,true);
  assert.equal(out.E,req);
  assert.equal(out.T,prepared);
});

test("call-frame expression poisons malformed user request instead of sending unprefixed",()=>{
  const context={globalThis:null,Date};context.globalThis=context;
  const expression=buildCallFrameMutationExpression(PREFIX);
  const fn=vm.runInNewContext("(function(E,T,o){const result=eval("+JSON.stringify(expression)+");return {E,T,o,result,state:globalThis.__sparkCiiBreakpointState}})",context);
  const out=fn({messages:[{author:{role:"user"},content:{parts:[]}}]},
    {cached:true},{cached:true});
  assert.equal(out.result.blocked,true);
  assert.equal(out.T,undefined);
  assert.equal(out.o,undefined);
  assert.equal(out.state.verifiedRewrite,false);
  assert.throws(()=>({...out.E}),/SPARK_CII_BLOCKED_NO_TEXT_PART/);
});

test("fresh breakpoint state expires when watcher heartbeat stops",()=>{
  const now=Date.now();
  assert.equal(breakpointStateIsFresh({
    implementation:"0.0.2-dispatch-breakpoint",installed:true,heartbeatAt:now-100,
  },now),true);
  assert.equal(breakpointStateIsFresh({
    implementation:"0.0.2-dispatch-breakpoint",installed:true,heartbeatAt:now-5000,
  },now),false);
});
