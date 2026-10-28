import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildEgressGateExpression, buildEgressGateDisableExpression } from "../src/guard-egress.mjs";

function fixture() {
  const listeners = new Map();
  const events = [];
  const form = {
    matches(s) { return s === "form"; },
    closest() { return null; },
    querySelector(selector) {
      if (selector.startsWith("input[")) return null;
      if (selector.includes("#prompt-textarea")) return editor;
      return null;
    }
  };
  const editor = {
    closest(selector) {
      if (selector === "form") return form;
      if (selector.includes("#prompt-textarea")) return editor;
      return null;
    }
  };
  const button = {
    matches(selector) { return selector.includes("send-button"); },
    closest(s) { return s === "form" ? form : s === "button" ? button : null; }
  };
  const win = {
    addEventListener(name,handler) { listeners.set(name,handler); },
    removeEventListener(name,handler) {
      if (listeners.get(name) === handler) listeners.delete(name);
    }
  };
  const context = {
    window:win, location:{protocol:"app:",hostname:"-",pathname:"/index.html",origin:"null"},
    Date, Math, globalThis:null
  };
  context.globalThis=context;
  function event(target,key) {
    const e={target,key,defaultPrevented:false,
      preventDefault() {this.defaultPrevented=true;},
      stopPropagation() {},stopImmediatePropagation() {}};
    events.push(e);return e;
  }
  return {context,win,form,editor,button,listeners,event,events};
}
test("egress gate blocks unsupported unarmed send without touching ProseMirror",()=>{
  const f=fixture();
  assert.equal(vm.runInNewContext(buildEgressGateExpression(),f.context),"SPARK_CII_GATE_INSTALLED");
  const event=f.event(f.button);
  f.listeners.get("click")(event);
  assert.equal(event.defaultPrevented,true);
  const state=f.win.__sparkCiiGate.getState();
  assert.equal(state.blockedIntents,1);
  assert.equal(state.sentIntents,1);
  assert.equal(state.lastReason,"BREAKPOINT_NOT_ARMED");
  assert.equal(state.armed,false);
});
test("egress gate allows only fresh armed CDP request interceptor",()=>{
  const f=fixture();
  vm.runInNewContext(buildEgressGateExpression(),f.context);
  f.context.__sparkCiiBreakpointState={implementation:"0.0.2-dispatch-breakpoint",
    installed:true,status:"BREAKPOINT_ARMED",heartbeatAt:Date.now()};
  f.win.__sparkCiiDisplayMask={getState:()=>({enabled:true,version:"CII_DISPLAY_MASK_V1"})};
  const ok=f.event(f.editor,"Enter");
  f.listeners.get("keydown")(ok);
  assert.equal(ok.defaultPrevented,false);
  assert.equal(f.win.__sparkCiiGate.getState().armed,true);
  f.context.__sparkCiiBreakpointState.heartbeatAt=Date.now()-9000;
  const old=f.event(f.editor,"Enter");
  f.listeners.get("keydown")(old);
  assert.equal(old.defaultPrevented,true);
  assert.equal(f.win.__sparkCiiGate.getState().blockedIntents,1);
  assert.equal(f.win.__sparkCiiGate.getState().lastChannel,"KEYDOWN");
});
test("egress gate never blocks unrelated keys, forms or IME input",()=>{
  const f=fixture();vm.runInNewContext(buildEgressGateExpression(),f.context);
  const shift=f.event(f.editor,"Enter");shift.shiftKey=true;
  f.listeners.get("keydown")(shift);
  const im=f.event(f.editor,"Enter");im.isComposing=true;
  f.listeners.get("keydown")(im);
  const generic=f.event({closest:()=>null},"Enter");
  f.listeners.get("keydown")(generic);
  assert.equal(f.win.__sparkCiiGate.getState().sentIntents,0);
  assert.ok(f.events.every(e=>!e.defaultPrevented));
});
test("egress gate is idempotent, removable, and exposes metadata only",()=>{
  const f=fixture();const expr=buildEgressGateExpression();
  assert.equal(vm.runInNewContext(expr,f.context),"SPARK_CII_GATE_INSTALLED");
  assert.equal(vm.runInNewContext(expr,f.context),"SPARK_CII_GATE_ALREADY");
  const snapshot=JSON.stringify(f.win.__sparkCiiGate.getState());
  assert.ok(!snapshot.includes("prefix"));
  assert.ok(!snapshot.includes("content"));
  assert.equal(vm.runInNewContext(buildEgressGateDisableExpression(),f.context),"DISABLED");
  assert.equal(f.listeners.size,0);
});

test("egress gate blocks an externally placed send button associated with a composer form",()=>{
  const f=fixture();
  f.button.form=f.form;
  f.button.closest=selector=>selector==="button"?f.button:null;
  vm.runInNewContext(buildEgressGateExpression(),f.context);
  const event=f.event(f.button);
  f.listeners.get("click")(event);
  assert.equal(event.defaultPrevented,true);
  assert.equal(f.win.__sparkCiiGate.getState().blockedIntents,1);
});

test("egress gate upgrades an obsolete running guard without leaving old listeners",()=>{
  const f=fixture();
  let removed=0;
  f.win.__sparkCiiGate={
    getState:()=>({enabled:true,revision:"EGRESS_SEND_GATE_V1"}),
    disable(){removed++;delete f.win.__sparkCiiGate;}
  };
  assert.equal(vm.runInNewContext(buildEgressGateExpression(),f.context),
    "SPARK_CII_GATE_UPGRADED");
  assert.equal(removed,1);
  assert.equal(f.win.__sparkCiiGate.getState().revision,"EGRESS_SEND_GATE_V3");
  const event=f.event(f.button);
  f.listeners.get("click")(event);
  assert.equal(event.defaultPrevented,true);
});

test("fresh network breakpoint still blocks Send when display masker is absent",()=>{
  const f=fixture();
  vm.runInNewContext(buildEgressGateExpression(),f.context);
  f.context.__sparkCiiBreakpointState={
    implementation:"0.0.2-dispatch-breakpoint",
    installed:true,status:"BREAKPOINT_ARMED",heartbeatAt:Date.now()
  };
  const missing=f.event(f.button);
  f.listeners.get("click")(missing);
  assert.equal(missing.defaultPrevented,true);
  assert.equal(f.win.__sparkCiiGate.getState().armed,false);
  f.win.__sparkCiiDisplayMask={
    getState:()=>({enabled:true,version:"CII_DISPLAY_MASK_V1"})
  };
  const verified=f.event(f.button);
  f.listeners.get("click")(verified);
  assert.equal(verified.defaultPrevented,false);
  assert.equal(f.win.__sparkCiiGate.getState().armed,true);
});
