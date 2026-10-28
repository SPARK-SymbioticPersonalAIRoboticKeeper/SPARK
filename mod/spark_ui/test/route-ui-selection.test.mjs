import test from "node:test";
import assert from "node:assert/strict";
import { extractSelectedModelFromFiber, ensureUiSubmissionObserver } from "../src/route-ui-selection.mjs";
import vm from "node:vm";
import { buildRouteOverlayExpression } from "../src/route-overlay.mjs";
import { safeUrl } from "../src/route-metadata.mjs";
import { RouteCollector } from "../src/route-collector.mjs";

function fiber(props, parent = null) {
  return { memoizedProps: props, return: parent };
}

test("selected model and effort come from separate verified React props", () => {
  const root = fiber({
    selectedModel: { slug: "gpt-6-thinking", thinkingEffort: "max", versionId: "latest" },
  });
  const power = fiber({
    selectedPowerSelection: {
      id: "gpt-6-thinking:max",
      model: "gpt-6-thinking",
      modelLabel: "GPT-6",
      reasoningEffort: "max",
      sliderLabel: "Extra High",
      isMaximum: false,
    },
  }, root);
  const current = extractSelectedModelFromFiber(fiber({ label: "PRIVATE PROMPT" }, power), "max");
  assert.equal(current.status, "observed");
  assert.deepEqual([current.model, current.effort, current.displayModel, current.displayEffort],
    ["gpt-6-thinking", "max", "GPT-6", "Extra High"]);
  assert.equal(current.isMaximumSelection, false);
  assert.equal(current.evidence.model, "React.memoizedProps.selectedModel.slug");
  assert.equal(current.evidence.effort, "React.memoizedProps.selectedModel.thinkingEffort");
  assert.equal(JSON.stringify(current).includes("PRIVATE PROMPT"), false);
});

test("Pro maximum tier differs from thinking effort max for Extra High", () => {
  const selection = fiber({ selectedPowerSelection: {
    model: "gpt-6-pro", reasoningEffort: "medium",
    sliderLabel: "Pro", isMaximum: true,
  } }, fiber({ selectedModel: {
    slug: "gpt-6-pro", thinkingEffort: "medium",
  } }));
  const pro = extractSelectedModelFromFiber(selection, "medium");
  assert.equal(pro.status, "observed");
  assert.equal(pro.effort, "medium");
  assert.equal(pro.displayEffort, "Pro");
  assert.equal(pro.isMaximumSelection, true);
});

test("mixed or malicious shell data is never taken as a genuine selected route", () => {
  const mismatch = fiber({ selectedPowerSelection: {
    model: "gpt-5-6", reasoningEffort: "medium",
  } }, fiber({ selectedModel: {slug: "gpt-6-thinking", thinkingEffort: "max"} }));
  assert.equal(extractSelectedModelFromFiber(mismatch, "max").status, "conflict");
  const invalid = fiber({ selectedModel: {
    slug: "private prompt contents should not appear",
    thinkingEffort: "<script>alert(1)</script>",
  } });
  const result = extractSelectedModelFromFiber(invalid, "max");
  assert.equal(result.model, null);
  assert.equal(result.status, "partial");
  assert.equal(JSON.stringify(result).includes("private prompt"), false);
});

test("effort alone remains partial when exact model is inaccessible", () => {
  const result = extractSelectedModelFromFiber(fiber({ unrelated: true }), "max");
  assert.equal(result.status, "partial");
  assert.equal(result.model, null);
  assert.equal(result.effort, "max");
});

test("overlay expression carries a read-only UI model probe and submission observer", () => {
  const source = buildRouteOverlayExpression(new RouteCollector().snapshot());
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /selectedModel/);
  assert.match(source, /selectedPowerSelection/);
  assert.match(source, /composer-send-click/);
  assert.match(source, /RESPONSE MODEL/);
  assert.match(source, /UI MODEL/);
  assert.match(source, /WIRE REQ MODEL/);
  assert.match(source, /RESOLVED MODEL/);
  assert.match(source, /RESOLVED EFFORT/);
  assert.match(source, /STREAM SERVER/);
  assert.match(source, /data-route-direction/);
  assert.match(source, /Show network diagnostics/);
});

test("WebSocket user identity is redacted but endpoint class remains", () => {
  const url = "wss://ws.chatgpt.com/p10/ws/user/user-PRIVATE_RANDOM_ID_12345678901234567890123";
  assert.equal(safeUrl(url), "wss://ws.chatgpt.com/p10/ws/user/:id");
  assert.equal(safeUrl("https://chatgpt.com/backend-api/conversation?token=SECRET"),
    "https://chatgpt.com/backend-api/conversation");
});

function messageFixture({ paragraphs = ["첫째 줄","둘째 줄"], editors = 1,
  selected = {status:"observed",model:"gpt-6",effort:"high",evidence:{}} } = {}) {
  const listeners = {};
  class FakeElement {
    constructor(tagName) {this.tagName=tagName;this.isConnected=true;this.children=[];}
    getBoundingClientRect(){return {width:350,height:45};}
    closest(selector){
      if (selector === "form") return this.form || null;
      if (selector.includes("ProseMirror") && this.tagName==="DIV")return this;
      if (selector.includes('button[aria-label="Send"]') && this.tagName==="BUTTON")return this;
      return null;
    }
    querySelector(){return null;}
  }
  const editor = new FakeElement("DIV");
  editor.children=paragraphs.map(text=>{
    const block=new FakeElement("P");block.innerText=text;return block;
  });
  editor.form=new FakeElement("FORM");
  const button=new FakeElement("BUTTON");button.form=editor.form;button.disabled=false;
  const extras=Array.from({length:editors-1},()=>new FakeElement("DIV"));
  const fakeWindow={};
  const location={href:"app://-/index.html?conversation=one"};
  const context={
    window:fakeWindow,location,
    document:{
      addEventListener(type,fn){(listeners[type]??=[]).push(fn);},
      querySelectorAll(){return [editor,...extras];}
    },
    getComputedStyle:()=>({display:"block",visibility:"visible"}),
    Element:FakeElement,Date
  };
  const observer=vm.runInNewContext(
    "(" + ensureUiSubmissionObserver.toString() + ")(readSelection,parseFiber)",
    {...context,readSelection:()=>selected,parseFiber:()=>null});
  const fire=(type,target,details={})=>{
    for(const fn of listeners[type]||[])fn({
      isTrusted:true,target,key:undefined,shiftKey:false,
      ctrlKey:false,metaKey:false,altKey:false,isComposing:false,keyCode:0,
      ...details
    });
  };
  return {context,observer,editor,button,location,fire};
}

test("outgoing panel captures unmodified paragraph boundaries on real Enter",()=>{
  const f=messageFixture({paragraphs:["첫째 줄","둘째 줄","","넷째 줄"]});
  const original=f.editor.children.map(p=>p.innerText);
  f.fire("keydown",f.editor,{key:"Enter"});
  assert.equal(f.observer.lastDraft.text,"첫째 줄\n둘째 줄\n\n넷째 줄");
  assert.equal(f.observer.lastDraft.source,"DOM_COMPOSER_BEFORE_SEND");
  assert.deepEqual(f.editor.children.map(p=>p.innerText),original);
  assert.equal(f.observer.observations[0].model,"gpt-6");
  assert.equal("text" in f.observer.observations[0],false,
    "metadata-only observer result must not contain prompt");
  assert.equal(f.observer.lastDraft.truncated,false);
});

test("outgoing panel captures Send click even if selected model/effort is unavailable",()=>{
  const f=messageFixture({selected:{status:"unavailable",model:null,effort:null}});
  f.fire("click",f.button);
  assert.equal(f.observer.lastDraft.text,"첫째 줄\n둘째 줄");
  assert.equal(f.observer.observations[0].model,null);
  assert.equal(f.observer.observations[0].type,"composer-send-click");
});

test("outgoing panel never invents a draft from an ambiguous composer",()=>{
  const f=messageFixture({editors:2});
  f.fire("click",f.button);
  assert.equal(f.observer.lastDraft,null);
  assert.equal(f.observer.observations.length,0);
});

test("outgoing panel resets volatile text on conversation change",()=>{
  const f=messageFixture();
  f.fire("keydown",f.editor,{key:"Enter"});
  assert.ok(f.observer.lastDraft);
  f.location.href="app://-/index.html?conversation=two";
  const second=vm.runInNewContext(
    "(" + ensureUiSubmissionObserver.toString() + ")(readSelection,parseFiber)",
    {...f.context,readSelection:()=>({status:"unavailable"}),parseFiber:()=>null});
  assert.equal(second.lastDraft,null);
  assert.equal(second.observations.length,0);
});

test("outgoing panel is renderer-only and never records/exports raw text",()=>{
  const source=buildRouteOverlayExpression(new RouteCollector().snapshot());
  assert.match(source,/data-route-outgoing-message-panel/);
  assert.match(source,/data-route-draft-message/);
  assert.match(source,/data-route-outbound-message/);
  assert.match(source,/data-route-rendered-message/);
  assert.match(source,/getLastOutboundText/);
  assert.match(source,/입력창 DOM 관측/);
  assert.match(source,/서버\/계정 처리 영역/);
  assert.match(source,/Record\/파일 로그에 미저장/);
  assert.doesNotMatch(source,/document\.execCommand/);
  assert.doesNotThrow(()=>new Function(source));
});
