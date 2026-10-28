param(
  [Alias('b')][switch]$Backup,
  [Alias('v')][switch]$Viewer,
  [string]$Title = '',
  [string]$OutputDirectory = '',
  [switch]$ArchiveAfterBackup,
  [string]$InputFile = '',
  [switch]$Headless,
  [switch]$Help
)
$ErrorActionPreference = 'Stop'
$moduleRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$backupRoot = Join-Path $moduleRoot 'backup'
$viewerRoot = Join-Path $moduleRoot 'viewer'

function Show-SparkLogHelp {
@'
SPARK ChatLog - Backup / Viewer
Usage (from SPARK root):
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -b
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -b -Title "Chat title" -OutputDirectory "C:\Backups" [-ArchiveAfterBackup]
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -v
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -v -InputFile "C:\Backups\chat.jsonl" [-Headless]
Options: -b = Backup, -v = Viewer, -Help = show this help.
A backup is verified before any optional reversible Archive.
Without -Title/-OutputDirectory, -b opens the Backup GUI.
Without -InputFile, -v opens the offline, read-only Viewer.
ChatGPT authentication is reused locally (no new API key).
'@ | Write-Output
}

if ($Help -or (-not $Backup -and -not $Viewer)) {
  Show-SparkLogHelp
  exit 0
}
if ($Backup -and $Viewer) {
  [Console]::Error.WriteLine('Select exactly one chatlog mode: -b OR -v.')
  exit 2
}
if ($Backup) {
  if ($InputFile -or $Headless) {
    [Console]::Error.WriteLine('Backup mode does not accept Viewer options.')
    exit 2
  }
  if ($Title -and $OutputDirectory) {
    if (-not(Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
      [Console]::Error.WriteLine('OutputDirectory must be an existing user-approved directory.')
      exit 2
    }
    & (Join-Path $backupRoot 'backup_chat_cli.ps1') -Title $Title -OutputDirectory $OutputDirectory -ArchiveAfterBackup:$ArchiveAfterBackup
    if (-not $?) { exit 1 }
    exit 0
  }
  if ($Title -or $OutputDirectory -or $ArchiveAfterBackup) {
    [Console]::Error.WriteLine('CLI backup requires both -Title and -OutputDirectory, or no options for GUI.')
    exit 2
  }
  # The user explicitly chose GUI. Hidden console does not imply headless UI.
  $gui = Join-Path $backupRoot 'backup_chat_gui.ps1'
  $powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $psArgs = '-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "' + $gui + '"'
  Start-Process -FilePath $powerShell -ArgumentList $psArgs -WindowStyle Hidden | Out-Null
  exit 0
}
if ($Title -or $OutputDirectory -or $ArchiveAfterBackup) {
  [Console]::Error.WriteLine('Viewer mode does not accept Backup options.')
  exit 2
}
if ($InputFile) {
  & (Join-Path $viewerRoot 'viewer_cli.ps1') -InputFile $InputFile -Headless:$Headless
  if (-not $?) { exit 1 }
  exit 0
}
if ($Headless) {
  [Console]::Error.WriteLine('-Headless requires -InputFile.')
  exit 2
}
Start-Process -FilePath (Join-Path $viewerRoot 'index.html') | Out-Null
exit 0
