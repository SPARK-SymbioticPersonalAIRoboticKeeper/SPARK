import { CdpClient } from "../../spark_ui/src/cdp.mjs";

const SCRIPT_PATTERN = /\/app-initial-[^/]+\.js$/;
const METHOD_SIGNATURE = "async startCompletionStream({additionalHeaders:";
const BODY_MARKER = "{let O=";
const HEARTBEAT_TTL_MS = 3000;

export function locateStartCompletionStream(source) {
  if (typeof source !== "string" || !source) throw new TypeError("CDP script source is required.");
  const start = source.indexOf(METHOD_SIGNATURE);
  if (start < 0) throw new Error("START_COMPLETION_STREAM_SIGNATURE_NOT_FOUND");
  const body = source.indexOf(BODY_MARKER, start);
  if (body < 0 || body - start > 8000) throw new Error("START_COMPLETION_STREAM_BODY_NOT_FOUND");
  const absoluteIndex = body + 1;
  const before = source.slice(0, absoluteIndex);
  const lineNumber = (before.match(/\n/g) || []).length;
  const lastNewline = before.lastIndexOf("\n");
  const columnNumber = absoluteIndex - (lastNewline + 1);
  return { start, body, absoluteIndex, lineNumber, columnNumber };
}

export function prefixRequestCopy(request, prefix) {
  if(typeof prefix!=="string"||!prefix.trim())return {ok:false,reason:"PREFIX_INVALID"};
  if(!request||typeof request!=="object"||Array.isArray(request))
    return {ok:false,reason:"REQUEST_NOT_OBJECT"};
  if(!Array.isArray(request.messages))return {ok:false,reason:"NO_MESSAGES"};
  let index=-1;
  for(let i=request.messages.length-1;i>=0;i--){
    const m=request.messages[i];
    if(m?.author?.role==="user"||m?.author==="user"||m?.role==="user"){index=i;break}
  }
  if(index<0)return {ok:false,reason:"NO_USER_MESSAGE"};
  const message=request.messages[index],parts=message?.content?.parts;
  if(!Array.isArray(parts))return {ok:false,reason:"NO_USER_PARTS"};
  let partIndex=-1,original=null,objectText=false;
  for(let i=0;i<parts.length;i++){
    const part=parts[i];
    if(typeof part==="string"&&part.trim()){
      partIndex=i;original=part;break;
    }
    if(part&&typeof part==="object"&&(part.type==="text"||part.type==="input_text")&&
       typeof part.text==="string"&&part.text.trim()){
      partIndex=i;original=part.text;objectText=true;break;
    }
  }
  // A user message containing only an image/file still needs CII. Preserve
  // attachments and prepend a separate plain-text part; never flatten them.
  const attachmentOnly=partIndex<0&&parts.length>0;
  if(partIndex<0&&!attachmentOnly)return {ok:false,reason:"NO_TEXT_PART"};
  const alreadyPrefixOnly=!attachmentOnly&&partIndex===0&&
    original===prefix&&parts.length>1;
  const merged=attachmentOnly?prefix:
    (alreadyPrefixOnly||original.startsWith(prefix+"\n\n"))?
      original:prefix+"\n\n"+original;
  const nextParts=parts.slice();
  if(attachmentOnly)nextParts.unshift(merged);
  else nextParts[partIndex]=objectText?{...parts[partIndex],text:merged}:merged;
  const messages=request.messages.slice();
  messages[index]={...message,content:{...message.content,parts:nextParts}};
  const updated={...request,messages};
  const actual=attachmentOnly?updated.messages[index].content.parts[0]:
    objectText?updated.messages[index].content.parts[partIndex].text:
      updated.messages[index].content.parts[partIndex];
  if(actual!==merged||!merged.startsWith(prefix))
    return {ok:false,reason:"PREFIX_READBACK_MISMATCH"};
  return {ok:true,request:updated,originalChars:original?.length??0,
    mergedChars:merged.length,attachmentOnly,alreadyPrefixed:!attachmentOnly&&merged===original};
}

export function buildCallFrameMutationExpression(prefix) {
  if(typeof prefix!=="string"||!prefix.trim())throw new TypeError("CII prefix must be nonempty.");
  const p=JSON.stringify(prefix);
  return [
    "(()=>{",
    "const prefix="+p+";",
    "const block=(reason)=>{",
    "try{const poison={...E};Object.defineProperty(poison,'messages',{enumerable:true,configurable:false,get(){throw new Error('SPARK_CII_BLOCKED_'+reason)}});E=poison;T=void 0;o=void 0}catch{}",
    "globalThis.__sparkCiiBreakpointState={implementation:'0.0.2-dispatch-breakpoint',installed:true,heartbeatAt:Date.now(),forwarded:Number(globalThis.__sparkCiiBreakpointState?.forwarded)||0,blocked:(Number(globalThis.__sparkCiiBreakpointState?.blocked)||0)+1,status:'BLOCKED_'+reason,lastChannel:'START_COMPLETION_STREAM',verifiedRewrite:false};",
    "return {ok:false,blocked:true,reason};};",
    "const rewrite=("+prefixRequestCopy.toString()+")(E,prefix);",
    "if(!rewrite.ok&&(rewrite.reason==='NO_MESSAGES'||rewrite.reason==='NO_USER_MESSAGE'))return {ok:true,passthrough:true,reason:rewrite.reason};",
    "if(!rewrite.ok)return block(rewrite.reason);",
    "E=rewrite.request;T=void 0;o=void 0;",
    "const previous=globalThis.__sparkCiiBreakpointState;",
    "globalThis.__sparkCiiBreakpointState={implementation:'0.0.2-dispatch-breakpoint',installed:true,heartbeatAt:Date.now(),forwarded:(Number(previous?.forwarded)||0)+1,blocked:Number(previous?.blocked)||0,status:'PREFIX_VERIFIED_BEFORE_TRANSPORT',lastChannel:'START_COMPLETION_STREAM',verifiedRewrite:true};",
    "globalThis.__sparkCiiBreakpointLastOutbound={at:new Date().toISOString(),source:'START_COMPLETION_STREAM_REQUEST',channel:'START_COMPLETION_STREAM',prefixVerified:true,originalChars:rewrite.originalChars,mergedChars:rewrite.mergedChars};",
    "return {ok:true,passthrough:false,verified:true,originalChars:rewrite.originalChars,mergedChars:rewrite.mergedChars,alreadyPrefixed:rewrite.alreadyPrefixed,attachmentOnly:rewrite.attachmentOnly};",
    "})()"
  ].join("");
}

export class CiiBreakpointInterceptor {
  constructor(target,prefix,{timeoutMs=8000}={}){
    this.target=target;this.prefix=prefix;this.timeoutMs=timeoutMs;
    this.client=new CdpClient(target.webSocketDebuggerUrl,timeoutMs);
    this.script=null;this.breakpointId=null;this.location=null;
    this.installed=false;this.closed=false;this.forwarded=0;this.blocked=0;
    this.passthrough=0;this.lastOutbound=null;this.lastError=null;
    this.waiters=[];
    this.attemptId=0;this.traceSeq=0;this.traceOverflow=0;this.traceEvents=[];
  }
  setPrefix(prefix){
    if(typeof prefix!=="string"||!prefix.trim())throw new TypeError("CII prefix must be nonempty.");
    this.prefix=prefix;
  }
  trace(event,attemptId=0,reason="",channel="START_COMPLETION_STREAM") {
    if(this.traceEvents.length>=256){this.traceEvents.shift();this.traceOverflow++}
    this.traceEvents.push({seq:++this.traceSeq,at:new Date().toISOString(),
      event,attemptId,reason,channel});
  }
  peekTrace(){return {events:this.traceEvents.map(e=>({...e})),overflow:this.traceOverflow}}
  ackTrace(seq){
    if(!Number.isSafeInteger(seq)||seq<0)return false;
    this.traceEvents=this.traceEvents.filter(item=>item.seq>seq);
    this.traceOverflow=0;
    return true;
  }
  async start(){
    if(this.installed)return this.snapshot();
    this.client.onEvent=(message)=>this.onEvent(message);
    await this.client.connect();
    await this.client.send("Runtime.enable");
    await this.client.send("Debugger.enable");
    for(let i=0;i<40&&!this.script;i++)await new Promise(r=>setTimeout(r,25));
    if(!this.script)throw new Error("APP_INITIAL_SCRIPT_NOT_FOUND");
    const source=(await this.client.send("Debugger.getScriptSource",{scriptId:this.script.scriptId})).scriptSource;
    const found=locateStartCompletionStream(source);
    const response=await this.client.send("Debugger.setBreakpoint",{
      location:{scriptId:this.script.scriptId,lineNumber:found.lineNumber,columnNumber:found.columnNumber},
      condition:"true"
    });
    this.breakpointId=response.breakpointId;
    this.location=response.actualLocation??{scriptId:this.script.scriptId,lineNumber:found.lineNumber,columnNumber:found.columnNumber};
    this.installed=true;
    await this.publish({status:"BREAKPOINT_ARMED",verifiedRewrite:false});
    this.trace("EGRESS_BOUNDARY_ARMED");
    return this.snapshot();
  }
  async publish(extra={}){
    if(this.closed)return;
    const state={implementation:"0.0.2-dispatch-breakpoint",installed:this.installed,
      heartbeatAt:Date.now(),forwarded:this.forwarded,blocked:this.blocked,
      passthrough:this.passthrough,status:this.lastError?"ERROR":"BREAKPOINT_ARMED",
      lastChannel:"START_COMPLETION_STREAM",verifiedRewrite:this.lastOutbound?.ciiMatched===true,...extra};
    const expression="(()=>{globalThis.__sparkCiiBreakpointState="+JSON.stringify(state)+";return true})()";
    await this.client.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:false});
  }
  async heartbeat(){if(!this.installed||this.closed)return false;await this.publish();return true}
  async onEvent({method,params}){
    if(method==="Debugger.scriptParsed"&&SCRIPT_PATTERN.test(params.url||"")){
      if(this.installed && this.script?.scriptId!==params.scriptId){
        this.installed=false;
        this.lastError="RELOAD_REARM_REQUIRED";
        this.trace("MESSAGE_BLOCKED",0,"RELOAD_REARM_REQUIRED");
      }
      this.script=params;return;
    }
    if(method==="Runtime.executionContextsCleared"&&this.installed){
      this.installed=false;
      this.lastError="RELOAD_REARM_REQUIRED";
      this.trace("MESSAGE_BLOCKED",0,"RELOAD_REARM_REQUIRED");
      return;
    }
    if(method!=="Debugger.paused")return;
    if(!this.breakpointId||!Array.isArray(params.hitBreakpoints)||
        !params.hitBreakpoints.includes(this.breakpointId))return;
    const attempt=++this.attemptId;
    this.trace("MESSAGE_INTERCEPTED",attempt);
    const frame=params.callFrames?.[0];
    let verified=false,failed=false;
    try{
      if(!frame?.callFrameId)throw new Error("NO_CALL_FRAME");
      const response=await this.client.send("Debugger.evaluateOnCallFrame",{
        callFrameId:frame.callFrameId,
        expression:buildCallFrameMutationExpression(this.prefix),
        returnByValue:true,silent:true
      });
      if(response.exceptionDetails)throw new Error("CALL_FRAME_MUTATION_EXCEPTION");
      const result=response.result?.value??null;
      if(result?.verified===true){
        verified=true;
        this.forwarded++;
        this.lastOutbound={at:new Date().toISOString(),
          source:"START_COMPLETION_STREAM_REQUEST",channel:"START_COMPLETION_STREAM",
          ciiMatched:true,prefixVerified:true,
          originalChars:Number(result.originalChars)||0,
          mergedChars:Number(result.mergedChars)||0};
        this.lastError=null;
        this.trace("PREFIX_VERIFIED",attempt,"CALLFRAME_REQUEST_COPY");
      }else if(result?.passthrough===true){
        this.passthrough++;
        this.trace("EGRESS_NON_USER_PASSTHROUGH",attempt,"NO_NEW_USER_TEXT");
      }else if(result?.blocked===true){
        failed=true;
        this.blocked++;
        this.lastError=result.reason||"BLOCKED";
        this.trace("MESSAGE_BLOCKED",attempt,this.lastError);
      }else{
        throw new Error("UNVERIFIED_MUTATION");
      }
    }catch(error){
      failed=true;
      this.blocked++;
      this.lastError=["NO_CALL_FRAME","CALL_FRAME_MUTATION_EXCEPTION",
        "UNVERIFIED_MUTATION"].includes(error?.message) ?
        error.message : "INTERCEPTOR_ERROR";
      if(frame?.callFrameId){
        try{await this.poison(frame.callFrameId,this.lastError)}
        catch{this.lastError="EGRESS_CONTROL_LOST"}
      }else{
        this.lastError="EGRESS_CONTROL_LOST";
      }
      this.trace("MESSAGE_BLOCKED",attempt,this.lastError);
    }finally{
      try{
        await this.client.send("Debugger.resume");
        if(verified)this.trace("MESSAGE_REPLAYED_UNCONFIRMED",attempt,"RESUMED_NOT_NETWORK");
      }catch{
        failed=true;
        this.lastError="RESUME_FAILED";
        this.trace("MESSAGE_BLOCKED",attempt,this.lastError);
      }
      if(failed){
        try{await this.publish()}catch{}
      }
    }
  }
  async poison(callFrameId,reason){
    const expression="(()=>{const p={...E};Object.defineProperty(p,'messages',{enumerable:true,get(){throw new Error('SPARK_CII_BLOCKED_"+reason+"')}});E=p;T=void 0;o=void 0;return true})()";
    await this.client.send("Debugger.evaluateOnCallFrame",{callFrameId,expression,returnByValue:true});
  }
  snapshot(){
    return {implementation:"0.0.2-dispatch-breakpoint",installed:this.installed&&!this.closed,
      heartbeatAt:Date.now(),forwarded:this.forwarded,blocked:this.blocked,passthrough:this.passthrough,
      status:this.lastError?"ERROR":this.installed?"BREAKPOINT_ARMED":"NOT_INSTALLED",
      lastChannel:"START_COMPLETION_STREAM",verifiedRewrite:this.lastOutbound?.ciiMatched===true,
      tracePending:this.traceEvents.length,traceOverflow:this.traceOverflow,
      location:this.location?{lineNumber:this.location.lineNumber,columnNumber:this.location.columnNumber}:null,
      lastError:this.lastError,lastOutbound:this.lastOutbound?{...this.lastOutbound}:null};
  }
  async close(){
    if(this.closed)return;this.closed=true;
    if(this.breakpointId){try{await this.client.send("Debugger.removeBreakpoint",{breakpointId:this.breakpointId})}catch{}}
    try{await this.client.send("Runtime.evaluate",{expression:"(()=>{delete globalThis.__sparkCiiBreakpointState;delete globalThis.__sparkCiiBreakpointLastOutbound;return true})()",returnByValue:true})}catch{}
    this.client.close();this.installed=false;
  }
}

export function breakpointStateIsFresh(state,now=Date.now()){
  return state?.implementation==="0.0.2-dispatch-breakpoint"&&state?.installed===true&&
    Number.isFinite(Number(state.heartbeatAt))&&now-Number(state.heartbeatAt)<=HEARTBEAT_TTL_MS;
}
