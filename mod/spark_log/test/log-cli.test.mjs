import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = path.join(ROOT, 'out', 'SPARK.ps1');
const LOG = path.join(ROOT, 'mod', 'spark_log', 'script', 'spark_log.ps1');

function run(args) {
  return spawnSync('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ENTRY, ...args],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10000 });
}

test('SPARK_Log backup and viewer share exactly one parameter-routed PowerShell entry point', async () => {
  const root = path.join(ROOT, 'mod', 'spark_log');
  const runner = await fs.readFile(LOG, 'utf8');
  const master = await fs.readFile(ENTRY, 'utf8');
  assert.match(master, /'chatlog'\s*\{[\s\S]*?spark_log\.ps1/);
  assert.match(runner, /\[Alias\('b'\)\]\[switch\]\$Backup/);
  assert.match(runner, /\[Alias\('v'\)\]\[switch\]\$Viewer/);
  assert.match(runner, /-ArchiveAfterBackup:\$ArchiveAfterBackup/);
  assert.match(runner, /backup_chat_cli\.ps1/);
  assert.match(runner, /backup_chat_gui\.ps1/);
  assert.match(runner, /viewer_cli\.ps1/);
  assert.match(runner, /index\.html/);
  assert.match(runner, /Select exactly one chatlog mode/);
  for (const file of ['backup/run_backup.cmd', 'viewer/open_viewer.cmd']) {
    assert.rejects(fs.stat(path.join(root, file)), { code: 'ENOENT' });
  }
  assert.match(await fs.readFile(path.join(root, 'viewer', 'THIRDPARTY.md'), 'utf8'), /Mermaid|DOMPurify/i);
});

test('historical SPARK_Log synthetic fixture and offline viewer vendor assets survive without raw user logs', async () => {
  const root = path.join(ROOT, 'mod', 'spark_log');
  const fixture = await fs.readFile(path.join(root, 'test', 'fixture', 'sample_chat_all_renderers.jsonl'), 'utf8');
  for (const row of fixture.split(/\r?\n/).filter(Boolean)) assert.doesNotThrow(() => JSON.parse(row));
  for (const file of ['viewer/vendor/marked.umd.js', 'viewer/vendor/mermaid.min.js',
    'viewer/vendor/purify.min.js', 'viewer/vendor/licenses/mermaid-MIT.txt']) {
    const stat = await fs.stat(path.join(root, file));
    assert.ok(stat.size > 0, file);
  }
});

test('PowerShell is sole command language; VBS is isolated hidden-tray launcher exception', async () => {
  for (const file of ['out/SPARK.cmd', 'out/SPARK.bat', 'mod/spark_log/backup/run_backup.cmd',
    'mod/spark_log/viewer/open_viewer.cmd']) {
    await assert.rejects(fs.stat(path.join(ROOT, file)), { code: 'ENOENT' });
  }
  const hidden = await fs.readFile(path.join(ROOT, 'out', 'spark', 'script', 'spark-hidden-action.ps1'), 'utf8');
  const vbs = await fs.readFile(path.join(ROOT, 'out', 'SPARK.vbs'), 'utf8');
  assert.match(hidden, /SPARK\.ps1/);
  assert.match(hidden, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.doesNotMatch(hidden, /\$psi\.FileName\s*=\s*.*cmd\.exe|\$entryPath\s*=\s*.*SPARK\.cmd/i);
  assert.match(vbs, /WindowStyle Hidden/);
  assert.match(vbs, /spark-tray-supervisor\.ps1/);
  const tray = await fs.readFile(path.join(ROOT, 'out', 'spark', 'script', 'spark-tray.ps1'), 'utf8');
  assert.match(tray, /System\.Windows\.Forms\.NotifyIcon/);
});

test('PowerShell help and Backup/Viewer mode separation work without launching UI', {
  skip: process.platform !== 'win32',
}, () => {
  const main = run(['help']);
  assert.equal(main.status, 0, main.stderr);
  assert.match(main.stdout, /chatlog -b/);
  assert.match(main.stdout, /start \[-SkipChatGPTUi\]/);
  assert.match(main.stdout, /restart/);
  const log = run(['chatlog', '-Help']);
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /SPARK ChatLog - Backup/);
  const clash = run(['chatlog', '-b', '-v']);
  assert.equal(clash.status, 2, clash.stderr);
  const missing = run(['chatlog', '-b', '-Title', 'a_title_only']);
  assert.equal(missing.status, 2, missing.stderr);
  const headless = run(['chatlog', '-v', '-Headless']);
  assert.equal(headless.status, 2, headless.stderr);
});

test('explicit main help and command-specific --help are read-only and complete', {
  skip: process.platform !== 'win32',
}, () => {
  // No-argument entrypoint now legitimately starts the user's SPARK session.
  // Never launch it during a read-only help regression.
  for (const args of [['--help'], ['-Help'], ['help'],
    ['start', '--help'], ['restart', '--help'], ['status', '--help'],
    ['stop', '--help'], ['auth', '--help']]) {
    const reply = run(args);
    assert.equal(reply.status, 0, 'args=' + args.join(' ') + ': ' + reply.stderr);
    assert.match(reply.stdout, /start \[-SkipChatGPTUi\]/);
    assert.match(reply.stdout, /restart/);
    assert.match(reply.stdout, /chatlog -b/);
    assert.match(reply.stdout, /chatlog -v/);
    assert.match(reply.stdout, /auth generate/);
    assert.match(reply.stdout, /--help/);
  }
  for (const args of [['chatlog'], ['chatlog', '--help'],
    ['chatlog', '-Help'], ['chatlog', 'help']]) {
    const reply = run(args);
    assert.equal(reply.status, 0, 'args=' + args.join(' ') + ': ' + reply.stderr);
    assert.match(reply.stdout, /SPARK ChatLog - Backup/);
    assert.match(reply.stdout, /chatlog -b/);
    assert.match(reply.stdout, /chatlog -v/);
  }
});

test('old log command is disabled and invalid chatlog/start arguments fail closed', {
  skip: process.platform !== 'win32',
}, () => {
  for (const args of [['log'], ['log', '--help'], ['log', '-b']]) {
    const reply = run(args);
    assert.equal(reply.status, 2, 'args=' + args.join(' '));
    assert.match(reply.stderr, /renamed to 'chatlog'/);
  }
  for (const args of [['start', 'unrecognized-positional'], ['start', '-b']]) {
    const reply = run(args);
    assert.equal(reply.status, 2, 'args=' + args.join(' '));
  }
});

test('SPARK source ownership and recovery policy stay explicit', async () => {
  const agents = await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const moduleReadme = await fs.readFile(path.join(ROOT, 'mod', 'spark_log', 'README.md'), 'utf8');
  const vendor = await fs.readFile(path.join(ROOT, 'mod', 'spark_log', 'viewer', 'THIRDPARTY.md'), 'utf8');

  // AGENTS.md is the reviewed public derivative, not the private upstream charter.
  // The public test retains source ownership and recovery expectations.
  assert.match(agents, /^# SPARK 0\.0\.3 — Public Engineering Charter/m);
  assert.match(agents, /P2 Machine-Oriented Deliverables/);
  assert.match(agents, /recovery mechanism before execution/);
  assert.match(moduleReadme, /Backup.*Viewer/);
  assert.match(moduleReadme, /chatlog.*진입점/);

  for (const rel of [
    'backup/ChatBackup.Core.psm1',
    'backup/backup_chat_cli.ps1',
    'backup/backup_chat_gui.ps1',
    'script/spark_log.ps1',
    'viewer/parser.js',
    'viewer/dil-renderer.js',
    'viewer/openui-runtime.js',
    'viewer/viewer.js',
    'viewer/viewer.css',
    'viewer/index.html'
  ]) {
    const entry = await fs.stat(path.join(ROOT, 'mod', 'spark_log', rel));
    assert.ok(entry.isFile(), rel + ' must stay in its documented module');
  }
  assert.match(vendor, /@openuidev\/browser-bundle/);
  for (const library of ['marked', 'DOMPurify', 'Mermaid', 'OpenUI']) {
    assert.ok(vendor.includes(library), library + ' must have a third-party entry');
  }
});
