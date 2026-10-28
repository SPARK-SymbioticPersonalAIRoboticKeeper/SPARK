param([string]$ConfigPath)
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if(-not $ConfigPath){
  $ConfigPath=Join-Path $root '.runtime\config\spark.local.json'
}
$env:SPARK_CONFIG=$ConfigPath

Write-Host '[S2-STATUS-01] Transport service'
$transportStatus=$null
$transportStatusExit=$null
Push-Location $root
try{
  $transportStatusOutput=@(& npm --prefix (Join-Path $root 'out') run --silent transport:status 2>&1)
  $transportStatusExit=$LASTEXITCODE
  if($transportStatusExit -eq 0 -and $transportStatusOutput){
    try{$transportStatus=($transportStatusOutput -join [Environment]::NewLine) | ConvertFrom-Json}catch{}
  }
}catch{}finally{Pop-Location}
if($transportStatus){
  Write-Host "$($transportStatus.status) (pid=$($transportStatus.pid), healthy=$($transportStatus.healthy), auth=$($transportStatus.authMode))"
}elseif($transportStatusExit -eq 0){
  Write-Host 'unknown'
}else{
  Write-Host 'not-running'
}

Write-Host '[S2-STATUS-02] Tunnel readiness / identity'
$config=$null
if(Test-Path -LiteralPath $ConfigPath -PathType Leaf){
  try{$config=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json}catch{}
}
$ready=$false
try{
  $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8080/readyz'
  $readyBody=$r.Content.Trim()
  $ready=($readyBody -eq 'ready' -or $readyBody.StartsWith('ready (mcp initialize requires auth:'))
}catch{}
if(-not $ready){
  Write-Host 'not-ready'
}elseif(-not $config -or -not $config.tunnel -or $config.tunnel.enabled -eq $false){
  Write-Host 'ready (identity=unverified: tunnel config unavailable/disabled)'
}else{
  $runtime=Join-Path $root 'log\system'
  $profileDir=Join-Path $root '.runtime\config\tunnel-profiles'
  $profilePath=Join-Path $profileDir ([string]$config.tunnel.profile + '.yaml')
  # Existing live processes may still reference the old launch path in their
  # disposable runtime identity record. Its SHA must match the private profile.
  $legacyProfilePath=Join-Path (Join-Path $runtime 'tunnel-profiles') ([string]$config.tunnel.profile + '.yaml')
  $runtimeStatePath=Join-Path $runtime 'tunnel-runtime.json'
  $pidPath=Join-Path $runtime 'tunnel-client.pid'
  $profileTunnelId=$null
  $profileHash=$null
  if(Test-Path -LiteralPath $profilePath -PathType Leaf){
    $match=[regex]::Match((Get-Content -LiteralPath $profilePath -Raw),'(?m)^\s*tunnel_id:\s*"?([^"\r\n#]+)"?\s*$')
    if($match.Success){$profileTunnelId=$match.Groups[1].Value.Trim()}
    $profileHash=(Get-FileHash -LiteralPath $profilePath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $runtimeState=$null
  if(Test-Path -LiteralPath $runtimeStatePath -PathType Leaf){try{$runtimeState=Get-Content -LiteralPath $runtimeStatePath -Raw | ConvertFrom-Json}catch{}}
  $tunnelPid=$null
  $processOk=$false
  if(Test-Path -LiteralPath $pidPath -PathType Leaf){
    try{$tunnelPid=[int](Get-Content -LiteralPath $pidPath | Select-Object -First 1);$p=Get-Process -Id $tunnelPid -ErrorAction Stop;$processOk=($p.ProcessName -eq 'tunnel-client')}catch{}
  }
  $identityOk=($processOk -and $runtimeState -and $profileTunnelId -and $profileHash -and [int]$runtimeState.pid -eq $tunnelPid -and [string]$runtimeState.tunnelId -eq [string]$config.tunnel.id -and ([string]$runtimeState.profilePath -ieq [string]$profilePath -or [string]$runtimeState.profilePath -ieq [string]$legacyProfilePath) -and [string]$runtimeState.profileSha256 -eq [string]$profileHash -and [string]$profileTunnelId -eq [string]$config.tunnel.id)
  if($identityOk){
    $controlPlane='unverified'
    $clientDir=[string]$config.tunnel.clientDir
    if(-not [System.IO.Path]::IsPathRooted($clientDir)){$clientDir=Join-Path $root $clientDir}
    # Only the read-only health probe may use the existing canonical executable
    # when an unchanged private configuration still points at the old module.
    $client=Join-Path $clientDir 'tunnel-client.exe'
    if(-not (Test-Path -LiteralPath $client -PathType Leaf)){
      $bundledClient=Join-Path $root 'mod\spark_transport\tool\tunnel_client\tunnel-client.exe'
      if(Test-Path -LiteralPath $bundledClient -PathType Leaf){$client=$bundledClient}
    }
    if(Test-Path -LiteralPath $client -PathType Leaf){
      try{$healthOutput=& $client health --port 8080 --require-control-plane-poll --json 2>$null;if($LASTEXITCODE -eq 0){$healthJson=($healthOutput -join [Environment]::NewLine)|ConvertFrom-Json;if($healthJson.result -eq 'ok' -and $healthJson.control_plane_poll.ok -eq $true){$controlPlane='ok'}}}catch{}
    }
    Write-Host "ready (identity=verified, tunnelId=$($config.tunnel.id), control-plane=$controlPlane)"
  }else{
    $runtimeTunnelId=if($runtimeState){[string]$runtimeState.tunnelId}else{'<missing>'}
    if(-not $profileTunnelId){$profileTunnelId='<missing>'}
    Write-Host "ready (IDENTITY-MISMATCH: config=$($config.tunnel.id), profile=$profileTunnelId, runtime=$runtimeTunnelId, processOwned=$processOk)"
  }
}

Write-Host '[S2-STATUS-03] ChatGPT Windows app'
$chatProcesses=Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue
if($chatProcesses){
  $ids=($chatProcesses | Select-Object -ExpandProperty Id) -join ','
  Write-Host "running (PID(s): $ids)"
}else{
  Write-Host 'not-running'
}

Write-Host '[S2-STATUS-04] ChatGPT UI runtime'
$activePath=Join-Path $root 'log\system\active.json'
if(-not (Test-Path -LiteralPath $activePath -PathType Leaf)){
  Write-Host 'not-active'
}else{
  try{
    $active=Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json
    $watcher=Get-CimInstance Win32_Process -Filter "ProcessId=$($active.watcherPid)" -ErrorAction SilentlyContinue
    $watcherOk=($watcher -and $watcher.CommandLine -and ($watcher.CommandLine -match 'mod[\\/](?:spark_ui|chatgpt_ui)[\\/]src[\\/]watch\.mjs'))
    $cdpOk=$false
    try{$targets=Invoke-RestMethod -Uri "http://127.0.0.1:$($active.port)/json/list" -TimeoutSec 1;$cdpOk=@($targets).Count -gt 0}catch{}
    if($watcherOk -and $cdpOk){Write-Host "active (theme=$($active.themeSelection), CDP=127.0.0.1:$($active.port), watcherPid=$($active.watcherPid))"}
    else{Write-Host "degraded (theme=$($active.themeSelection), watcher=$watcherOk, cdp=$cdpOk)"}
  }catch{Write-Host "invalid-state: $($_.Exception.Message)"}
}

Write-Host '[S2-STATUS-05] CII instruction injection'
$ciiStatus=Join-Path $root 'mod\spark_cii\script\spark-cii.ps1'
if(-not(Test-Path -LiteralPath $ciiStatus -PathType Leaf)){
  Write-Host 'missing (CII launcher unavailable; do not assume a prefix is applied)'
}else{
  try{
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ciiStatus -Action status
    if($LASTEXITCODE -ne 0){
      Write-Host 'degraded (read the CII audit; do not assume messages are protected)'
    }
  }catch{
    Write-Host 'unverified (CII readiness probe failed)'
  }
}
