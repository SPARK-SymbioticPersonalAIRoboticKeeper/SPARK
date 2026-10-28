import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
export async function freePort(){return await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
export async function makeFixture(){const base=await fs.mkdtemp(path.join(os.tmpdir(),'spark-'));const root=path.join(base,'root');const outside=path.join(base,'outside');await fs.mkdir(path.join(root,'nested'),{recursive:true});await fs.mkdir(outside,{recursive:true});await fs.writeFile(path.join(root,'hello.txt'),'hello\n','utf8');await fs.writeFile(path.join(root,'nested','n.txt'),'nested\n','utf8');await fs.writeFile(path.join(outside,'secret.txt'),'SECRET\n','utf8');return{base,root,outside,cleanup:()=>fs.rm(base,{recursive:true,force:true})};}
export function requestEnvelope(method,params={},id=1){return{jsonrpc:'2.0',id,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{name:'test',version:'1'}}}};}
export function headersFor(body){const h={'content-type':'application/json','mcp-protocol-version':'2026-07-28','mcp-method':body.method};if(body.method==='tools/call')h['mcp-name']=body.params.name;return h;}
