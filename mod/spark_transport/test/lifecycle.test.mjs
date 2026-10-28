import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort, makeFixture } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'mod', 'spark_transport', 'src', 'cli.mjs');

function run(command, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, command], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (data) => out += data);
    child.stderr.on('data', (data) => err += data);
    child.on('exit', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

test('Transport start/status/stop/restart', async (t) => {
  const f = await makeFixture();
  const port = await freePort();
  const accessTokenPath = path.join(f.base, 'Access_token');
  await fs.writeFile(accessTokenPath, 'spk_' + Buffer.alloc(32, 0x31).toString('base64url') + '\n', 'utf8');
  const env = {
    NODE_ENV: 'test',
    SPARK_TEST_ACCESS_TOKEN_PATH: accessTokenPath,
    SPARK_ROOT: f.root,
    SPARK_PORT: String(port),
    SPARK_STATE_DIR: path.join(f.base, 'state'),
    SPARK_LOG_DIR: path.join(f.base, 'logs'),
    SPARK_MCP_AUTH_MODE: 'bearer',
    SPARK_MCP_BEARER_TOKEN_SHA256: crypto.createHash('sha256').update('test-lifecycle-token').digest('hex'),
  };
  t.after(async () => {
    await run('stop', env).catch(() => {});
    await f.cleanup();
  });
  // The product never creates an unapproved log directory implicitly.
  await fs.mkdir(env.SPARK_LOG_DIR, { recursive: true });
  await fs.mkdir(env.SPARK_STATE_DIR, { recursive: true });

  let result = await run('start', env);
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).status, 'started');
  result = await run('status', env);
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).status, 'running');
  result = await run('stop', env);
  assert.equal(result.code, 0, result.err);
  result = await run('start', env);
  assert.equal(result.code, 0, result.err);
  result = await run('stop', env);
  assert.equal(result.code, 0, result.err);
});

test('Transport refuses startup when Access_token is missing', async (t) => {
  const f = await makeFixture();
  const port = await freePort();
  const stateDir = path.join(f.base, 'state');
  const env = {
    NODE_ENV: 'test',
    SPARK_TEST_ACCESS_TOKEN_PATH: path.join(f.base, 'missing-Access_token'),
    SPARK_ROOT: f.root,
    SPARK_PORT: String(port),
    SPARK_STATE_DIR: stateDir,
    SPARK_LOG_DIR: path.join(f.base, 'logs'),
  };
  t.after(async()=>{await f.cleanup();});
  await fs.mkdir(env.SPARK_LOG_DIR, { recursive: true });
  await fs.mkdir(env.SPARK_STATE_DIR, { recursive: true });
  const result=await run('start',env);
  assert.notEqual(result.code,0);
  const log = await fs.readFile(path.join(f.base, 'logs', 'spark.log'), 'utf8');
  assert.match(log,/Access_token Bearer authentication is required/i);
});

test('runtime logs use approved repo/log subdirectory or existing external path, never .runtime', async (t) => {
  const f = await makeFixture();
  t.after(async () => { await f.cleanup(); });
  const configPath = path.join(f.base, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ transport: { allowedRoot: f.root } }), 'utf8');
  const logDir = path.join(f.base, 'logs');
  await fs.mkdir(logDir, { recursive: true });
  assert.throws(() => loadConfig({ configPath, logDir, stateDir: path.join(ROOT, '.runtime') }),
    /credential-only/i);
  assert.throws(() => loadConfig({ configPath, logDir, stateDir: path.join(ROOT, 'unapproved-no-such-state-directory') }),
    /pre-existing user-approved directory/i);
  const accepted = loadConfig({ configPath, logDir });
  assert.equal(accepted.logDir, path.resolve(logDir));
  const approved = path.join(ROOT, 'log', 'system');
  if (await fs.stat(approved).then((info) => info.isDirectory()).catch(() => false)) {
    assert.equal(loadConfig({ configPath, logDir: approved }).logDir, approved);
  } else {
    assert.throws(() => loadConfig({ configPath, logDir: approved }), /must already exist/i);
  }
  assert.throws(() => loadConfig({
    configPath, logDir: path.join(ROOT, '.runtime', 'logs'),
  }), /only under log/i);
  assert.throws(() => loadConfig({ configPath, logDir: path.join(ROOT, 'log') }),
    /only under log/i);
});

test('Windows lifecycle out/spark/script preserve help/init/start/restart/status/stop contract', async () => {
  const [psEntry, hiddenLauncher, hiddenWorker, trayController, init, start, stop, status, uiLauncher, uiCli, uiWatcher] = await Promise.all([
    fs.readFile(path.join(ROOT, 'out', 'SPARK.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'out', 'SPARK.vbs'), 'utf8'),
    fs.readFile(path.join(ROOT, 'out/spark/script', 'spark-hidden-action.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'out/spark/script', 'spark-tray.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'out/spark/script', 'init-user.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'out/spark/script', 'start-all.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'out/spark/script', 'stop-all.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'out/spark/script', 'status-all.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'mod', 'spark_ui', 'script', 'start-chatgpt-ui.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'mod', 'spark_ui', 'src', 'cli.mjs'), 'utf8'),
    fs.readFile(path.join(ROOT, 'mod', 'spark_ui', 'src', 'watch.mjs'), 'utf8'),
  ]);

  assert.match(psEntry, /function Show-SparkHelp/);
  assert.match(psEntry, /\[string\]\$Command = ''/);
  assert.match(psEntry, /if \(-not \$action\)\s*\{[\s\S]*?SPARK\.vbs/);
  assert.match(psEntry, /'autostart'\s*\{[\s\S]*?spark-autostart\.ps1/);
  assert.match(psEntry, /'init'\s*\{/);
  assert.match(psEntry, /'auth'\s*\{/);
  assert.match(psEntry, /'restart'\s*\{[\s\S]*?stop-all\.ps1[\s\S]*?start-all\.ps1/);
  assert.match(psEntry, /'status'\s*\{[\s\S]*?status-all\.ps1/);
  assert.match(psEntry, /'chatlog'\s*\{[\s\S]*?spark_log\.ps1/);
  assert.match(psEntry, /'validate'\s*\{[\s\S]*?validate-windows\.ps1/);
  assert.doesNotMatch(psEntry, /&\s+cmd\.exe|Start-Process\s+cmd\.exe/i);
  assert.match(hiddenLauncher, /spark-tray-supervisor\.ps1/i);
  // Double-click is idempotent: recover a stopped backend without destroying a healthy session.
  assert.match(hiddenLauncher, /If WScript\.Arguments\.Count = 0 Then[\s\S]*?action = "start"/i);
  assert.doesNotMatch(hiddenLauncher, /-EnsureStarted/i);
  assert.match(hiddenLauncher, /Case "start", "restart", "status", "stop"/i);
  assert.match(hiddenLauncher, /shell\.Run command, 0, False/i);
  assert.match(hiddenLauncher, /spark-hidden-action\.ps1/i);
  assert.doesNotMatch(hiddenLauncher, />>|OpenTextFile|spark-launcher\.log/i);
  assert.doesNotMatch(hiddenLauncher, /dotnet|SPARK-Tray\.exe/i);
  assert.match(hiddenWorker, /SPARK\.ps1/i);
  assert.match(hiddenWorker, /spark-lifecycle\.log/i);
  assert.match(hiddenWorker, /Get-SparkLogDirectory/i);
  assert.match(hiddenWorker, /Join-Path \$logDir 'spark-lifecycle\.log'/i);
  assert.match(hiddenWorker, /Local\\SPARK\.Lifecycle/i);
  assert.match(hiddenWorker, /FileShare\]::ReadWrite/i);
  assert.match(hiddenWorker, /Local\\SPARK\.RestartRequest/i);
  assert.match(hiddenWorker, /WaitOne\(15000\)/);
  assert.match(hiddenWorker, /WaitOne\(300000\)/);
  assert.match(hiddenWorker, /duplicate \{1\} ignored; existing \{1\} is running/i);
  assert.match(hiddenWorker, /Local\\SPARK\.StartRequest/i);
  assert.match(hiddenWorker, /spark-lifecycle\.log/i);
  assert.doesNotMatch(hiddenWorker, /Join-Path\s+\$logDir\s+'spark-action\.log'/i);
  assert.match(hiddenWorker, /Join-Path \$runtime \('completed-worker-'/i);
  assert.doesNotMatch(hiddenWorker, /Join-Path \$runtime 'recovery'/i);
  assert.doesNotMatch(hiddenWorker, /launcher-recovery|spark-action-\d/i);
  assert.match(hiddenWorker, /powershell\.exe/i);
  assert.doesNotMatch(hiddenWorker, /\$psi\.FileName\s*=\s*.*cmd\.exe/i);
  // Redirect to asynchronously drained pipes, not an exclusively locked action log.
  assert.match(hiddenWorker, /RedirectStandardOutput\s*=\s*\$true/i);
  assert.match(hiddenWorker, /RedirectStandardError\s*=\s*\$true/i);
  assert.match(hiddenWorker, /ReadAsync\(/i);
  assert.match(hiddenWorker, /Receive-ActionOutput/i);
  assert.match(hiddenWorker, /\$child\.WaitForExit\(200\)/i);
  assert.doesNotMatch(hiddenWorker, /\$child\.WaitForExit\(\)/i);
  assert.doesNotMatch(hiddenWorker, /' >"' \+ \$actionLog/i);
  assert.doesNotMatch(hiddenWorker, /spark-launcher\.log/i);
  assert.match(trayController, /System\.Windows\.Forms\.NotifyIcon/i);
  assert.match(trayController, /Local\\SPARK\.SimpleTray/i);
  assert.match(trayController, /doc\\spark_icon1\.png/i);
  assert.match(trayController, /'Start'/i);
  assert.match(trayController, /'Restart'/i);
  assert.match(trayController, /'Stop'/i);
  assert.match(trayController, /AutoStart ON/i);
  assert.match(trayController, /AutoStart OFF/i);
  assert.match(trayController, /spark-tray-exit\.request/i);
  assert.match(trayController, /'Open Log'/i);
  assert.match(trayController, /SPARK\.vbs/i);
  assert.match(trayController, /spark-tray\.log/i);
  assert.match(trayController, /Get-SparkLogDirectory/i);
  assert.match(trayController, /spark-lifecycle\.log/i);
  assert.doesNotMatch(trayController, /spark-launcher\.log/i);
  assert.match(trayController, /Tray logging is best-effort/i);
  assert.match(trayController, /Invoke-RestMethod .*healthUrl/i);
  assert.doesNotMatch(trayController, /dotnet|npm install|nuget/i);
  assert.match(init, /auth-cli\.mjs/);
  assert.match(init, /\$authCli generate --json/);
  assert.match(init, /already initialized/i);
  assert.match(init, /Incomplete initialization state/i);
  assert.match(init, /\$configExists -and \$accessTokenExists/);
  assert.match(init, /\$configExists -xor \$accessTokenExists/);
  assert.match(init, /\[Console\]::Error\.WriteLine/);
  assert.doesNotMatch(init, /\bthrow\b/i);
  assert.doesNotMatch(init, /Write-Host[^\r\n]*\$ConfigPath/i);
  assert.doesNotMatch(init, /Write-Host[^\r\n]*\$root/i);
  assert.match(init, /UTF8Encoding.*false/);
  assert.match(init, /Access_token/);
  assert.doesNotMatch(init, /spark-access-key\.txt/);
  assert.match(start, /Access_token/);
  assert.match(start, /API_secret_key/);
  assert.match(start, /Test-TunnelReadyContent/);
  assert.doesNotMatch(start, /transport\.auth|bearerTokenSha256|controlPlaneKeySha256|sparkAccessKeySha256/);
  assert.match(start, /Get-StartApps/);
  assert.match(start, /\.runtime\\config\\spark\.local\.json/);
  assert.doesNotMatch(start, /mod\\spark_transport\\config\\spark\.local\.json/);
  assert.doesNotMatch(start, /Test-Path -LiteralPath \$moduleConfig -PathType Leaf/);
  assert.match(start, /Get-Process -Name 'ChatGPT'/);
  assert.match(start, /npm --prefix .* run --silent transport:start/);
  assert.match(start, /bounded-process-cli\.mjs/);
  assert.match(start, /30000 \$client doctor/);
  assert.match(start, /Get-SparkLogDirectory/i);
  assert.match(start, /Join-Path \$logDir 'tunnel-doctor\.log'/i);
  assert.match(uiLauncher, /Get-SparkLogDirectory/i);
  assert.match(uiLauncher, /Join-Path \$LogDirectory 'watcher-out\.log'/i);
  assert.match(stop, /bounded-process-cli\.mjs/);
  assert.match(status, /npm --prefix .* run --silent transport:status/);
  assert.match(start, /\.StartsWith\('\[S2-08\]'\)/);
  assert.doesNotMatch(start, /-like\s+'\[S2-0[78]\]\*'/i);
  assert.match(start, /\$readyTimeoutSeconds=60/);
  assert.match(start, /tunnel-runtime\.json/);
  assert.match(start, /Get-TunnelProfileId/);
  assert.match(start, /\$runtimeIdentityOk/);
  assert.match(start, /profileTunnelId.*config\.tunnel\.id/);
  assert.match(start, /--require-control-plane-poll/);
  assert.doesNotMatch(start, /profile doctor skipped/i);
  assert.match(status, /IDENTITY-MISMATCH/);
  assert.match(status, /tunnel-runtime\.json/);
  assert.match(status, /--require-control-plane-poll/);
  assert.doesNotMatch(start, /health\?details=true/);
  assert.doesNotMatch(start, /health\/mcp/);
  assert.doesNotMatch(start, /health\/control-plane/);
  assert.match(start, /health --port 8080 --pid-file .* --require-control-plane-poll --json/);
  assert.doesNotMatch(start, /did not become ready within 20 seconds/i);
  assert.match(start, /remains running as PID/);
  assert.match(start, /Start-ChatGPTExperience/);
  assert.match(start, /\[switch\]\$SkipChatGPTUi/);
  assert.match(start, /if\(\$SkipChatGPTUi\).*return/);
  assert.match(start, /mod\\spark_ui\\script\\start-chatgpt-ui\.ps1/);
  assert.match(start, /Test-ChatGPTUiRuntime/);
  assert.match(start, /spark-tray-supervisor\.ps1/);
  assert.ok(start.indexOf('Start-SparkTray\n') < start.indexOf('[S2-03] Starting Transport service'), 'Tray must start before backend startup can fail');
  assert.match(psEntry, /mod\\spark_transport\\script\\validate-windows\.ps1/);
  assert.match(status, /Get-Process -Name 'ChatGPT'/);
  assert.match(status, /ChatGPT UI runtime/);
  assert.match(status, /log\\system\\active\.json/);
  assert.match(stop, /\$tunnelPid\s*=/);
  assert.doesNotMatch(stop, /\$pid\s*=/i);
  assert.match(stop, /log\\system\\active\.json/);
  assert.match(stop, /Stop-Process -Name|Stop-Process/);
  assert.match(uiLauncher, /--remote-debugging-port=\$port/);
  assert.match(uiLauncher, /start-chatgpt-ui|SPARK ChatGPT UI/i);
  assert.match(uiLauncher, /\[UI-01\].*Theme config validated/);
  assert.match(uiLauncher, /\[UI-06\].*startup complete/);
  assert.match(uiLauncher, /TransportHealthUrl/);
  assert.match(uiWatcher, /--transport-health/);
  assert.match(uiWatcher, /buildProgressExpression/);
  assert.match(start, /chatgptUi\.progress/);
  assert.doesNotMatch(uiLauncher, /\$result\s*\|\s*ConvertTo-Json/);
  assert.match(uiCli, /Chrome DevTools|CDP|apply|restore/i);
});

test('Windows hidden status works with an exclusively locked obsolete action log', {
  skip: process.platform !== 'win32',
  timeout: 18000,
}, async (t) => {
  const f = await makeFixture();
  const scripts = path.join(f.root, 'out', 'spark', 'script');
  await fs.mkdir(scripts, { recursive: true });
  await fs.copyFile(path.join(ROOT, 'out/spark/script', 'spark-hidden-action.ps1'),
    path.join(scripts, 'spark-hidden-action.ps1'));
  await fs.copyFile(path.join(ROOT, 'out/spark/script', 'spark-log-path.ps1'),
    path.join(scripts, 'spark-log-path.ps1'));
  await fs.writeFile(path.join(f.root, 'out', 'SPARK.ps1'),
    "Write-Output 'FIXTURE_STATUS_OK'\nexit 0\n", 'utf8');

  const actionLog = path.join(f.outside, 'spark-action.log');
  await fs.writeFile(actionLog, 'EXCLUSIVE_OLD_ACTION_LOG\n', 'utf8');
  const escaped = actionLog.replaceAll("'", "''");
  const owner = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$f=[IO.File]::Open('${escaped}',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);Write-Output 'LOCKED';Start-Sleep -Seconds 12;$f.Dispose()`],
  { cwd: f.base, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopOwner = async () => {
    if (owner.exitCode !== null || owner.signalCode !== null) return;
    const closed = new Promise((resolve) => owner.once('close', resolve));
    owner.kill();
    await closed;
  };
  t.after(async () => {
    await stopOwner();
    await f.cleanup();
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Could not acquire exclusive fixture log lock')), 5000);
    owner.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('LOCKED')) { clearTimeout(timer); resolve(); }
    });
    owner.once('error', reject);
    owner.once('exit', (code) => reject(new Error('Lock owner terminated early: ' + code)));
  });
  const worker = path.join(scripts, 'spark-hidden-action.ps1');
  const execution = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        worker, '-Action', 'status', '-NoErrorDialog'],
      { cwd: f.root, windowsHide: true,
        env: { ...process.env, SPARK_LOG_DIR: f.outside } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(execution.code, 0, execution.stderr);
  const lifecycle = await fs.readFile(path.join(f.outside, 'spark-lifecycle.log'), 'utf8');
  assert.match(lifecycle, /FIXTURE_STATUS_OK/);
  assert.match(lifecycle, /action=status completed exitCode=0/);
  await stopOwner();
  assert.equal(await fs.readFile(actionLog, 'utf8'), 'EXCLUSIVE_OLD_ACTION_LOG\n');
});

test('repository hygiene keeps local-only state out of tracked source', async () => {
  const gitignore = await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /(?:^|\r?\n)\/_pArc\/(?:\r?\n|$)/);
  assert.match(gitignore, /(?:^|\r?\n)\/ref\/(?:\r?\n|$)/);
  assert.match(gitignore, /(?:^|\r?\n)\/doc\/wiki\/(?:\r?\n|$)/);
  assert.match(gitignore, /(?:^|\r?\n)\/\.runtime\/(?:\r?\n|$)/);
  assert.deepEqual(gitignore.replace(/\r\n/g, '\n').trimEnd().split('\n'),
    ['/_pArc/', '/doc/wiki/', '/.runtime/', '/log/', '/ref/']);
});

test('renamed Transport resolves the legacy bundled tunnel path from existing configuration without rewriting it', async (t) => {
  const f = await makeFixture();
  t.after(async () => f.cleanup());
  const configPath = path.join(f.base, 'config.json');
  const logDir = path.join(f.base, 'logs');
  const stateDir = path.join(f.base, 'state');
  await fs.mkdir(logDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    transport: { allowedRoot: f.root },
    tunnel: { clientDir: 'mod/transport/tool/tunnel_client' }
  }), 'utf8');

  const expected = path.join(ROOT, 'mod', 'spark_transport', 'tool', 'tunnel_client');
  const actual = loadConfig({ configPath, logDir, stateDir });
  assert.equal(actual.tunnel.clientDir.toLowerCase(), expected.toLowerCase());
  assert.equal((await fs.readFile(configPath, 'utf8')).includes('mod/transport/tool/tunnel_client'), true);
  const current = await fs.stat(expected);
  assert.equal(current.isDirectory(), true);
});

test('Tray icon registration is probed and restored without restarting the lifecycle', async () => {
  const tray = await fs.readFile(path.join(ROOT, 'out/spark/script/spark-tray.ps1'), 'utf8');
  assert.match(tray, /Shell_NotifyIconGetRect/);
  assert.match(tray, /GetRegistrationState\(NotifyIcon icon\)/);
  assert.match(tray, /\$result -ge 0/);
  assert.match(tray, /\$script:missingRegistrationChecks -ge 2/);
  assert.match(tray, /\$notifyIcon\.Visible = \$false[\s\S]*?\$notifyIcon\.Visible = \$true/);
  assert.match(tray, /\$timer\.Add_Tick\(\{[\s\S]*?Test-TrayShellRegistration/);
  assert.match(tray, /heartbeat shell=/);
  assert.match(tray, /if \(\$changed\) \{ \$notifyIcon\.Icon = \$runningIcon \}/);
  assert.match(tray, /if \(\$changed\) \{ \$notifyIcon\.Icon = \$stoppedIcon \}/);
  assert.doesNotMatch(tray, /Stop-Process -Name ChatGPT/i);
  if (process.platform !== 'win32') return;
  // Compile the exact production C# probe in a new process, without creating
  // any visible notification icon or altering the active desktop.
  const { spawnSync } = await import('node:child_process');
  const program = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$s=[IO.File]::ReadAllText(' + "'" + path.join(ROOT, 'out/spark/script/spark-tray.ps1').replaceAll("'", "''") + "'" + ')',
    '$m=[regex]::Match($s,"(?s)-TypeDefinition @\x27\\r?\\n(.*?)\\r?\\n\x27@")',
    "if(-not $m.Success){throw 'C# source missing'}",
    "Add-Type -TypeDefinition $m.Groups[1].Value -ReferencedAssemblies @('System.Windows.Forms.dll','System.Drawing.dll')",
    '$n=[System.Windows.Forms.NotifyIcon]::new()',
    'try{if([SparkTrayShellProbe]::GetRegistrationState($n) -ne [int]::MinValue){exit 3}}finally{$n.Dispose()}',
  ].join(';');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', program], {
    cwd: ROOT, encoding: 'utf8', timeout: 14000,
  });
  assert.equal(result.status, 0, result.stderr || 'Tray C# probe regression failed');
});
