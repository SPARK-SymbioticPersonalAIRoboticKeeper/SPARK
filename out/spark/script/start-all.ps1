param([string]$ConfigPath,[switch]$SkipChatGPTUi)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$boundedProcess=Join-Path $root 'mod\spark_transport\src\bounded-process-cli.mjs'

function Fail-Step([string]$Id,[string]$Message){
  Write-Host "[$Id] FAIL - $Message" -ForegroundColor Red
  throw "[$Id] $Message"
}

function Test-TunnelReadyContent([string]$Content){
  return ([string]$Content).Trim() -match '^ready(?:$|\s|\()'
}

function Start-SparkTray(){
  $supervisorScript=Join-Path $PSScriptRoot 'spark-tray-supervisor.ps1'
  $trayScript=Join-Path $PSScriptRoot 'spark-tray.ps1'
  $trayPidPath=Join-Path $root 'log\system\spark-tray.pid'
  $supervisorPidPath=Join-Path $root 'log\system\spark-tray-supervisor.pid'
  $exitFlag=Join-Path $root 'log\system\spark-tray-exit.request'
  # An explicit Start cancels an earlier Exit Tray request.
  if(Test-Path -LiteralPath $exitFlag){Remove-Item -LiteralPath $exitFlag -Force -ErrorAction Stop}
  $owner=$null
  if(Test-Path -LiteralPath $supervisorPidPath -PathType Leaf){
    try{
      $n=[int](Get-Content -LiteralPath $supervisorPidPath -Raw)
      $p=Get-CimInstance Win32_Process -Filter "ProcessId=$n" -ErrorAction Stop
      if($p -and $p.Name -eq 'powershell.exe' -and $p.CommandLine -and
         $p.CommandLine.IndexOf($supervisorScript,[StringComparison]::OrdinalIgnoreCase) -ge 0){$owner=$p}
    }catch{}
  }
  if(-not $owner){
    $proc=Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @(
      '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$supervisorScript+'"')
    ) -WindowStyle Hidden -PassThru -ErrorAction Stop
    if($proc.HasExited){Fail-Step 'S2-TRAY' ('Tray supervisor exited immediately, exitCode='+$proc.ExitCode)}
  }
  $deadline=(Get-Date).AddSeconds(20)
  do{
    Start-Sleep -Milliseconds 300
    if(Test-Path -LiteralPath $trayPidPath -PathType Leaf){
      try{
        $trayPid=[int](Get-Content -LiteralPath $trayPidPath -Raw)
        $tray=Get-CimInstance Win32_Process -Filter "ProcessId=$trayPid" -ErrorAction Stop
        if($tray -and $tray.Name -eq 'powershell.exe' -and $tray.CommandLine -and
           $tray.CommandLine.IndexOf($trayScript,[StringComparison]::OrdinalIgnoreCase) -ge 0){
          Write-Host "[S2-TRAY] PASS - Tray supervisor/NotifyIcon process verified, PID=$trayPid"
          return
        }
      }catch{}
    }
  }while((Get-Date)-lt$deadline)
  Fail-Step 'S2-TRAY' 'Tray missing after 20 seconds. Review spark-tray-supervisor.log and spark-tray.log.'
}
function Start-NormalChatGPTApp(){
  $running=Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue
  if($running){Write-Host '[S2-10] PASS - ChatGPT already running';return}
  $app=Get-StartApps | Where-Object { $_.Name -eq 'ChatGPT' } | Select-Object -First 1
  if(-not $app){Fail-Step 'S2-10' 'ChatGPT Windows app is not registered in Start Apps'}
  Write-Host "[S2-10] Starting ChatGPT Windows app: $($app.AppID)"
  Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$($app.AppID)"
  $deadline=(Get-Date).AddSeconds(10)
  do{
    Start-Sleep -Milliseconds 250
    if(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue){Write-Host '[S2-10] PASS - ChatGPT running';return}
  }while((Get-Date)-lt$deadline)
  Fail-Step 'S2-10' 'ChatGPT launch was requested but no ChatGPT process appeared within 10 seconds'
}

function Test-ChatGPTUiRuntime(){
  $activePath=Join-Path $root 'log\system\active.json'
  if(-not (Test-Path -LiteralPath $activePath -PathType Leaf)){return $false}
  try{
    $active=Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json
    if(-not $active.port -or -not $active.watcherPid){return $false}
    $watcher=Get-CimInstance Win32_Process -Filter "ProcessId=$($active.watcherPid)" -ErrorAction SilentlyContinue
    if(-not $watcher -or -not $watcher.CommandLine -or -not ($watcher.CommandLine -match 'mod[\\/](?:spark_ui|chatgpt_ui)[\\/]src[\\/]watch\.mjs')){return $false}
    $targets=Invoke-RestMethod -Uri "http://127.0.0.1:$($active.port)/json/list" -TimeoutSec 1
    return (@($targets).Count -gt 0 -and [bool](Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue))
  }catch{return $false}
}

function Start-ChatGPTExperience(){
  if($SkipChatGPTUi){Write-Host '[S2-10] SKIP - Backend-only maintenance; preserve the active ChatGPT window and keyboard focus';return}
  $uiEnabled=$true
  if($config.PSObject.Properties.Name -contains 'chatgptUi' -and $config.chatgptUi -and $config.chatgptUi.enabled -eq $false){$uiEnabled=$false}
  if(-not $uiEnabled){Start-NormalChatGPTApp;return}

  if(Test-ChatGPTUiRuntime){Write-Host '[S2-10] PASS - ChatGPT UI runtime already active';return}

  $theme='dark-red'
  if($config.PSObject.Properties.Name -contains 'chatgptUi' -and $config.chatgptUi.theme){$theme=[string]$config.chatgptUi.theme}
  $progressEnabled=$true
  if($config.PSObject.Properties.Name -contains 'chatgptUi' -and $config.chatgptUi -and $config.chatgptUi.PSObject.Properties.Name -contains 'progress' -and $config.chatgptUi.progress -and $config.chatgptUi.progress.enabled -eq $false){$progressEnabled=$false}
  $transportHost=if($config.transport.host){[string]$config.transport.host}else{'127.0.0.1'}
  $transportUrlHost=if($transportHost -eq '::1'){'[::1]'}else{$transportHost}
  $transportPort=if($config.transport.port){[int]$config.transport.port}else{8765}
  $healthPath=if($config.transport.healthPath){[string]$config.transport.healthPath}else{'/health'}
  $transportHealthUrl="http://${transportUrlHost}:$transportPort$healthPath"
  $launcher=Join-Path $root 'mod\spark_ui\script\start-chatgpt-ui.ps1'
  if(-not (Test-Path -LiteralPath $launcher -PathType Leaf)){Fail-Step 'S2-10' "ChatGPT UI launcher not found: $launcher"}
  Write-Host "[S2-10] Starting ChatGPT with integrated ChatGPT UI: $theme, progress=$progressEnabled"
  $uiArgs=@('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',$launcher,'-Theme',$theme,'-TransportHealthUrl',$transportHealthUrl)
  if(-not $progressEnabled){$uiArgs+='-DisableProgress'}
  & node $boundedProcess 60000 powershell.exe @uiArgs
  if($LASTEXITCODE -ne 0){Fail-Step 'S2-10' "integrated ChatGPT UI launcher failed or exceeded 60 second watchdog (exitCode=$LASTEXITCODE)"}
  if(-not (Test-ChatGPTUiRuntime)){Fail-Step 'S2-10' 'ChatGPT UI launcher returned success but runtime validation failed'}
  Write-Host '[S2-10] PASS - ChatGPT + ChatGPT UI runtime active'
}

function Start-CiiExperience(){
  if($SkipChatGPTUi){
    Write-Host '[S2-10A] SKIP - backend-only start; no new ChatGPT UI/CDP target'
    return
  }
  if($config.PSObject.Properties.Name -contains 'chatgptUi' -and $config.chatgptUi -and
     $config.chatgptUi.enabled -eq $false){
    Write-Host '[S2-10A] SKIP - normal ChatGPT app has no managed CDP target; CII unavailable'
    return
  }
  $ciiScript=Join-Path $root 'mod\spark_cii\script\spark-cii.ps1'
  if(-not(Test-Path -LiteralPath $ciiScript -PathType Leaf)){
    Fail-Step 'S2-10A' 'CII startup script missing'
  }
  & node $boundedProcess 15000 powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ciiScript -Action start
  if($LASTEXITCODE -ne 0){
    Fail-Step 'S2-10A' 'CII injection not verified; SPARK startup cannot claim full ChatGPT protection'
  }
  Write-Host '[S2-10A] PASS - CII request-boundary armed on eligible CDP page(s); actual outgoing Prefix/server receipt remains unverified until observed'
}

function Show-TunnelHealthDiagnostics(){
  Write-Host '[S2-09] ---- tunnel health diagnostics ----'
  $uris=@(
    'http://127.0.0.1:8080/healthz',
    'http://127.0.0.1:8080/readyz'
  )
  foreach($uri in $uris){
    try{
      $response=Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $uri
      Write-Host "[S2-09] $uri -> HTTP $($response.StatusCode) $($response.Content.Trim())"
    }catch{
      $status='request-failed'
      try{if($_.Exception.Response){$status='HTTP '+[int]$_.Exception.Response.StatusCode}}catch{}
      Write-Host "[S2-09] $uri -> $status : $($_.Exception.Message)"
    }
  }

  $healthPidFile=Join-Path (Join-Path $root 'log\system') 'tunnel-client.pid'
  if($client -and (Test-Path -LiteralPath $client -PathType Leaf)){
    Write-Host '[S2-09] tunnel-client control-plane health:'
    try{
      & node $boundedProcess 10000 $client health --port 8080 --pid-file $healthPidFile --require-control-plane-poll --json
      if($LASTEXITCODE -ne 0){Write-Host "[S2-09] tunnel-client health failed or exceeded 10 second watchdog, exitCode=$LASTEXITCODE"}
    }catch{
      Write-Host "[S2-09] tunnel-client health failed: $($_.Exception.Message)"
    }
  }
  Write-Host '[S2-09] ---- end tunnel health diagnostics ----'
}

if(-not $ConfigPath){
  $ConfigPath=Join-Path $root '.runtime\config\spark.local.json'
}
if(-not (Test-Path $ConfigPath)){
  Write-Host '[S2-01] FAIL - local config not found.' -ForegroundColor Red
  Write-Host '         Copy mod\spark_transport\config\spark.example.json to .runtime\config\spark.local.json and edit allowedRoot/tunnel.id.'
  exit 2
}
$ConfigPath=(Resolve-Path $ConfigPath).Path
$env:SPARK_CONFIG=$ConfigPath
. (Join-Path $PSScriptRoot 'spark-log-path.ps1')
. (Join-Path $PSScriptRoot 'spark-data-path.ps1')
$env:SPARK_DATA_DIR=Initialize-SparkUserData -SourceRoot $root
$logDir=Get-SparkLogDirectory -Root $root -InitializeApprovedDisposableState
$env:SPARK_LOG_DIR=$logDir
# Tray control remains available even when backend/Tunnel/UI startup fails.
Start-SparkTray
try{$config=Get-Content -Raw $ConfigPath | ConvertFrom-Json}catch{Fail-Step 'S2-01' "invalid JSON in local config: $($_.Exception.Message)"}
Write-Host "[S2-01] PASS - Config loaded: $ConfigPath"

Write-Host '[S2-02] Checking Node.js...'
& node --version
if($LASTEXITCODE -ne 0){Fail-Step 'S2-02' 'Node.js 20+ is required'}
Write-Host '[S2-02] PASS - Node.js available'

$transportLog=Join-Path $logDir 'spark.log'

$accessTokenPath=Join-Path $root '.runtime\secrets\Access_token'
if(-not (Test-Path -LiteralPath $accessTokenPath -PathType Leaf)){
  Fail-Step 'S2-02A' "Access_token is required: $accessTokenPath"
}
Write-Host '[S2-02A] PASS - Access_token found; local Bearer validation is mandatory.'

Write-Host '[S2-03] Starting Transport service...'
Push-Location $root
try {
  $transportStartOutput=@(& node $boundedProcess 15000 cmd.exe /d /c npm --prefix (Join-Path $root 'out') run --silent transport:start 2>&1)
  $transportStartExit=$LASTEXITCODE
  if($transportStartExit -ne 0){
    Write-Host '[S2-03] FAIL - Transport start returned a non-zero exit code.' -ForegroundColor Red
    if($transportStartOutput){$transportStartOutput | ForEach-Object { Write-Host "[S2-03] $_" }}
    Write-Host "[S2-03] Transport log: $transportLog"
    if(Test-Path $transportLog){
      Write-Host '[S2-03] ---- Transport log tail ----'
      Get-Content -Path $transportLog -Tail 40
      Write-Host '[S2-03] ---- end Transport log ----'
    }
    throw '[S2-03] Transport start failed'
  }
} finally { Pop-Location }
Write-Host '[S2-03] PASS - Transport service started'

$health="http://$($config.transport.host):$($config.transport.port)$($config.transport.healthPath)"
Write-Host "[S2-04] Health check: $health"
try{$r=Invoke-RestMethod -TimeoutSec 3 $health}catch{Fail-Step 'S2-04' "Transport health request failed: $($_.Exception.Message)"}
if($r.status -ne 'ok'){Fail-Step 'S2-04' 'Transport health response was not ok'}
Write-Host "[S2-04] PASS - Transport healthy, version=$($r.version)"

if($config.tunnel.enabled -eq $false){Write-Host '[S2-05] PASS - Tunnel disabled by config.';Start-ChatGPTExperience;Start-CiiExperience;Start-SparkTray;Write-Host '[S2-11] PASS - Startup complete.';exit 0}
if(-not $config.tunnel.id -or $config.tunnel.id -like 'tunnel_x*'){Fail-Step 'S2-05' 'Set tunnel.id in local config'}

$keyPath=Join-Path $root '.runtime\secrets\API_secret_key'
if(-not (Test-Path $keyPath)){Fail-Step 'S2-05' "API_secret_key file not found: $keyPath"}
$keyPath=(Resolve-Path $keyPath).Path
$keyValue=(Get-Content -Raw $keyPath).Trim()
if(-not $keyValue){Fail-Step 'S2-05' "API_secret_key file is empty: $keyPath"}
$keyRef="file:$keyPath"
Write-Host "[S2-05] PASS - API_secret_key loaded from .runtime\secrets (value hidden)"

$clientDir=$config.tunnel.clientDir
if(-not [System.IO.Path]::IsPathRooted($clientDir)){$clientDir=Join-Path $root $clientDir}
# Preserve the old private clientDir setting without changing .runtime files.
$canonicalClientDir=Join-Path $root 'mod\spark_transport\tool\tunnel_client'
if(([string]$clientDir -match '(?i)(?:^|[\\/])transport[\\/]tool[\\/]tunnel_client[\\/]?$') -and
   -not (Test-Path -LiteralPath (Join-Path $clientDir 'tunnel-client.exe') -PathType Leaf) -and
   (Test-Path -LiteralPath (Join-Path $canonicalClientDir 'tunnel-client.exe') -PathType Leaf)){
  $clientDir=$canonicalClientDir
}
Write-Host "[S2-06] Checking tunnel-client: $clientDir"
& node $boundedProcess 180000 powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'mod\spark_transport\script\bootstrap-tunnel.ps1') -Version $config.tunnel.clientVersion -ClientDir $clientDir
if($LASTEXITCODE -ne 0){Fail-Step 'S2-06' "tunnel-client bootstrap failed or exceeded 180 second watchdog (exitCode=$LASTEXITCODE)"}
$client=Join-Path $clientDir 'tunnel-client.exe'
if(-not (Test-Path $client)){Fail-Step 'S2-06' "tunnel-client.exe not found after bootstrap: $client"}
Write-Host "[S2-06] PASS - tunnel-client ready: $client"

$profile=$config.tunnel.profile
$runtime=Join-Path $root 'log\system';New-Item -ItemType Directory -Force $runtime|Out-Null
$profileConfigRoot=Join-Path $root '.runtime\config'
if(-not (Test-Path -LiteralPath $profileConfigRoot -PathType Container)){Fail-Step 'S2-07' 'Private config directory missing under .runtime'}
$profileDir=Join-Path $profileConfigRoot 'tunnel-profiles';New-Item -ItemType Directory -Force $profileDir|Out-Null
$profilePath=Join-Path $profileDir ($profile + '.yaml')
# A running tunnel started before the migration can still report its old launch path.
# Only accept the exact former path when its saved SHA matches the private profile.
$legacyProfilePath=Join-Path (Join-Path $runtime 'tunnel-profiles') ($profile + '.yaml')
$runtimeStatePath=Join-Path $runtime 'tunnel-runtime.json'
$existingTunnelPidFile=Join-Path $runtime 'tunnel-client.pid'

function Get-TunnelProfileId([string]$Path){
  if(-not (Test-Path -LiteralPath $Path -PathType Leaf)){return $null}
  $match=[regex]::Match((Get-Content -LiteralPath $Path -Raw),'(?m)^\s*tunnel_id:\s*"?([^"\r\n#]+)"?\s*$')
  if(-not $match.Success){return $null}
  return $match.Groups[1].Value.Trim()
}

function Get-TunnelProfileHash([string]$Path){
  if(-not (Test-Path -LiteralPath $Path -PathType Leaf)){return $null}
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Stop-OwnedTunnel([int]$TunnelPid,[string]$Reason){
  Write-Host "[S2-07] $Reason; stopping SPARK-owned tunnel-client PID=$TunnelPid"
  try{Stop-Process -Id $TunnelPid -Force -ErrorAction Stop}catch{Fail-Step 'S2-07' "failed to stop SPARK-owned tunnel-client PID=$TunnelPid : $($_.Exception.Message)"}
  $deadline=(Get-Date).AddSeconds(10)
  while((Get-Process -Id $TunnelPid -ErrorAction SilentlyContinue) -and (Get-Date)-lt$deadline){Start-Sleep -Milliseconds 200}
  if(Get-Process -Id $TunnelPid -ErrorAction SilentlyContinue){Fail-Step 'S2-07' "SPARK-owned tunnel-client PID=$TunnelPid did not stop within 10 seconds"}
  Remove-Item -LiteralPath $existingTunnelPidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $runtimeStatePath -Force -ErrorAction SilentlyContinue
}

function Test-TunnelControlPlanePoll(){
  try{
    $healthOutput=& node $boundedProcess 10000 $client health --port 8080 --require-control-plane-poll --json 2>$null
    if($LASTEXITCODE -ne 0){return $false}
    $healthJson=($healthOutput -join [Environment]::NewLine) | ConvertFrom-Json
    return ($healthJson.result -eq 'ok' -and $healthJson.control_plane_poll.ok -eq $true)
  }catch{return $false}
}

$existingTunnelOwned=$false
$existingTunnelPid=$null
$existingTunnelProcess=$null
if(Test-Path -LiteralPath $existingTunnelPidFile -PathType Leaf){
  try{
    $existingTunnelPid=[int](Get-Content -LiteralPath $existingTunnelPidFile | Select-Object -First 1)
    $existingTunnelProcess=Get-Process -Id $existingTunnelPid -ErrorAction Stop
    if($existingTunnelProcess.ProcessName -eq 'tunnel-client'){$existingTunnelOwned=$true}
  }catch{}
}

$listenerReady=$false
try{
  $ready=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:8080/readyz'
  $listenerReady=(Test-TunnelReadyContent $ready.Content)
}catch{}
if($listenerReady -and -not $existingTunnelOwned){Fail-Step 'S2-07' 'Port 8080 reports ready but is not owned by the SPARK tunnel PID file; refusing to reuse an unknown listener'}

$profileTunnelId=Get-TunnelProfileId $profilePath
$profileHash=Get-TunnelProfileHash $profilePath
# Validate existing private config before stopping a running tunnel.
# Tracked-source history is Git-only; never duplicate or force-overwrite private profiles.
if(Test-Path -LiteralPath $profilePath -PathType Leaf){
  $profileText=Get-Content -LiteralPath $profilePath -Raw
  $profileUsesApiSecretKey=($profileText -match 'API_secret_key')
  if(-not $profileTunnelId -or $profileTunnelId -ne [string]$config.tunnel.id -or -not $profileUsesApiSecretKey){
    Fail-Step 'S2-07' 'Private Tunnel profile mismatches configured ID/key reference; refusing to overwrite or create backup. Correct the original profile explicitly; never commit secrets to Git.'
  }
}
$runtimeState=$null
if(Test-Path -LiteralPath $runtimeStatePath -PathType Leaf){
  try{$runtimeState=Get-Content -LiteralPath $runtimeStatePath -Raw | ConvertFrom-Json}catch{}
}
$runtimeIdentityOk=$false
if($listenerReady -and $existingTunnelOwned -and $runtimeState -and $profileTunnelId -and $profileHash){
  $runtimeIdentityOk=(
    [int]$runtimeState.pid -eq $existingTunnelPid -and
    [string]$runtimeState.tunnelId -eq [string]$config.tunnel.id -and
    ([string]$runtimeState.profilePath -ieq [string]$profilePath -or [string]$runtimeState.profilePath -ieq [string]$legacyProfilePath) -and
    [string]$runtimeState.profileSha256 -eq [string]$profileHash -and
    [string]$profileTunnelId -eq [string]$config.tunnel.id
  )
}

if($runtimeIdentityOk -and (Test-TunnelControlPlanePoll)){
  Write-Host "[S2-07] PASS - Existing SPARK tunnel identity verified for $($config.tunnel.id), PID=$existingTunnelPid"
  Start-ChatGPTExperience
  Start-CiiExperience
  Start-SparkTray;Write-Host '[S2-11] PASS - Startup complete.'
  exit 0
}

if($existingTunnelOwned){
  $reason='existing tunnel identity could not be verified against current config/profile'
  if($profileTunnelId -and $profileTunnelId -ne [string]$config.tunnel.id){$reason="tunnel ID mismatch: config=$($config.tunnel.id), profile=$profileTunnelId"}
  Stop-OwnedTunnel $existingTunnelPid $reason
  $listenerReady=$false
}

Write-Host "[S2-07] Checking tunnel profile: $profile"
Write-Host "[S2-07] SPARK profile directory: $profileDir"
$profileTunnelId=Get-TunnelProfileId $profilePath
if(Test-Path -LiteralPath $profilePath -PathType Leaf){
  if((Get-TunnelProfileHash $profilePath) -ne $profileHash){
    Fail-Step 'S2-07' 'Tunnel profile changed since validation; refusing to overwrite or create backup.'
  }
  & node $boundedProcess 30000 $client doctor --profile $profile --profile-dir $profileDir --explain *> (Join-Path $logDir 'tunnel-doctor.log')
  if($LASTEXITCODE -ne 0){
    Fail-Step 'S2-07' 'Existing Tunnel profile doctor failed; preserving profile without force-reinit or backup.'
  }
}else{
  Write-Host '[S2-07] SPARK-owned profile not found; initializing Tunnel profile for Bearer-protected local MCP...'
  & node $boundedProcess 30000 $client init --sample sample_mcp_remote_no_auth --profile $profile --profile-dir $profileDir --tunnel-id $config.tunnel.id --mcp-server-url $config.tunnel.localMcpUrl --control-plane-api-key-ref $keyRef
  if($LASTEXITCODE -ne 0){Fail-Step 'S2-07' "tunnel profile init failed or exceeded 30 second watchdog (exitCode=$LASTEXITCODE)"}
}

$profileTunnelId=Get-TunnelProfileId $profilePath
if($profileTunnelId -ne [string]$config.tunnel.id){Fail-Step 'S2-07' "tunnel profile ID mismatch after initialization: config=$($config.tunnel.id), profile=$profileTunnelId"}
& node $boundedProcess 30000 $client doctor --profile $profile --profile-dir $profileDir --explain *> (Join-Path $logDir 'tunnel-doctor.log')
if($LASTEXITCODE -ne 0){Fail-Step 'S2-07' "tunnel doctor failed or exceeded 30 second watchdog (exitCode=$LASTEXITCODE)"}
Write-Host "[S2-07] PASS - tunnel profile ready for $profileTunnelId"

try{
  $ready=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:8080/readyz'
  if(Test-TunnelReadyContent $ready.Content){Fail-Step 'S2-08' 'Port 8080 is still ready after stale/unverified SPARK tunnel cleanup; refusing to start another tunnel-client'}
}catch{
  if($_.Exception.Message.StartsWith('[S2-08]')){throw}
}

Write-Host '[S2-08] Starting tunnel-client with hidden, handle-isolated ShellExecuteEx semantics...'
$psi=New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName=$client
$psi.Arguments="run --profile `"$profile`" --profile-dir `"$profileDir`""
$psi.WorkingDirectory=$root
# A long-lived tunnel must not inherit stdout/stderr handles owned by the
# bounded startup command. Use a hidden independent ShellExecuteEx launch.
$psi.UseShellExecute=$true
$psi.WindowStyle=[System.Diagnostics.ProcessWindowStyle]::Hidden
$proc=New-Object System.Diagnostics.Process
$proc.StartInfo=$psi
try{
  $started=$proc.Start()
  if(-not $started){Fail-Step 'S2-08' 'tunnel-client process did not start'}
}catch{
  Fail-Step 'S2-08' "tunnel-client launch failed: $($_.Exception.Message)"
}
Set-Content -Encoding ascii (Join-Path $runtime 'tunnel-client.pid') $proc.Id
$profileHash=Get-TunnelProfileHash $profilePath
$runtimeState=[ordered]@{
  pid=$proc.Id
  tunnelId=[string]$config.tunnel.id
  profile=[string]$profile
  profilePath=[string]$profilePath
  profileSha256=[string]$profileHash
  startedAt=(Get-Date).ToString('o')
}
$runtimeState | ConvertTo-Json | Set-Content -LiteralPath $runtimeStatePath -Encoding utf8
if(-not (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf)){Fail-Step 'S2-08' 'failed to persist tunnel runtime identity state'}
Write-Host "[S2-08] PASS - tunnel-client started, PID=$($proc.Id), tunnelId=$($config.tunnel.id)"

$readyTimeoutSeconds=60
Write-Host "[S2-09] Waiting for tunnel /readyz + successful Control Plane poll (up to $readyTimeoutSeconds seconds)..."
$deadline=(Get-Date).AddSeconds($readyTimeoutSeconds)
do{
  Start-Sleep -Milliseconds 500
  if($proc.HasExited){
    Show-TunnelHealthDiagnostics
    Fail-Step 'S2-09' "tunnel-client exited before readiness acceptance, exitCode=$($proc.ExitCode). Check the external logs directory: $logDir\tunnel-doctor.log and run tunnel-client.exe run --profile $profile --profile-dir $profileDir manually for console diagnostics."
  }
  try{
    $ready=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:8080/readyz'
    $readyBody=$ready.Content.Trim()
    $mcpReady=($readyBody -eq 'ready' -or $readyBody.StartsWith('ready (mcp initialize requires auth:'))
    if($mcpReady -and (Test-TunnelControlPlanePoll)){
      if($readyBody -ne 'ready'){Write-Host '[S2-09] INFO - tunnel ready; unauthenticated MCP readiness probe was correctly rejected by SPARK Bearer auth.'}
      Write-Host "[S2-09] PASS - tunnel ready + Control Plane poll OK (PID $($proc.Id), tunnelId=$($config.tunnel.id))"
      Start-ChatGPTExperience
      Start-CiiExperience
      Start-SparkTray;Write-Host '[S2-11] PASS - Startup complete.'
      exit 0
    }
  }catch{}
}while((Get-Date)-lt$deadline)

Show-TunnelHealthDiagnostics
if(-not $proc.HasExited){
  Write-Host "[S2-09] INFO - tunnel-client remains running as PID $($proc.Id) so readiness diagnostics are preserved. Run SPARK.cmd stop to clean it up."
}
Fail-Step 'S2-09' "tunnel-client did not become ready within $readyTimeoutSeconds seconds"
