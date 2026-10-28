import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  buildEarlyExpression,
  buildEarlyDisableExpression,
} from "../src/early.mjs";

const PREFIX = "항상 존댓말 사용, 반말 답변 절대 불허\n먼저 SPARK으로 작업하고, 도저히 안될 경우에만 Work 전환 문의";

function fixture({ readyState = "loading" } = {}) {
  const delivered = [];
  const composer = { textContent: "사용자 원문" };
  let fetchVersion = 1;
  const nativeFetch = async (input, init) => {
    delivered.push({ fetchVersion, input, init });
    return { ok: true, status: 200 };
  };
  class FakeRequest {
    constructor(input, init = {}) {
      if (input instanceof FakeRequest) {
        this.url = input.url;
        this.method = init.method ?? input.method;
        this.body = init.body ?? input.body;
      } else {
        this.url = String(input);
        this.method = init.method ?? "GET";
        this.body = init.body ?? null;
      }
    }
    clone() {
      const self = this;
      return { text: async () => String(self.body ?? "") };
    }
  }
  const context = {
    console,
    URL,
    Promise,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Error,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    Request: FakeRequest,
    location: { protocol:"app:", href:"app://-/index.html" },
    document: { readyState },
    fetch: nativeFetch,
    __composer: composer,
  };
  context.globalThis = context;
  return {
    context, delivered, composer,
    setFetchVersion(value) { fetchVersion = value; },
    install(options={generation:1}) {
      return vm.runInNewContext(buildEarlyExpression(PREFIX, options), context);
    },
  };
}

function body(text, extras = {}) {
  return JSON.stringify({
    action:"next",
    messages:[{
      id:"u1",
      author:{role:"user"},
      content:{content_type:"text",parts:[text]},
      ...extras,
    }],
  });
}

test("document-start fetch injects only outbound JSON and leaves visible composer untouched", async () => {
  const f=fixture();
  const original=f.composer.textContent;
  assert.equal(f.install(),"SPARK_CII_EARLY_READY");
  const requestBody=body("원문");
  await f.context.fetch("https://chatgpt.com/backend-api/f/conversation",
    {method:"POST",body:requestBody});
  assert.equal(f.composer.textContent,original);
  assert.equal(f.delivered.length,1);
  const sent=JSON.parse(f.delivered[0].init.body);
  assert.equal(sent.messages[0].content.parts[0],PREFIX+"\n\n원문");
  const state=f.context.__sparkCiiEarly.getState();
  assert.equal(state.phase,"DOCUMENT_START");
  assert.equal(state.forwarded,1);
  assert.equal(state.verifiedRewrite,true);
  assert.equal(state.lastChannel,"FETCH");
  assert.equal(f.context.__sparkCiiEarly.getLastOutboundText().text,
    PREFIX+"\n\n원문");
});

test("conversation endpoint aliases are supported and prefix is idempotent", async () => {
  const f=fixture();f.install();
  for(const endpoint of ["/backend-api/conversation","/backend-api/f/conversation"]){
    await f.context.fetch("https://chatgpt.com"+endpoint,{method:"POST",
      body:body(PREFIX+"\n\n반복")});
  }
  assert.equal(f.delivered.length,2);
  for(const x of f.delivered) {
    const text=JSON.parse(x.init.body).messages[0].content.parts[0];
    assert.equal(text,PREFIX+"\n\n반복");
    assert.equal(text.split(PREFIX).length-1,1);
  }
});

test("application replacing window.fetch cannot bypass document-start getter", async () => {
  const f=fixture();f.install();
  f.setFetchVersion(2);
  f.context.fetch=async (input,init)=>{
    f.delivered.push({fetchVersion:2,input,init});return {ok:true};
  };
  await f.context.fetch("https://chatgpt.com/backend-api/f/conversation",
    {method:"POST",body:body("setter")});
  assert.equal(f.delivered.at(-1).fetchVersion,2);
  assert.equal(JSON.parse(f.delivered.at(-1).init.body)
    .messages[0].content.parts[0],PREFIX+"\n\nsetter");
  assert.equal(f.context.__sparkCiiEarly.getState().fetchHookReady,true);
});

test("Windows ArrayBuffer conversation body is rewritten before fetch", async () => {
  const f=fixture();f.install();
  const encoded=new TextEncoder().encode(body("윈도우 바이트 본문"));
  const buffer=encoded.buffer.slice(encoded.byteOffset,encoded.byteOffset+encoded.byteLength);
  await f.context.fetch("https://chatgpt.com/backend-api/f/conversation",
    {method:"POST",body:buffer});
  assert.equal(f.delivered.length,1);
  assert.equal(f.delivered[0].init.body instanceof ArrayBuffer,true);
  const sent=JSON.parse(new TextDecoder().decode(
    new Uint8Array(f.delivered[0].init.body)));
  assert.equal(sent.messages[0].content.parts[0],
    PREFIX+"\n\n윈도우 바이트 본문");
  assert.equal(f.context.__sparkCiiEarly.getState().verifiedRewrite,true);
});

test("non-conversation and foreign requests pass through unchanged", async () => {
  const f=fixture();f.install();
  const raw=body("원문");
  await f.context.fetch("https://chatgpt.com/backend-api/me",
    {method:"POST",body:raw});
  await f.context.fetch("https://evil.example/backend-api/f/conversation",
    {method:"POST",body:raw});
  assert.deepEqual(f.delivered.map(x=>x.init.body),[raw,raw]);
  assert.equal(f.context.__sparkCiiEarly.getState().forwarded,0);
});

test("recognized conversation with unreadable body fails closed", async () => {
  const f=fixture();f.install();
  await assert.rejects(
    f.context.fetch("https://chatgpt.com/backend-api/f/conversation",
      {method:"POST",body:{not:"string"}}),
    /SPARK_CII_BLOCKED_UNSUPPORTED_FETCH_BODY/);
  assert.equal(f.delivered.length,0);
  assert.equal(f.context.__sparkCiiEarly.getState().blocked,1);
});

test("last user message text object is rewritten while attachments remain intact", async () => {
  const f=fixture();f.install();
  const payload={
    messages:[
      {author:{role:"user"},content:{parts:["old"]}},
      {author:{role:"assistant"},content:{parts:["answer"]}},
      {author:{role:"user"},content:{parts:[
        {type:"input_text",text:"new"},
        {type:"image",url:"file://fixture"},
      ]}},
    ],
  };
  await f.context.fetch("https://chatgpt.com/backend-api/f/conversation",
    {method:"POST",body:JSON.stringify(payload)});
  const sent=JSON.parse(f.delivered[0].init.body);
  assert.equal(sent.messages[0].content.parts[0],"old");
  assert.equal(sent.messages[2].content.parts[0].text,PREFIX+"\n\nnew");
  assert.deepEqual(sent.messages[2].content.parts[1],
    {type:"image",url:"file://fixture"});
});

test("first-party HTTP bridge assigned after document-start receives rewritten bytes", async () => {
  const f=fixture();f.install();
  const calls=[];
  f.context.__valdiDeviceIntegrity={
    request(id,request){calls.push({kind:"request",id,request});return Promise.resolve({});},
    stream(id,request,callbacks){calls.push({kind:"stream",id,request,callbacks});return Promise.resolve({});},
    cancel(){return Promise.resolve();},
  };
  const bytes=new TextEncoder().encode(body("bridge"));
  await f.context.__valdiDeviceIntegrity.request("r1",{
    method:"POST",url:"https://chatgpt.com/backend-api/f/conversation",
    headerNames:[],headerValues:[],body:bytes,
  });
  assert.equal(calls.length,1);
  const sent=JSON.parse(new TextDecoder().decode(calls[0].request.body));
  assert.equal(sent.messages[0].content.parts[0],PREFIX+"\n\nbridge");
  const state=f.context.__sparkCiiEarly.getState();
  assert.equal(state.bridgeHookReady,true);
  assert.equal(state.lastChannel,"OWL_REQUEST");
});

test("late install is explicitly not document-start", () => {
  const f=fixture({readyState:"complete"});
  f.install();
  assert.equal(f.context.__sparkCiiEarly.getState().phase,"LATE");
});

test("disable restores latest application fetch and removes active injector", async () => {
  const f=fixture();f.install();
  const replacement=async (input,init)=>{
    f.delivered.push({fetchVersion:9,input,init});return {ok:true};
  };
  f.context.fetch=replacement;
  assert.equal(vm.runInNewContext(buildEarlyDisableExpression(),f.context),
    "SPARK_CII_EARLY_DISABLED");
  assert.equal(f.context.__sparkCiiEarly,undefined);
  assert.equal(f.context.fetch,replacement);
});

test("newer generation wins over stale document-start scripts", () => {
  const f=fixture();
  assert.equal(f.install({generation:10}),"SPARK_CII_EARLY_READY");
  const other="새 지침";
  const result=vm.runInNewContext(buildEarlyExpression(other,{generation:9}),f.context);
  assert.equal(result,"SPARK_CII_EARLY_STALE");
  assert.equal(f.context.__sparkCiiEarly.getState().generation,10);
});
