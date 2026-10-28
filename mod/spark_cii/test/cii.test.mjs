import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadPrefix, normalizePrefix, DEFAULT_CONFIG_PATH } from "../src/config.mjs";
import { buildGuardExpression, buildDisableExpression, buildStatusExpression, buildTraceExpression, buildTraceAckExpression } from "../src/guard.mjs";
import { parseArgs, isCiiTarget, executeOnce, evaluateCiiReadiness } from "../src/cli.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(DIR, "../config/config_cii.example.txt");
const PREFIX = "항상 존댓말을 사용하고 반말 절대 금지\n먼저 SPARK으로 작업하고 도저히 안될 경우에만 Work 전환 문의";

function createFixture({ url = "app://-/index.html", hiddenClone = false, multipleVisible = false, prosemirror = false, noVisibleEditor = false } = {}) {
  const listeners = new Map();
  const sent = [];
  const locationUrl = new URL(url);
  const getListeners = (name) => listeners.get(name) ?? [];
  const listen = (name, cb) => listeners.set(name, [...getListeners(name), cb]);
  const remove = (name, cb) => listeners.set(name, getListeners(name).filter((f) => f !== cb));
  const event = (target, details = {}) => ({
    target, defaultPrevented: false,
    key: undefined, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    isComposing: false, keyCode: 0,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() {},
    ...details
  });

  class Node {
    constructor(tagName) {
      this.tagName = tagName; this.isConnected = true; this.childElementCount = 0;
      this.attributes = {}; this.disabled = false; this.isContentEditable = false;
      const classes = new Set();
      this.classList = {
        contains: (v) => classes.has(v), add: (v) => classes.add(v),
        remove: (v) => classes.delete(v)
      };
      this.style = { setProperty() {}, removeProperty() {} };
    }
    getBoundingClientRect() { return { width: 350, height: 40 }; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    matches(selector) {
      if (selector === "form") return this.tagName === "FORM";
      if (selector === "button") return this.tagName === "BUTTON";
      if (selector.includes("send-button") || selector.includes("Send") ||
          selector.includes("button[type=")) return this.tagName === "BUTTON" && this.knownSend;
      return false;
    }
    closest(selector) {
      if (selector === "form") return this.tagName === "FORM" ? this : this.form ?? null;
      if (selector === "button") return this.tagName === "BUTTON" ? this : null;
      if (selector.includes("user") || selector.includes("assistant") ||
          selector.includes("[data-auth]") || selector.includes("otp-login")) return null;
      return null;
    }
    contains(node) { return node === this || node?.form === this; }
    querySelector(selector) {
      if (selector.includes("one-time-code")) return null;
      if (selector.includes("img,figure")) return null;
      return null;
    }
    querySelectorAll() { return []; }
    focus() {}
    dispatchEvent() {}
  }
  class Textarea extends Node {
    constructor() { super("TEXTAREA"); this._value = ""; }
    get value() { return this._value; }
    set value(text) { this._value = text; }
  }
  const form = new Node("FORM");
  const editor = prosemirror ? new Node("DIV") : new Textarea();
  editor.form = form;
  if (noVisibleEditor) editor.getBoundingClientRect = () => ({ width: 0, height: 0 });
  if (prosemirror) { editor.isContentEditable = true; editor.classList.add("ProseMirror"); editor.children = []; }
  const hiddenEditor = hiddenClone ? new Textarea() : null;
  if (hiddenEditor) {
    hiddenEditor.form = form;
    hiddenEditor.getBoundingClientRect = () => ({ width: 0, height: 0 });
  }
  const secondEditor = multipleVisible ? new Textarea() : null;
  if (secondEditor) secondEditor.form = form;
  const send = new Node("BUTTON");
  send.form = form;
  send.knownSend = true;
  form.querySelectorAll = () => [send];
  form.contains = (node) => node === editor || node === send;
  const beforeSend = [];
  const sentFrames = [];
  class FakeWebSocket {
    constructor(url = "ws://127.0.0.1:4500") { this.url = url; }
    send(frame) {
      sentFrames.push(frame);
      const message = JSON.parse(frame);
      if (message.method === "turn/start") sent.push(message.params.input[0].text);
    }
  }
  const nativeSocket = new FakeWebSocket();
  const viewMessages = [];
  const nativeDispatchMessages = [];
  const nativeDispatchFixture = {
    handlers: new Map(), bufferedMessages: [], handledBufferedMessages: [],
    dispatchMessage(type, payload, marker) { nativeDispatchMessages.push({type, payload, marker}); }
  };
  const fixtureHost = {
    postMessage(message) { viewMessages.push(message); },
    getState() { return null; },
    setState() {}
  };
  const win = {
    __sparkCiiFixtureHost: fixtureHost,
    __sparkCiiFixtureDispatch: nativeDispatchFixture,
    __sparkCiiGuard: undefined,
    WebSocket: FakeWebSocket,
    addEventListener: listen,
    removeEventListener: remove,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} })
  };
  function nativeSend() {
    const value = prosemirror ? editor.children.map((p) => p.innerText).join("\n") : editor.value;
    beforeSend.push({
      text: value,
      paragraphCount: prosemirror ? editor.children.length : null
    });
    nativeSocket.send(JSON.stringify({
      method: "turn/start", id: sentFrames.length + 1,
      params: { input: [{ type: "text", text: value }] }
    }));
    if (prosemirror) editor.children = [];
    else editor.value = "";
  }
  const fire = (name, ev) => {
    for (const cb of [...getListeners(name)]) cb(ev);
    if (name === "click" && ev.target === send && !ev.defaultPrevented) {
      nativeSend();
    } else if (name === "keydown" && ev.key === "Enter" && !ev.shiftKey &&
               !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.defaultPrevented) {
      fire("click", event(send));
    } else if (name === "submit" && ev.target === form && !ev.defaultPrevented) {
      nativeSend();
    }
  };
  send.click = () => fire("click", event(send));
  const doc = {
    body: {}, head: { appendChild() {} },
    querySelectorAll(selector) {
      if (selector.includes("#prompt-textarea")) return [
        editor, ...(hiddenEditor ? [hiddenEditor] : []), ...(secondEditor ? [secondEditor] : [])
      ];
      return [];
    },
    querySelector() { return null; },
    getElementById() { return null; },
    createElement() { return new Node("STYLE"); },
    createRange() { return { selectNodeContents() {} }; },
    execCommand() { throw new Error("Cii must not invoke execCommand"); }
  };
  const context = {
    window: win, document: doc, HTMLTextAreaElement: Textarea, URL,
    getComputedStyle: () => ({ display: "block", visibility: "visible",
      fontSize: "16px", lineHeight: "24px", color: "#000" }),
    location: { protocol: locationUrl.protocol, hostname: locationUrl.hostname,
      pathname: locationUrl.pathname, origin: locationUrl.origin,
      href: locationUrl.href },
    Event: class { constructor(name) { this.name = name; } },
    setTimeout: (fn) => { fn(); },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  return { context, editor, sent, send, fire, event, win, beforeSend, sentFrames, nativeSocket, fixtureHost, viewMessages, nativeDispatchFixture, nativeDispatchMessages };
}

test("Cii plain-text config preserves Korean instructions and validates safety", async () => {
  assert.equal(await loadPrefix(SAMPLE), PREFIX);
  assert.equal(normalizePrefix("\uFEFF" + PREFIX.replace(/\n/g, "\r\n") + "\n"), PREFIX);
  assert.throws(() => normalizePrefix("  \n"), /empty/);
  assert.throws(() => normalizePrefix("one\0two"), /NUL/);
  assert.throws(() => normalizePrefix("x".repeat(20000)), /16 KiB/);
  assert.match(DEFAULT_CONFIG_PATH.replaceAll("\\", "/"), /\/\.runtime\/config\/config_cii$/);
});

test("Cii only accepts ChatGPT application/chat pages, not login or unrelated pages", () => {
  const t = (url, type = "page") => ({
    url, type, webSocketDebuggerUrl: "ws://127.0.0.1:9230/devtools/page/abc"
  });
  assert.equal(isCiiTarget(t("app://-/index.html")), true);
  assert.equal(isCiiTarget(t("https://chatgpt.com/c/123")), true);
  assert.equal(isCiiTarget(t("https://chatgpt.com/auth/login")), false);
  assert.equal(isCiiTarget(t("https://chatgpt.com/settings")), false);
  assert.equal(isCiiTarget(t("https://other.example")), false);
  assert.equal(isCiiTarget(t("app://-/other.html")), false);
  assert.equal(isCiiTarget(t("app://-/index.html", "worker")), false);
});

test("Cii parses safe local configuration with no remote CDP option", () => {
  const opts = parseArgs(["run", "--port", "9230", "--interval", "350", "--json"]);
  assert.equal(opts.command, "run");
  assert.equal(opts.port, 9230);
  assert.equal(opts.intervalMs, 350);
  assert.equal(opts.json, true);
  assert.throws(() => parseArgs(["run", "--interval", "100"]), /between 250/);
  assert.throws(() => parseArgs(["run", "--host", "remote.example"]), /Unknown Cii option/);
});

test("Cii patches only the outgoing message and prevents duplicate injection", () => {
  const f = createFixture();
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX), f.context), "SPARK_CII_READY");
  f.editor.value = "원본 요청";
  f.fire("click", f.event(f.send));
  assert.deepEqual(f.sent, [PREFIX + "\n\n원본 요청"]);
  assert.equal(f.win.__sparkCiiGuard.getState().forwarded, 1);
  f.editor.value = PREFIX + "\n\n이미 주입됨";
  f.fire("click", f.event(f.send));
  assert.equal(f.sent[1], PREFIX + "\n\n이미 주입됨");
  assert.equal(f.win.__sparkCiiGuard.getState().forwarded, 2);
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX), f.context), "SPARK_CII_ALREADY");
  assert.equal(f.win.__sparkCiiGuard.getState().forwarded, 2);
});

test("Cii injects through Enter and preserves multiline original content", () => {
  const f = createFixture({ hiddenClone: true });
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX), f.context), "SPARK_CII_READY");
  f.editor.value = "1행\n2행";
  f.fire("keydown", f.event(f.editor, { key: "Enter" }));
  assert.deepEqual(f.sent, [PREFIX + "\n\n1행\n2행"]);
  f.editor.value = "Shift+Enter";
  f.fire("keydown", f.event(f.editor, { key: "Enter", shiftKey: true }));
  assert.equal(f.sent.length, 1);
  assert.equal(f.editor.value, "Shift+Enter");
});

test("Cii leaves multiple visible editors unchanged; native transport handles actual send", () => {
  const f = createFixture({ multipleVisible: true });
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX), f.context), "SPARK_CII_READY");
  f.editor.value = "검증되지 않은 편집기";
  const click = f.event(f.send);
  f.fire("click", click);
  assert.equal(click.defaultPrevented, false);
  assert.deepEqual(f.beforeSend, [{ text: "검증되지 않은 편집기", paragraphCount: null }]);
  assert.deepEqual(f.sent, [PREFIX + "\n\n검증되지 않은 편집기"]);
  assert.equal(f.win.__sparkCiiGuard.getState().editorReady, false);
  assert.equal(f.win.__sparkCiiGuard.getState().blocked, 0);
});

test("Cii rejects login origin and never intercepts an unrecognized login send", () => {
  const login = createFixture({ url: "https://chatgpt.com/auth/login" });
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX), login.context),
    "SPARK_CII_ORIGIN_REJECTED");
  assert.equal(login.win.__sparkCiiGuard, undefined);
});

test("Cii disabling removes listeners, and status excludes instruction contents", () => {
  const f = createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX), f.context);
  const status = vm.runInNewContext(buildStatusExpression(), f.context);
  assert.equal(status.enabled, true);
  assert.equal(JSON.stringify(status).includes(PREFIX), false);
  assert.equal(vm.runInNewContext(buildDisableExpression(), f.context), "SPARK_CII_DISABLED");
  f.editor.value = "원본 그대로";
  f.fire("click", f.event(f.send));
  assert.deepEqual(f.sent, ["원본 그대로"]);
  assert.equal(vm.runInNewContext(buildStatusExpression(), f.context), null);
});

test("Cii preserves signed-in ProseMirror paragraph boundaries on send", () => {
  const f = createFixture({ prosemirror: true, hiddenClone: true });
  f.editor.children = [
    { tagName: "P", innerText: "첫 번째 행" },
    { tagName: "P", innerText: "" },
    { tagName: "P", innerText: "마지막 행" }
  ];
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX), f.context), "SPARK_CII_READY");
  f.fire("click", f.event(f.send));
  assert.deepEqual(f.sent, [PREFIX + "\n\n첫 번째 행\n\n마지막 행"]);
  assert.equal(f.win.__sparkCiiGuard.getState().forwarded, 1);
});

test("Cii records transport patch, not DOM replay, without storing prompt contents", () => {
  const f=createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  f.editor.value="개인 메시지 원문 - 감사 로그 제외";
  f.fire("click",f.event(f.send));
  const trace=vm.runInNewContext(buildTraceExpression(),f.context);
  assert.deepEqual(Array.from(trace.events,x=>x.event),[
    "MESSAGE_INTERCEPTED","PREFIX_VERIFIED"
  ]);
  assert.equal(trace.events[1].reason,"EGRESS_PATCHED");
  assert.ok(trace.events.every(x=>x.attemptId===1));
  assert.equal(JSON.stringify(trace).includes(PREFIX),false);
  assert.equal(JSON.stringify(trace).includes("개인 메시지 원문"),false);
  assert.equal(vm.runInNewContext(buildTraceAckExpression(trace.events.at(-1).seq),f.context),true);
  assert.equal(vm.runInNewContext(buildStatusExpression(),f.context).tracePending,0);
});

test("Cii never blocks user typing/paste even when editor recognition is temporarily missing", () => {
  const f=createFixture({noVisibleEditor:true});
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  f.editor.value="원본 그대로\n두번째 줄";
  const original=f.editor.value;
  f.fire("paste",f.event(f.editor));
  assert.equal(f.editor.value,original);
  const click=f.event(f.send);
  f.fire("click",click);
  assert.equal(click.defaultPrevented,false);
  assert.deepEqual(f.beforeSend,[{text:original,paragraphCount:null}]);
  assert.deepEqual(f.sent,[PREFIX+"\n\n"+original]);
  assert.equal(f.win.__sparkCiiGuard.getState().blocked,0);
});

test("Cii does not add blank paragraphs or reveal prefix in ProseMirror before native send", () => {
  const f = createFixture({prosemirror:true});
  f.editor.children = [
    { tagName:"P",innerText:"항상 존댓말을 사용하고 반말 절대 금지" },
    { tagName:"P",innerText:"먼저 SPARK으로 작업하고 도저히 안될 경우에만 Work 전환 문의" }
  ];
  const before = structuredClone(f.editor.children);
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  f.fire("paste",f.event(f.editor));
  assert.deepEqual(f.editor.children,before);
  const click=f.event(f.send);
  f.fire("click",click);
  assert.equal(click.defaultPrevented,false);
  assert.deepEqual(f.beforeSend,[{text:before.map(x=>x.innerText).join("\n"),paragraphCount:2}]);
  assert.deepEqual(f.sent,[PREFIX+"\n\n"+before.map(x=>x.innerText).join("\n")]);
  assert.equal(f.sent[0].split("\n\n").length,2,"only one separator is added");
});


test("Cii patches MessagePort JSON-RPC payload without mutating its argument", () => {
  const f=createFixture();
  const sent=[];
  class Port { postMessage(data, options) { sent.push({data, options}); } }
  f.win.MessagePort=Port;
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  const payload={method:"turn/steer",params:{threadId:"t",input:[{type:"text",text:"기존 명령"}]}};
  const options={transfer:[]};
  new Port().postMessage(payload,options);
  assert.equal(payload.params.input[0].text,"기존 명령");
  assert.equal(sent[0].data.params.input[0].text,PREFIX+"\n\n기존 명령");
  assert.equal(sent[0].options,options);
  assert.equal(f.win.__sparkCiiGuard.getState().lastEgressChannel,"MESSAGE_PORT");
});

test("Cii patches only known ChatGPT POST fetch bodies, preserving other traffic", async () => {
  const f=createFixture({url:"https://chatgpt.com/c/example"});
  const requests=[];
  f.win.fetch=async (input,init)=>{requests.push({input,init});return {ok:true}};
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  const payload={messages:[{
    author:{role:"user"},
    content:{content_type:"text",parts:["본문 1\n본문 2"]}
  }],model:"test"};
  const raw=JSON.stringify(payload);
  await f.win.fetch("https://chatgpt.com/backend-api/conversation",{
    method:"POST",headers:{"Content-Type":"application/json"},body:raw
  });
  assert.equal(requests.length,1);
  const value=JSON.parse(requests[0].init.body);
  assert.equal(value.messages[0].content.parts[0],PREFIX+"\n\n본문 1\n본문 2");
  assert.equal(value.model,"test");
  assert.equal(raw,JSON.stringify(payload),"request source not changed");
  await f.win.fetch("https://chatgpt.com/backend-api/auth",{
    method:"POST",body:raw
  });
  assert.equal(requests[1].init.body,raw);
  await f.win.fetch("https://evil.example/backend-api/conversation",{
    method:"POST",body:raw
  });
  assert.equal(requests[2].init.body,raw);
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,1);
});

test("Cii never rewrites unrelated WebSocket frames or request attachments", () => {
  const f=createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  const foreign=new f.win.WebSocket("wss://evil.example/ws");
  const frame=JSON.stringify({method:"turn/start",params:{input:[{type:"text",text:"민감한 원문"}]}});
  foreign.send(frame);
  assert.equal(f.sentFrames[0],frame);
  const multipart=JSON.stringify({method:"turn/start",params:{input:[
    {type:"text",text:"첨부 메시지"},{type:"image",url:"file://example"}
  ]}});
  f.nativeSocket.send(multipart);
  assert.equal(f.sentFrames[1],multipart);
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,0);
});

test("Cii updates legacy installed DOM-edit guard to non-mutating transport v4", () => {
  const f=createFixture();
  let disabled=0;
  f.win.__sparkCiiGuard={
    getState(){return {enabled:true,implementation:"DOM_EDIT_V1"}},
    disable(){disabled++;delete f.win.__sparkCiiGuard},
    configure(){throw new Error("Legacy implementation must not be kept")}
  };
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX),f.context),"SPARK_CII_READY");
  assert.equal(disabled,1);
  assert.equal(f.win.__sparkCiiGuard.getState().implementation,"0.0.2");
  f.editor.value="새 메시지";
  f.fire("click",f.event(f.send));
  assert.equal(f.beforeSend[0].text,"새 메시지");
  assert.equal(f.sent[0],PREFIX+"\n\n새 메시지");
});

test("Cii does not claim egress verification before first actual transport patch", () => {
  const f=createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  const s=f.win.__sparkCiiGuard.getState();
  assert.equal(s.implementation,"0.0.2");
  assert.equal(s.outboundPatchObserved,false);
  assert.equal(s.outboundModified,0);
  assert.equal(s.status,"EGRESS_HOOKS_READY_UNVERIFIED");
  assert.equal(JSON.stringify(s).includes(PREFIX),false);
});

test("Cii never invokes a visible-composer rewrite in the guard source", async () => {
  const fs=await import("node:fs/promises");
  const code=await fs.readFile(path.resolve(DIR,"../src/guard.mjs"),"utf8");
  for(const forbidden of [
    "document.execCommand", "element.focus(", "HTMLTextAreaElement.prototype",
    "element.textContent =", "element.innerHTML =", "button.click()"
  ]) assert.equal(code.includes(forbidden),false,forbidden);
});


test("Cii native-view bridge changes only the outbound prompt at the IPC handoff", async () => {
  const f=createFixture();
  const original=f.fixtureHost.postMessage;
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX,{bridgeFixture:true}),f.context),"SPARK_CII_READY");
  await f.win.__sparkCiiGuard.ready;
  const status=f.win.__sparkCiiGuard.getState();
  assert.equal(status.implementation,"0.0.2");
  assert.equal(status.egressHooks.nativeView,true);
  assert.equal(status.nativeViewStatus,"ARMED_UNVERIFIED");
  assert.equal(status.outboundPatchObserved,false);
  f.editor.value="문단1\n문단2";
  const raw=f.editor.value;
  const message={
    type:"start-turn-for-host",hostId:"localhost",threadId:"c1",
    prompt:"문단1\n문단2",messageMetadata:{},
  };
  f.fixtureHost.postMessage(message);
  assert.equal(f.editor.value,raw,"native hook never writes editor");
  assert.equal(f.viewMessages.length,1);
  assert.equal(f.viewMessages[0].prompt,PREFIX+"\n\n문단1\n문단2");
  assert.equal(message.prompt,raw,"source object preserved");
  assert.equal(f.viewMessages[0].threadId,"c1");
  assert.equal(f.win.__sparkCiiGuard.getState().outboundPatchObserved,true);
  assert.equal(f.win.__sparkCiiGuard.getState().lastEgressChannel,"NATIVE_VIEW");
  assert.equal(f.win.__sparkCiiGuard.getState().nativeViewStatus,"MATCHED_OUTBOUND");
  assert.equal(JSON.stringify(f.win.__sparkCiiGuard.getState()).includes(raw),false);
  assert.equal(JSON.stringify(f.win.__sparkCiiGuard.getState()).includes(PREFIX),false);
  assert.equal(vm.runInNewContext(buildDisableExpression(),f.context),"SPARK_CII_DISABLED");
  assert.equal(f.fixtureHost.postMessage,original,"native bridge restored on disable");
});

test("Cii native-view steer payload keeps input shape and avoids duplicated prefix", async () => {
  const f=createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX,{bridgeFixture:true}),f.context);
  await f.win.__sparkCiiGuard.ready;
  const request={type:"steer-turn-for-host",input:[{type:"text",text:"명령 A\n명령 B"}],hostId:"test"};
  f.fixtureHost.postMessage(request);
  assert.equal(f.viewMessages[0].input[0].text,PREFIX+"\n\n명령 A\n명령 B");
  assert.equal(request.input[0].text,"명령 A\n명령 B");
  const same={...request,input:[{type:"text",text:PREFIX+"\n\n기존"}]};
  f.fixtureHost.postMessage(same);
  assert.equal(f.viewMessages[1].input[0].text,PREFIX+"\n\n기존");
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,2);
});

test("Cii native-view leaves attachments and unrelated message types unmodified", async () => {
  const f=createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX,{bridgeFixture:true}),f.context);
  await f.win.__sparkCiiGuard.ready;
  const other={type:"window-focus",prompt:"hello"};
  const attached={type:"start-turn-for-host",prompt:"image",attachments:[{name:"x.png"}]};
  const unknown={type:"start-turn-for-host",prompt:{text:"unknown-form"}};
  for(const x of [other,attached,unknown])f.fixtureHost.postMessage(x);
  assert.equal(f.viewMessages[0],other);
  assert.equal(f.viewMessages[1],attached);
  assert.equal(f.viewMessages[2],unknown);
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,0);
  assert.equal(f.win.__sparkCiiGuard.getState().nativeViewUnrecognized,2);
  assert.equal(f.win.__sparkCiiGuard.getState().nativeViewStatus,"RECOGNIZED_TYPE_UNKNOWN_SHAPE");
});

test("Cii native-view is explicit unavailable unless exactly one known dispatcher exists",async()=>{
  const f=createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  await f.win.__sparkCiiGuard.ready;
  const state=f.win.__sparkCiiGuard.getState();
  assert.equal(state.egressHooks.nativeView,false);
  assert.equal(state.nativeViewStatus,"LEGACY_DISABLED");
  assert.equal(state.egressHooks.nativeDispatch,false);
  assert.equal(state.implementation,"0.0.2");
});


test("CII earlier implementation matches the REAL desktop mcp-request -> request.method=turn/start envelope", async () => {
  const f=createFixture();
  const originalPost=f.fixtureHost.postMessage;
  const install=vm.runInNewContext(buildGuardExpression(PREFIX,{bridgeFixture:true}),f.context);
  assert.equal(install,"SPARK_CII_READY");
  await f.win.__sparkCiiGuard.ready;
  const initial=f.win.__sparkCiiGuard.getState();
  assert.equal(initial.implementation,"0.0.2");
  assert.equal(initial.egressHooks.nativeView,true);
  assert.equal(initial.dryRunVerified,true);
  assert.equal(initial.outboundPatchObserved,false);
  const originalText="첫 줄\n두 번째 줄\n세 번째 줄";
  f.editor.value=originalText;
  const request={
    type:"mcp-request", hostId:"local", priority:"interactive",
    request:{id:"turn-42",method:"turn/start",params:{
      threadId:"thread-42",model:"gpt-test",
      input:[{type:"text",text:originalText}]
    }}
  };
  f.fixtureHost.postMessage(request);
  assert.equal(f.editor.value,originalText,"composer must not change");
  assert.equal(request.request.params.input[0].text,originalText,"source request must not change");
  assert.equal(f.viewMessages[0].request.params.input[0].text,PREFIX+"\n\n"+originalText);
  assert.equal(f.viewMessages[0].request.id,"turn-42");
  assert.equal(f.viewMessages[0].request.method,"turn/start");
  assert.equal(f.viewMessages[0].request.params.model,"gpt-test");
  assert.equal(f.viewMessages[0].request.params.threadId,"thread-42");
  assert.equal(f.viewMessages[0].hostId,"local");
  const after=f.win.__sparkCiiGuard.getState();
  assert.equal(after.outboundPatchObserved,true);
  assert.equal(after.outboundModified,1);
  assert.equal(after.nativeViewStatus,"MATCHED_OUTBOUND");
  assert.equal(after.nativeViewUnrecognized,0);
  assert.equal(after.lastEgressChannel,"NATIVE_VIEW");
  assert.equal(JSON.stringify(after).includes(originalText),false);
  assert.equal(JSON.stringify(after).includes(PREFIX),false);
  assert.equal(vm.runInNewContext(buildDisableExpression(),f.context),"SPARK_CII_DISABLED");
  assert.equal(f.fixtureHost.postMessage,originalPost,"original dispatch must be restored");
});

test("CII earlier implementation covers steer, addUserMessage, and idempotent prefix on desktop", async () => {
  const f=createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX,{bridgeFixture:true}),f.context);
  await f.win.__sparkCiiGuard.ready;
  for(const method of ["turn/steer","turn/addUserMessage"]){
    const original={type:"mcp-request",request:{
      id:method,method,params:{threadId:"t",input:[{type:"text",text:"후속 메시지"}]}
    }};
    f.fixtureHost.postMessage(original);
    assert.equal(original.request.params.input[0].text,"후속 메시지");
  }
  assert.equal(f.viewMessages[0].request.params.input[0].text,PREFIX+"\n\n후속 메시지");
  assert.equal(f.viewMessages[1].request.params.input[0].text,PREFIX+"\n\n후속 메시지");
  const prefixed={type:"mcp-request",request:{id:"already",method:"turn/start",
    params:{input:[{type:"text",text:PREFIX+"\n\n이미 포함된 요청"}]}}};
  f.fixtureHost.postMessage(prefixed);
  assert.equal(f.viewMessages[2].request.params.input[0].text,PREFIX+"\n\n이미 포함된 요청");
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,3);
});

test("CII earlier implementation covers queued user submissions and updates with preserved message data", async () => {
  const f=createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX,{bridgeFixture:true}),f.context);
  await f.win.__sparkCiiGuard.ready;
  for(const method of ["thread/queue/add","thread/queue/update"]){
    const message={type:"mcp-request",request:{
      id:method,method,params:{
        threadId:"queued",queuedSubmissionId:"q-1",
        input:[{type:"text",text:"대기열 메시지\n두 번째 줄"}]
      }
    }};
    f.fixtureHost.postMessage(message);
    assert.equal(message.request.params.input[0].text,"대기열 메시지\n두 번째 줄");
  }
  assert.equal(f.viewMessages.length,2);
  for(const result of f.viewMessages){
    assert.equal(result.request.params.input[0].text,PREFIX+"\n\n대기열 메시지\n두 번째 줄");
    assert.equal(result.request.params.queuedSubmissionId,"q-1");
    assert.equal(result.request.params.threadId,"queued");
  }
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,2);
});

test("CII earlier implementation fails closed for non-chat IPC and unknown user-message shapes", async () => {
  const f=createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX,{bridgeFixture:true}),f.context);
  await f.win.__sparkCiiGuard.ready;
  const other={type:"mcp-request",request:{method:"config/read",params:{prompt:"unchanged"}}};
  const unsupported={type:"mcp-request",request:{method:"turn/start",params:{input:[{type:"image",url:"img"}]}}};
  const noInput={type:"mcp-request",request:{method:"turn/start",params:{input:[]}}};
  const unrelated={type:"window-focus",request:{method:"turn/start",params:{input:[{type:"text",text:"nope"}]}}};
  for(const req of [other,unsupported,noInput,unrelated])f.fixtureHost.postMessage(req);
  for(let i=0;i<4;i++)assert.equal(f.viewMessages[i],[other,unsupported,noInput,unrelated][i]);
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,0);
  assert.equal(f.win.__sparkCiiGuard.getState().nativeViewUnrecognized,2);
  assert.equal(f.win.__sparkCiiGuard.getState().nativeViewStatus,"RECOGNIZED_TYPE_UNKNOWN_SHAPE");
});

test("CII earlier implementation independently injects in TWO different desktop chat windows, not in detached utility window", async () => {
  const pages=[createFixture(),createFixture()];
  for(const page of pages){
    vm.runInNewContext(buildGuardExpression(PREFIX,{bridgeFixture:true}),page.context);
    await page.win.__sparkCiiGuard.ready;
    assert.equal(page.win.__sparkCiiGuard.getState().dryRunVerified,true);
    page.fixtureHost.postMessage({type:"mcp-request",request:{
      method:"turn/start",params:{input:[{type:"text",text:"창별 테스트"}]}
    }});
    assert.equal(page.viewMessages.length,1);
    assert.equal(page.viewMessages[0].request.params.input[0].text,PREFIX+"\n\n창별 테스트");
    assert.equal(page.win.__sparkCiiGuard.getState().outboundPatchObserved,true);
  }
  const webTarget=(url)=>({type:"page",url,webSocketDebuggerUrl:"ws://127.0.0.1:7994/devtools/page/test"});
  assert.equal(isCiiTarget(webTarget("app://-/index.html")),true);
  assert.equal(isCiiTarget(webTarget("app://-/detached-window.html")),false);
  assert.equal(pages[0].win.__sparkCiiGuard.getState().outboundModified,1);
  assert.equal(pages[1].win.__sparkCiiGuard.getState().outboundModified,1);
});

test("CII 0.0.2 wraps the real two-argument native dispatchMessage API, not the unused postMessage store",async()=>{
  const f=createFixture();
  const nativeOriginal=f.nativeDispatchFixture.dispatchMessage;
  const oldViewOriginal=f.fixtureHost.postMessage;
  f.editor.value="줄1\n줄2";
  const source={id:42,method:"turn/start",params:{threadId:"t",input:[{type:"text",text:"줄1\n줄2",text_elements:[]}]}};
  const payload={request:source,hostId:"host-1",priority:"critical"};
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX,{nativeDispatchFixture:true}),f.context),"SPARK_CII_READY");
  await f.win.__sparkCiiGuard.ready;
  const ready=f.win.__sparkCiiGuard.getState();
  assert.equal(ready.implementation,"0.0.2");
  assert.equal(ready.transportRevision,"native-dispatch-v1");
  assert.equal(ready.egressHooks.nativeDispatch,true);
  assert.equal(ready.egressHooks.nativeView,false);
  assert.equal(ready.nativeDispatchStatus,"ARMED_UNVERIFIED");
  assert.equal(ready.dryRunVerified,true);
  f.nativeDispatchFixture.dispatchMessage("mcp-request",payload,"extra");
  assert.equal(f.nativeDispatchMessages.length,1);
  assert.equal(f.nativeDispatchMessages[0].type,"mcp-request");
  assert.equal(f.nativeDispatchMessages[0].payload.request.params.input[0].text,PREFIX+"\n\n줄1\n줄2");
  assert.equal(f.nativeDispatchMessages[0].payload.request.params.threadId,"t");
  assert.equal(f.nativeDispatchMessages[0].payload.hostId,"host-1");
  assert.equal(f.nativeDispatchMessages[0].marker,"extra");
  assert.equal(source.params.input[0].text,"줄1\n줄2","original app-server request remains unchanged");
  assert.equal(f.editor.value,"줄1\n줄2","no visible composer rewrite");
  assert.equal(f.fixtureHost.postMessage,oldViewOriginal,"legacy postMessage store untouched");
  const live=f.win.__sparkCiiGuard.getState();
  assert.equal(live.lastEgressChannel,"NATIVE_DISPATCH");
  assert.equal(live.outboundModified,1);
  assert.equal(live.outboundPatchObserved,true);
  assert.equal(live.nativeDispatchStatus,"MATCHED_OUTBOUND");
  assert.equal(JSON.stringify(live).includes("줄1"),false);
  assert.equal(JSON.stringify(live).includes(PREFIX),false);
  assert.equal(vm.runInNewContext(buildDisableExpression(),f.context),"SPARK_CII_DISABLED");
  assert.equal(f.nativeDispatchFixture.dispatchMessage,nativeOriginal,"restores actual dispatcher on disable");
});

test("CII 0.0.2 restores transport on upgrade from the erroneous v4 guard",async()=>{
  const f=createFixture();
  let disabled=0;
  f.win.__sparkCiiGuard={
    getState(){return {enabled:true,implementation:"EGRESS_ONLY_V4"}},
    configure(){throw Error("old guard must not be reused")},
    disable(){disabled++;delete f.win.__sparkCiiGuard}
  };
  vm.runInNewContext(buildGuardExpression(PREFIX,{nativeDispatchFixture:true}),f.context);
  await f.win.__sparkCiiGuard.ready;
  assert.equal(disabled,1);
  assert.equal(f.win.__sparkCiiGuard.getState().implementation,"0.0.2");
  assert.equal(f.win.__sparkCiiGuard.getState().egressHooks.nativeDispatch,true);
  f.nativeDispatchFixture.dispatchMessage("mcp-request",{request:{
    method:"turn/start",params:{input:[{type:"text",text:"test"}]}
  }});
  assert.equal(f.nativeDispatchMessages[0].payload.request.params.input[0].text,PREFIX+"\n\ntest");
});

test("CII 0.0.2 does not alter unrelated dispatcher events, mixed input or rich attachments",async()=>{
  const f=createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX,{nativeDispatchFixture:true}),f.context);
  await f.win.__sparkCiiGuard.ready;
  const requests=[
    ["window-focus",{request:{method:"turn/start",params:{input:[{type:"text",text:"unrelated"}]}}}],
    ["mcp-request",{request:{method:"config/read",params:{input:[{type:"text",text:"config"}]}}}],
    ["mcp-request",{request:{method:"turn/start",params:{input:[{type:"text",text:"attachment",text_elements:[{byteRange:{start:0,end:5},placeholder:"fixture"}]}]}}}],
    ["mcp-request",{request:{method:"turn/start",params:{input:[{type:"text",text:"mixed"},{type:"image",url:"fixture"}]}}}],
  ];
  for(const [type,payload] of requests)f.nativeDispatchFixture.dispatchMessage(type,payload);
  assert.equal(f.nativeDispatchMessages.length,requests.length);
  for(let i=0;i<requests.length;i++){
    assert.equal(f.nativeDispatchMessages[i].type,requests[i][0]);
    assert.equal(f.nativeDispatchMessages[i].payload,requests[i][1],"unsupported payload unchanged by identity");
  }
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,0);
});

test("CII 0.0.2 installs actual dispatch hooks in two isolated desktop pages",async()=>{
  const pages=[createFixture(),createFixture()];
  for(let i=0;i<pages.length;i++){
    const f=pages[i];
    vm.runInNewContext(buildGuardExpression(PREFIX,{nativeDispatchFixture:true}),f.context);
    await f.win.__sparkCiiGuard.ready;
    assert.equal(f.win.__sparkCiiGuard.getState().egressHooks.nativeDispatch,true);
    f.nativeDispatchFixture.dispatchMessage("mcp-request",{request:{method:"turn/start",params:{
      input:[{type:"text",text:"window-"+i}]
    }}});
    assert.equal(f.nativeDispatchMessages[0].payload.request.params.input[0].text,PREFIX+"\n\nwindow-"+i);
    assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,1);
  }
  assert.notEqual(pages[0].nativeDispatchFixture,pages[1].nativeDispatchFixture);
});

test("Cii flags suspected prefix bypass after an Enter send without a matching native dispatch patch",async()=>{
  const f=createFixture();
  let now=1000;
  class Clock extends Date {
    constructor(...args){super(...(args.length?args:[now]));}
    static now(){return now;}
  }
  f.context.Date=Clock;
  vm.runInNewContext(buildGuardExpression(PREFIX,{nativeDispatchFixture:true}),f.context);
  await f.win.__sparkCiiGuard.ready;
  f.nativeSocket.url="wss://unrelated.example/ws";
  f.editor.value="unprotected test command";
  f.fire("keydown",f.event(f.editor,{key:"Enter"}));
  assert.equal(f.sentFrames.length,1);
  assert.equal(f.sentFrames[0].includes(PREFIX),false);
  assert.equal(f.win.__sparkCiiGuard.getState().suspectedMissingPrefix,0);
  now+=2500;
  assert.equal(f.win.__sparkCiiGuard.getState().suspectedMissingPrefix,1);
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,0);
  now+=12000;
  f.nativeDispatchFixture.dispatchMessage("mcp-request",{request:{
    method:"turn/start",params:{input:[{type:"text",text:"later native send"}]}
  }});
  assert.equal(f.win.__sparkCiiGuard.getState().suspectedMissingPrefix,1);
});

test("Cii CLI separates an armed hook from a healthy sender when unprefixed sends are suspected",async()=>{
  const deps={
    resolvePort:async()=>9230,
    matchingTargets:async()=>[{type:"page",url:"app://-/index.html"}],
    inspect:async()=>[{active:true,state:{enabled:true,implementation:"0.0.2",
      suspectedMissingPrefix:2}}]
  };
  const state=await executeOnce({command:"probe",port:9230},deps);
  assert.equal(state.active,true);
  assert.equal(state.healthy,false);
  assert.equal(state.suspectedUnprotected,2);
  assert.equal(state.targetCount,1);
  const fine=await executeOnce({command:"probe",port:9230},{...deps,
    inspect:async()=>[{active:true,state:{enabled:true,suspectedMissingPrefix:0}}]});
  assert.equal(fine.active,true);
  assert.equal(fine.healthy,true);
});

test("CII outgoing inspector exposes only the actual local API argument in renderer memory", async () => {
  const f = createFixture();
  const original = "원문 첫줄\n둘째줄\n\n넷째줄";
  vm.runInNewContext(buildGuardExpression(PREFIX, {nativeDispatchFixture:true}), f.context);
  await f.win.__sparkCiiGuard.ready;
  assert.equal(f.win.__sparkCiiGuard.getLastOutboundText(), null);
  f.nativeDispatchFixture.dispatchMessage("mcp-request", {request:{
    method:"turn/start", params:{input:[{type:"text",text:original}]}
  }});
  const observed = f.win.__sparkCiiGuard.getLastOutboundText();
  assert.equal(observed.text, PREFIX + "\n\n" + original);
  assert.equal(observed.source, "LOCAL_CLIENT_API_CALL");
  assert.equal(observed.channel, "NATIVE_DISPATCH");
  assert.equal(observed.ciiMatched, true);
  assert.equal(observed.truncated, false);
  assert.equal(JSON.stringify(f.win.__sparkCiiGuard.getState()).includes(original), false);
  assert.equal(JSON.stringify(f.win.__sparkCiiGuard.peekTrace()).includes(original), false);
  assert.equal(JSON.stringify(f.win.__sparkCiiGuard.peekTrace()).includes(PREFIX), false);
  assert.equal(vm.runInNewContext(buildDisableExpression(), f.context), "SPARK_CII_DISABLED");
  assert.equal(f.win.__sparkCiiGuard, undefined);
});

test("CII outgoing inspector does not invent a payload for an unsupported dispatch", async () => {
  const f = createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX, {nativeDispatchFixture:true}), f.context);
  await f.win.__sparkCiiGuard.ready;
  f.nativeDispatchFixture.dispatchMessage("mcp-request", {request:{
    method:"config/read",params:{input:[{type:"text",text:"DO_NOT_DISCLOSE"}]}
  }});
  assert.equal(f.win.__sparkCiiGuard.getLastOutboundText(),null);
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,0);
});

test("CII outgoing inspector clears previous payload when config is changed", async () => {
  const f = createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX, {nativeDispatchFixture:true}), f.context);
  await f.win.__sparkCiiGuard.ready;
  f.nativeDispatchFixture.dispatchMessage("mcp-request", {request:{
    method:"turn/start",params:{input:[{type:"text",text:"원문"}]}
  }});
  assert.ok(f.win.__sparkCiiGuard.getLastOutboundText());
  f.win.__sparkCiiGuard.configure("새로운 지침");
  assert.equal(f.win.__sparkCiiGuard.getLastOutboundText(),null);
});

function createDesktopComposerSubmissionFixture(text = "첫째 줄\n둘째 줄\n\n넷째 줄") {
  const f = createFixture({prosemirror:true});
  const form = f.editor.form;
  const messages = [];
  const split = text.split("\n");
  f.editor.children = split.map(line => ({tagName:"P", innerText:line, textContent:line}));
  const emitter = {
    listeners:new Map([["submit",new Set()]]),
    emit(type, ...args) {
      let emitted=false;
      for (const callback of this.listeners.get(type) || []) {
        callback(...args);
        emitted=true;
      }
      return emitted;
    }
  };
  class FakeController {
    constructor() { this.view={dom:f.editor}; this.eventEmitter=emitter; }
    getText(){return f.editor.children.map(p=>p.innerText).join("\n");}
  }
  const controller=new FakeController();
  const originalRead = controller.getText;
  const originalEmit = emitter.emit;
  const doSubmit = function(event) {
    event.preventDefault();
    messages.push(controller.getText());
  };
  // The live Desktop form has __reactProps$ and __reactFiber$ objects.
  form["__reactProps$fixture"] = {onSubmit:doSubmit};
  form["__reactFiber$fixture"] = {
    memoizedProps:{value:controller},return:null
  };
  const formProps=form["__reactProps$fixture"];
  emitter.listeners.get("submit").add(() => form["__reactProps$fixture"].onSubmit(f.event(form)));
  return {...f, form, controller, emitter, messages,
    originalRead, originalEmit, originalSubmit:doSubmit, formProps, raw:text};
}

test("production Electron mode never rewrites React composer text", () => {
  const f=createDesktopComposerSubmissionFixture("화면에는 원문만");
  f.win.electronBridge={sendMessageFromView(){}};
  delete f.win.__sparkCiiFixtureHost;
  delete f.win.__sparkCiiFixtureDispatch;
  const beforeRead=f.controller.getText;
  const beforeSubmit=f.formProps.onSubmit;
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  const state=f.win.__sparkCiiGuard.getState();
  assert.equal(state.composerSubmitRevision,"disabled-native-dispatch");
  assert.equal(state.composerSubmit.bound,false);
  assert.equal(state.composerSubmit.status,"DISABLED_NATIVE_DISPATCH");
  assert.equal(f.controller.getText,beforeRead);
  assert.equal(f.formProps.onSubmit,beforeSubmit);
  f.formProps.onSubmit(f.event(f.form));
  assert.deepEqual(f.messages,["화면에는 원문만"]);
  assert.equal(f.editor.children.map(x=>x.innerText).join("\n"),"화면에는 원문만");
  assert.equal(f.win.__sparkCiiGuard.getLastOutboundText(),null);
});

test("CII 0.0.2 prefixes EXACT real React form submit argument, not ProseMirror DOM", () => {
  const f=createDesktopComposerSubmissionFixture();
  const paragraphs=f.editor.children.map(p=>p.innerText);
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX),f.context),"SPARK_CII_READY");
  const state=f.win.__sparkCiiGuard.getState();
  assert.equal(state.implementation,"0.0.2");
  assert.equal(state.composerSubmitRevision,"react-submit-gettext");
  assert.equal(state.composerSubmit.bound,true);
  assert.equal(state.composerSubmit.formHook,true);
  assert.equal(state.composerSubmit.enterHook,true);
  assert.equal(state.composerSubmit.textReadHook,true);
  assert.equal(state.composerSubmit.controllerMatched,true);
  assert.equal(f.controller.getText(),f.raw,"ordinary editor read remains unmodified");
  const ev=f.event(f.form);
  f.formProps.onSubmit(ev);
  assert.equal(ev.defaultPrevented,true,"native submission callback unchanged");
  assert.deepEqual(f.messages,[PREFIX+"\n\n"+f.raw]);
  assert.deepEqual(f.editor.children.map(p=>p.innerText),paragraphs);
  assert.equal(f.controller.getText(),f.raw,"read wrapper affects submit scope only");
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.merged,1);
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,0,
    "native network/IPC patch not invented");
  const inspector=f.win.__sparkCiiGuard.getLastOutboundText();
  assert.equal(inspector.channel,"COMPOSER_SUBMIT");
  assert.equal(inspector.source,"LOCAL_COMPOSER_SUBMIT_ARGUMENT");
  assert.equal(inspector.ciiMatched,true);
  assert.equal(inspector.text,PREFIX+"\n\n"+f.raw);
  assert.equal(JSON.stringify(f.win.__sparkCiiGuard.getState()).includes(f.raw),false);
  assert.equal(JSON.stringify(f.win.__sparkCiiGuard.peekTrace()).includes(PREFIX),false);
});

test("CII 0.0.2 prefixes Enter submit event emitted by the actual controller", () => {
  const f=createDesktopComposerSubmissionFixture("첫 번째\n두 번째");
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.bound,true);
  f.emitter.emit("submit");
  assert.deepEqual(f.messages,[PREFIX+"\n\n첫 번째\n두 번째"]);
  assert.equal(f.controller.getText(),f.raw);
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.merged,1);
});

test("CII 0.0.2 idempotent prefix, React props re-render and cleanup", () => {
  const f=createDesktopComposerSubmissionFixture("original");
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  f.formProps.onSubmit(f.event(f.form));
  const fresh = {onSubmit:function(ev){ev.preventDefault();f.messages.push(f.controller.getText());}};
  f.form["__reactProps$fixture"]=fresh;
  f.win.__sparkCiiGuard.configure(PREFIX);
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.bound,true);
  fresh.onSubmit(f.event(f.form));
  assert.deepEqual(f.messages,[PREFIX+"\n\noriginal",PREFIX+"\n\noriginal"]);
  assert.equal(f.formProps.onSubmit,f.originalSubmit,"old React handler restored");
  assert.equal(vm.runInNewContext(buildDisableExpression(),f.context),"SPARK_CII_DISABLED");
  assert.equal(f.controller.getText,f.originalRead);
  assert.equal(f.emitter.emit,f.originalEmit);
  assert.equal(fresh.onSubmit.toString().includes("refreshComposer"),false);
  assert.equal(f.controller.getText(),"original");
  fresh.onSubmit(f.event(f.form));
  assert.equal(f.messages[2],"original","disabled means no hidden prefix");
});

test("CII 0.0.2 keeps invalid/empty submit unchanged; no unsanctioned injection", () => {
  const f=createDesktopComposerSubmissionFixture("");
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  f.formProps.onSubmit(f.event(f.form));
  assert.deepEqual(f.messages,[""]);
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.merged,0);
  assert.equal(f.win.__sparkCiiGuard.getLastOutboundText(),null);
});

test("CII 0.0.2 independently hooks multiple Desktop chat windows", () => {
  for(const raw of ["첫 대화\n두 번째","별도 창 메시지"]) {
    const f=createDesktopComposerSubmissionFixture(raw);
    vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
    f.formProps.onSubmit(f.event(f.form));
    assert.equal(f.messages[0],PREFIX+"\n\n"+raw);
    assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.merged,1);
    assert.equal(f.controller.getText(),raw);
  }
});

test("CII 0.0.2 fails closed when the React submit path is unrecognizable", () => {
  const f=createDesktopComposerSubmissionFixture();
  f.formProps.onSubmit=function(event){ event.preventDefault(); f.messages.push("other handler"); };
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  const state=f.win.__sparkCiiGuard.getState();
  assert.equal(state.composerSubmit.bound,false);
  assert.equal(state.composerSubmit.status,"REACT_SUBMIT_PATH_UNAVAILABLE");
  assert.equal(f.controller.getText(),f.raw);
});

test("CII 0.0.2 Desktop readiness is owned by the native dispatch hook", () => {
  const page={url:"app://-/index.html",type:"page",webSocketDebuggerUrl:"ws://test"};
  const now=10_000;
  const native={
    enabled:true,implementation:"0.0.2",transportRevision:"native-dispatch-v1",
    egressHooks:{nativeDispatch:true},nativeDispatchStatus:"ARMED_UNVERIFIED",
    nativeDispatchUnrecognized:0,dryRunVerified:true
  };
  assert.deepEqual(evaluateCiiReadiness(page,native,now),
    {active:true,mode:"NATIVE_DISPATCH_EGRESS"});
  assert.deepEqual(evaluateCiiReadiness(page,{...native,nativeDispatchStatus:"MATCHED_OUTBOUND"},now),
    {active:true,mode:"NATIVE_DISPATCH_EGRESS"});
  assert.deepEqual(evaluateCiiReadiness(page,{...native,nativeDispatchUnrecognized:1},now),
    {active:false,mode:"NATIVE_DISPATCH_UNRECOGNIZED"});
  assert.deepEqual(evaluateCiiReadiness(page,{...native,egressHooks:{nativeDispatch:false}},now),
    {active:false,mode:"NATIVE_DISPATCH_UNAVAILABLE"});
});

test("CII 0.0.2 keeps the old dispatch breakpoint only as a non-desktop fallback", () => {
  const page={url:"https://chatgpt.com/",type:"page",webSocketDebuggerUrl:"ws://test"},now=20_000;
  const base={enabled:true,implementation:"0.0.2",transportRevision:"native-dispatch-v1",
    egressHooks:{nativeDispatch:false},dryRunVerified:true};
  assert.deepEqual(evaluateCiiReadiness(page,base,now),
    {active:false,mode:"DISPATCH_BREAKPOINT_MISSING_OR_STALE"});
  const protectedState={...base,dispatchBreakpoint:{
    implementation:"0.0.2-dispatch-breakpoint",installed:true,
    heartbeatAt:19_900,forwarded:0,blocked:0,status:"BREAKPOINT_ARMED"}};
  assert.deepEqual(evaluateCiiReadiness(page,protectedState,now),
    {active:true,mode:"START_COMPLETION_STREAM_EGRESS"});
  const blocked={...protectedState,dispatchBreakpoint:{
    ...protectedState.dispatchBreakpoint,blocked:1,status:"ERROR"}};
  assert.deepEqual(evaluateCiiReadiness(page,blocked,now),
    {active:false,mode:"DISPATCH_BREAKPOINT_ERROR"});
});

test("CII 0.0.2 safely layers over recognized orphaned React wrappers without duplicate prefixes", () => {
  const f=createDesktopComposerSubmissionFixture("문단 하나\n문단 둘");
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.bound,true);
  // Simulate an orphaned renderer wrapper after a failed prior transition.
  delete f.win.__sparkCiiGuard;
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.bound,true);
  f.formProps.onSubmit(f.event(f.form));
  assert.deepEqual(f.messages,[PREFIX+"\n\n문단 하나\n문단 둘"]);
  assert.equal(f.controller.getText(),"문단 하나\n문단 둘");
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.merged,1);
});

function createQuickChatSubmitFixture(raw="첫 번째\n두 번째\n\n네 번째") {
  const f=createFixture({prosemirror:true});
  const form=f.editor.form;
  const messages=[];
  f.editor.children=raw.split("\n").map(line=>({tagName:"P",innerText:line,textContent:line}));
  const emitter={
    listeners:new Map([["submit",new Set()]]),
    emit(type,...args) {
      for(const fn of this.listeners.get(type)||[])fn(...args);
      return true;
    }
  };
  class QuickController {
    constructor(){this.view={dom:f.editor};this.eventEmitter=emitter;}
    getPersistedText(){return f.editor.children.map(p=>p.innerText).join("\n");}
  }
  const controller=new QuickController();
  const imperative={
    focus(){},blur(){},
    submit(){messages.push(controller.getPersistedText());}
  };
  const originalRead=controller.getPersistedText;
  const originalSubmit=imperative.submit;
  const originalEmit=emitter.emit;
  const onSubmit=function(ev){ev.preventDefault();imperative.submit();};
  form["__reactProps$fixture"]={onSubmit};
  form["__reactFiber$fixture"]={memoizedProps:{},
    memoizedState:{memoizedState:{current:imperative},
      next:{memoizedState:controller,next:null}},return:null};
  emitter.listeners.get("submit").add(()=>imperative.submit());
  return {...f,form,controller,imperative,emitter,messages,
    originalRead,originalSubmit,originalEmit,raw};
}

test("CII 0.0.2 prefixes Quick Chat form.submit -> imperative ref -> getPersistedText",()=>{
  const f=createQuickChatSubmitFixture();
  const original=f.editor.children.map(p=>p.innerText);
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  const status=f.win.__sparkCiiGuard.getState();
  assert.equal(status.composerSubmit.bound,true);
  assert.equal(status.composerSubmit.mode,"QUICK_CHAT");
  assert.equal(status.composerSubmit.formHook,true);
  assert.equal(status.composerSubmit.imperativeHook,true);
  assert.equal(status.composerSubmit.enterHook,true);
  assert.equal(status.composerSubmit.textReadHook,true);
  assert.equal(f.controller.getPersistedText(),f.raw);
  f.form["__reactProps$fixture"].onSubmit(f.event(f.form));
  assert.deepEqual(f.messages,[PREFIX+"\n\n"+f.raw]);
  assert.deepEqual(f.editor.children.map(p=>p.innerText),original);
  assert.equal(f.controller.getPersistedText(),f.raw);
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.merged,1);
  assert.equal(f.win.__sparkCiiGuard.getState().outboundModified,0);
  assert.equal(f.win.__sparkCiiGuard.getLastOutboundText().text,PREFIX+"\n\n"+f.raw);
});

test("CII 0.0.2 handles Quick Chat Enter emitter AND direct imperative submit",()=>{
  const f=createQuickChatSubmitFixture("독립 창\n메시지");
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  f.emitter.emit("submit");
  f.imperative.submit();
  assert.deepEqual(f.messages,
    [PREFIX+"\n\n독립 창\n메시지",PREFIX+"\n\n독립 창\n메시지"]);
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.merged,2);
  assert.equal(f.controller.getPersistedText(),f.raw);
});

test("CII 0.0.2 restores Quick Chat controller and imperative methods on disable",()=>{
  const f=createQuickChatSubmitFixture();
  const originalForm=f.form["__reactProps$fixture"].onSubmit;
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  assert.equal(f.win.__sparkCiiGuard.getState().composerSubmit.bound,true);
  vm.runInNewContext(buildDisableExpression(),f.context);
  assert.equal(f.controller.getPersistedText,f.originalRead);
  assert.equal(f.imperative.submit,f.originalSubmit);
  assert.equal(f.emitter.emit,f.originalEmit);
  assert.equal(f.form["__reactProps$fixture"].onSubmit,originalForm);
  f.imperative.submit();
  assert.equal(f.messages[0],f.raw);
});

test("CII 0.0.2 refuses Quick Chat when imperative ref does not read persisted text",()=>{
  const f=createQuickChatSubmitFixture();
  f.imperative.submit=function(){f.messages.push("unsupported path");};
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  const state=f.win.__sparkCiiGuard.getState();
  assert.equal(state.composerSubmit.bound,false);
  assert.equal(state.composerSubmit.status,"REACT_SUBMIT_PATH_UNAVAILABLE");
  assert.equal(f.controller.getPersistedText(),f.raw);
});

test("CII 0.0.2 has independent protected standard and Quick Chat pages",()=>{
  const normal=createDesktopComposerSubmissionFixture("normal");
  const quick=createQuickChatSubmitFixture("quick");
  for(const f of [normal,quick])vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  normal.formProps.onSubmit(normal.event(normal.form));
  quick.form["__reactProps$fixture"].onSubmit(quick.event(quick.form));
  assert.equal(normal.messages[0],PREFIX+"\n\nnormal");
  assert.equal(quick.messages[0],PREFIX+"\n\nquick");
  assert.equal(normal.win.__sparkCiiGuard.getState().composerSubmit.mode,"STANDARD");
  assert.equal(quick.win.__sparkCiiGuard.getState().composerSubmit.mode,"QUICK_CHAT");
});
