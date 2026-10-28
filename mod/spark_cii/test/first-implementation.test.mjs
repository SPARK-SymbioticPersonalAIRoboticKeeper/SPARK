import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadPrefix, normalizePrefix, DEFAULT_CONFIG_PATH } from "../src/config.mjs";
import { buildGuardExpression, buildDisableExpression, buildStatusExpression } from "../src/guard-first.mjs";
import { buildTraceExpression, buildTraceAckExpression } from "../src/guard.mjs";
import { parseArgs, isCiiTarget, persistCiiTraces } from "../src/cli.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(DIR, "../config/config_cii.example.txt");
const PREFIX = "항상 존댓말을 사용하고 반말 절대 금지\n먼저 SPARK으로 작업하고 도저히 안될 경우에만 Work 전환 문의";

function createFixture({ url = "app://-/index.html", hiddenClone = false, multipleVisible = false, prosemirror = false } = {}) {
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
  const win = {
    __sparkCiiGuard: undefined,
    addEventListener: listen,
    removeEventListener: remove,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} })
  };
  const fire = (name, ev) => {
    for (const cb of [...getListeners(name)]) cb(ev);
    if (name === "click" && ev.target === send && !ev.defaultPrevented) {
      sent.push(prosemirror ? editor.children.map((p) => p.innerText).join("\n") : editor.value);
      if (prosemirror) editor.children = [];
      else editor.value = "";
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
    execCommand(command, unused, value) {
      if (!prosemirror || command !== "insertText") return false;
      editor.children = String(value).split("\n").map((line) => ({ tagName: "P", innerText: line }));
      return true;
    }
  };
  const context = {
    window: win, document: doc, HTMLTextAreaElement: Textarea,
    getComputedStyle: () => ({ display: "block", visibility: "visible",
      fontSize: "16px", lineHeight: "24px", color: "#000" }),
    location: { protocol: locationUrl.protocol, hostname: locationUrl.hostname,
      pathname: locationUrl.pathname, origin: locationUrl.origin },
    Event: class { constructor(name) { this.name = name; } },
    setTimeout: (fn) => { fn(); },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  return { context, editor, sent, send, fire, event, win };
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

test("Cii fails closed for ambiguous composers, and rejects login origin", () => {
  const f = createFixture({ multipleVisible: true });
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX), f.context), "SPARK_CII_READY");
  f.editor.value = "검증되지 않은 편집기";
  f.fire("click", f.event(f.send));
  assert.equal(f.sent[0], "검증되지 않은 편집기");
  assert.equal(f.win.__sparkCiiGuard.getState().editorReady, false);
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

test("Cii does not rewrite ProseMirror when its native controller cannot be identified", () => {
  const f = createFixture({ prosemirror: true, hiddenClone: true });
  f.editor.children = [
    { tagName: "P", innerText: "첫 번째 행" },
    { tagName: "P", innerText: "" },
    { tagName: "P", innerText: "마지막 행" }
  ];
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX), f.context), "SPARK_CII_READY");
  f.fire("click", f.event(f.send));
  assert.deepEqual(f.sent, ["첫 번째 행\n\n마지막 행"]);
  const state = f.win.__sparkCiiGuard.getState();
  assert.equal(state.forwarded, 0);
  assert.equal(state.blocked, 1);
  assert.equal(state.safeBypass, true);
  assert.equal(state.status, "BLOCKED_UNSUPPORTED_EDITOR_SAFE_BYPASS");
});

test("active CII traces each insertion stage with no prefix or user text", () => {
  const f = createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX), f.context);
  f.editor.value = "PRIVATE_USER_MESSAGE_UNLOGGABLE";
  f.fire("click", f.event(f.send));
  const trace = vm.runInNewContext(buildTraceExpression(), f.context);
  assert.deepEqual(Array.from(trace.events, item => item.event), [
    "SEND_EVENT_SEEN", "EDITOR_RESOLVED", "PREFIX_PLAN_VERIFIED",
    "MESSAGE_INTERCEPTED", "PREFIX_APPLIED", "PREFIX_VERIFIED",
    "PREFIX_READBACK_VERIFIED", "SEND_BUTTON_READY",
    "MESSAGE_REPLAYED_UNCONFIRMED"
  ]);
  assert.ok(trace.events.every(item => item.attemptId === 1 &&
    (item.channel === "CLICK" || item.channel === "")));
  const status = vm.runInNewContext(buildStatusExpression(), f.context);
  assert.equal(status.traceVersion, 1);
  assert.equal(status.lastAttempt.editor, "PASS");
  assert.equal(status.lastAttempt.plan, "PASS");
  assert.equal(status.lastAttempt.insert, "PASS");
  assert.equal(status.lastAttempt.immediate, "PASS");
  assert.equal(status.lastAttempt.readback, "PASS");
  assert.equal(status.lastAttempt.send, "CLICK_CALLED");
  assert.equal(status.lastAttempt.result, "LOCAL_SEND_ONLY");
  assert.equal(status.forwarded, 1);
  const serialized = JSON.stringify({trace, status});
  assert.ok(!serialized.includes(PREFIX));
  assert.ok(!serialized.includes("PRIVATE_USER_MESSAGE_UNLOGGABLE"));
  assert.ok(!serialized.includes("https://"));
  const lastSeq = trace.events.at(-1).seq;
  assert.equal(vm.runInNewContext(buildTraceAckExpression(lastSeq), f.context), true);
  assert.equal(vm.runInNewContext(buildStatusExpression(), f.context).tracePending, 0);
});

test("ambiguous editor records CII bypass instead of claiming inserted Prefix", () => {
  const f = createFixture({ multipleVisible: true });
  vm.runInNewContext(buildGuardExpression(PREFIX), f.context);
  f.editor.value = "untouched without prefix";
  f.fire("click", f.event(f.send));
  assert.deepEqual(f.sent, ["untouched without prefix"]);
  const state = vm.runInNewContext(buildStatusExpression(), f.context);
  assert.equal(state.lastAttempt.editor, "FAIL");
  assert.equal(state.lastAttempt.result, "BYPASSED");
  assert.equal(state.lastAttempt.reason, "EDITOR_MISSING_OR_AMBIGUOUS");
  assert.equal(state.lastAttempt.insert, "NOT_RUN");
  const trace = vm.runInNewContext(buildTraceExpression(), f.context);
  assert.deepEqual(Array.from(trace.events, item => item.event),
    ["SEND_EVENT_SEEN", "MESSAGE_BYPASSED"]);
});

test("unsafe ProseMirror records exact failure stage and subsequent SAFE_BYPASS", () => {
  const f = createFixture({ prosemirror: true });
  f.editor.children = [{ tagName:"P", innerText:"PRIVATE_PROSEMIRROR_DRAFT" }];
  vm.runInNewContext(buildGuardExpression(PREFIX), f.context);
  f.fire("click", f.event(f.send));
  const first = vm.runInNewContext(buildStatusExpression(), f.context);
  assert.equal(first.blocked, 1);
  assert.equal(first.safeBypass, true);
  assert.equal(first.lastAttempt.plan, "FAIL");
  assert.equal(first.lastAttempt.reason, "CONTROLLER_UNAVAILABLE");
  assert.equal(first.lastFailure.reason, "CONTROLLER_UNAVAILABLE");
  assert.equal(first.lastAttempt.result, "BYPASSED");
  f.editor.children = [{tagName:"P",innerText:"another draft"}];
  f.fire("click",f.event(f.send));
  const later = vm.runInNewContext(buildStatusExpression(), f.context);
  assert.equal(later.lastAttempt.reason, "SAFE_BYPASS");
  assert.equal(later.lastFailure.reason, "CONTROLLER_UNAVAILABLE",
    "original cause must survive later safe bypasses");
  assert.equal(later.lastAttempt.result, "BYPASSED");
  assert.equal(later.lastAttempt.insert, "NOT_RUN");
  const trace = vm.runInNewContext(buildTraceExpression(), f.context);
  assert.deepEqual(Array.from(trace.events, e => e.event), [
    "SEND_EVENT_SEEN","EDITOR_RESOLVED","PREFIX_PLAN_FAILED",
    "MESSAGE_BYPASSED","SEND_EVENT_SEEN","MESSAGE_BYPASSED"
  ]);
  assert.ok(!JSON.stringify(trace).includes("PRIVATE_PROSEMIRROR_DRAFT"));
});

test("failed textarea write records precise failure and preserves no-forward safety", () => {
  const f = createFixture();
  f.editor.dispatchEvent = () => { f.editor.value = "changed during input event"; };
  vm.runInNewContext(buildGuardExpression(PREFIX), f.context);
  f.editor.value = "original";
  f.fire("click", f.event(f.send));
  const st = vm.runInNewContext(buildStatusExpression(), f.context);
  assert.equal(st.lastAttempt.insert, "FAIL");
  assert.equal(st.lastAttempt.reason, "WRITE_MISMATCH");
  assert.equal(st.lastAttempt.send, "NOT_RUN");
  assert.equal(st.lastAttempt.result, "BLOCKED");
  assert.equal(st.forwarded, 0);
  assert.equal(st.safeBypass, true);
  assert.equal(f.sent.length, 0);
  const trace = vm.runInNewContext(buildTraceExpression(), f.context);
  assert.equal(trace.events.at(-1).event, "MESSAGE_BLOCKED");
  assert.equal(trace.events.at(-1).reason, "WRITE_MISMATCH");
});

test("CII metadata queue is bounded and ACK is lossless for remaining stages", () => {
  const f = createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX), f.context);
  for (let i = 0; i < 40; i += 1) {
    f.editor.value = "short";
    f.fire("click", f.event(f.send));
  }
  const before = vm.runInNewContext(buildTraceExpression(), f.context);
  assert.equal(before.events.length, 256);
  assert.ok(before.overflow > 0);
  const first = before.events[0].seq;
  const last = before.events.at(-1).seq;
  assert.equal(last - first, 255);
  assert.equal(vm.runInNewContext(buildTraceAckExpression(first), f.context), true);
  const remainder = vm.runInNewContext(buildTraceExpression(), f.context);
  assert.equal(remainder.events.length, 255);
  assert.equal(vm.runInNewContext(buildTraceAckExpression(last), f.context), true);
  assert.equal(vm.runInNewContext(buildStatusExpression(), f.context).tracePending, 0);
  assert.equal(vm.runInNewContext(buildStatusExpression(), f.context).traceOverflow, 0);
});

test("real guard events reach the audit layer with ordered ACK and no message text", async () => {
  const f = createFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX), f.context);
  f.editor.value = "UNLOGGABLE_PERSONAL_MESSAGE";
  f.fire("click", f.event(f.send));
  const records=[];let acked=false;
  await persistCiiTraces([{id:"renderer-live-mock",url:"app://-/index.html"}],{
    write:async(event,details)=>{
      assert.equal(acked,false,"must write all events before acknowledging");
      records.push({event,details});
    }
  },{
    inspectTrace:async()=>vm.runInNewContext(buildTraceExpression(),f.context),
    acknowledge:async(_,seq)=>{
      assert.equal(records.at(-1).details.seq,seq);
      acked=true;
      return vm.runInNewContext(buildTraceAckExpression(seq),f.context);
    }
  });
  assert.equal(records.length,9);
  assert.equal(records[0].event,"SEND_EVENT_SEEN");
  assert.equal(records.at(-1).event,"MESSAGE_REPLAYED_UNCONFIRMED");
  assert.ok(records.every(r=>r.details.attemptId===1));
  assert.equal(acked,true);
  assert.equal(vm.runInNewContext(buildStatusExpression(),f.context).tracePending,0);
  assert.ok(!JSON.stringify(records).includes(PREFIX));
  assert.ok(!JSON.stringify(records).includes("UNLOGGABLE_PERSONAL_MESSAGE"));
});
