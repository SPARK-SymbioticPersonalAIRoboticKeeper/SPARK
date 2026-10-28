[CmdletBinding()]
param(
  [ValidateSet('on','off','status')][string]$Action='status',
  [string]$TestStartupDirectory = ''
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$launcher=Join-Path $root 'out\SPARK.vbs'
$wscript=Join-Path $env:WINDIR 'System32\wscript.exe'
$startup=[Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
if($TestStartupDirectory){
  # Only isolated regression fixtures may override the actual Startup folder.
  $tmp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
  $candidate=[IO.Path]::GetFullPath($TestStartupDirectory).TrimEnd('\','/')
  if(-not $candidate.StartsWith(($tmp+'\'),[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Autostart fixture must be under the OS temporary directory.'
  }
  $startup=$candidate
}
if(-not (Test-Path -LiteralPath $startup -PathType Container)) { throw 'User Startup directory is unavailable.' }
if(([IO.File]::GetAttributes($startup) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Startup directory cannot be a junction or symlink.'}
if(-not (Test-Path -LiteralPath $launcher -PathType Leaf)){throw 'SPARK launcher missing.'}
if(-not (Test-Path -LiteralPath $wscript -PathType Leaf)){throw 'Windows Script Host executable unavailable.'}
$linkPath=Join-Path $startup 'SPARK.lnk'
$arguments='"'+$launcher+'"'
$shell=New-Object -ComObject WScript.Shell
function Get-ExistingLinkStatus {
  if(-not (Test-Path -LiteralPath $linkPath)){return 'OFF'}
  $item=Get-Item -LiteralPath $linkPath -Force
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){return 'CONFLICT'}
  $shortcut=$shell.CreateShortcut($linkPath)
  if([IO.Path]::GetFullPath([string]$shortcut.TargetPath) -ine [IO.Path]::GetFullPath($wscript) -or
     [string]$shortcut.Arguments -cne $arguments -or
     [IO.Path]::GetFullPath([string]$shortcut.WorkingDirectory) -ine $root){return 'CONFLICT'}
  return 'ON'
}
$before=Get-ExistingLinkStatus
switch($Action){
  'on' {
    if($before -eq 'CONFLICT'){throw 'SPARK Startup entry exists but is not managed by SPARK. Refusing to overwrite.'}
    if($before -eq 'OFF'){
      $link=$shell.CreateShortcut($linkPath)
      $link.TargetPath=$wscript
      $link.Arguments=$arguments
      $link.WorkingDirectory=$root
      $link.Description='Start SPARK tray and managed services after user login'
      $link.WindowStyle=7
      $link.Save()
      if((Get-ExistingLinkStatus) -ne 'ON'){throw 'SPARK autostart shortcut verification failed.'}
    }
  }
  'off' {
    if($before -eq 'CONFLICT'){throw 'Unrecognized Startup entry. Refusing to remove an unrelated shortcut.'}
    if($before -eq 'ON'){
      Remove-Item -LiteralPath $linkPath -Force -ErrorAction Stop
      if((Get-ExistingLinkStatus) -ne 'OFF'){throw 'SPARK autostart disable verification failed.'}
    }
  }
}
$after=Get-ExistingLinkStatus
Write-Output ('SPARK AUTOSTART '+$after+' (per-user login; no pre-login GUI)')
if($after -eq 'CONFLICT'){exit 3}
