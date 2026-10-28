import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const read=rel=>readFile(path.join(ROOT,rel),'utf8');
const modules=[
  ['spark_transport','TRANSPORT'],
  ['spark_ui','UI'],
  ['spark_log','LOG'],
  ['spark_cii','CII']
];
const sourceDocuments=['README.md',...modules.flatMap(([module,manual])=>
  ['doc/'+manual+'.md','mod/'+module+'/README.md']),
  'mod/spark_log/backup/README.md','mod/spark_log/viewer/README.md',
  'doc/COLD_START.md','doc/ARCH.md','doc/ARCH_QGate.md','doc/RELEASE.md'];

test('6.5 README is durable project introduction without reviewer notes or runtime telemetry',async()=>{
  const s=await read('README.md');
  assert.match(s,/^# SPARK — Symbiotic Personal AI Robotic Keeper/m);
  assert.match(s,/~{3}mermaid/);
  for(const [name,manual]of modules){
    assert.ok(s.includes(name),name+' missing');
    assert.ok(s.includes('](doc/'+manual+'.md)'),manual+' missing');
  }
  assert.ok(s.includes('Windows ChatGPT'), 'Desktop integration unclear');
  assert.match(s,/MCP/);
  assert.ok(s.includes('Backup'), 'Backup terminology missing');
  assert.doesNotMatch(s,/<!--[\s\S]*?-->| \d+\/\d+ PASS|forwarded=\d+|ARMED_UNVERIFIED|candidate|지난 테스트|최근 검증|실제 검증:/i);
  assert.doesNotMatch(s,/!\[[^\]]+\]\(doc\/png\/Picture\d+\.png\)/);
  assert.ok(s.length<10500,'Project overview has become an installation manual');
});
test('6.5 all four module documentation pairs use canonical owner and a navigable manual',async()=>{
  for(const [name,manual]of modules){
    const r=await read('mod/'+name+'/README.md');
    const m=await read('doc/'+manual+'.md');
    assert.match(r,new RegExp('^# '+name+'\\b','m'));
    assert.match(m,new RegExp('^# '+name+'\\b','m'));
    assert.ok(r.includes('../../doc/'+manual+'.md'),name+' manual link');
    assert.ok(m.includes('../mod/'+name+'/'),name+' source owner link');
    assert.ok(r.includes('~~~'),name+' executable/diagram examples missing');
    assert.ok(m.includes('## 6.')||m.includes('## 7.')||m.includes('## 8.'),name+' troubleshooting/handoff missing');
    assert.doesNotMatch(r,/<!--[\s\S]*?-->/);
    assert.doesNotMatch(m,/<!--[\s\S]*?-->/);
  }
});
test('6.5 all documentation links remain valid relative to owning Markdown file',async()=>{
  for(const rel of sourceDocuments){
    const s=await read(rel);
    for(const m of s.matchAll(/!?\[[^\]\n]+\]\(([^)\n]+)\)/g)){
      const link=m[1].trim().split(/\s+["']/)[0];
      if(!link||/^(?:https?:|mailto:|#|data:)/.test(link))continue;
      const target=decodeURIComponent(link.split('#')[0].split('?')[0]);
      await access(path.resolve(ROOT,path.dirname(rel),target));
    }
    // Literal file path inside HTML img tags must also exist.
    for(const m of s.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)){
      if(!/^https?:/.test(m[1]))await access(path.resolve(ROOT,path.dirname(rel),m[1]));
    }
  }
});
test('6.5 each public manual distinguishes actual commands and protects the private runtime',async()=>{
  const guide=await read('doc/TRANSPORT.md');
  const entry=await read('out/SPARK.ps1');
  const pkg=JSON.parse(await read('out/package.json'));
  assert.equal(pkg.version,'0.0.3');
  for(const cmd of ['init','start','status','validate','chatlog'])assert.ok(entry.includes("'"+cmd+"'"),'CLI missing '+cmd);
  for(const step of ['git clone https://github.com/SPARK-SymbioticPersonalAIRoboticKeeper/SPARK.git',
    'Set-Location .\\SPARK','Test-Path .\\out\\SPARK.ps1',
    'KEY_FILE_PRESENT','TOKEN_FILE_PRESENT','CONFIG_OK','SPARK_SMOKE_OK',
    'OAuth','No authentication','Bearer'])assert.ok(guide.includes(step),step);
  assert.ok(guide.indexOf('git clone ')<guide.indexOf('Set-Location .\\SPARK'));
  for(const k of ['Runtime API key','MCP Access Token','tunnel.id','transport.allowedRoot'])assert.ok(guide.includes(k),k);
  assert.ok(guide.includes('start -SkipChatGPTUi'));
  assert.ok(guide.includes('Create as a plugin'));
  assert.ok(guide.indexOf('### 5.2.')<guide.indexOf('### 5.3.'));
  const cii=await read('doc/CII.md');
  assert.match(cii,/startCompletionStream/);
  assert.match(cii,/Display Mask/);
  const backup=await read('doc/LOG.md');
  for(const marker of ['chatlog -b','chatlog -v','-ArchiveAfterBackup','-OutputDirectory'])assert.ok(backup.includes(marker),marker);
});
test('6.5 public charter is a reviewed full pArc derivative with all ten principles',async()=>{
  const agents=await read('AGENTS.md');
  const svg=await read('doc/Introduction.svg');
  assert.match(agents,/^# SPARK 0\.0\.3 — Public Engineering Charter/m);
  for(let i=1;i<=10;i++)assert.match(agents,new RegExp('\\bP'+i+'\\b'));
  for(const principle of ['Symmetric V-Model','Machine-Oriented Deliverables','Complete Phase Deliverables'])
    assert.ok(agents.includes(principle),'Missing '+principle);
  for(const phase of ['SWE1','SWE2','SWE3','SWE4','SWE5','SWE6'])
    assert.ok(agents.includes(phase),'Missing '+phase);
  assert.match(agents,/recovery mechanism before execution/);
  assert.match(agents,/SWE2 → SWE3 → SWE4/);
  assert.match(agents,/\]\(doc\/Introduction\.svg\)/);
  assert.match(svg,/<svg\b/);
  assert.match(svg,/P1/);
});
test('6.5 Wiki source, if present in private checkout, is a complete project introduction',async()=>{
  const root=path.join(ROOT,'doc/wiki');
  let exists=false;
  try{exists=(await stat(root)).isDirectory()}catch(error){if(error.code!=='ENOENT')throw error}
  if(!exists)return; // Wiki uses its own Git repository; the Public source checkout is independent.
  const home=await readFile(path.join(root,'Home.md'),'utf8');
  const sidebar=await readFile(path.join(root,'_Sidebar.md'),'utf8');
  assert.match(home,/^# SPARK\s*$/m);
  assert.ok(home.includes('~~~mermaid'));
  assert.doesNotMatch(home,/^# Home\b/m);
  for(const [name]of modules){
    assert.ok(home.includes(']('+name+')'),name+' Wiki navigation');
    assert.ok(sidebar.includes(']('+name+')'),name+' Sidebar navigation');
    const page=await readFile(path.join(root,name+'.md'),'utf8');
    assert.match(page,new RegExp('^# '+name+'\\b','m'));
    assert.ok(page.length>1250,name+' Wiki empty');
  }
  for(const link of [...home.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]){
    const dest=link[1];
    if(/^(?:https?:|mailto:|#)/.test(dest))continue;
    try{await access(path.join(root,dest))}catch{
      await access(path.join(root,dest+'.md'));
    }
  }
});

test('6.5 isolated-install handoff covers real launcher, module boundaries and stop conditions',async()=>{
  const handoff=await read('doc/COLD_START.md');
  const launcher=await read('out/SPARK.ps1');
  const cfg=await read('mod/spark_transport/src/config.mjs');
  const cii=await read('mod/spark_cii/src/config.mjs');
  for(const name of modules.map(([m])=>m))assert.ok(handoff.includes(name),'missing '+name);
  for(const cmd of ['git clone ','Test-Path .\\out\\SPARK.ps1','npm --prefix out test',
    'out\\SPARK.ps1 init','out\\SPARK.ps1 start -SkipChatGPTUi',
    'out\\SPARK.ps1 status','node mod/spark_ui/src/cli.mjs validate',
    'npm --prefix out test'])
    assert.ok(handoff.includes(cmd),'missing executable command: '+cmd);
  for(const feature of ['NOT RUN','NOT OBSERVED','Runtime API key','MCP Access Token',
    'No authentication','SWE3DP','Access Token','run_command'])
    assert.ok(handoff.includes(feature),'missing acceptance boundary '+feature);
  for(const command of ["'init'","'start'","'status'"])assert.ok(launcher.includes(command));
  assert.match(cfg,/RUNTIME_CONFIG_PATH/);
  assert.match(cii,/DEFAULT_CONFIG_PATH/);
  assert.match(await read('doc/RELEASE.md'),/parentless root commit/);
  assert.match(await read('doc/ARCH_QGate.md'),/6\.5/);
  assert.doesNotMatch(handoff,/spark00000\/SPARK|E:[\\/]SRC|(?:_pArc|\.runtime)[\\/]/i);
});
