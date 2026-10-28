#!/usr/bin/env node
// Independent SPARK Cii entry point. Does not patch the existing UI watcher.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_CONFIG_PATH, SPARK_ROOT, loadPrefix } from "./config.mjs";
import { buildDisableExpression, buildStatusExpression, buildReadyExpression, buildTraceExpression, buildTraceAckExpression } from "./guard.mjs";
import { buildEgressGateExpression, buildEgressGateDisableExpression } from "./guard-egress.mjs";
import { buildDisplayMaskExpression, buildDisableDisplayMaskExpression } from "./display-mask.mjs";
import { CiiBreakpointInterceptor, breakpointStateIsFresh } from "./breakpoint.mjs";
import { CiiAudit, failureCode, readAuditTail } from "./audit.mjs";
import { evaluate, listTargets, installForFutureDocuments,
  removeFutureDocumentScript } from "../../spark_ui/src/cdp.mjs";

const ACTIVE_PATH = path.join(SPARK_ROOT, "log", "system", "active.json");
const interceptors = new Map();
const gateRegistrations = new Map();
const displayRegistrations = new Map();

export function isCiiTarget(target) {
  if (target?.type !== "page" || !target.webSocketDebuggerUrl) return false;
  let url;
  try { url = new URL(target.url); } catch { return false; }
  if (url.protocol === "app:") {
    return url.hostname === "-" && url.pathname === "/index.html";
  }
  if (url.origin !== "https://chatgpt.com") return false;
  return !/^\/(auth|login|verify|oauth|sso|mfa|challenge|account|settings|billing|checkout|security)(\/|$)/i.test(url.pathname);
}

export function parseArgs(argv) {
  const options = {
    command: argv[0],
    port: null,
    configPath: DEFAULT_CONFIG_PATH,
    intervalMs: 500,
    json: false,
    tail: 30,
  };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") { options.json = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error("Missing value for " + flag);
    if (flag === "--config") options.configPath = path.resolve(value);
    else if (flag === "--port") options.port = Number(value);
    else if (flag === "--interval") options.intervalMs = Number(value);
    else if (flag === "--tail") options.tail = Number(value);
    else throw new Error("Unknown Cii option: " + flag);
  }
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 250 || options.intervalMs > 60_000) {
    throw new Error("--interval must be between 250 and 60000 milliseconds.");
  }
  if (!Number.isInteger(options.tail) || options.tail < 1 || options.tail > 200) {
    throw new Error("--tail must be between 1 and 200.");
  }
  return options;
}

export async function resolvePort(explicitPort) {
  if (explicitPort !== null) return explicitPort;
  let active;
  try {
    active = JSON.parse((await readFile(ACTIVE_PATH, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("No CDP --port specified and active.json is unavailable.");
  }
  const port = Number(active?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Active ChatGPT CDP port is not valid.");
  }
  return port;
}

function fingerprint(prefix) {
  return createHash("sha256").update(prefix).digest("hex").slice(0, 12);
}

const pause = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
const typeOfTarget = (target) => target.url?.startsWith("app:") ? "desktop" : "web";

function interceptorKey(target) {
  return target.id || target.webSocketDebuggerUrl;
}

async function closeMissingInterceptors(targets) {
  const keep=new Set(targets.map(interceptorKey));
  for(const [key,interceptor] of interceptors){
    if(keep.has(key)) continue;
    try{await interceptor.close()}catch{}
    interceptors.delete(key);
  }
}

async function ensureBreakpointInterceptor(target,prefix) {
  const key=interceptorKey(target);
  let interceptor=interceptors.get(key);
  if(interceptor &&
      (interceptor.target.webSocketDebuggerUrl!==target.webSocketDebuggerUrl ||
        interceptor.installed!==true || interceptor.closed===true)){
    try{await interceptor.close()}catch{}
    interceptors.delete(key);
    interceptor=null;
  }
  if(!interceptor){
    interceptor=new CiiBreakpointInterceptor(target,prefix,{timeoutMs:8000});
    try{
      await interceptor.start();
      interceptors.set(key,interceptor);
    }catch(error){
      try{await interceptor.close()}catch{}
      throw error;
    }
  }else{
    interceptor.setPrefix(prefix);
    await interceptor.heartbeat();
  }
  return interceptor;
}

async function pageBreakpointState(target) {
  return evaluate(target,"(()=>globalThis.__sparkCiiBreakpointState??null)()",
    {timeoutMs:3000});
}

async function pageBreakpointOutbound(target) {
  return evaluate(target,"(()=>globalThis.__sparkCiiBreakpointLastOutbound??null)()",
    {timeoutMs:3000});
}

async function closeBreakpointInterceptor(target) {
  const key=interceptorKey(target);
  const interceptor=interceptors.get(key);
  if(!interceptor)return false;
  try{await interceptor.close()}finally{interceptors.delete(key)}
  return true;
}

async function closeAllInterceptors() {
  for(const interceptor of interceptors.values()){
    try{await interceptor.close()}catch{}
  }
  interceptors.clear();
}


// A gate is installed at document start as well as in the current renderer.
// If the debugger cannot attach or its heartbeat stops, user Send stays blocked
// rather than silently bypassing Prefix insertion. This does not cover native
// sends outside the instrumented renderer and must not be called full E2E proof.
async function gateScriptIds(target) {
  const ids=await evaluate(target,
    "(()=>Array.isArray(window.__sparkCiiGateDocumentIds)?" +
    "window.__sparkCiiGateDocumentIds.filter(x=>typeof x==='string'&&x.length<100):[])()",
    {timeoutMs:2000});
  return Array.isArray(ids)?ids.slice(0,8):[];
}
async function ensureEgressGate(target) {
  const key=interceptorKey(target);
  // Protect the active page before registering its future-document copy.
  const result=await evaluate(target,buildEgressGateExpression(),{timeoutMs:3000});
  if(!["SPARK_CII_GATE_INSTALLED","SPARK_CII_GATE_ALREADY",
        "SPARK_CII_GATE_UPGRADED"].includes(result))
    throw new Error("EGRESS_GATE_NOT_INSTALLED");
  const state=await evaluate(target,
    "(()=>window.__sparkCiiGate?.getState?.()??null)()",{timeoutMs:2000});
  if(state?.enabled!==true || state.revision!=="EGRESS_SEND_GATE_V3")
    throw new Error("EGRESS_GATE_NOT_ENABLED_OR_OUTDATED");
  let record=gateRegistrations.get(key);
  if(record && record.ws!==target.webSocketDebuggerUrl){
    gateRegistrations.delete(key);
    record=null;
  }
  if(!record){
    // Recover registration IDs from a previously force-killed watcher before
    // adding a new script. The marker holds opaque CDP IDs, never user text.
    for(const id of await gateScriptIds(target)){
      try{await removeFutureDocumentScript(target,id,{timeoutMs:2000})}catch{}
    }
    const identifier=await installForFutureDocuments(target,buildEgressGateExpression(),
      {timeoutMs:4000});
    gateRegistrations.set(key,{identifier,ws:target.webSocketDebuggerUrl});
    await evaluate(target,"(()=>{window.__sparkCiiGateDocumentIds="+
      JSON.stringify([identifier])+";return true})()",{timeoutMs:2000});
  }
  return state;
}
async function removeEgressGate(target) {
  const key=interceptorKey(target),record=gateRegistrations.get(key);
  const ids=new Set([...(await gateScriptIds(target)),
    ...(record?[record.identifier]:[])]);
  // Remove document-start scripts before disabling the current page.
  for(const id of ids){
    try{await removeFutureDocumentScript(target,id,{timeoutMs:2000})}catch{}
  }
  try{await evaluate(target,
    "(()=>{delete window.__sparkCiiGateDocumentIds;return true})()",
    {timeoutMs:1500})}catch{}
  try{await evaluate(target,buildEgressGateDisableExpression(),{timeoutMs:2000})}catch{}
  gateRegistrations.delete(key);
}
async function closeMissingGates(targets) {
  const keep=new Set(targets.map(interceptorKey));
  for(const key of gateRegistrations.keys()){
    if(!keep.has(key))gateRegistrations.delete(key);
  }
}

// Presentation masking is independent of the old ProseMirror injection
// guard. It never changes a submitted request or the app's message model.
async function getDisplayMaskScriptIds(target) {
  const ids=await evaluate(target,
    "(()=>Array.isArray(window.__sparkCiiDisplayDocumentIds)?" +
    "window.__sparkCiiDisplayDocumentIds.filter(x=>typeof x==='string'&&x.length<100):[])()",
    {timeoutMs:2000});
  return Array.isArray(ids)?ids.slice(0,8):[];
}
async function ensureDisplayMask(target,prefix) {
  const key=interceptorKey(target);
  const expr=buildDisplayMaskExpression(prefix);
  const installed=await evaluate(target,expr,{timeoutMs:4000});
  if(!["SPARK_CII_DISPLAY_INSTALLED","SPARK_CII_DISPLAY_ALREADY"].includes(installed))
    throw new Error("CII_DISPLAY_MASK_NOT_INSTALLED");
  const state=await evaluate(target,
    "(()=>window.__sparkCiiDisplayMask?.getState?.()??null)()",{timeoutMs:2500});
  if(state?.enabled!==true || state.version!=="CII_DISPLAY_MASK_V1")
    throw new Error("CII_DISPLAY_MASK_INACTIVE");
  let record=displayRegistrations.get(key);
  if(record && record.ws!==target.webSocketDebuggerUrl){
    displayRegistrations.delete(key);
    record=null;
  }
  if(!record || record.prefix!==prefix){
    const existing=await getDisplayMaskScriptIds(target);
    for(const id of new Set([...existing,...(record?[record.identifier]:[])])){
      try{await removeFutureDocumentScript(target,id,{timeoutMs:2500})}catch{}
    }
    const identifier=await installForFutureDocuments(target,expr,{timeoutMs:4000});
    displayRegistrations.set(key,{identifier,ws:target.webSocketDebuggerUrl,prefix});
    await evaluate(target,
      "(()=>{window.__sparkCiiDisplayDocumentIds="+JSON.stringify([identifier])+
      ";return true})()",{timeoutMs:2000});
  }
  return state;
}
async function removeDisplayMask(target) {
  const key=interceptorKey(target);
  const record=displayRegistrations.get(key);
  const ids=new Set([...(await getDisplayMaskScriptIds(target)),
    ...(record?[record.identifier]:[])]);
  for(const id of ids){
    try{await removeFutureDocumentScript(target,id,{timeoutMs:2500})}catch{}
  }
  try{await evaluate(target,
    "(()=>{delete window.__sparkCiiDisplayDocumentIds;return true})()",
    {timeoutMs:1500})}catch{}
  try{await evaluate(target,buildDisableDisplayMaskExpression(),
    {timeoutMs:3000})}catch{}
  displayRegistrations.delete(key);
}
function closeMissingDisplayMasks(targets) {
  const keep=new Set(targets.map(interceptorKey));
  for(const key of displayRegistrations.keys()){
    if(!keep.has(key))displayRegistrations.delete(key);
  }
}

export function evaluateCiiReadiness(target,state,now=Date.now()) {
  if(state?.stage==="EGRESS_REQUEST_BOUNDARY"){
    if(state.enabled!==true || state.gate?.enabled!==true)
      return {active:false,mode:"EGRESS_GATE_MISSING"};
    if(state.gate.revision!=="EGRESS_SEND_GATE_V3")
      return {active:false,mode:"EGRESS_GATE_OUTDATED"};
    if(state.displayMask?.enabled!==true ||
       state.displayMask?.version!=="CII_DISPLAY_MASK_V1")
      return {active:false,mode:"DISPLAY_MASK_MISSING"};
    if(state.displayScriptReady!==true)
      return {active:false,mode:"DISPLAY_MASK_DOCUMENT_START_MISSING"};
    if(!breakpointStateIsFresh(state.dispatchBreakpoint,now))
      return {active:false,mode:"EGRESS_BOUNDARY_MISSING_OR_STALE"};
    if(state.gate.armed!==true)
      return {active:false,mode:"EGRESS_SEND_GATE_NOT_ARMED"};
    if(state.dispatchBreakpoint.status==="ERROR")
      return {active:false,mode:"EGRESS_INTERCEPTOR_ERROR"};
    return {active:true,mode:Number(state.dispatchBreakpoint.forwarded)>0?
      "EGRESS_REQUEST_PREFIX_VERIFIED_LOCAL":"EGRESS_BOUNDARY_ARMED_UNVERIFIED"};
  }
  if(state?.enabled === true && state?.implementation === "0.0.2" &&
      state?.stage === "ORIGINAL_EDITOR_INSERT") {
    if (state.safeBypass === true || Number(state.blocked) > 0) {
      return {active:false,mode:"ORIGINAL_EDITOR_INSERT_SAFE_BYPASS"};
    }
    return {active:true,mode:state.editorReady ?
      "ORIGINAL_EDITOR_INSERT_ARMED" : "ORIGINAL_EDITOR_INSERT_WAITING_EDITOR"};
  }
  if(state?.enabled!==true||state?.implementation!=="0.0.2"){
    return {active:false,mode:"GUARD_MISSING_OR_MISMATCHED"};
  }
  const desktop=target?.url?.startsWith("app:");
  const nativeReady=state?.transportRevision==="native-dispatch-v1" &&
    state?.egressHooks?.nativeDispatch===true &&
    state?.dryRunVerified===true &&
    ["ARMED_UNVERIFIED","MATCHED_OUTBOUND"].includes(state?.nativeDispatchStatus);
  if(desktop&&nativeReady){
    if(Number(state?.nativeDispatchUnrecognized)>0){
      return {active:false,mode:"NATIVE_DISPATCH_UNRECOGNIZED"};
    }
    return {active:true,mode:"NATIVE_DISPATCH_EGRESS"};
  }
  const breakpoint=state.dispatchBreakpoint;
  if(!breakpointStateIsFresh(breakpoint,now)){
    return {active:false,mode:desktop?
      "NATIVE_DISPATCH_UNAVAILABLE":"DISPATCH_BREAKPOINT_MISSING_OR_STALE"};
  }
  if(breakpoint.status==="ERROR"||Number(breakpoint.blocked)>0){
    return {active:false,mode:"DISPATCH_BREAKPOINT_ERROR"};
  }
  return {active:true,mode:"START_COMPLETION_STREAM_EGRESS"};
}

async function matchingTargets(port) {
  const targets = await listTargets({ host: "127.0.0.1", port, timeoutMs: 1800 });
  return targets.filter(isCiiTarget);
}

async function inspect(targets) {
  const results=[];
  for(const target of targets){
    try{
      const gate=await evaluate(target,
        "(()=>window.__sparkCiiGate?.getState?.()??null)()",{timeoutMs:3000});
      if(gate){
        const breakpoint=await pageBreakpointState(target);
        const displayMask=await evaluate(target,
          "(()=>window.__sparkCiiDisplayMask?.getState?.()??null)()",
          {timeoutMs:3000});
        const scriptReady=await evaluate(target,
          "(()=>Array.isArray(window.__sparkCiiDisplayDocumentIds)&&" +
          "window.__sparkCiiDisplayDocumentIds.length>0)()",{timeoutMs:2000});
        const state={enabled:gate.enabled,stage:"EGRESS_REQUEST_BOUNDARY",
          gate,displayMask,displayScriptReady:scriptReady===true,
          dispatchBreakpoint:breakpoint};
        const readiness=evaluateCiiReadiness(target,state);
        results.push({target:typeOfTarget(target),active:readiness.active,
          readiness:readiness.mode,traceReady:true,composerArgumentMerged:false,
          localForwarded:Number(breakpoint?.forwarded)||0,
          requestBoundaryVerified:(Number(breakpoint?.forwarded)||0)>0,
          actualNetworkSubmitObserved:false,outboundPatchObserved:false,state});
        continue;
      }
      const guard=await evaluate(target,buildReadyExpression(),{timeoutMs:4000});
      if (guard?.stage === "ORIGINAL_EDITOR_INSERT") {
        const readiness=evaluateCiiReadiness(target,guard);
        results.push({target:typeOfTarget(target),active:readiness.active,
          readiness:readiness.mode,composerArgumentMerged:false,
          traceReady:guard.traceVersion===1 && Number.isSafeInteger(guard.tracePending),
          localForwarded:Number(guard.forwarded)||0,
          actualNetworkSubmitObserved:false,outboundPatchObserved:false,state:guard});
        continue;
      }
      const breakpoint=await pageBreakpointState(target);
      const state=guard?{...guard,dispatchBreakpoint:breakpoint}:guard;
      const readiness=evaluateCiiReadiness(target,state);
      const nativeObserved=Number(state?.outboundModified)>0 &&
        state?.lastEgressChannel==="NATIVE_DISPATCH";
      results.push({target:typeOfTarget(target),active:readiness.active,
        readiness:readiness.mode,composerArgumentMerged:false,
        outboundPatchObserved:nativeObserved||(Number(breakpoint?.forwarded)||0)>0,
        actualNetworkSubmitObserved:(Number(breakpoint?.forwarded)||0)>0,state});
    }catch(error){
      results.push({target:typeOfTarget(target),active:false,error:error.message});
    }
  }
  return results;
}

async function install(targets,prefix) {
  // Mandatory egress-first deployment. The send gate is installed before the
  // old ProseMirror hook is removed or the debugger intercept is armed.
  // A missing controller is never a reason to send the original unprefixed.
  await closeMissingInterceptors(targets);
  await closeMissingGates(targets);
  closeMissingDisplayMasks(targets);
  const results=[];
  for(const target of targets){
    try{
      await ensureEgressGate(target);
      const display=await ensureDisplayMask(target,prefix);
      const old=await evaluate(target,
        "(()=>{const g=window.__sparkCiiGuard;if(!g)return 'NONE';" +
        "if(typeof g.disable!=='function')return 'NOT_REMOVABLE';" +
        "g.disable();return window.__sparkCiiGuard?'STILL_ACTIVE':'REMOVED'})()",
        {timeoutMs:3000});
      if(!["NONE","REMOVED"].includes(old))
        throw new Error("LEGACY_COMPOSER_GUARD_NOT_REMOVED");
      try{await evaluate(target,
        "(()=>globalThis.__sparkCiiEarly?.disable?.()??null)()",
        {timeoutMs:1500})}catch{}
      const interceptor=await ensureBreakpointInterceptor(target,prefix);
      const gate=await evaluate(target,
        "(()=>window.__sparkCiiGate?.getState?.()??null)()",{timeoutMs:3000});
      const breakpoint=await pageBreakpointState(target);
      const state={enabled:gate?.enabled===true,stage:"EGRESS_REQUEST_BOUNDARY",
        gate,displayMask:display,displayScriptReady:true,
        dispatchBreakpoint:breakpoint};
      const readiness=evaluateCiiReadiness(target,state);
      results.push({target:typeOfTarget(target),active:readiness.active,
        result:readiness.mode,stage:state.stage,readiness:readiness.mode,
        traceReady:true,sourceCommit:"EGRESS_CDP_BREAKPOINT",
        intercepted:interceptor.attemptId,localForwarded:interceptor.forwarded,
        blocked:interceptor.blocked,actualNetworkSubmitObserved:false,
        outboundPatchObserved:false,requestBoundaryVerified:interceptor.forwarded>0});
    }catch(error){
      // Keep the send gate installed. Failure must not turn into bypass.
      results.push({target:typeOfTarget(target),active:false,
        readiness:"EGRESS_FAIL_CLOSED",error:failureCode(error)});
    }
  }
  return results;
}

async function disable(targets) {
  const results=[];
  for(const target of targets){
    try{
      const breakpointClosed=await closeBreakpointInterceptor(target);
      await removeEgressGate(target);
      await removeDisplayMask(target);
      let earlyResult=null;
      try{earlyResult=await evaluate(target,
        "(()=>globalThis.__sparkCiiEarly?.disable?.()??null)()",
        {timeoutMs:1500})}catch{}
      const result=await evaluate(target,buildDisableExpression(),{timeoutMs:2000});
      results.push({target:typeOfTarget(target),disabled:true,result,
        breakpointClosed,earlyResult});
    }catch(error){
      results.push({target:typeOfTarget(target),disabled:false,
        reason:failureCode(error)});
    }
  }
  return results;
}

export async function executeOnce(options, dependencies = {}) {
  const getPort = dependencies.resolvePort ?? resolvePort;
  const getTargets = dependencies.matchingTargets ?? matchingTargets;
  const inspectTargets = dependencies.inspect ?? inspect;
  const installTargets = dependencies.install ?? install;
  const disableTargets = dependencies.disable ?? disable;
  const getPrefix = dependencies.loadPrefix ?? loadPrefix;
  if (options.command === "validate") {
    const prefix = await getPrefix(options.configPath);
    return { command: "validate", valid: true, configPath: options.configPath,
      prefixChars: prefix.length, fingerprint: fingerprint(prefix) };
  }
  if (options.command === "audit") {
    return { command: "audit", ...(await readAuditTail({limit:options.tail})) };
  }
  const port = await getPort(options.port);
  const targets = await getTargets(port);
  if (options.command === "probe") {
    const results = await inspectTargets(targets);
    const active = targets.length > 0 && results.length === targets.length &&
      results.every((x) => x.active && x.state?.enabled === true);
    const suspectedUnprotected = results.reduce((total, entry) =>
      total + (Number(entry.state?.suspectedMissingPrefix) || 0), 0);
    const traceReady = targets.length > 0 && results.length === targets.length &&
      results.every(entry => entry.traceReady === true);
    return { command: "probe", port, targetCount: targets.length,
      active, healthy: active && suspectedUnprotected === 0 &&
        results.every(entry => entry.state?.stage !== "EGRESS_REQUEST_BOUNDARY" ||
          entry.requestBoundaryVerified === true),
      traceReady, actualSubmitObserved: results.some(x => x.actualNetworkSubmitObserved),
      suspectedUnprotected, targets: results };
  }
  if (options.command === "protect") {
    // One-shot fail-closed guard used before watcher replacement. It does not
    // attach a temporary debugger or claim that Prefix was sent.
    const results=[];
    for(const target of targets){
      try{
        const state=await evaluate(target,buildEgressGateExpression(),{timeoutMs:3000});
        results.push({target:typeOfTarget(target),protected:
          ["SPARK_CII_GATE_INSTALLED","SPARK_CII_GATE_ALREADY",
            "SPARK_CII_GATE_UPGRADED"].includes(state)});
      }catch{results.push({target:typeOfTarget(target),protected:false})}
    }
    if(!targets.length||results.some(r=>!r.protected))
      throw new Error("EGRESS_FAIL_CLOSED_PREPARE_FAILED");
    return {command:"protect",targetCount:targets.length,results};
  }
  if (options.command === "disable") {
    return { command: "disable", port, targetCount: targets.length,
      results: await disableTargets(targets) };
  }
  if (options.command === "once") {
    // Persistent CDP breakpoints vanish when this one-shot process exits.
    // Reporting one-shot injection success would be a false guarantee.
    throw new Error("EGRESS_REQUIRES_PERSISTENT_WATCHER: use run or start.");
  }
  throw new Error("Unknown Cii command: " + options.command);
}

// Write browser-produced metadata first, then acknowledge it. A logging failure
// prevents acknowledgement, so the next poll can retry without exposing text.
const traceUnavailableAt = new Map();
function targetAuditKey(target) {
  return createHash("sha256").update(String(interceptorKey(target))).digest("hex")
    .slice(0, 16).toUpperCase();
}
export async function persistCiiTraces(targets, audit, { inspectTrace = async (target) =>
  interceptors.get(interceptorKey(target))?.peekTrace() ??
    evaluate(target, buildTraceExpression(), { timeoutMs: 3000 }),
  acknowledge = async (target, seq) =>
    interceptors.get(interceptorKey(target))?.ackTrace(seq) ??
    evaluate(target, buildTraceAckExpression(seq), { timeoutMs: 3000 }) } = {}) {
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const snapshot = await inspectTrace(target);
    const kind = typeOfTarget(target);
    const targetKey = targetAuditKey(target);
    if (!snapshot || !Array.isArray(snapshot.events)) {
      // A missing trace API is an observable gap, not evidence of insertion.
      // Throttle warning records for unavailable or legacy renderer targets.
      const now = Date.now();
      if (now - (traceUnavailableAt.get(targetKey) ?? 0) >= 60_000) {
        await audit.write("TARGET_TRACE_UNAVAILABLE", {
          reason: "TRACE_API_MISSING", targetKind: kind, targetIndex: index, targetKey
        });
        traceUnavailableAt.set(targetKey, now);
      }
      continue;
    }
    traceUnavailableAt.delete(targetKey);
    const events = snapshot.events;
    for (const event of events) {
      await audit.write(event.event, { attemptId: event.attemptId, seq: event.seq,
        occurredAt: event.at, reason: event.reason, channel: event.channel,
        targetKind: kind, targetIndex: index, targetKey });
    }
    if (Number.isSafeInteger(snapshot.overflow) && snapshot.overflow > 0) {
      await audit.write("TRACE_OVERFLOW", { count: snapshot.overflow,
        targetKind: kind, targetIndex: index, targetKey });
    }
    if (events.length > 0 || snapshot.overflow > 0) {
      const last = events.at(-1)?.seq;
      if (!Number.isSafeInteger(last) || last < 0) throw new Error("CII trace sequence invalid");
      const accepted = await acknowledge(target, last);
      if (accepted !== true) throw new Error("CII trace acknowledgement failed");
    }
  }
}

export async function runWatcher(
  options,
  report = (value) => process.stdout.write(JSON.stringify(value) + "\n"),
  dependencies = {}
) {
  const getPort = dependencies.resolvePort ?? resolvePort;
  const getTargets = dependencies.matchingTargets ?? matchingTargets;
  const installTargets = dependencies.install ?? install;
  const disableTargets = dependencies.disable ?? disable;
  const getPrefix = dependencies.loadPrefix ?? loadPrefix;
  const persist = dependencies.persistTraces ?? persistCiiTraces;
  const audit = dependencies.audit ?? new CiiAudit();
  const wait = dependencies.pause ?? pause;
  const shouldStop = dependencies.shouldStop ?? (() => false);
  // An unrecorded watcher must not silently claim to protect chat messages.
  await audit.write("WATCHER_STARTED", { status: "STARTED" });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let errors = 0;
  let lastReport = "";
  let lastPort = null;
  let lastStatus = null;
  let lastHeartbeat = 0;
  try {
    while (!stopping && !shouldStop()) {
      let targets = [];
      try {
        lastPort = await getPort(options.port);
        targets = await getTargets(lastPort);
        const prefix = await getPrefix(options.configPath);
        const results = await installTargets(targets, prefix);
        const suspectedBypass = results.reduce((total, result) =>
          total + (Number(result.suspectedMissingPrefix) || 0), 0);
        const egressArmedUnverified=results.some(r=>
          r.stage==="EGRESS_REQUEST_BOUNDARY" && r.requestBoundaryVerified!==true);
        const status = targets.length === 0 ? "NO_TARGET" :
          results.length === targets.length && results.every((r) => r.active) ?
            (suspectedBypass > 0 ? "SUSPECTED_BYPASS" :
              egressArmedUnverified ? "ARMED_UNVERIFIED" : "ACTIVE") : "DEGRADED";
        // Always drain content-free events, including SAFE_BYPASS and failures.
        // Skipping DEGRADED discarded the exact evidence needed to diagnose
        // failed Prefix insertion on one of multiple chat windows.
        if (targets.length > 0) await persist(targets, audit);
        errors = 0;
        const reportValue = { status, port: lastPort,
          targetCount: targets.length, suspectedBypass,
          fingerprint: fingerprint(prefix), results };
        const summary = JSON.stringify(reportValue);
        const now = Date.now();
        if (status !== lastStatus || now - lastHeartbeat >= 60_000) {
          await audit.write("WATCHER_STATE", { status, port: lastPort,
            targetCount: targets.length, count: suspectedBypass });
          lastHeartbeat = now;
          lastStatus = status;
        }
        if (summary !== lastReport) { report(reportValue); lastReport = summary; }
      } catch (error) {
        errors += 1;
        // Never disable a fail-closed send gate because the watcher errored.
        // A transient CDP/audit failure must not turn CII into silent bypass.
        const reason = failureCode(error);
        // Avoid raw error paths, message contents or secret values in the ledger.
        try {
          if (lastStatus !== "DISCONNECTED" || errors === 1 || errors % 60 === 0) {
            await audit.write("WATCHER_FAILURE", { reason, count: errors,
              targetCount: targets.length });
          }
        } catch {
          // The UI supervisor independently records missing CII; never claim ACTIVE.
        }
        lastStatus = "DISCONNECTED";
        const reportValue = { status: "DISCONNECTED", port: lastPort,
          retry: errors, reason };
        const summary = JSON.stringify(reportValue);
        if (summary !== lastReport) { report(reportValue); lastReport = summary; }
      }
      if (!stopping && !shouldStop()) await wait(options.intervalMs);
    }
  } finally {
    try { const port = await getPort(options.port); await disableTargets(await getTargets(port)); }
    catch {}
    try { await audit.write("WATCHER_STOPPED", { status: "STOPPED" }); } catch {}
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const HELP = [
  "SPARK Cii (Custom Instruction Injector)",
  "",
  "Usage:",
  "  node mod/spark_cii/src/cli.mjs <validate|probe|protect|run|disable> [options]",
  "",
  "Commands:",
  "  validate          Validate the private config without connecting to CDP",
  "  probe             Read-only status of eligible ChatGPT pages",
  "  once              Deprecated: fails (egress interception needs persistent watcher)",
  "  protect           Install fail-closed UI gate before watcher replacement",
  "  run               Keep Cii installed across reloads, until Ctrl+C",
  "  disable           Remove Cii listeners/masking from current page(s)",
  "  audit             Read recent content-free CII diagnostic events (no CDP required)",
  "",
  "Options:",
  "  --config <path>    UTF-8 plain-text instructions (default: .runtime/config/config_cii)",
  "  --port <number>    Loopback CDP port (default: log/system/active.json)",
  "  --interval <ms>    Poll interval for run (250..60000, default 500)",
  "  --tail <1..200>    Audit record count (default 30)",
  "  --json             Compact JSON result",
  "",
  "Security: local CDP only; no user messages, login inputs, or credentials are logged.",
  "",
].join("\n");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command || options.command === "--help" || options.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (options.command === "run") {
    await runWatcher(options);
    return;
  }
  const result = await executeOnce(options);
  process.stdout.write(JSON.stringify(result, null, options.json ? 0 : 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write("spark-cii: " + error.message + "\n");
    process.exitCode = 1;
  });
}
