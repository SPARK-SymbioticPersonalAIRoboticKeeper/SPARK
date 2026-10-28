import test from "node:test";
import assert from "node:assert/strict";
import {
  extractChatUserText, isChatRequestDestination, RouteFlowObserver,
} from "../src/route-flow.mjs";

const host = "https://chatgpt.com/backend-api/conversation";

test("only recognized authenticated chat endpoint classes can enter flow", () => {
  assert.equal(isChatRequestDestination(host, "POST"), true);
  assert.equal(isChatRequestDestination("https://chatgpt.com/backend-api/f/conversation", "POST"), true);
  assert.equal(isChatRequestDestination("wss://chatgpt.com/backend-api/responses", "WS"), true);
  assert.equal(isChatRequestDestination("https://chatgpt.com/backend-api/usage", "POST"), false);
  assert.equal(isChatRequestDestination("https://example.net/backend-api/conversation", "POST"), false);
  assert.equal(isChatRequestDestination("http://chatgpt.com/backend-api/conversation", "POST"), false);
  assert.equal(isChatRequestDestination(host, "GET"), false);
});

test("preserves exact user text and paragraph spacing from known API envelope", () => {
  const text = "항상 존댓말을 사용해 주세요.\n\n두 번째 문단";
  const body = JSON.stringify({ messages: [{
    author: {role:"user"}, content: {parts:[text]}
  }], authorization:"SECRET_NEVER_CAPTURE", cookie:"not for trace" });
  const result = extractChatUserText(body);
  assert.deepEqual(result, {text, fullChars:text.length, truncated:false,
    shape:"SINGLE_USER_MESSAGE"});
  assert.equal(JSON.stringify(result).includes("SECRET_NEVER_CAPTURE"), false);
});

test("ignores assistant output, ambiguous history, auth and arbitrary request body", () => {
  for (const input of [
    JSON.stringify({messages:[{role:"assistant",content:"secret"}]}),
    JSON.stringify({messages:[{role:"user",content:"A"},{role:"user",content:"B"}]}),
    JSON.stringify({headers:{authorization:"secret"},credentials:{token:"secret"}}),
    JSON.stringify({input:[{type:"text",text:"secret"}]}),
    JSON.stringify({prompt:"secret"})
  ]) {
    assert.equal(extractChatUserText(input, "WS"), null);
  }
});

test("extracts recognized turn/start JSON-RPC input for WebSocket", () => {
  const body=JSON.stringify({type:"mcp-request",
    request:{method:"turn/start",params:{input:[{type:"text",text:"첫 줄\n다음 줄"}]}}});
  assert.deepEqual(extractChatUserText(body,"WS"),{
    text:"첫 줄\n다음 줄",fullChars:8,truncated:false,shape:"RPC_INPUT"
  });
});

test("request correlation is bounded, de-duplicates CDP postData fallback and labels TLS evidence", () => {
  const c=new RouteFlowObserver({maxEntries:2,clock:()=>"2026-10-27T10:00:00.000Z"});
  const body=JSON.stringify({messages:[{role:"user",content:{parts:["Test 1"]}}]});
  assert.equal(c.request({id:"secret-id",url:host,method:"POST",body}),true);
  assert.equal(c.request({id:"secret-id",url:host,method:"POST",body}),false);
  assert.equal(c.response({id:"secret-id",securityState:"secure",
    protocol:"h2",securityDetails:{protocol:"TLS 1.3"}}),true);
  const state=c.snapshot();
  assert.equal(state.httpObserved,1);
  assert.equal(state.entries[0].tls,"TLS 1.3");
  assert.equal(state.entries[0].protocol,"h2");
  assert.equal(JSON.stringify(state).includes("secret-id"),false);
  assert.equal(JSON.stringify(state).includes("authorization"),false);
});

test("only user-message extracts are stored; snapshot respects capacity", () => {
  const c=new RouteFlowObserver({maxEntries:2});
  for(let n=0;n<4;n++){
    c.request({id:"i"+n,url:host,method:"POST",
      body:JSON.stringify({messages:[{role:"user",content:{parts:["message-"+n]}}]})});
  }
  assert.deepEqual(c.snapshot().entries.map(x=>x.message.text),
    ["message-3","message-2"]);
  assert.equal(c.snapshot().httpObserved,4);
  assert.equal(c.request({id:"leak",url:"https://evil.com/backend-api/conversation",
    method:"POST",body:JSON.stringify({messages:[{role:"user",content:"x"}]})}),false);
});

test("very long user text is explicitly marked truncated, not falsely exact", () => {
  const text="x".repeat(20_050);
  const result=extractChatUserText(JSON.stringify({prompt:text}));
  assert.equal(result.fullChars,20_050);
  assert.equal(result.text.length,20_000);
  assert.equal(result.truncated,true);
});
