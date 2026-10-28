param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [switch]$ArchiveAfterBackup
)
Import-Module (Join-Path $PSScriptRoot 'ChatBackup.Core.psm1') -Force
$r = Backup-ChatGPTConversation -Title $Title -OutputDirectory $OutputDirectory -ArchiveAfterBackup:$ArchiveAfterBackup
$r | Format-List
