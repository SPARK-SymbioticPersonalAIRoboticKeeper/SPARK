import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import cp from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => fs.readFile(path.join(ROOT, p), 'utf8');

test('0.0.3 runtime, manifest, CLI, manual and module docs agree on current version', async () => {
  const pkg = JSON.parse(await read('out/package.json'));
  assert.equal(pkg.version, '0.0.3');
  assert.match(await read('mod/spark_transport/src/constants.mjs'), /APP_VERSION = '0\.0\.3'/);
  assert.match(await read('out/SPARK.ps1'), /SPARK 0\.0\.3/);
  for (const file of ['README.md','doc/TRANSPORT.md','doc/UI.md','doc/LOG.md','doc/CII.md','doc/RELEASE.md','doc/ARCH.md','doc/ARCH_QGate.md','mod/spark_cii/README.md','mod/spark_log/README.md']) {
    const text = await read(file);
    if(!['README.md','mod/spark_cii/README.md','mod/spark_log/README.md'].includes(file))
      assert.match(text.slice(0,2200), /0\.0\.3/, file);
  }
  assert.match(pkg.scripts.test, /spark_cii\/test/);
});

test('README overview, complete Transport installation guide and four module owners agree', async () => {
  const readme = await read('README.md');
  const heads = [...readme.replace(/\r\n/g, '\n').matchAll(/^## [1-4]\. [^\n]+/gm)].map(x => x[0]);
  assert.equal(heads.length, 4, JSON.stringify(heads));
  for (const [i,heading] of ['시스템 개요','시작하기','구조와 확장','문서와 기여'].entries())
    assert.equal(heads[i], '## '+(i+1)+'. '+heading);
  assert.match(readme, /(?:```|~~~)mermaid/);
  for (const [name,manual] of [['spark_transport','TRANSPORT'],['spark_ui','UI'],['spark_log','LOG'],['spark_cii','CII']]) {
    assert.equal((await fs.stat(path.join(ROOT, 'mod', name))).isDirectory(), true);
    assert.ok(readme.includes('**'+name+'**'), name+' canonical identifier');
    assert.ok(readme.includes('](doc/'+manual+'.md)'), name+' manual link');
    assert.match(await read('doc/'+manual+'.md'), /0\.0\.3/, manual+' current product version');
    assert.match(await read('mod/'+name+'/README.md'), new RegExp('^# '+name+' ', 'm'), name+' source README');
  }
  const installation = await read('doc/TRANSPORT.md');
  for (const step of ['Tunnel ID','API key','Create','Publish','Connect','Smoke test','FAQ']) {
    assert.ok(installation.toLowerCase().includes(step.toLowerCase()), 'Missing installation step: '+step);
  }
});

test('private data, user source and Wiki remain outside the public Git index', async () => {
  const patterns = ['/_pArc/','/doc/wiki/','/.runtime/','/log/','/ref/'];
  assert.deepEqual((await read('.gitignore')).replace(/\r\n/g,'\n').trimEnd().split('\n'),patterns);
  const files = cp.execFileSync('git',['ls-files','-z'],{cwd:ROOT,encoding:'utf8'}).split('\0').filter(Boolean);
  for (const name of files) {
    assert.doesNotMatch(name, /(^|\/)(\.runtime|_pArc|log|\.git)(\/|$)/);
    assert.ok(!name.startsWith('doc/wiki/'));
    assert.ok(!/\.(exe|dll|pem|pfx|p12|key)$/i.test(name));
  }
});

test('public engineering charter is reviewed and checksum-pinned', async () => {
 const buf=await fs.readFile(path.join(ROOT,'AGENTS.md'));
 const text=buf.toString('utf8').replace(/\r\n/g,'\n');
 // Pin the reviewed LF content; Windows checkout may convert worktree text to CRLF.
 assert.equal(createHash('sha256').update(text,'utf8').digest('hex'),'6d31bc8d9795baa71bbe5cba1dfaadcae7d2bbfa679c6eb92fa9f2721a40c44c');
 for(const marker of ['One-page Charter','P2 Machine-Oriented Deliverables','recovery mechanism before execution','SPARK 0.0.3'])
   assert.ok(text.includes(marker),marker);
 assert.doesNotMatch(text,/spark00000\/SPARK|[A-Z]:[\\/](?:Users|SRC)[\\/]/);
});

test('public source omits private publication utility but retains CI and release policy', async () => {
 await assert.rejects(fs.access(path.join(ROOT,'out/spark/script/publish-public.ps1')),{code:'ENOENT'});
 const release=await read('doc/RELEASE.md');
 assert.match(release,/public release/i);assert.match(release,/parentless root commit/i);
 const workflow=await read('.github/workflows/ci.yml');
 for(const marker of ['npm --prefix out test','ubuntu-latest','windows-latest'])assert.ok(workflow.includes(marker));
 assert.match(workflow,/name: Test[\s\S]*?shell: bash\s+run: \|/);
 assert.match(workflow,/unset PSModulePath PSMODULEPATH/);
 assert.match(workflow,/npm --prefix out test/);
});

test('public manuals have no internal paths or editorial placeholders', async () => {
  const manuals = [
    'README.md', 'doc/TRANSPORT.md', 'doc/UI.md', 'doc/LOG.md',
    'doc/CII.md', 'doc/RELEASE.md', 'doc/ARCH.md',
    'doc/ARCH_QGate.md', 'mod/spark_log/README.md',
    'mod/spark_cii/README.md', 'mod/spark_log/viewer/README.md',
    'doc/png/05-access-token.svg', 'doc/readme/05-access-token.svg'
  ];
  const forbidden = /(?:_pArc|\.pArc|\.runtime|<private-state>|SPARK_Log|doc\/wiki|SPARK_Android|%LOCALAPPDATA%|log\/system|[A-Z]:[\\/](?:SRC|Users|AppData)[\\/]|spark00000\/SPARK|USER MANUAL REVIEW|# 개인 파일 실제 경로는)/;
  for (const name of manuals) {
    const content = await read(name);
    assert.doesNotMatch(content, forbidden, 'Non-public name/path or editorial placeholder: ' + name);
  }
});

test('README is a product overview, Transport is the only full installation walkthrough', async () => {
  const readme = await read('README.md');
  const guide = await read('doc/TRANSPORT.md');
  assert.match(readme, /\[spark_transport 설치 가이드\]\(doc\/TRANSPORT\.md\)/);
  assert.doesNotMatch(readme, /<!--[\s\S]*?-->|348\/348|EGRESS_BOUNDARY_ARMED|not observed|candidate/gi);
  assert.doesNotMatch(readme, /<img\b[^>]*src="doc\/png\/Picture\d+\.png"/);
  assert.doesNotMatch(readme, /PNG 캡처 11장|촬영한 기존 Apps/);
  const actualSections = [...guide.matchAll(/^## (\d+)\. /gm)].map(x => Number(x[1]));
  assert.deepEqual(actualSections, [1, 2, 3, 4, 5, 6, 7, 8], 'Installation must be sequential, not duplicate numbering');
  assert.ok(guide.indexOf('### 5.2. Plugins에서 바로 추가하는 화면이라면') <
    guide.indexOf('### 5.3. Apps / Drafts 화면이 보이는 경우'), 'Current and Apps variants must be separate');
  for (const item of ['Tunnels Read + Manage', 'Tunnels Read + Use', 'ChatGPT Workspace',
    'Add custom MCP server', 'Create as a plugin', 'Connection',
    'Bearer', 'Draft', 'Publish', 'Connect', 'Smoke test',
    'run_command', 'start -SkipChatGPTUi', 'KEY_FILE_PRESENT', 'TOKEN_FILE_PRESENT',
    'CONFIG_OK', 'SPARK_SMOKE_1', 'SPARK_SMOKE_2', 'SPARK_SMOKE_OK']) {
    assert.ok(guide.includes(item), 'Missing novice installation checkpoint: ' + item);
  }
  for (let q = 1; q <= 8; q++) assert.ok(guide.includes('### 7.' + q + '.'),
    'Missing FAQ 7.' + q);
  assert.doesNotMatch(guide, /2026-09|촬영한|스크린샷 모음|사진 갤러리/);
  const fence = String.fromCharCode(96).repeat(3);
  assert.equal((guide.split(fence).length - 1) % 2, 0, 'Broken fenced code block');

  for (const [name, content] of [['README.md', readme], ['doc/TRANSPORT.md', guide]]) {
    const relativeDir = path.dirname(name);
    for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const href = match[1];
      if (/^(?:https?:|mailto:|#)/.test(href)) continue;
      await fs.access(path.resolve(ROOT, relativeDir, href.split('#')[0]));
    }
  }
  for (const match of readme.matchAll(/<(?:img|a)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    const href = match[1];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    await fs.access(path.resolve(ROOT, href.split('#')[0]));
  }
  // Verify GitHub-style chapter anchors, not just that TRANSPORT.md exists.
  const slug = (heading) => heading.toLowerCase()
    .replace(/[^\p{L}\p{N}\- ]/gu, '').replace(/ /g, '-');
  const anchors = new Set([...guide.matchAll(/^#{1,6} (.+)$/gm)].map(m => slug(m[1])));
  for (const match of readme.matchAll(/\]\(doc\/TRANSPORT\.md#([^)]*)\)/g)) {
    assert.ok(anchors.has(match[1]), 'Broken README chapter link: ' + match[1]);
  }
});

test('a fresh installation agent can resume in a new terminal without unsafe auth fallback', async () => {
  const guide = await read('doc/TRANSPORT.md');
  const entry = await read('out/SPARK.ps1');
  const config = await read('mod/spark_transport/src/config.mjs');

  assert.match(guide, /주소 표시줄.{0,40}powershell/);
  assert.match(guide, /Test-Path \.\\out\\SPARK\.ps1/);
  assert.match(guide, /SPARK 프로젝트 폴더.{0,130}PowerShell/);
  assert.match(guide, /5\.3\.11절의 두 줄짜리 경로 조회/);
  assert.match(guide, /tunnel_x\+/);
  assert.match(guide, /OAuth.{0,50}No authentication.{0,85}중단/);
  assert.match(guide, /인증 호환성 미검증/);
  assert.match(guide, /Runtime API key.*MCP/);
  assert.match(entry, /'start'\s*\{[\s\S]{0,150}-SkipChatGPTUi/);
  assert.match(config, /export const RUNTIME_CONFIG_PATH/);
  assert.match(config, /export const ACCESS_TOKEN_PATH/);
  assert.doesNotMatch(guide, /notepad\.exe \$accessPath.{0,80}그대로 실행/i);
});

test('release gate pins eleven images located at their actual installation steps', async () => {
  const reviewed=Object.freeze({
    "Picture1.png": "6c2fa3ecf53ac56adcec5806fe8812acb0950532afb14b5fab64caa00a55bfb5",
    "Picture2.png": "1179ea3c029d2d85a4a4b9930374dca972504052c9c55182b708fa516334920d",
    "Picture3.png": "84b71d9c35df78c2d5c34738e9f7ba9ad4e9aa4dcbe905e5380bf13619d653a3",
    "Picture4.png": "740907531d838429af3ab75ef97bd15d35f7e3526660e0bc39a6af3e4667cae9",
    "Picture5.png": "7a436e7425b9e18491219f1e43fef976fe973f4374a54d8bf518e72e375286f6",
    "Picture6.png": "ae43b78db8c6cdd0bce276ba8454305d9ca7161c6d0fd1b6fc8e20bf299c469d",
    "Picture7.png": "f7111a94318c244ce62aea0ad74ba6065a768a3758809d4a88fe4c055a812795",
    "Picture8.png": "da10c4c455cac4917557e085859bcb37d79497e030b068bf8e0ef79e02294897",
    "Picture9.png": "e3c2de4372241c7936d1f8d203a731c25730dbd9a2be83d19f95c7b2d3be7382",
    "Picture10.png": "d7c786a6ff01d3f56e90d1fbe6b74a7d9424c0a9fbb097d3e714e430e1dd4f86",
    "Picture11.png": "f3b51cdb4954e3b7b8e676f627766ed187fbe8d5f91484635a20d6a359eb0857"
});
  const pins=Object.entries(reviewed).map(([name,hash])=>[null,name,hash]);
  const guide = await read('doc/TRANSPORT.md');
  const readme = await read('README.md');

  assert.equal(pins.length, 11, 'Only reviewed screenshots may be published');
  await assert.rejects(fs.access(path.join(ROOT,'doc/png/Spark.docx')),{code:'ENOENT'});
  const linked = [...guide.matchAll(/\[!\[[^\]]+\]\(png\/Picture(\d+)\.png\)\]\(png\/Picture\1\.png\)/g)].map(x => Number(x[1]));
  assert.deepEqual(linked, Array.from({length:11},(_,i)=>i+1), 'Each screenshot belongs next to the action, in order');
  assert.doesNotMatch(readme, /Picture\d+\.png/, 'README must not duplicate screenshot gallery');
  for (let index = 1; index <= 11; index++) {
    const filename = 'Picture' + index + '.png';
    const pin = pins.find(x => x[1] === filename);
    assert.ok(pin, 'Missing screenshot hash for ' + filename);
    const start = guide.indexOf('#### 5.3.' + index + '.');
    const next = index === 11 ? guide.indexOf('\n## 6.', start) :
      guide.indexOf('#### 5.3.' + (index+1) + '.', start);
    assert.ok(start >= 0 && next > start, 'Missing installation step for '+filename);
    assert.ok(guide.slice(start,next).includes('](png/' + filename + ')'), 'Screenshot outside correct step: '+filename);
    const png = await fs.readFile(path.join(ROOT, 'doc/png', filename));
    const digest = createHash('sha256').update(png).digest('hex');
    assert.equal(digest, pin[2], 'Screenshot changed without review: '+filename);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Invalid PNG: '+filename);
    assert.ok(png.readUInt32BE(16)>=300 && png.readUInt32BE(20)>=120, 'Unexpected PNG dimensions: '+filename);
    const safeChunks = new Set(['IHDR', 'sRGB', 'gAMA', 'PLTE', 'pHYs', 'IDAT', 'IEND']);
    let offset = 8, endSeen = false;
    while (offset + 12 <= png.length) {
      const length = png.readUInt32BE(offset);
      const kind = png.toString('ascii',offset+4,offset+8);
      assert.ok(safeChunks.has(kind), 'Private PNG metadata chunk: '+filename+'/'+kind);
      assert.ok(offset+12+length <= png.length, 'Invalid PNG chunk: '+filename);
      offset += 12+length;
      if(kind === 'IEND'){endSeen=true;break;}
    }
    assert.ok(endSeen && offset===png.length, 'Missing end marker or trailing data: '+filename);
  }
});

test('rendered Transport markdown displays eleven screenshots in the installation flow', async () => {
  const { marked } = require(path.join(ROOT,'mod/spark_log/viewer/vendor/marked.umd.js'));
  const html = marked.parse(await read('doc/TRANSPORT.md'));
  const rendered = [...html.matchAll(/<img\b[^>]*\bsrc="png\/Picture(\d+)\.png"/g)].map(x=>Number(x[1]));
  assert.deepEqual(rendered,Array.from({length:11},(_,i)=>i+1),'Screenshot rendered order');
  assert.match(html, /<table>/);
  assert.ok(html.indexOf('#### 5.3.') < 0, 'Markdown headings must render as HTML');
});
test('public source excludes all ref/ files and uses five user-approved safety ignore rules', async () => {
 const files=cp.execFileSync('git',['ls-files','-z'],{cwd:ROOT,encoding:'utf8'}).split('\0').filter(Boolean);
 assert.ok(!files.includes('out/spark/script/publish-public.ps1'));
 assert.ok(!files.some(f=>f.startsWith('ref/')||f.startsWith('doc/wiki/')));
 assert.doesNotMatch(await read('AGENTS.md'),/spark00000\/SPARK/);
 assert.match(await read('doc/RELEASE.md'),/\[SPARK Public\]\(https:\/\/github\.com\/SPARK-SymbioticPersonalAIRoboticKeeper\/SPARK\)/);
 assert.equal((await read('.gitignore')).replace(/\r\n/g,'\n'),'/_pArc/\n/doc/wiki/\n/.runtime/\n/log/\n/ref/\n');
});

test('fresh Windows private-root init never creates public credential directories', { skip: process.platform !== 'win32' }, async (t) => {
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spark-private-init-fixture-'));
  t.after(async () => fs.rm(tmp, { recursive: true, force: true }));
  const script = (await read('out/spark/script/init-user.ps1')).replace(/\r\n/g,'\n');
  const begin = script.indexOf('function Initialize-PrivateData {');
  const end = script.indexOf('\n}\n\nInitialize-PrivateData', begin);
  assert.ok(begin >= 0 && end > begin, 'Init private helper must exist');
  const helper = script.slice(begin, end + 2);
  const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
  const powershell = [
    "$ErrorActionPreference='Stop'",
    '$root=' + quote(tmp),
    'function Fail([string]$Message) { throw $Message }',
    helper,
    'Initialize-PrivateData',
    "$dir=Join-Path $root '.runtime'",
    '$acl=Get-Acl -LiteralPath $dir',
    '$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "$allowed=@($current,'S-1-5-18','S-1-5-32-544')",
    '$unknown=@($acl.Access|Where-Object{ $allowed -notcontains $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })',
    "[pscustomobject]@{Private=$acl.AreAccessRulesProtected;UnknownAccess=$unknown.Count;HasConfig=(Test-Path (Join-Path $dir 'config'));HasSecrets=(Test-Path (Join-Path $dir 'secrets'));HasData=(Test-Path (Join-Path $dir 'data'))}|ConvertTo-Json -Compress",
  ].join(';');
  const r = cp.spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', powershell], { encoding:'utf8', cwd:ROOT, timeout:18000 });
  assert.equal(r.status, 0, r.stderr || 'Fresh private ACL provisioning failed');
  const obj=JSON.parse(r.stdout.trim());
  assert.deepEqual([obj.Private, obj.UnknownAccess, obj.HasConfig, obj.HasSecrets, obj.HasData],[true,0,true,true,false]);
});

test('user data root never resolves inside source or .runtime, and uses per-user app data', async () => {
  const { sparkDataRoot } = await import('../../../out/spark/data-path.mjs');
  const source = ROOT;
  const allowed = sparkDataRoot({ env: { LOCALAPPDATA: process.platform === 'win32' ? 'C:\\Users\\Example\\AppData\\Local' : '/tmp', XDG_DATA_HOME: '/tmp' }, platform: process.platform, projectRoot: source });
  assert.match(allowed, /SPARK|spark/);
  assert.equal(path.relative(source, allowed).startsWith('.') || path.isAbsolute(path.relative(source, allowed)), true);
  assert.throws(() => sparkDataRoot({
    env: { LOCALAPPDATA: process.platform === 'win32' ? 'C:\\Users\\Example\\AppData\\Local' : '/tmp', SPARK_DATA_DIR: path.join(source, '.runtime','data') },
    platform: process.platform, projectRoot: source,
  }), /inside source, \.runtime or disposable log/);
});

test('isolated Windows app data provisioning is private and never creates .runtime/data', { skip: process.platform !== 'win32' }, async (t) => {
  const os = await import('node:os');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'spark-app-data-fixture-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const dest = path.join(root, 'SPARK');
  const helper = path.join(ROOT, 'out/spark/script/spark-data-path.ps1');
  const lit = (v) => "'" + v.replaceAll("'", "''") + "'";
  const code = [
    "$ErrorActionPreference='Stop'",
    "$env:SPARK_DATA_DIR=" + lit(dest),
    '. ' + lit(helper),
    '$full=Initialize-SparkUserData -SourceRoot ' + lit(ROOT),
    '$acl=Get-Acl -LiteralPath $full',
    "$n=@('chatlog','audit','ui-state','route-recordings')|Where-Object{Test-Path -LiteralPath (Join-Path $full $_) -PathType Container}",
    "[pscustomobject]@{ValidPrivateAcl=$acl.AreAccessRulesProtected;AllDataFolders=(@($n).Count -eq 4);SourceRuntimeUntouched=(-not (Test-Path -LiteralPath (Join-Path " + lit(root) + " '.runtime')))}|ConvertTo-Json -Compress"
  ].join(';');
  const result = cp.spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', code], { cwd:ROOT, encoding:'utf8', timeout:18000 });
  assert.equal(result.status, 0, result.stderr || 'User app data initialization failed');
  const actual=JSON.parse(result.stdout.trim());
  assert.deepEqual([actual.ValidPrivateAcl,actual.AllDataFolders,actual.SourceRuntimeUntouched],[true,true,true]);
});
