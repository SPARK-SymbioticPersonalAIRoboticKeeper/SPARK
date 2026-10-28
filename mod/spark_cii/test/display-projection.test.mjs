import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildDisplayMaskExpression, buildDisableDisplayMaskExpression } from "../src/display-mask.mjs";

const PREFIX="첫째 반드시 존댓말\n둘째 반말 금지\n셋째 응답 검증\n넷째 SPARK 우선";
function fixture(initialText=PREFIX+"\n\n사용자가 작성한 원문") {
  const attrs=new Map(),styleProps=new Map(),css=new Map();
  const classSet=new Set(["text-size-chat","whitespace-pre-wrap"]);
  const leaf={
    tagName:"DIV",isConnected:true,isContentEditable:false,childElementCount:0,
    textContent:initialText,style:{
      setProperty(k,v){styleProps.set(k,v)},
      removeProperty(k){styleProps.delete(k)}
    },
    classList:{
      contains(k){return classSet.has(k)},
      add(k){classSet.add(k)},
      remove(k){classSet.delete(k)}
    },
    closest(selector) {return selector.includes("form")?null:null},
    setAttribute(k,v){attrs.set(k,v)},
    getAttribute(k){return attrs.get(k)??null},
    removeAttribute(k){attrs.delete(k)}
  };
  const root={querySelectorAll(selector){return selector.includes("whitespace-pre-wrap")?[leaf]:[]}};
  const document={
    body:{},documentElement:{},head:{appendChild(el){css.set(el.id,el)}},
    getElementById(id){return css.get(id)||null},
    createElement(tag){return {tagName:tag.toUpperCase(),id:"",
      textContent:"",remove(){css.delete(this.id)}}},
    querySelectorAll(selector) {
      if(selector.includes("user-message"))return [root];
      if(selector.startsWith(".spark-cii"))return classSet.has("spark-cii-display-projection")?[leaf]:[];
      return [];
    }
  };
  let notify=()=>{};
  class MutationObserver {
    constructor(callback){notify=callback}
    observe(){}
    disconnect(){notify=()=>{}}
  }
  const window={addEventListener(){}};
  const context={window,document,
    location:{protocol:"app:",hostname:"-",pathname:"/index.html"},
    getComputedStyle:()=>({fontSize:"18px",lineHeight:"29px",color:"rgb(255, 255, 200)"}),
    MutationObserver,queueMicrotask,Date,globalThis:null};
  context.globalThis=context;
  return {context,window,document,leaf,attrs,css,classSet,styleProps,
    async mutate(next){leaf.textContent=next;notify([]);await Promise.resolve();}
  };
}
test("display mask projects only original user text without altering source DOM or logging prefix",()=>{
  const f=fixture();
  assert.equal(vm.runInNewContext(buildDisplayMaskExpression(PREFIX),f.context),
    "SPARK_CII_DISPLAY_INSTALLED");
  assert.equal(f.leaf.textContent,PREFIX+"\n\n사용자가 작성한 원문");
  assert.equal(f.attrs.get("data-spark-cii-visible"),"사용자가 작성한 원문");
  assert.ok(f.classSet.has("spark-cii-display-projection"));
  assert.equal(f.styleProps.get("--spark-cii-display-font-size"),"18px");
  assert.match(f.css.get("spark-cii-display-mask-v1").textContent,/font-size:0!important/);
  assert.match(f.css.get("spark-cii-display-mask-v1").textContent,/::after/);
  const state=f.window.__sparkCiiDisplayMask.getState();
  assert.equal(state.enabled,true);assert.equal(state.masked,1);
  assert.equal(state.errors,0);assert.equal(state.version,"CII_DISPLAY_MASK_V1");
  assert.equal(JSON.stringify(state).includes(PREFIX),false);
});
test("mask is limited to user message containers and never rewrites an assistant or editor",()=>{
  const f=fixture();
  f.document.querySelectorAll=()=>[];
  vm.runInNewContext(buildDisplayMaskExpression(PREFIX),f.context);
  assert.equal(f.attrs.has("data-spark-cii-visible"),false);
  assert.equal(f.leaf.textContent,PREFIX+"\n\n사용자가 작성한 원문");
});
test("mutation observer projects newly rendered content before animation frame",async()=>{
  const f=fixture("message without prefix");
  vm.runInNewContext(buildDisplayMaskExpression(PREFIX),f.context);
  assert.equal(f.attrs.has("data-spark-cii-visible"),false);
  await f.mutate(PREFIX+"\n\n두 번째 사용자 요청");
  assert.equal(f.attrs.get("data-spark-cii-visible"),"두 번째 사용자 요청");
  await f.mutate(PREFIX+"\n\n내용 갱신");
  assert.equal(f.attrs.get("data-spark-cii-visible"),"내용 갱신");
  await f.mutate("prefix 없이 작성한 메시지");
  assert.ok(!f.classSet.has("spark-cii-display-projection"));
  assert.equal(f.attrs.has("data-spark-cii-visible"),false);
});
test("mask is idempotent, configurable without secrets in status, and removable",async()=>{
  const f=fixture();
  const expr=buildDisplayMaskExpression(PREFIX);
  vm.runInNewContext(expr,f.context);
  assert.equal(vm.runInNewContext(expr,f.context),"SPARK_CII_DISPLAY_ALREADY");
  const next="다른 규칙";
  assert.equal(f.window.__sparkCiiDisplayMask.configure(next),true);
  await f.mutate(next+"\n\n새 본문");
  assert.equal(f.attrs.get("data-spark-cii-visible"),"새 본문");
  assert.equal(f.window.__sparkCiiDisplayMask.projectText(next+"\n\n새 본문"),"새 본문");
  assert.equal(f.window.__sparkCiiDisplayMask.projectText("정상 원문"),"정상 원문");
  assert.equal(vm.runInNewContext(buildDisableDisplayMaskExpression(),f.context),"DISABLED");
  assert.ok(!f.classSet.has("spark-cii-display-projection"));
  assert.equal(f.css.size,0);
  assert.equal(f.window.__sparkCiiDisplayMask,undefined);
});
test("prefix-only user content projects empty text, preserving underlying message bytes",()=>{
  const f=fixture(PREFIX);
  vm.runInNewContext(buildDisplayMaskExpression(PREFIX),f.context);
  assert.equal(f.attrs.get("data-spark-cii-visible"),"");
  assert.equal(f.leaf.textContent,PREFIX);
});

test("legacy rich Markdown bubble hides only exact Prefix paragraph, preserving user list",()=>{
  const prefix="첫 번째 설정\n두 번째 설정";
  const styles=new Map();
  const prefixClasses=new Set();
  const title={nodeType:3,textContent:"첫 번째 설정"};
  const br={nodeType:1,tagName:"BR",textContent:""};
  const second={nodeType:3,textContent:"두 번째 설정"};
  const paragraph={tagName:"P",childNodes:[title,br,second],
    classList:{contains:k=>prefixClasses.has(k),add:k=>prefixClasses.add(k),
      remove:k=>prefixClasses.delete(k)}};
  const authoredList={tagName:"OL",textContent:"실제 사용자 질문 목록"};
  const rich={isConnected:true,isContentEditable:false,firstElementChild:paragraph,
    children:[paragraph,authoredList],
    classList:{contains:k=>k==="rich-text-user-turn"},
    closest:selector=>selector.includes("group/user-message")?{tagName:"DIV"}:null};
  const doc={body:{},documentElement:{},head:{appendChild:e=>styles.set(e.id,e)},
    getElementById:id=>styles.get(id)||null,
    createElement:tag=>({id:"",textContent:"",remove(){styles.delete(this.id)}}),
    querySelectorAll:selector=>{
      if(selector===".rich-text-user-turn")return [rich];
      if(selector===".spark-cii-rich-prefix-hidden")
        return prefixClasses.has("spark-cii-rich-prefix-hidden")?[paragraph]:[];
      return [];
    }};
  const win={addEventListener(){}};
  const context={document:doc,window:win,location:{
    protocol:"app:",hostname:"-",pathname:"/index.html"},
    MutationObserver:class {observe(){}disconnect(){}},
    queueMicrotask,getComputedStyle:()=>({fontSize:"16px",lineHeight:"24px",color:"black"}),Date};
  assert.equal(vm.runInNewContext(buildDisplayMaskExpression(prefix),context),
    "SPARK_CII_DISPLAY_INSTALLED");
  assert.ok(prefixClasses.has("spark-cii-rich-prefix-hidden"));
  assert.equal(authoredList.textContent,"실제 사용자 질문 목록");
  assert.equal(paragraph.childNodes[0],title);
  assert.match(styles.get("spark-cii-display-mask-v1").textContent,
    /spark-cii-rich-prefix-hidden\{display:none!important/);
  assert.equal(vm.runInNewContext(buildDisableDisplayMaskExpression(),context),
    "DISABLED");
  assert.ok(!prefixClasses.has("spark-cii-rich-prefix-hidden"));
});
