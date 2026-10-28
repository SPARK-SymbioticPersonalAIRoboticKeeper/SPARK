import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("SWE2 4.3 canonical level-one layout and two ordinary root files", async () => {
  const names = await fs.readdir(ROOT, { withFileTypes: true });
  const allowedDirs = new Set([
    ".git", ".github", "doc", "log", "ref", "mod", "out",
    // .runtime is user-managed; _pArc is the original private process Git repository.
    ".runtime", "_pArc",
  ]);
  const allowedFiles = new Set(["AGENTS.md", "README.md", ".gitignore"]);
  for (const item of names) {
    assert.ok(
      item.isDirectory() ? allowedDirs.has(item.name) : allowedFiles.has(item.name),
      "Unapproved root Level0/Level1 item: " + item.name,
    );
  }
  for (const name of [".github", "doc", "log", "mod", "out"]) {
    assert.ok(names.some(item => item.name === name && item.isDirectory()), name);
  }
  for (const name of ["SPARK.cmd", "SPARK.vbs", "package.json", "scripts", "modules", "docs", "refs"]) {
    assert.ok(!names.some(item => item.name === name), "Legacy item remains: " + name);
  }
});

test("reference, private chat archive and modules are in their canonical owned paths", async () => {
  const expected = [
    "mod/spark_transport/script/validate-windows.ps1",
    "mod/spark_transport/tool/tunnel_client/.gitkeep",
    "mod/spark_transport/src/config.mjs",
    "mod/spark_ui/script/start-chatgpt-ui.ps1",
    "mod/spark_ui/src/route-overlay.mjs",
    "out/spark/script/start-all.ps1",
    "out/spark/script/status-all.ps1",
    "out/SPARK.ps1", "out/SPARK.vbs", "out/package.json",
  ];
  for (const f of expected) assert.ok((await fs.stat(path.join(ROOT, f))).isFile(), f);
  const refModule = path.join(ROOT, "mod", "spark_transport", "refs");
  assert.equal(await fs.stat(refModule).then(() => true).catch(() => false), false);
  const log = await fs.readdir(path.join(ROOT, "log"));
  if (process.platform === "win32" && log.includes("chat_history")) {
    const children = await fs.readdir(path.join(ROOT, "log", "chat_history"));
    assert.ok(children.length >= 1);
  }
});

test("bounded hidden tunnel-client startup cannot inherit the caller's console pipes", async () => {
  const source = await fs.readFile(path.join(ROOT, "out", "spark", "script", "start-all.ps1"), "utf8");
  assert.match(source, /\$psi\.UseShellExecute=\$true/);
  assert.match(source, /\$psi\.WindowStyle=\[System\.Diagnostics\.ProcessWindowStyle\]::Hidden/);
  assert.doesNotMatch(source, /\$psi\.UseShellExecute=\$false/);
});

test("project Git excludes all five user-approved local-only roots including ref", async () => {
  const ignore = await fs.readFile(path.join(ROOT, ".gitignore"), "utf8");
  const rules = ignore.replace(/\r\n/g, "\n").trimEnd().split("\n");
  assert.deepEqual(rules, ["/_pArc/", "/doc/wiki/", "/.runtime/", "/log/", "/ref/"]);
  assert.match(ignore, /^\/ref\/$/m);
  const { execFileSync } = await import("node:child_process");
  const trackedRef = execFileSync("git", ["ls-files", "--", "ref/"], {
    cwd: ROOT, encoding: "utf8",
  }).trim();
  assert.equal(trackedRef, "", "ref/ must remain local-only even in Private source");
  const project = JSON.parse(await fs.readFile(path.join(ROOT, "out", "package.json"), "utf8"));
  assert.equal(project.version, "0.0.3");
  assert.match(project.scripts.test, /\.\.\/mod\/spark_transport\/test/);
  assert.match(project.scripts.test, /\.\.\/mod\/spark_ui\/test/);
});

test('SPARK module names and entrypoint paths use the spark_ prefix', async () => {
  const moduleDir = path.join(ROOT, 'mod');
  const names = new Set(await fs.readdir(moduleDir));
  for (const name of ['spark_transport', 'spark_ui', 'spark_log']) {
    assert.ok(names.has(name), 'Missing canonical module ' + name);
  }
  for (const name of ['transport', 'chatgpt_ui']) {
    assert.ok(!names.has(name), 'Legacy module directory must not remain: ' + name);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'out', 'package.json'), 'utf8'));
  for (const route of ['../mod/spark_transport/test/', '../mod/spark_ui/test/', '../mod/spark_log/test/']) {
    assert.ok(manifest.scripts.test.includes(route), route);
  }
  const ignores = await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8');
  assert.deepEqual(ignores.replace(/\r\n/g, '\n').trimEnd().split('\n'),
    ['/_pArc/', '/doc/wiki/', '/.runtime/', '/log/', '/ref/']);
  const config = await fs.readFile(path.join(moduleDir, 'spark_transport', 'src', 'config.mjs'), 'utf8');
  assert.ok(config.includes('resolveTunnelClientDir'));
});

test('all operational config loaders use the private runtime path, not a module-local secret file', async () => {
  const sources = [
    'out/spark/script/start-all.ps1',
    'out/spark/script/status-all.ps1',
    'out/spark/script/stop-all.ps1',
    'out/spark/script/spark-log-path.ps1',
    'out/spark/script/spark-tray.ps1',
    'mod/spark_transport/script/validate-windows.ps1',
  ];
  for (const relative of sources) {
    const content = await fs.readFile(path.join(ROOT, relative), 'utf8');
    assert.match(content, /\.runtime\\config\\spark\.local\.json/i, relative);
    assert.doesNotMatch(content, /mod\\spark_transport\\config\\spark\.local\.json/i, relative);
  }
  const configSource = await fs.readFile(path.join(ROOT, 'mod/spark_transport/src/config.mjs'), 'utf8');
  assert.match(configSource, /RUNTIME_CONFIG_PATH/);
  assert.doesNotMatch(configSource, /MODULE_CONFIG_PATH/);
  const ignore = await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\/\.runtime\/$/m);
  assert.doesNotMatch(ignore, /mod\/spark_transport\/config\/spark\.local\.json/);
});

test('Tunnel connection profile remains single-copy private config; no automatic backup or force overwrite', async () => {
  const start = await fs.readFile(path.join(ROOT, 'out/spark/script/start-all.ps1'), 'utf8');
  const status = await fs.readFile(path.join(ROOT, 'out/spark/script/status-all.ps1'), 'utf8');
  assert.match(start, /\$profileConfigRoot=Join-Path \$root '\.runtime\\config'/);
  assert.match(start, /\$profileDir=Join-Path \$profileConfigRoot 'tunnel-profiles'/);
  assert.doesNotMatch(start, /tunnel-profile-backups|Backup-TunnelProfile|init --force/i);
  assert.match(start, /Private Tunnel profile mismatches configured ID\/key reference; refusing to overwrite or create backup/);
  assert.match(start, /Existing Tunnel profile doctor failed; preserving profile without force-reinit or backup/);
  assert.ok(start.indexOf('Private Tunnel profile mismatches configured ID/key reference') < start.indexOf('Stop-OwnedTunnel $existingTunnelPid $reason'), 'profile mismatch must fail before active tunnel stop');
  assert.match(status, /\$profileDir=Join-Path \$root '\.runtime\\config\\tunnel-profiles'/);
  assert.doesNotMatch(start, /\$profileDir=Join-Path \$runtime 'tunnel-profiles'/);
  assert.doesNotMatch(start, /Copy-Item\s+-LiteralPath\s+\$profilePath\b/i);
  assert.match(start, /\$legacyProfilePath=/);
  assert.match(status, /\$legacyProfilePath=/);
  assert.match(start, /\$runtimeState\.profileSha256 -eq \[string\]\$profileHash/);
  assert.match(status, /\$runtimeState\.profileSha256 -eq \[string\]\$profileHash/);
  // The original runtime identity/PID is temporary and deliberately stays in log/system.
  assert.match(start, /\$runtimeStatePath=Join-Path \$runtime 'tunnel-runtime\.json'/);
  assert.match(status, /\$runtimeStatePath=Join-Path \$runtime 'tunnel-runtime\.json'/);
  const ignore = await fs.readFile(path.join(ROOT, '.gitignore'), 'utf8');
  assert.deepEqual(ignore.replace(/\r\n/g, '\n').trimEnd().split('\n'),
    ['/_pArc/', '/doc/wiki/', '/.runtime/', '/log/', '/ref/']);
});

test('disposable log/system is securely reprovisioned without creating durable recovery data', { skip: process.platform !== 'win32' }, async (t) => {
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'spark-log-disposable-fixture-'));
  t.after(async () => fs.rm(fixture, { recursive: true, force: true }));
  const helper = path.join(ROOT, 'out', 'spark', 'script', 'spark-log-path.ps1');
  const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
  const script = [
    "$ErrorActionPreference='Stop'",
    "$env:SPARK_CONFIG=''",
    "$env:SPARK_LOG_DIR=''",
    '. ' + literal(helper),
    '$root=' + literal(fixture),
    '$first=Get-SparkLogDirectory -Root $root -InitializeApprovedDisposableState',
    "Remove-Item -LiteralPath (Join-Path $root 'log') -Recurse -Force",
    '$second=Get-SparkLogDirectory -Root $root -InitializeApprovedDisposableState',
    '$acl=Get-Acl -LiteralPath $second',
    "$children=@('ledger','recovery')|ForEach-Object{Test-Path -LiteralPath (Join-Path $second $_)}",
    "[pscustomobject]@{SamePath=($first -ieq $second);PrivateAcl=$acl.AreAccessRulesProtected;ChildrenPresent=(@($children|Where-Object{$_ -ne $true}).Count -eq 0)}|ConvertTo-Json -Compress",
  ].join('; ');
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(run.status, 0, run.stderr || 'approved disposable log reprovision failed');
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.SamePath, true);
  assert.equal(result.PrivateAcl, true);
  assert.equal(result.ChildrenPresent, false);
  assert.equal(await fs.stat(path.join(fixture, 'log', 'system')).then(s => s.isDirectory()), true);
  assert.equal(await fs.stat(path.join(fixture, '.runtime')).then(() => true).catch(() => false), false);
});


test('persistent production data is outside .runtime and disposable log/system', async () => {
  const config = await fs.readFile(path.join(ROOT, 'mod/spark_transport/src/config.mjs'), 'utf8');
  const server = await fs.readFile(path.join(ROOT, 'mod/spark_transport/src/server.mjs'), 'utf8');
  const pal = await fs.readFile(path.join(ROOT, 'mod/spark_transport/src/file-pal.mjs'), 'utf8');
  const ledger = await fs.readFile(path.join(ROOT, 'mod/spark_transport/src/ledger.mjs'), 'utf8');
  const nodeData = await fs.readFile(path.join(ROOT, 'out/spark/data-path.mjs'), 'utf8');
  const powershellData = await fs.readFile(path.join(ROOT, 'out/spark/script/spark-data-path.ps1'), 'utf8');
  const ui = await fs.readFile(path.join(ROOT, 'mod/spark_ui/script/start-chatgpt-ui.ps1'), 'utf8');
  const watcher = await fs.readFile(path.join(ROOT, 'mod/spark_ui/src/watch.mjs'), 'utf8');
  const gui = await fs.readFile(path.join(ROOT, 'mod/spark_log/backup/backup_chat_gui.ps1'), 'utf8');
  const init = await fs.readFile(path.join(ROOT, 'out/spark/script/init-user.ps1'), 'utf8');
  assert.match(config, /USER_DATA_ROOT = sparkDataRoot/);
  assert.match(config, /durableLedgerDir: path\.join\(USER_DATA_ROOT, 'audit'\)/);
  assert.doesNotMatch(config, /durableRecoveryRoot|RUNTIME_DATA_ROOT/);
  assert.match(server, /durableLedgerDir:config\.durableLedgerDir/);
  assert.doesNotMatch(server, /recoveryRoot:config\./);
  assert.doesNotMatch(pal, /SPARK-PAL-SNAPSHOT|spark-snapshot|recoveryRoot/);
  assert.match(ledger, /durableLedgerDir/);
  assert.match(nodeData, /LOCALAPPDATA/);
  assert.match(powershellData, /LOCALAPPDATA/);
  assert.match(ui, /Get-SparkUserDataRoot -SourceRoot/);
  assert.match(watcher, /sparkDataRoot\(\{ projectRoot:/);
  assert.match(gui, /Get-SparkUserDataRoot -SourceRoot/);
  assert.match(init, /Initialize-SparkUserData -SourceRoot/);
  assert.doesNotMatch(init, /\.runtime\\data|Join-Path \$privateRoot 'data'/);
});
