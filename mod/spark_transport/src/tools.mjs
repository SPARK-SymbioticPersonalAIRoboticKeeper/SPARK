import crypto from 'node:crypto';
import { PolicyError } from './path-policy.mjs';
import { moveToRecycleBin } from './recycle-bin.mjs';
import { runProcess } from './command-runner.mjs';
import { createFilePal } from './file-pal.mjs';

const pathProp = (description, def) => ({ type: 'string', description, ...(def === undefined ? {} : { default: def }) });
const textProp = (description) => ({ type: 'string', description });
const MANAGED_CONTINUE_COMMAND = '__SPARK_CONTINUE__';
const MANAGED_CANCEL_COMMAND = '__SPARK_CANCEL__';

function externalizeManagedResult(result) {
  if (!result || typeof result !== 'object' || typeof result.resumeId !== 'string') return result;
  const { resumeId, ...external } = result;
  if (result.inProgress === true) {
    external.continuation = { command: MANAGED_CONTINUE_COMMAND, args: [resumeId] };
    external.cancellation = { command: MANAGED_CANCEL_COMMAND, args: [resumeId] };
  }
  return external;
}

export const TOOL_DEFINITIONS = Object.freeze([
  { name:'list_directory', title:'List directory', description:'List entries inside configured allowed roots. Relative paths are resolved by root policy; if the same relative path exists in multiple roots the call fails as ambiguous. With multiple roots, an absolute path is accepted only inside one configured root.', inputSchema:{type:'object',properties:{path:pathProp('Directory path. Use an absolute path to disambiguate duplicate relative paths across roots.','.')},additionalProperties:false}, annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}},
  { name:'read_file', title:'Read file', description:'Read a UTF-8 text file inside configured allowed roots. Duplicate relative paths across roots are rejected as ambiguous; use an absolute path to select the intended root.', inputSchema:{type:'object',properties:{path:pathProp('File path. Absolute paths are allowed only when multiple roots are configured and the path is inside one of them.')} ,required:['path'],additionalProperties:false}, annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false}},
  { name:'create_file', title:'Create file', description:'Create one new UTF-8 file. Fails if the target already exists. No companion backup or temporary file is created.', inputSchema:{type:'object',properties:{path:pathProp('Relative file path.'),text:textProp('UTF-8 file content.')},required:['path','text'],additionalProperties:false}, annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
  { name:'write_file', title:'Write file', description:'Replace one existing UTF-8 file without a PAL snapshot. Checkpoint tracked source in Git before editing; non-Git files have no durable rollback.', inputSchema:{type:'object',properties:{path:pathProp('Relative file path.'),text:textProp('Replacement UTF-8 content.')},required:['path','text'],additionalProperties:false}, annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}},
  { name:'modify_file', title:'Modify file', description:'Replace exactly one occurrence of search text without a PAL snapshot. Use a verified Git checkpoint for recoverable source changes.', inputSchema:{type:'object',properties:{path:pathProp('Relative file path.'),search:textProp('Exact text to find once.'),replace:textProp('Replacement text.')},required:['path','search','replace'],additionalProperties:false}, annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}},
  { name:'create_directory', title:'Create directory', description:'Create a directory under the allowed root.', inputSchema:{type:'object',properties:{path:pathProp('Relative directory path.'),recursive:{type:'boolean',default:false}},required:['path'],additionalProperties:false}, annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  { name:'copy_path', title:'Copy file or directory', description:'Copy a file or directory inside the allowed root. Destination must not exist.', inputSchema:{type:'object',properties:{source:pathProp('Relative source path.'),destination:pathProp('Relative destination path.')},required:['source','destination'],additionalProperties:false}, annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
  { name:'move_path', title:'Move or rename file/directory', description:'Directly move or rename one path. No backup sidecar is created. If destination exists, fail with ALREADY_EXISTS and leave both paths unchanged.', inputSchema:{type:'object',properties:{source:pathProp('Relative source path.'),destination:pathProp('Relative destination path.')},required:['source','destination'],additionalProperties:false}, annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}},
  { name:'delete_path', title:'Delete to Recycle Bin', description:'Move a file or directory to the Windows Recycle Bin. Permanent-delete fallback is forbidden.', inputSchema:{type:'object',properties:{path:pathProp('Relative path to delete.')},required:['path'],additionalProperties:false}, annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}},
  { name:'run_command', title:'Run command', description:'Run a non-elevated process with an allowed-root-confined working directory, request-scoped heartbeat/progress, cancellation cleanup, and structured output. There is no default absolute runtime deadline; set timeoutMs only when a real terminal deadline is known. Shell parsing is disabled; invoke cmd.exe or powershell.exe explicitly when needed.', inputSchema:{type:'object',properties:{command:textProp('Executable name/path available to the current user.'),args:{type:'array',items:{type:'string'},default:[]},cwd:pathProp('Relative working directory','.'),timeoutMs:{type:'integer',minimum:1,description:'Optional explicit terminal deadline in milliseconds from command start. Omit for normal long-running work; no default absolute deadline is applied.'}},required:['command'],additionalProperties:false}, annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}},
]);

function hashBytes(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function errorShape(error){
  if(error instanceof PolicyError)return{code:error.code,message:error.message};
  if(error?.code==='EACCES'||error?.code==='EPERM')return{code:'PERMISSION_DENIED',message:'access was denied by the operating system'};
  if(error?.code==='EEXIST'||error?.code==='ALREADY_EXISTS')return{code:'ALREADY_EXISTS',message:'target already exists'};
  if(error?.code==='ENOTEMPTY')return{code:'DIRECTORY_NOT_EMPTY',message:'directory is not empty'};
  if(error?.code)return{code:String(error.code),message:error.message||'the operation failed'};
  return{code:'INTERNAL_ERROR',message:'the operation failed'};
}
function validateOnlyKeys(obj,allowed){return !!obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).every(k=>allowed.has(k));}

export function createToolRuntime({policy,maxReadBytes,stateDir,commandTimeoutMs,commandHeartbeatMs=10000,recycleBin=true,recycle=moveToRecycleBin,runner=runProcess,managedCommands=null,filePal}){
  const files=filePal??createFilePal();

  async function readFile(args){
    if(!validateOnlyKeys(args,new Set(['path']))||typeof args.path!=='string'||!args.path)return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'read_file requires a non-empty string path'}};
    try{
      const r=await policy.resolveFile(args.path);
      if(r.stat.size>maxReadBytes)return{ok:false,error:{code:'FILE_TOO_LARGE',message:`file exceeds the configured ${maxReadBytes} byte read limit`}};
      const bytes=await files.readBytes(r.absolutePath);
      let text;
      try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return{ok:false,error:{code:'UNSUPPORTED_ENCODING',message:'read_file supports UTF-8 text only'}};}
      return{ok:true,path:r.displayPath,type:'file',encoding:'utf-8',bytes:bytes.length,sha256:hashBytes(bytes),text};
    }catch(error){return{ok:false,error:errorShape(error)};}
  }

  async function listDirectory(args={}){
    if(args==null)args={};
    if(!validateOnlyKeys(args,new Set(['path'])))return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'list_directory accepts only path'}};
    const requested=args.path??'.';
    if(typeof requested!=='string')return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'path must be a string'}};
    try{
      const r=await policy.resolveDirectory(requested);
      const physical=await files.listDirectory(r.absolutePath);
      const base=r.displayPath==='.'?'':r.displayPath;
      return{ok:true,path:r.displayPath,type:'directory',entries:physical.map((item)=>({...item,relativePath:[base,item.name].filter(Boolean).join('/')}))};
    }catch(error){return{ok:false,error:errorShape(error)};}
  }

  async function createFile(args){
    if(!validateOnlyKeys(args,new Set(['path','text']))||typeof args.path!=='string'||typeof args.text!=='string')return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'create_file requires path and text'}};
    try{
      const t=await policy.resolveForCreate(args.path);
      const created=await files.createTextFile(t.absolutePath,args.text);
      return{ok:true,path:t.displayPath,...created};
    }catch(error){return{ok:false,error:errorShape(error)};}
  }

  async function writeFile(args){
    if(!validateOnlyKeys(args,new Set(['path','text']))||typeof args.path!=='string'||typeof args.text!=='string')return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'write_file requires path and text'}};
    try{
      const r=await policy.resolveMutationEntry(args.path);
      if(!r.stat.isFile())throw new PolicyError('NOT_A_FILE','path is not a regular file');
      const result=await files.replaceTextFile({absolutePath:r.absolutePath,displayPath:r.displayPath,text:args.text});
      return{ok:true,path:r.displayPath,...result};
    }catch(error){return{ok:false,error:errorShape(error)};}
  }

  async function modifyFile(args){
    if(!validateOnlyKeys(args,new Set(['path','search','replace']))||typeof args.path!=='string'||typeof args.search!=='string'||typeof args.replace!=='string'||!args.search)return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'modify_file requires path, non-empty search, and replace'}};
    try{
      const r=await policy.resolveMutationEntry(args.path);
      if(!r.stat.isFile())throw new PolicyError('NOT_A_FILE','path is not a regular file');
      const bytes=await files.readBytes(r.absolutePath);
      let text;
      try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return{ok:false,error:{code:'UNSUPPORTED_ENCODING',message:'modify_file supports UTF-8 text only'}};}
      const first=text.indexOf(args.search);
      if(first<0)return{ok:false,error:{code:'SEARCH_NOT_FOUND',message:'search text was not found'}};
      if(text.indexOf(args.search,first+args.search.length)>=0)return{ok:false,error:{code:'SEARCH_NOT_UNIQUE',message:'search text occurs more than once'}};
      const beforeSha256=hashBytes(bytes);
      const updated=text.slice(0,first)+args.replace+text.slice(first+args.search.length);
      const result=await files.replaceTextFile({absolutePath:r.absolutePath,displayPath:r.displayPath,text:updated,expectedBeforeSha256:beforeSha256});
      return{ok:true,path:r.displayPath,replacements:1,beforeSha256:result.before.sha256,afterSha256:result.after.sha256};
    }catch(error){return{ok:false,error:errorShape(error)};}
  }

  async function createDirectory(args){
    if(!validateOnlyKeys(args,new Set(['path','recursive']))||typeof args.path!=='string'||(args.recursive!==undefined&&typeof args.recursive!=='boolean'))return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'create_directory requires path and optional recursive boolean'}};
    try{
      const t=await policy.resolveForCreate(args.path,{parentMustExist:!args.recursive});
      await files.createDirectory(t.absolutePath,args.recursive===true);
      return{ok:true,path:t.displayPath,type:'directory'};
    }catch(error){return{ok:false,error:errorShape(error)};}
  }

  async function copyPath(args){
    if(!validateOnlyKeys(args,new Set(['source','destination']))||typeof args.source!=='string'||typeof args.destination!=='string')return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'copy_path requires source and destination'}};
    try{
      const s=await policy.resolveMutationEntry(args.source,'R');
      const d=await policy.resolveForCreate(args.destination,{permission:'W'});
      await files.copyPath(s.absolutePath,d.absolutePath,s.stat.isDirectory());
      return{ok:true,source:s.displayPath,destination:d.displayPath,type:s.stat.isDirectory()?'directory':'file'};
    }catch(error){return{ok:false,error:errorShape(error)};}
  }

  async function movePath(args){
    if(!validateOnlyKeys(args,new Set(['source','destination']))||typeof args.source!=='string'||typeof args.destination!=='string')return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'move_path requires source and destination'}};
    try{
      const s=await policy.resolveMutationEntry(args.source);
      const d=await policy.resolveForCreate(args.destination);
      await files.movePath(s.absolutePath,d.absolutePath);
      return{ok:true,source:s.displayPath,destination:d.displayPath};
    }catch(error){return{ok:false,error:errorShape(error)};}
  }

  async function deletePath(args){
    if(!validateOnlyKeys(args,new Set(['path']))||typeof args.path!=='string'||!args.path)return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'delete_path requires path'}};
    if(!recycleBin)return{ok:false,error:{code:'RECYCLE_BIN_DISABLED',message:'permanent deletion is not permitted; enable Recycle Bin policy'}};
    try{
      const r=await policy.resolveMutationEntry(args.path);
      if(r.displayPath==='.')throw new PolicyError('ROOT_DELETE_FORBIDDEN','allowed root cannot be deleted');
      await recycle(r.absolutePath,r.stat.isDirectory());
      return{ok:true,path:r.displayPath,recovery:{type:'windows-recycle-bin'}};
    }catch(error){return{ok:false,error:errorShape(error)};}
  }

  async function runCommand(args,context={}){
    if(!validateOnlyKeys(args,new Set(['command','args','cwd','timeoutMs']))||typeof args.command!=='string'||!args.command)return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'run_command requires command and optional args/cwd/timeoutMs'}};
    const commandArgs=args.args??[];
    if(!Array.isArray(commandArgs)||!commandArgs.every((value)=>typeof value==='string'))return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'args must be an array of strings'}};

    if(args.command===MANAGED_CONTINUE_COMMAND||args.command===MANAGED_CANCEL_COMMAND){
      if(commandArgs.length!==1||!commandArgs[0])return{ok:false,error:{code:'INVALID_ARGUMENTS',message:`${args.command} requires exactly one opaque continuation token in args`}};
      if(!managedCommands)return{ok:false,error:{code:'MANAGED_COMMANDS_UNAVAILABLE',message:'managed command continuation is unavailable in this runtime'}};
      try{
        const result=await managedCommands.resume(commandArgs[0],{cancel:args.command===MANAGED_CANCEL_COMMAND},context);
        return{...externalizeManagedResult(result),elevated:false};
      }catch(error){return{ok:false,error:errorShape(error)};}
    }

    try{
      const cwd=await policy.resolveCwd(args.cwd??'.');
      const timeout=args.timeoutMs??commandTimeoutMs??null;
      if(timeout!==null&&(!Number.isSafeInteger(timeout)||timeout<=0))return{ok:false,error:{code:'INVALID_ARGUMENTS',message:'timeoutMs must be a positive integer when provided'}};
      if(managedCommands){
        const result=await managedCommands.startAndWait({
          command:args.command,
          args:commandArgs,
          cwd:cwd.absolutePath,
          timeoutMs:timeout,
        },context);
        return{...externalizeManagedResult(result),cwd:cwd.displayPath,elevated:false};
      }
      const result=await runner({
        command:args.command,
        args:commandArgs,
        cwd:cwd.absolutePath,
        timeoutMs:timeout,
        heartbeatIntervalMs:commandHeartbeatMs,
        onHeartbeat:context.onProgress,
        signal:context.signal,
      });
      return{...result,cwd:cwd.displayPath,elevated:false};
    }catch(error){return{ok:false,error:errorShape(error)};}
  }

  async function call(name,args={},context={}){
    const table={read_file:readFile,list_directory:listDirectory,create_file:createFile,write_file:writeFile,modify_file:modifyFile,create_directory:createDirectory,copy_path:copyPath,move_path:movePath,delete_path:deletePath,run_command:runCommand};
    const fn=table[name];
    return fn?fn(args,context):{ok:false,error:{code:'UNKNOWN_TOOL',message:`unknown tool: ${String(name)}`}};
  }

  return{call,readFile,listDirectory,createFile,writeFile,modifyFile,createDirectory,copyPath,movePath,deletePath,runCommand,filePal:files};
}
