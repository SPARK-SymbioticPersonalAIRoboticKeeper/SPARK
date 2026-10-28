// Durable, content-free CII diagnostics. Never persist message/prefix text, URLs or credentials.
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { sparkDataRoot } from "../../../out/spark/data-path.mjs";
import { SPARK_ROOT } from "./config.mjs";

const EVENTS = new Set(["WATCHER_STARTED","WATCHER_STATE","WATCHER_FAILURE","WATCHER_STOPPED",
 "MESSAGE_INTERCEPTED","PREFIX_VERIFIED","MESSAGE_REPLAYED_UNCONFIRMED",
 "MESSAGE_BLOCKED","DISPLAY_MASKED","TRACE_OVERFLOW","UI_CII_STATE",
 "SEND_EVENT_SEEN","EDITOR_RESOLVED","MESSAGE_BYPASSED",
 "PREFIX_PLAN_VERIFIED","PREFIX_PLAN_FAILED","PREFIX_APPLIED",
 "PREFIX_ALREADY_PRESENT","PREFIX_READBACK_VERIFIED","SEND_BUTTON_READY",
 "TARGET_TRACE_UNAVAILABLE","EGRESS_BOUNDARY_ARMED","EGRESS_NON_USER_PASSTHROUGH"]);
const CODES = /^[A-Z][A-Z0-9_]{0,63}$/;
const FIELDS = ["reason","status","action","channel","targetKind",
 "targetIndex","targetKey","attemptId","seq","count","targetCount","port"];
export function ciiAuditPath({root=SPARK_ROOT,dataRoot}={}) {
 return path.join(dataRoot ?? sparkDataRoot({projectRoot:root}), "audit", "cii-events.jsonl");
}
export function safeAuditRecord(event, details={}, {now=()=>new Date(),source="cii",pid=process.pid}={}) {
 if(!EVENTS.has(event)) throw new Error("Invalid CII audit event");
 const record={schema:1,at:now().toISOString(),source:source==="ui"?"ui":"cii",
  event,pid:Number.isSafeInteger(pid)&&pid>=0?pid:null};
 if (typeof details?.occurredAt === "string" &&
     /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(details.occurredAt) &&
     !Number.isNaN(Date.parse(details.occurredAt))) record.occurredAt = details.occurredAt;
 for(const key of FIELDS){
  const v=details?.[key];
  if(key==="targetKind"){if(["desktop","web","unknown"].includes(v))record[key]=v;}
  else if(typeof v==="string"&&CODES.test(v))record[key]=v;
  else if(typeof v==="number"&&Number.isSafeInteger(v)&&v>=0)record[key]=v;
 }
 return record;
}
export class CiiAudit {
 constructor({filePath=ciiAuditPath(),source="cii",now}={}) {
  this.filePath=filePath;this.source=source;this.now=now;
 }
 async write(event,details={}){
  const record=safeAuditRecord(event,details,{source:this.source,...(this.now?{now:this.now}:{})});
  const dir=await lstat(path.dirname(this.filePath));
  if(!dir.isDirectory()||dir.isSymbolicLink())throw new Error("CII audit directory invalid");
  try{
   const file=await lstat(this.filePath);
   if(!file.isFile()||file.isSymbolicLink())throw new Error("CII audit file invalid");
  }catch(error){if(error.code!=="ENOENT")throw error;}
  const handle=await open(this.filePath,"a",0o600);
  try{
   if(!(await handle.stat()).isFile())throw new Error("CII audit file type changed");
   const bytes=Buffer.from(JSON.stringify(record)+"\n","utf8");
   if(bytes.byteLength>1024)throw new Error("CII audit record too large");
   await handle.write(bytes);await handle.sync();
  }finally{await handle.close();}
  return record;
 }
}
export function failureCode(error){
 const message=String(error?.message||"");
 if(/CDP|ECONNREFUSED|ECONNRESET|websocket|active\.json|No CDP/i.test(message))return "CDP_UNAVAILABLE";
 if(/config|prefix|UTF-8|ENOENT|EACCES/i.test(message))return "CONFIG_OR_ACCESS_FAILURE";
 if(/CII audit/i.test(message))return "AUDIT_FAILURE";
 return "UNCLASSIFIED_FAILURE";
}

// Bounded read-only inspection; works even when CDP and CII watcher are stopped.
// Never returns fields outside the audit metadata schema.
export async function readAuditTail({ filePath=ciiAuditPath(), limit=30 }={}) {
 if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Audit tail must be 1..200");
 let handle;
 try { handle=await open(filePath,"r"); }
 catch(error){if(error.code==="ENOENT")return {status:"NOT_FOUND",records:[]};throw error;}
 try {
  const info=await handle.stat();
  if(!info.isFile())throw new Error("CII audit file is not regular");
  const length=Math.min(info.size,256*1024);
  const start=info.size-length;
  const buffer=Buffer.alloc(length);
  await handle.read(buffer,0,length,start);
  const lines=buffer.toString("utf8").split(/\r?\n/);
  if(start>0)lines.shift(); // Ignore any partial first record.
  const allow=new Set(["schema","at","occurredAt","source","event","pid",
    "reason","status","action","channel","targetKind","targetIndex","targetKey",
    "attemptId","seq","count","targetCount","port"]);
  const records=[];
  for(const line of lines){
   if(!line.trim())continue;
   try{
    const parsed=JSON.parse(line);
    if(!EVENTS.has(parsed?.event)||parsed?.schema!==1)continue;
    const safe={};
    for(const [key,value] of Object.entries(parsed)) {
     if(!allow.has(key))continue;
     if(key==="at"||key==="occurredAt"){
      if(typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&
         value.length<=32&&!Number.isNaN(Date.parse(value)))safe[key]=value;
     }else if(key==="source"){
      if(value==="cii"||value==="ui")safe[key]=value;
     }else if(key==="targetKind"){
      if(["desktop","web","unknown"].includes(value))safe[key]=value;
     }else if(key==="event"){
      if(EVENTS.has(value))safe[key]=value;
     }else if(key==="schema"||key==="pid"||["targetIndex","attemptId","seq","count","targetCount","port"].includes(key)){
      if(Number.isSafeInteger(value)&&value>=0)safe[key]=value;
     }else if(typeof value==="string"&&CODES.test(value))safe[key]=value;
    }
    records.push(safe);
   }catch{}
  }
  return {status:"OK",records:records.slice(-limit)};
 }finally{await handle.close();}
}
