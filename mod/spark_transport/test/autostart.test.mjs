import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..','..','..');
const PS = path.join(ROOT, 'out', 'spark', 'script', 'spark-autostart.ps1');
const winOnly = { skip: process.platform !== 'win32' };
function invoke(action, folder) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    PS, '-Action', action, '-TestStartupDirectory', folder,
  ], { cwd: ROOT, encoding:'utf8', timeout:16000 });
  return {code:r.status, out:r.stdout.trim(), err:r.stderr.trim()};
}

test('AutoStart on/off/status is reversible, idempotent, and never changes real Windows Startup in isolated fixture', winOnly, () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(), 'spark-startup-test-'));
  const link=path.join(home,'SPARK.lnk');
  try {
    for (const [action,expected,exists] of [
      ['status','OFF',false],['on','ON',true],['on','ON',true],
      ['status','ON',true],['off','OFF',false],['off','OFF',false],['status','OFF',false]
    ]) {
      const r=invoke(action,home);
      assert.equal(r.code,0,r.err);
      assert.match(r.out,new RegExp('SPARK AUTOSTART '+expected));
      assert.equal(fs.existsSync(link),exists);
    }
  } finally { fs.rmSync(home,{recursive:true,force:true}); }
});

test('AutoStart never overwrites a foreign Startup entry', winOnly, () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(), 'spark-startup-conflict-'));
  const link=path.join(home,'SPARK.lnk');
  try {
    fs.writeFileSync(link,'UNRELATED_USER_LINK');
    const r=invoke('on',home);
    assert.notEqual(r.code,0);
    assert.equal(fs.readFileSync(link,'utf8'),'UNRELATED_USER_LINK');
    const off=invoke('off',home);
    assert.notEqual(off.code,0);
    assert.equal(fs.readFileSync(link,'utf8'),'UNRELATED_USER_LINK');
  } finally { fs.rmSync(home,{recursive:true,force:true}); }
});

test('Explorer PowerShell entrypoint and VBS both delegate to idempotent start, without changing PS1 association', async () => {
  const entry=fs.readFileSync(path.join(ROOT,'out','SPARK.ps1'),'utf8');
  const vbs=fs.readFileSync(path.join(ROOT,'out','SPARK.vbs'),'utf8');
  const tray=fs.readFileSync(path.join(ROOT,'out','spark','script','spark-tray.ps1'),'utf8');
  const supervisor=fs.readFileSync(path.join(ROOT,'out','spark','script','spark-tray-supervisor.ps1'),'utf8');
  assert.match(entry,/\[string\]\$Command = ''/);
  assert.match(entry,/if \(-not \$action\)[\s\S]*?SPARK\.vbs/);
  assert.match(vbs,/If WScript\.Arguments\.Count = 0 Then[\s\S]*?action = "start"/);
  assert.match(vbs,/spark-tray-supervisor\.ps1/);
  assert.match(tray,/AutoStart ON/);
  assert.match(tray,/AutoStart OFF/);
  assert.match(tray,/spark-tray-exit\.request/);
  assert.match(supervisor,/Local\\SPARK\.TraySupervisor/);
  assert.match(supervisor,/Get-OwnedTray/);
  assert.match(supervisor,/Start-Sleep -Seconds 6/);
  assert.doesNotMatch(entry,/New-ItemProperty|Set-ItemProperty|HKCU:|HKLM:/i);
});

test('AutoStart is one top-level tray item with exactly two checked submenu options', () => {
  const tray=fs.readFileSync(path.join(ROOT,'out','spark','script','spark-tray.ps1'),'utf8');
  const autoTop=[...tray.matchAll(/\[void\]\$menu\.Items\.Add\(\$(autoMenuItem|autoStateItem|autoOnItem|autoOffItem)\)/g)].map(m=>m[1]);
  assert.deepEqual(autoTop,['autoMenuItem']);
  const submenu=[...tray.matchAll(/\[void\]\$autoMenuItem\.DropDownItems\.Add\(\$(autoOnItem|autoOffItem)\)/g)].map(m=>m[1]);
  assert.deepEqual(submenu,['autoOnItem','autoOffItem']);
  assert.match(tray,/\$autoMenuItem = \[System\.Windows\.Forms\.ToolStripMenuItem\]::new\('AutoStart'\)/);
  assert.match(tray,/\$autoOnItem = \[System\.Windows\.Forms\.ToolStripMenuItem\]::new\('ON'\)/);
  assert.match(tray,/\$autoOffItem = \[System\.Windows\.Forms\.ToolStripMenuItem\]::new\('OFF'\)/);
  assert.match(tray,/\$autoOnItem\.Checked = \$enabled/);
  assert.match(tray,/\$autoOffItem\.Checked = -not \$enabled/);
  assert.match(tray,/\$autoMenuItem\.Add_DropDownOpening\(\{ Update-AutostartStatus \}\)/);
  assert.doesNotMatch(tray,/\$autoStateItem|new\('AutoStart OFF'\)|new\('AutoStart ON/);
});

test('actual WinForms menu callbacks reflect OFF, ON, OFF and ambiguous state without touching Windows Startup',winOnly,()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'spark-tray-submenu-fixture-'));
  const stateFile=path.join(home,'state.txt');
  const fakeFile=path.join(home,'fake-startup.ps1');
  const harness=path.join(home,'check-submenu.ps1');
  const trayFile=path.join(ROOT,'out','spark','script','spark-tray.ps1');
  const quote=s=>s.replaceAll("'","''");
  try {
    fs.writeFileSync(stateFile,'OFF');
    fs.writeFileSync(fakeFile,[
      "param([ValidateSet('on','off','status')][string]$Action='status')",
      "$f=Join-Path $PSScriptRoot 'state.txt'",
      "if($Action -eq 'on'){[IO.File]::WriteAllText($f,'ON')}",
      "if($Action -eq 'off'){[IO.File]::WriteAllText($f,'OFF')}",
      "Write-Output ('SPARK AUTOSTART '+([IO.File]::ReadAllText($f))+' (fixture)')",
      ""
    ].join('\n'));
    fs.writeFileSync(harness,[
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      "$autostartScript='"+quote(fakeFile)+"'",
      "$sourcePath='"+quote(trayFile)+"'",
      "$autoMenuItem=[System.Windows.Forms.ToolStripMenuItem]::new('AutoStart')",
      "$autoOnItem=[System.Windows.Forms.ToolStripMenuItem]::new('ON')",
      "$autoOffItem=[System.Windows.Forms.ToolStripMenuItem]::new('OFF')",
      '[void]$autoMenuItem.DropDownItems.Add($autoOnItem)',
      '[void]$autoMenuItem.DropDownItems.Add($autoOffItem)',
      '$notifyIcon=[System.Windows.Forms.NotifyIcon]::new()',
      'function Write-TrayLog([string]$Message) {}',
      '$tok=$null;$err=$null',
      '$ast=[Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tok,[ref]$err)',
      "if(@($err).Count){throw 'Invalid tray script syntax'}",
      "$defs=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Update-AutostartStatus','Set-AutostartMode')},$true))",
      "if($defs.Count -ne 2){throw 'Expected 2 real tray functions'}",
      'foreach($fn in $defs){. ([scriptblock]::Create($fn.Extent.Text))}',
      "$autoOnItem.Add_Click({Set-AutostartMode 'on'})",
      "$autoOffItem.Add_Click({Set-AutostartMode 'off'})",
      'Update-AutostartStatus',
      "if($autoOnItem.Checked -or -not $autoOffItem.Checked){throw 'OFF initial check failure'}",
      '$autoOnItem.PerformClick()',
      "if(-not $autoOnItem.Checked -or $autoOffItem.Checked){throw 'ON check failure'}",
      '$autoOffItem.PerformClick()',
      "if($autoOnItem.Checked -or -not $autoOffItem.Checked){throw 'OFF check failure'}",
      "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'state.txt'),'CONFLICT')",
      'Update-AutostartStatus',
      "if($autoOnItem.Checked -or $autoOffItem.Checked -or $autoOnItem.Enabled -or $autoOffItem.Enabled){throw 'Unknown status must not falsely show OFF'}",
      "$notifyIcon.Dispose();$autoMenuItem.Dispose()",
      "Write-Output 'OFF->ON->OFF->CONFLICT verified with real tray functions'",
      ''
    ].join('\n'));
    const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',harness],{cwd:ROOT,encoding:'utf8',timeout:26000});
    assert.equal(r.status,0,r.stderr||r.stdout);
    assert.match(r.stdout,/OFF->ON->OFF->CONFLICT verified/);
  }finally{
    fs.rmSync(home,{recursive:true,force:true});
  }
});
