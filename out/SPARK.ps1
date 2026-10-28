param(
  [Parameter(Position=0)][string]$Command = '',
  [Parameter(Position=1)][string]$Subcommand = '',
  [Alias('b')][switch]$Backup,
  [Alias('v')][switch]$Viewer,
  [string]$Title = '',
  [string]$OutputDirectory = '',
  [switch]$ArchiveAfterBackup,
  [string]$InputFile = '',
  [switch]$Headless,
  [switch]$SkipChatGPTUi,
  [switch]$Help
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$common = Join-Path $PSScriptRoot 'spark\script'

function Show-SparkHelp {
@'
SPARK 0.0.3 - Symbiotic Personal AI Robotic Keeper
Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 [command] [options]

General and lifecycle commands:
  <no arguments>      Start/recover SPARK tray, Transport, Tunnel, UI and CII (Explorer-friendly).
  --help | -Help      Show this list without running any service.
  help                Show this list.
  init                Initialize the local private configuration.
  start [-SkipChatGPTUi]
                      Start or repair Transport/Tunnel/UI/CII; optionally omit UI launch.
  restart             Stop and restart all SPARK-owned services (disruptive).
  status              Read-only Transport/Tunnel/ChatGPT UI status.
  stop                Stop SPARK-owned services (tray remains available).
  autostart [on|off|status]
                      Manage reversible, per-user Windows login Startup shortcut.
  validate            Run Windows Transport validation.
  auth generate       Generate a new Access_token (modifies credentials).

Chat conversation backup / viewer (NOT transport/system logs):
  chatlog              Show ChatLog command and option help.
  chatlog -b           Open Backup GUI.
  chatlog -b -Title "..." -OutputDirectory "..." [-ArchiveAfterBackup]
                      Back up one chat to an EXISTING output directory.
  chatlog -v           Open the offline Chat/JSONL Viewer.
  chatlog -v -InputFile "C:\path\chat.jsonl" [-Headless]
  chatlog --help      Show complete ChatLog-specific options.

Help safety: [command] --help never runs start/restart/stop/backup.
Legacy 'log' command is removed; use 'chatlog'.
Windows hidden tray launcher: out\SPARK.vbs (one VBS exception).
PowerShell (.ps1/.psm1) owns all other command implementations.
'@ | Write-Output
}

try {
  $action = [string]$Command
  if ($action -eq 'log') {
    [Console]::Error.WriteLine("Command 'log' has been renamed to 'chatlog'. Run 'chatlog --help' for options.")
    exit 2
  }
  if ($Help -and $action -ne 'chatlog' -or $action -in @('help', '--help', '-h', '/?')) {
    Show-SparkHelp
    exit 0
  }
  if ($Subcommand -and $action -notin @('auth', 'chatlog', 'autostart')) {
    [Console]::Error.WriteLine('Unexpected positional argument: ' + $Subcommand)
    exit 2
  }
  if ($action -ne 'chatlog' -and ($Backup -or $Viewer -or $Title -or $OutputDirectory -or $ArchiveAfterBackup -or $InputFile -or $Headless)) {
    [Console]::Error.WriteLine('Chat backup/viewer options require the chatlog command.')
    exit 2
  }
  if (-not $action) {
    # Explorer "Run with PowerShell": no-argument invocation must not silently show help and exit.
    $launcher = Join-Path $root 'out\SPARK.vbs'
    $hostExe = Join-Path $env:WINDIR 'System32\wscript.exe'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'SPARK.vbs is missing.' }
    $process = Start-Process -FilePath $hostExe -ArgumentList ('"'+$launcher+'"') -PassThru -WindowStyle Hidden -ErrorAction Stop
    Write-Output ('SPARK user-session launch requested (WScript PID='+$process.Id+'). Check tray and spark-lifecycle.log for completion.')
    exit 0
  }
  switch ($action.ToLowerInvariant()) {
    'autostart' {
      $mode = if ($Subcommand) { $Subcommand.ToLowerInvariant() } else { 'status' }
      if ($mode -notin @('on', 'off', 'status')) { throw 'Usage: SPARK.ps1 autostart [on|off|status]' }
      & (Join-Path $common 'spark-autostart.ps1') -Action $mode
      if (-not $?) { exit 1 }
      exit 0
    }
    'init' {
      & (Join-Path $common 'init-user.ps1')
      if (-not $?) { exit 1 }
      exit 0
    }
    'start' {
      & (Join-Path $common 'start-all.ps1') -SkipChatGPTUi:$SkipChatGPTUi
      if (-not $?) { exit 1 }
      exit 0
    }
    'restart' {
      if ($SkipChatGPTUi) { throw 'restart requires full UI lifecycle; use start -SkipChatGPTUi for backend-only startup.' }
      & (Join-Path $common 'stop-all.ps1')
      if (-not $?) { exit 1 }
      & (Join-Path $common 'start-all.ps1')
      if (-not $?) { exit 1 }
      exit 0
    }
    'status' {
      & (Join-Path $common 'status-all.ps1')
      if (-not $?) { exit 1 }
      exit 0
    }
    'stop' {
      & (Join-Path $common 'stop-all.ps1')
      if (-not $?) { exit 1 }
      exit 0
    }
    'validate' {
      & (Join-Path $root 'mod\spark_transport\script\validate-windows.ps1')
      if (-not $?) { exit 1 }
      exit 0
    }
    'auth' {
      if ($Subcommand -ne 'generate') { throw 'Usage: SPARK.ps1 auth generate' }
      & node.exe (Join-Path $root 'mod\spark_transport\src\auth-cli.mjs') generate
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      exit 0
    }
    'chatlog' {
      if ($Subcommand -and $Subcommand -ne 'help') {
        throw 'ChatLog options use -b or -v, not a second positional operation.'
      }
      $runner = Join-Path $root 'mod\spark_log\script\spark_log.ps1'
      & $runner -Backup:$Backup -Viewer:$Viewer -Title $Title -OutputDirectory $OutputDirectory -ArchiveAfterBackup:$ArchiveAfterBackup -InputFile $InputFile -Headless:$Headless -Help:($Help -or $Subcommand -eq 'help')
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
      if (-not $?) { exit 1 }
      exit 0
    }
    default {
      Show-SparkHelp
      [Console]::Error.WriteLine('Unknown SPARK command: ' + $action)
      exit 2
    }
  }
} catch {
  [Console]::Error.WriteLine('SPARK command failed: ' + $_.Exception.Message)
  exit 1
}
