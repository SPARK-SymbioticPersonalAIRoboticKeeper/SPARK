param([string]$ConfigPath)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$boundedProcess=Join-Path $root 'mod\spark_transport\src\bounded-process-cli.mjs'
if(-not $ConfigPath){
  $ConfigPath=Join-Path $root '.runtime\config\spark.local.json'
}
$env:SPARK_CONFIG=$ConfigPath
$runtime=Join-Path $root 'log\system'
$pidFile=Join-Path $runtime 'tunnel-client.pid'

$stopFailures=[System.Collections.Generic.List[string]]::new()
$ciiScript=Join-Path $root 'mod\spark_cii\script\spark-cii.ps1'
$ciiCli=Join-Path $root 'mod\spark_cii\src\cli.mjs'
function Get-SPARKCiiWatchers {
  $pattern='(?i)(?:^|\s)"?'+[regex]::Escape($ciiCli)+'"?\s+run(?:\s|$)'
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern })
}
Write-Host '[S2-STOP-00] Stopping CII before ChatGPT CDP closes...'
try {
  & node $boundedProcess 15000 powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ciiScript -Action stop
  if ($LASTEXITCODE -ne 0) { Write-Host '[S2-STOP-00] WARN - CII launcher failed; checking owned watcher processes' }
  $remaining=@(Get-SPARKCiiWatchers)
  foreach ($old in $remaining) {
    $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($old.ProcessId)" -ErrorAction Stop
    if ($current -and $current.CreationDate -eq $old.CreationDate -and $current.CommandLine -ceq $old.CommandLine) {
      Stop-Process -Id $old.ProcessId -Force -ErrorAction Stop
    }
  }
  $deadline=(Get-Date).AddSeconds(5)
  while (@(Get-SPARKCiiWatchers).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  if (@(Get-SPARKCiiWatchers).Count -gt 0) { throw 'CII watcher still running.' }
  Write-Host '[S2-STOP-00] PASS - CII watcher stopped'
} catch {
  [void]$stopFailures.Add('CII: '+$_.Exception.Message)
  Write-Host ('[S2-STOP-00] FAIL - '+$_.Exception.Message)
}

function Get-SPARKManagedTunnel {
  $known=@(
    (Join-Path $root 'mod\spark_transport\tool\tunnel_client\tunnel-client.exe'),
    (Join-Path $root 'mod\transport\tool\tunnel_client\tunnel-client.exe')
  )
  if(Test-Path -LiteralPath $ConfigPath -PathType Leaf){
    try {
      $cfg=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
      $dir=[string]$cfg.tunnel.clientDir
      if($dir){
        if(-not [IO.Path]::IsPathRooted($dir)){$dir=Join-Path $root $dir}
        $known+=Join-Path $dir 'tunnel-client.exe'
      }
    } catch {throw 'Tunnel client directory configuration is invalid.'}
  }
  $allowed=@($known|ForEach-Object{[IO.Path]::GetFullPath($_)})
  @(
    Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -ErrorAction Stop |
      Where-Object {
        $t=$_
        $t.ExecutablePath -and $t.CommandLine -and
        @($allowed|Where-Object{$_ -ieq $t.ExecutablePath}).Count -gt 0 -and
        $t.CommandLine -match '(?i)(?:^|\s)run\s+--profile(?:\s|=)'
      }
  )
}

try {
Write-Host '[S2-STOP-01] Stopping tunnel-client...'
if(Test-Path $pidFile){
  $tunnelPid=[int](Get-Content $pidFile | Select-Object -First 1)
  $owned=@(Get-SPARKManagedTunnel)
  $claimed=Get-CimInstance Win32_Process -Filter "ProcessId=$tunnelPid" -ErrorAction Stop
  if($claimed -and @($owned|Where-Object{$_.ProcessId -eq $tunnelPid}).Count -eq 0){
    throw ('Tunnel PID '+$tunnelPid+' belongs to an unverified process; refusing to terminate it.')
  }
  Stop-Process -Id $tunnelPid -ErrorAction SilentlyContinue
  $deadline=(Get-Date).AddSeconds(5)
  while((Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue) -and (Get-Date)-lt$deadline){Start-Sleep -Milliseconds 100}
  if(Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue){
    & node $boundedProcess 5000 taskkill.exe /PID $tunnelPid /T /F *> $null
    $forceDeadline=(Get-Date).AddSeconds(3)
    while((Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue) -and (Get-Date)-lt$forceDeadline){Start-Sleep -Milliseconds 100}
  }
  if(Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue){throw "tunnel-client PID=$tunnelPid did not stop within bounded cleanup"}
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "[S2-STOP-01] PASS - tunnel-client stopped, PID=$tunnelPid"
}else{
  Write-Host '[S2-STOP-01] PASS - no tunnel PID file present'
}

foreach($candidate in @(Get-SPARKManagedTunnel)){
  $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)" -ErrorAction Stop
  if($current -and $current.CreationDate -eq $candidate.CreationDate -and
     $current.CommandLine -ceq $candidate.CommandLine -and
     $current.ExecutablePath -ieq $candidate.ExecutablePath){
    Stop-Process -Id $candidate.ProcessId -Force -ErrorAction Stop
  }
}
$tunnelDeadline=(Get-Date).AddSeconds(8)
while(@(Get-SPARKManagedTunnel).Count -gt 0 -and (Get-Date) -lt $tunnelDeadline){
  Start-Sleep -Milliseconds 200
}
if(@(Get-SPARKManagedTunnel).Count -gt 0){throw 'Managed Tunnel process still running.'}
Write-Host '[S2-STOP-01] PASS - no SPARK-managed Tunnel process remains'
} catch { [void]$stopFailures.Add('Tunnel: '+$_.Exception.Message); Write-Host ('[S2-STOP-01] FAIL - '+$_.Exception.Message) }
try {
Write-Host '[S2-STOP-02] Stopping Transport service...'
Push-Location $root
try{
  & node $boundedProcess 15000 cmd.exe /d /c npm --prefix (Join-Path $root 'out') run transport:stop
  if($LASTEXITCODE -ne 0){throw "Transport stop failed or exceeded 15 second watchdog (exitCode=$LASTEXITCODE)"}
}finally{Pop-Location}
Write-Host '[S2-STOP-02] PASS - Transport service stopped or already stopped'

} catch { [void]$stopFailures.Add('Transport: '+$_.Exception.Message); Write-Host ('[S2-STOP-02] FAIL - '+$_.Exception.Message) }
try {
Write-Host '[S2-STOP-03] Stopping ChatGPT UI watcher...'
$uiActivePath=Join-Path $root 'log\system\active.json'
if(Test-Path -LiteralPath $uiActivePath -PathType Leaf){
  try{
    $uiActive=Get-Content -LiteralPath $uiActivePath -Raw | ConvertFrom-Json
    if($uiActive.watcherPid){
      $watcher=Get-CimInstance Win32_Process -Filter "ProcessId=$($uiActive.watcherPid)" -ErrorAction SilentlyContinue
      if($watcher -and $watcher.CommandLine -and ($watcher.CommandLine -match 'mod[\\/](?:spark_ui|chatgpt_ui)[\\/]src[\\/]watch\.mjs')){
        Stop-Process -Id $watcher.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
  }catch{}
  Remove-Item -LiteralPath $uiActivePath -Force -ErrorAction SilentlyContinue
}
$watcherCli=Join-Path $root 'mod\spark_ui\src\watch.mjs'
$watcherPattern='(?i)(?:^|\s)"?'+[regex]::Escape($watcherCli)+'"?(?:\s|$)'
function Get-SPARKUiWatchers {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine -match $watcherPattern })
}
foreach($old in @(Get-SPARKUiWatchers)){
  $fresh=Get-CimInstance Win32_Process -Filter "ProcessId=$($old.ProcessId)" -ErrorAction Stop
  if($fresh -and $fresh.CreationDate -eq $old.CreationDate -and $fresh.CommandLine -ceq $old.CommandLine){
    Stop-Process -Id $old.ProcessId -Force -ErrorAction Stop
  }
}
$watcherDeadline=(Get-Date).AddSeconds(5)
while(@(Get-SPARKUiWatchers).Count -gt 0 -and (Get-Date) -lt $watcherDeadline){Start-Sleep -Milliseconds 200}
if(@(Get-SPARKUiWatchers).Count -gt 0){throw 'Managed UI watcher remains running.'}
Write-Host '[S2-STOP-03] PASS - all managed ChatGPT UI watchers stopped'

} catch { [void]$stopFailures.Add('UI watcher: '+$_.Exception.Message); Write-Host ('[S2-STOP-03] FAIL - '+$_.Exception.Message) }
try {
Write-Host '[S2-STOP-04] Stopping ChatGPT Windows app...'
$deadline=(Get-Date).AddSeconds(12)
do {
  $chatProcesses=@(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue)
  if($chatProcesses.Count -eq 0){break}
  foreach($proc in $chatProcesses){
    try{Stop-Process -Id $proc.Id -Force -ErrorAction Stop}
    catch{if(Get-Process -Id $proc.Id -ErrorAction SilentlyContinue){throw}}
  }
  Start-Sleep -Milliseconds 250
} while((Get-Date) -lt $deadline)
$remainingChat=@(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue)
if($remainingChat.Count -gt 0){throw ('ChatGPT.exe processes still running: '+$remainingChat.Count)}
Write-Host '[S2-STOP-04] PASS - all ChatGPT.exe processes confirmed terminated'

} catch { [void]$stopFailures.Add('ChatGPT: '+$_.Exception.Message); Write-Host ('[S2-STOP-04] FAIL - '+$_.Exception.Message) }

# STOP_VERIFY: count actual remaining processes independently of stop return codes.
try {
  $ciiLeft=@(Get-SPARKCiiWatchers).Count
  $uiLeft=@(Get-SPARKUiWatchers).Count
  $gptLeft=@(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue).Count
  $tunnelLeft=@(Get-SPARKManagedTunnel).Count
} catch {
  [void]$stopFailures.Add('process verification failed: '+$_.Exception.Message)
  $ciiLeft=-1; $uiLeft=-1; $gptLeft=-1; $tunnelLeft=-1
}
$transportLive=$false; $tunnelReady=$false
try{ $transportLive=((Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2).status -eq 'ok') }catch{}
try{
  $reply=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/readyz' -TimeoutSec 2
  $tunnelReady=([string]$reply.Content).Trim() -match '^ready(?:$|\s|\()'
}catch{}
Write-Host ('[S2-STOP-VERIFY] CII='+$ciiLeft+' UI='+$uiLeft+' ChatGPT='+$gptLeft+' Tunnel='+$tunnelLeft+' TransportHealthy='+$transportLive+' TunnelReady='+$tunnelReady)
if($ciiLeft -ne 0 -or $uiLeft -ne 0 -or $gptLeft -ne 0 -or $tunnelLeft -ne 0 -or $transportLive -or $tunnelReady){
  [void]$stopFailures.Add('managed runtime processes or endpoints remain active')
}
if($stopFailures.Count -eq 0){Write-Host '[S2-STOP-VERIFY] PASS - all managed services stopped; Tray remains available'}
# STOP_AGGREGATE: do not report success if any component cleanup failed.
if($stopFailures.Count -gt 0){throw ('SPARK stop incomplete: '+($stopFailures -join '; '))}
