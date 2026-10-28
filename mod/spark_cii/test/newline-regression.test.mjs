import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {buildGuardExpression} from "../src/guard-first.mjs";

const PREFIX = "검증용 지침 Alpha\n검증용 지침 Beta";
const TYPE = {
  paragraph: {name:"paragraph"},
  ordered_list: {name:"ordered_list"},
};
function block(type, text) {
  return {
    type: TYPE[type], textContent:text, nodeSize:text.length + 2,
    isText:false, isLeaf:false, isAtom:false,
    // Real ProseMirror marks TEXT nodes as both isAtom and isLeaf.
    // A safe injector must never reject ordinary text on that basis.
    descendants(fn) {
      if (this.textContent) fn({
        type:{name:"text"},isAtom:true,isLeaf:true,isText:true,
        textContent:this.textContent
      });
    },
    eq(other) {return this.type.name === other.type.name && this.textContent === other.textContent;}
  };
}
function makeDoc(children) {
  return {
    type:{name:"doc"}, childCount:children.length,
    content:{content:children},textContent:children.map(x=>x.textContent).join("\n"),
    child(i) {return children[i];},
    eq(other) {return !!other && this.childCount===other.childCount &&
      children.every((item,i)=>item.eq(other.child(i)));}
  };
}
function serialize(doc) {
  const nodes=doc.content.content;
  const index=nodes.findIndex(n=>n.type.name==="ordered_list");
  if(index>=0){
    const before=nodes.slice(0,index).map(n=>n.textContent).join("\n");
    const after=nodes.slice(index).map(n=>n.textContent).join("\n");
    if(index===0)return after;
    // Match observed desktop behavior for a list after a new block:
    // one prefix paragraph gives a normal paragraph/list separation;
    // extra preceding paragraphs produce incompatible Markdown spacing.
    return before + (index===1?"\n\n":"\n\n\n\n") + after;
  }
  return nodes.map(n=>n.textContent).join("\n");
}

function fixture(initialNodes, {disabled=false,unserializable=false}={}) {
  const listeners=new Map(),scheduled=[],sent=[];
  const on=(name,handler)=>listeners.set(name,[...(listeners.get(name)||[]),handler]);
  const off=(name,handler)=>listeners.set(name,(listeners.get(name)||[]).filter(f=>f!==handler));
  const classes=new Set(["ProseMirror"]);
  const editor={
    tagName:"DIV",isContentEditable:true,isConnected:true,children:[],
    classList:{contains:v=>classes.has(v)},
    getBoundingClientRect:()=>({width:300,height:40}),
    getAttribute:n=>n==="contenteditable"?"true":null,
    querySelector:()=>null,closest:s=>s==="form"?form:null,
    contains:n=>n===editor,focus() {},
  };
  const button={tagName:"BUTTON",disabled,knownSend:true,form:null,
    matches:s=>s==="button" || s.includes("Send") || s.includes("send-button") || s.includes("submit"),
    getBoundingClientRect:()=>({width:45,height:45}),
    closest:s=>s==="button"?button:s==="form"?form:null,
  };
  const form={
    tagName:"FORM",matches:s=>s==="form",querySelector:()=>null,
    querySelectorAll:()=>[button],contains:n=>n===editor || n===button,
    closest:()=>null
  };
  button.form=form;
  const schema={
    text: value=>({text:value}),
    nodes:{paragraph:{create:(_attrs,content)=>block("paragraph",content?.text || "")}}
  };
  const makeState=doc=>({doc,schema,get tr(){
    return {doc,
      insert(at,nodes) {
        assert.equal(at,0);
        this.doc=makeDoc([...nodes,...this.doc.content.content]);
        return this;
      }
    };
  }});
  const view={
    dom:editor,isDestroyed:false,state:makeState(makeDoc(initialNodes)),
    dispatch(tr) {
      this.state=makeState(tr.doc);
      editor.children=tr.doc.content.content.map(n=>({tagName:"P",innerText:n.textContent}));
    },
    updateState(state) {
      this.state=state;
      editor.children=state.doc.content.content.map(n=>({tagName:"P",innerText:n.textContent}));
    }
  };
  view.updateState(view.state);
  const controller={
    view,dictation:{get document(){return view.state.doc;}},
    getText(doc=this.dictation.document) {
      return (unserializable?"MISMATCH:":"")+serialize(doc);
    },
  };
  editor.parentElement={"__reactFiber$fixture":{memoizedProps:{composerController:controller},return:null}};
  const win={
    __sparkCiiGuard:null,addEventListener:on,removeEventListener:off
  };
  const doc={
    body:{},head:{appendChild(){}},
    querySelectorAll:s=>s.includes("#prompt-textarea")?[editor]:[],
    querySelector:()=>null,getElementById:()=>null,
    createElement:()=>({style:{},textContent:""}),
    execCommand:()=>{throw Error("Regression: execCommand(insertText) must never touch ProseMirror");}
  };
  const context={window:win,document:doc,location:{protocol:"app:",hostname:"-",pathname:"/index.html",origin:"null"},
    getComputedStyle:()=>({display:"block",visibility:"visible",fontSize:"16px",lineHeight:"24px",color:"black"}),
    MutationObserver:class{observe(){} disconnect(){}},
    setTimeout:(callback,ms)=>scheduled.push({callback,ms})};
  const fire=(name,target,details={})=>{
    const ev={
      target,key:name==="keydown"?"Enter":undefined,isComposing:false,keyCode:0,
      shiftKey:false,ctrlKey:false,metaKey:false,altKey:false,defaultPrevented:false,
      preventDefault(){this.defaultPrevented=true;},stopPropagation(){},stopImmediatePropagation(){},
      ...details
    };
    for(const listener of [...listeners.get(name)||[]])listener(ev);
    if(name==="click"&&target===button&&!ev.defaultPrevented)sent.push(controller.getText());
    return ev;
  };
  button.click=()=>fire("click",button);
  return {
    editor,button,view,controller,win,context,sent,scheduled,fire,
    sendTimers(){
      const pending=scheduled.splice(0);
      for(const x of pending.filter(x=>x.ms===140))x.callback();
    }
  };
}
function enable(f) {
  assert.equal(vm.runInNewContext(buildGuardExpression(PREFIX),f.context),"SPARK_CII_READY");
  assert.equal(f.win.__sparkCiiGuard.getState().safeBypass,false);
}

test("ProseMirror Enter inserts exact prefix without rewriting original paragraph",()=>{
  const original=block("paragraph","원본 문장");
  const f=fixture([original]);enable(f);
  const before=f.view.state.doc;
  const ev=f.fire("keydown",f.editor);
  assert.equal(ev.defaultPrevented,true);
  assert.equal(f.sent.length,0);
  assert.equal(f.view.state.doc.child(f.view.state.doc.childCount-1),original);
  assert.equal(f.view.state.doc.eq(before),false);
  assert.equal(f.controller.getText(),PREFIX+"\n\n원본 문장");
  f.sendTimers();
  assert.deepEqual(f.sent,[PREFIX+"\n\n원본 문장"]);
  assert.equal(f.win.__sparkCiiGuard.getState().forwarded,1);
});

test("ProseMirror paste with intentional blank lines never expands into extra empty blocks",()=>{
  const f=fixture([
    block("paragraph","첫 번째 행"),
    block("paragraph",""),
    block("paragraph","마지막 행"),
  ]);
  enable(f);f.fire("click",f.button);
  assert.equal(f.controller.getText(),PREFIX+"\n\n첫 번째 행\n\n마지막 행");
  const blocks=f.view.state.doc.content.content;
  assert.equal(blocks.slice(-3).map(n=>n.textContent).join("|"),"첫 번째 행||마지막 행");
  f.sendTimers();
  assert.deepEqual(f.sent,[PREFIX+"\n\n첫 번째 행\n\n마지막 행"]);
});

test("Numbered Markdown list is preserved without extra line breaks",()=>{
  const list=block("ordered_list","1. 첫째\n2. 둘째");
  const f=fixture([list]);enable(f);f.fire("keydown",f.editor);
  assert.equal(f.view.state.doc.child(f.view.state.doc.childCount-1),list);
  assert.equal(f.controller.getText(),PREFIX+"\n\n1. 첫째\n2. 둘째");
  f.sendTimers();
  assert.deepEqual(f.sent,[PREFIX+"\n\n1. 첫째\n2. 둘째"]);
});

test("Rapid double Enter is intercepted only once and cannot create blank paragraphs",()=>{
  const f=fixture([block("paragraph","중복 Enter")]);enable(f);
  const first=f.fire("keydown",f.editor),second=f.fire("keydown",f.editor);
  assert.equal(first.defaultPrevented,true);
  assert.equal(second.defaultPrevented,true);
  assert.equal(f.controller.getText(),PREFIX+"\n\n중복 Enter");
  f.sendTimers();
  assert.deepEqual(f.sent,[PREFIX+"\n\n중복 Enter"]);
  assert.equal(f.win.__sparkCiiGuard.getState().intercepted,1);
});

test("Shift+Enter and IME composition leave the editor completely unchanged",()=>{
  const f=fixture([block("paragraph","입력 중")]);enable(f);
  const before=f.view.state.doc;
  assert.equal(f.fire("keydown",f.editor,{shiftKey:true}).defaultPrevented,false);
  assert.equal(f.fire("keydown",f.editor,{isComposing:true}).defaultPrevented,false);
  assert.equal(f.view.state.doc,before);
  assert.equal(f.sent.length,0);
});

test("If Send is unavailable, transaction rollback restores original draft and disables interception",()=>{
  const f=fixture([block("paragraph","보존해야 할 입력")],{disabled:true});
  enable(f);const originalState=f.view.state;
  f.fire("keydown",f.editor);
  assert.equal(f.view.state.doc.eq(originalState.doc),false);
  f.sendTimers();
  const st=f.win.__sparkCiiGuard.getState();
  assert.equal(st.safeBypass,true);
  assert.equal(st.blocked,1);
  assert.equal(st.status,"BLOCKED_SEND_UNAVAILABLE");
  assert.equal(f.view.state.doc.eq(originalState.doc),true);
  assert.equal(f.view.state,originalState);
  assert.equal(f.fire("keydown",f.editor).defaultPrevented,false);
});

test("Unsupported serialization fails open without touching original draft",()=>{
  const f=fixture([block("paragraph","원본")],{unserializable:true});
  enable(f);
  const before=f.view.state.doc;
  const ev=f.fire("keydown",f.editor);
  assert.equal(ev.defaultPrevented,false);
  assert.equal(f.view.state.doc,before);
  assert.equal(f.sent.length,0);
  const st=f.win.__sparkCiiGuard.getState();
  assert.equal(st.safeBypass,true);
  assert.equal(st.blocked,1);
  assert.equal(st.forwarded,0);
  assert.equal(f.fire("keydown",f.editor).defaultPrevented,false);
});
