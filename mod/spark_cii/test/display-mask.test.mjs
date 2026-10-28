import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {buildGuardExpression, buildDisableExpression} from "../src/guard.mjs";
import {safeAuditRecord} from "../src/audit.mjs";

const PREFIX = "**항상 존댓말 사용, 반말 답변 절대 불허**\n**먼저 SPARK으로 작업하고 도저히 안될 경우에만 Work 전환 문의**";

function classList(...initial) {
  const values = new Set(initial);
  return {
    add(name) { values.add(name); },
    contains(name) { return values.has(name); },
    remove(name) { values.delete(name); },
  };
}

function createMarkdownFixture({wrongSecondLine = false} = {}) {
  const lines = PREFIX.split("\n").map(line => line.slice(2, -2));
  const bold1 = {nodeType: 1, tagName:"STRONG", textContent:lines[0]};
  const br = {nodeType:1, tagName:"BR", textContent:""};
  const bold2 = {nodeType:1, tagName:"STRONG",
    textContent:wrongSecondLine ? "다른 지침" : lines[1]};
  const prefixParagraph = {
    tagName:"P", isConnected:true, childNodes:[bold1,br,bold2],
    textContent:bold1.textContent + bold2.textContent,
    classList:classList(),
  };
  const body = {
    tagName:"OL", textContent:"첫째 요청 둘째 요청",
    childElementCount:2, classList:classList(),
  };
  const rich = {
    tagName:"DIV", isConnected:true, isContentEditable:false,
    classList:classList("rich-text-user-turn"), firstElementChild:prefixParagraph,
    children:[prefixParagraph,body],
    closest(selector) {
      if (selector.includes("form,") || selector.startsWith("form")) return null;
      if (selector.includes("group/user-message")) return {tagName:"DIV"};
      return null;
    },
  };
  const styles = [];
  let observer;
  const doc = {
    body:{},head:{appendChild(el){styles.push(el);}},
    querySelectorAll(selector) {
      if (selector === ".rich-text-user-turn") return [rich];
      if (selector === ".spark-cii-rich-prefix-hidden") {
        return prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden") ?
          [prefixParagraph] : [];
      }
      return [];
    },
    getElementById(id) { return styles.find(x=>x.id===id) || null; },
    createElement(tag) {
      return {tagName:tag.toUpperCase(), id:null, textContent:"", remove(){}};
    },
  };
  const win = {
    __sparkCiiGuard:null,
    addEventListener() {}, removeEventListener() {},
  };
  const context = {
    document:doc, window:win, location:{
      protocol:"app:", hostname:"-",pathname:"/index.html",href:"app://-/index.html",
    },
    URL, getComputedStyle(){return {display:"block",visibility:"visible"}},
    setTimeout(cb){cb();},
    MutationObserver:class {
      constructor(cb){observer=cb;}
      observe() {}
      disconnect() {}
    },
  };
  return {context,win,rich,prefixParagraph,body,styles,
    observeAgain(){observer?.([{type:"childList"}]);}};
}

test("rich-text prefix paragraph is visually hidden without touching the authored list or DOM text",()=>{
  const f=createMarkdownFixture();
  const beforePrefix=f.prefixParagraph.textContent;
  const beforeOriginal=f.body.textContent;
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX),f.context),"SPARK_CII_READY");
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),true);
  assert.equal(f.win.__sparkCiiGuard.getState().masked,1);
  for (const event of f.win.__sparkCiiGuard.peekTrace().events) {
    assert.doesNotThrow(() => safeAuditRecord(event.event));
  }
  assert.equal(f.prefixParagraph.textContent,beforePrefix,"underlying text remains unchanged");
  assert.equal(f.body.textContent,beforeOriginal,"user Markdown list unchanged");
  assert.deepEqual(f.rich.children,[f.prefixParagraph,f.body],"React children not removed");
  assert.match(f.styles[0].textContent,/spark-cii-rich-prefix-hidden\{display:none!important;/);
  f.observeAgain();
  assert.equal(f.win.__sparkCiiGuard.getState().masked,1,"observer must be idempotent");
});

test("unrelated Markdown is not hidden when prefix does not match exactly",()=>{
  const f=createMarkdownFixture({wrongSecondLine:true});
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),false);
  assert.equal(f.win.__sparkCiiGuard.getState().masked,0);
});

test("disabling CII restores all display markers without editing the original text",()=>{
  const f=createMarkdownFixture();
  const original=f.prefixParagraph.textContent;
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),true);
  assert.equal(vm.runInNewContext(buildDisableExpression(),f.context),"SPARK_CII_DISABLED");
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),false);
  assert.equal(f.prefixParagraph.textContent,original);
});

test("changing configured prefix invalidates the old paragraph mask",()=>{
  const f=createMarkdownFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),true);
  f.win.__sparkCiiGuard.configure("**다른 설정**");
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),false);
});

test("newly rendered user Markdown is hidden during the mutation callback",()=>{
  const f=createMarkdownFixture({wrongSecondLine:true});
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),false);
  f.prefixParagraph.childNodes[2].textContent =
    PREFIX.split("\n")[1].slice(2,-2);
  f.observeAgain();
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),true);
  assert.equal(f.win.__sparkCiiGuard.getState().maskErrors,0);
});

const PLAIN_PREFIX = "첫 번째 검증 규칙\n두 번째 검증 규칙";

function createPlainFixture({singleNode = false, mismatch = false, noUserBody = false} = {}) {
  const f = createMarkdownFixture();
  const lines = PLAIN_PREFIX.split("\n");
  f.prefixParagraph.childNodes = singleNode ?
    [{nodeType:3, textContent:lines.join("\n")}] :
    [{nodeType:3, textContent:lines[0]},
      {nodeType:1, tagName:"BR", textContent:""},
      {nodeType:3, textContent:mismatch ? "다른 지침" : lines[1]}];
  f.prefixParagraph.textContent = f.prefixParagraph.childNodes
    .map(node => node.textContent).join("");
  if (noUserBody) f.rich.children = [f.prefixParagraph];
  return f;
}

test("plain-text config hides exact P text/BR/text prefix without altering message",()=>{
  const f = createPlainFixture();
  const original = f.prefixParagraph.textContent;
  const userList = f.body.textContent;
  vm.runInNewContext(buildGuardExpression(PLAIN_PREFIX),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),true);
  assert.equal(f.win.__sparkCiiGuard.getState().masked,1);
  assert.equal(f.prefixParagraph.textContent,original);
  assert.equal(f.body.textContent,userList);
  assert.deepEqual(f.rich.children,[f.prefixParagraph,f.body]);
  assert.equal(f.win.__sparkCiiGuard.getState().maskErrors,0);
  f.observeAgain();
  assert.equal(f.win.__sparkCiiGuard.getState().masked,1);
});

test("plain-text config matches an entire literal newline text node",()=>{
  const f=createPlainFixture({singleNode:true});
  vm.runInNewContext(buildGuardExpression(PLAIN_PREFIX),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),true);
});

test("plain-text config rejects unmatched/partial prefix and missing user text",()=>{
  for(const opts of [{mismatch:true},{noUserBody:true}]){
    const f=createPlainFixture(opts);
    vm.runInNewContext(buildGuardExpression(PLAIN_PREFIX),f.context);
    assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),false);
    assert.equal(f.win.__sparkCiiGuard.getState().masked,0);
  }
});

test("plain-text prefix visual marker is reversible on disable",()=>{
  const f=createPlainFixture();
  const old=f.prefixParagraph.textContent;
  vm.runInNewContext(buildGuardExpression(PLAIN_PREFIX),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),true);
  vm.runInNewContext(buildDisableExpression(),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),false);
  assert.equal(f.prefixParagraph.textContent,old);
});

test("updating from Markdown to plain config rechecks rich prefix immediately",()=>{
  const f=createMarkdownFixture();
  vm.runInNewContext(buildGuardExpression(PREFIX),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),true);
  const lines=PLAIN_PREFIX.split("\n");
  f.prefixParagraph.childNodes=[
    {nodeType:3,textContent:lines[0]},
    {nodeType:1,tagName:"BR",textContent:""},
    {nodeType:3,textContent:lines[1]}
  ];
  f.prefixParagraph.textContent=lines.join("");
  f.win.__sparkCiiGuard.configure(PLAIN_PREFIX);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),true);
  assert.equal(f.win.__sparkCiiGuard.getState().maskErrors,0);
});

test("plain current config masks historical Markdown-rendered prefix",()=>{
  // The historical user bubble still contains STRONG nodes even though the
  // current config no longer contains Markdown markers.
  const f=createMarkdownFixture();
  const plain=PREFIX.split("\n").map(line=>line.slice(2,-2)).join("\n");
  const authored=f.body.textContent;
  vm.runInNewContext(buildGuardExpression(plain),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),true);
  assert.equal(f.body.textContent,authored);
  assert.equal(f.win.__sparkCiiGuard.getState().maskErrors,0);
});

test("mixed STRONG and text within a prefix-like paragraph remains visible",()=>{
  const f=createPlainFixture();
  f.prefixParagraph.childNodes[0]={
    nodeType:1,tagName:"STRONG",textContent:PLAIN_PREFIX.split("\n")[0]
  };
  vm.runInNewContext(buildGuardExpression(PLAIN_PREFIX),f.context);
  assert.equal(f.prefixParagraph.classList.contains("spark-cii-rich-prefix-hidden"),false);
  assert.equal(f.win.__sparkCiiGuard.getState().masked,0);
});
