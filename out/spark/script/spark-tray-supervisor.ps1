[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$trayPath=Join-Path $PSScriptRoot 'spark-tray.ps1'
$logPath=Join-Path $root 'log\system\spark-tray-supervisor.log'
$pidPath=Join-Path $root 'log\system\spark-tray-supervisor.pid'
$exitRequest=Join-Path $root 'log\system\spark-tray-exit.request'
$trayPidPath=Join-Path $root 'log\system\spark-tray.pid'
$powershell=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
. (Join-Path $PSScriptRoot 'spark-log-path.ps1')
$null=Get-SparkLogDirectory -Root $root -InitializeApprovedDisposableState
function Write-SupervisorLog([string]$Message){
  try{[IO.File]::AppendAllText($logPath,('['+[DateTime]::UtcNow.ToString('o')+'] '+$Message+[Environment]::NewLine))}catch{}
}
function Get-OwnedTray {
  if(-not(Test-Path -LiteralPath $trayPidPath -PathType Leaf)){return $null}
  try{
    $n=[int](Get-Content -LiteralPath $trayPidPath -Raw)
    $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+$n) -ErrorAction Stop
    if(-not $proc -or -not $proc.CommandLine -or $proc.Name -ne 'powershell.exe'){return $null}
    if($proc.CommandLine.IndexOf($trayPath,[StringComparison]::OrdinalIgnoreCase) -lt 0){return $null}
    if((Get-Process -Id $n -ErrorAction Stop).SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){return $null}
    return $proc
  }catch{return $null}
}
$created=$false
$mutex=[Threading.Mutex]::new($true,'Local\SPARK.TraySupervisor',[ref]$created)
if(-not $created){$mutex.Dispose();exit 0}
$failures=0
try{
  try{Set-Content -LiteralPath $pidPath -Value $PID -Encoding ASCII -ErrorAction Stop}catch{}
  Write-SupervisorLog ('supervisor started pid='+$PID)
  while($true){
    if(Test-Path -LiteralPath $exitRequest -PathType Leaf){
      Write-SupervisorLog 'exit requested by tray menu; supervisor stopped'
      break
    }
    $existing=Get-OwnedTray
    if($existing){
      $failures=0
      Start-Sleep -Seconds 6
      continue
    }
    $failures++
    if($failures -gt 1){
      $pause=[Math]::Min(60,[Math]::Pow(2,[Math]::Min($failures,5)))
      Write-SupervisorLog ('tray unavailable; retry after '+$pause+'s')
      Start-Sleep -Seconds $pause
      if(Test-Path -LiteralPath $exitRequest -PathType Leaf){break}
    }
    try{
      $p=Start-Process -FilePath $powershell -ArgumentList @(
        '-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',('"'+$trayPath+'"')
      ) -WindowStyle Hidden -PassThru -ErrorAction Stop
      Write-SupervisorLog ('launched tray pid='+$p.Id)
      $deadline=[DateTime]::UtcNow.AddSeconds(12)
      do{
        Start-Sleep -Milliseconds 350
        if($p.HasExited){throw ('Tray exited during initialization, code='+$p.ExitCode)}
        $registered=Get-OwnedTray
        if($registered -and $registered.ProcessId -eq $p.Id){break}
      }while([DateTime]::UtcNow -lt $deadline)
      if(-not $registered -or $registered.ProcessId -ne $p.Id){
        Write-SupervisorLog ('Tray registration not verified in 12s, pid='+$p.Id)
      }else{
        Write-SupervisorLog ('Tray adopted, pid='+$p.Id)
        $failures=0
      }
      $p.Dispose()
    }catch{
      Write-SupervisorLog ('tray start failed: '+$_.Exception.Message)
    }
  }
}finally{
  try{Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue}catch{}
  Write-SupervisorLog 'supervisor exited'
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
