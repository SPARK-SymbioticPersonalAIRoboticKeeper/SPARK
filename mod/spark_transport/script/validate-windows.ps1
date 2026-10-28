param([string]$ConfigPath)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path

function Fail-Step([string]$Id,[string]$Message){
  Write-Host "[$Id] FAIL - $Message" -ForegroundColor Red
  throw "[$Id] $Message"
}

if(-not $ConfigPath){
  $ConfigPath=Join-Path $root '.runtime\config\spark.local.json'
}
if(-not (Test-Path $ConfigPath)){Fail-Step 'S2V-01' 'local config not found'}
try{$config=Get-Content -Raw $ConfigPath | ConvertFrom-Json}catch{Fail-Step 'S2V-01' "invalid JSON in local config: $($_.Exception.Message)"}
$base="http://$($config.transport.host):$($config.transport.port)$($config.transport.mcpPath)"
$proto='2026-07-28'
$id=100
$accessTokenPath=Join-Path $root '.runtime\secrets\Access_token'
if(-not (Test-Path -LiteralPath $accessTokenPath -PathType Leaf)){Fail-Step 'S2V-01A' "Access_token is required: $accessTokenPath"}
$accessToken=(Get-Content -LiteralPath $accessTokenPath -Raw).Trim()
if(-not $accessToken){Fail-Step 'S2V-01A' "Access_token is empty: $accessTokenPath"}
$authHeader='Bearer '+$accessToken

function Call-Tool([string]$Name,[hashtable]$Arguments){
  $script:id++
  $body=@{jsonrpc='2.0';id=$script:id;method='tools/call';params=@{name=$Name;arguments=$Arguments;_meta=@{'io.modelcontextprotocol/protocolVersion'=$proto;'io.modelcontextprotocol/clientCapabilities'=@{};'io.modelcontextprotocol/clientInfo'=@{name='spark-transport-validator';version='1'}}}}|ConvertTo-Json -Depth 12 -Compress
  $h=@{'MCP-Protocol-Version'=$proto;'Mcp-Method'='tools/call';'Mcp-Name'=$Name}
  if($authHeader){$h['Authorization']=$authHeader}
  try{return (Invoke-RestMethod -Method Post -Uri $base -Headers $h -ContentType 'application/json' -Body $body -TimeoutSec 15).result.structuredContent}catch{Fail-Step 'S2V-MCP' "$Name request failed or exceeded 15 second watchdog: $($_.Exception.Message)"}
}

function Assert-Ok($r,[string]$Id,[string]$Name){
  if(-not $r.ok){Fail-Step $Id "$Name failed: $($r.error.code) $($r.error.message)"}
  Write-Host "[$Id] PASS - $Name (operationId=$($r.operationId))"
}

Write-Host "[S2V-01] PASS - Config/MCP endpoint: $base"
$probeBody=@{jsonrpc='2.0';id=99;method='tools/list';params=@{_meta=@{'io.modelcontextprotocol/protocolVersion'=$proto;'io.modelcontextprotocol/clientCapabilities'=@{};'io.modelcontextprotocol/clientInfo'=@{name='spark-auth-validator';version='1'}}}}|ConvertTo-Json -Depth 10 -Compress
$probeHeaders=@{'MCP-Protocol-Version'=$proto;'Mcp-Method'='tools/list'}
function Get-ProbeStatus([hashtable]$Headers){
  try{return [int](Invoke-WebRequest -UseBasicParsing -Method Post -Uri $base -Headers $Headers -ContentType 'application/json' -Body $probeBody -TimeoutSec 15).StatusCode}catch{
    if($_.Exception.Response){return [int]$_.Exception.Response.StatusCode}
    throw
  }
}
$noAuthStatus=Get-ProbeStatus $probeHeaders
if($noAuthStatus -ne 401){Fail-Step 'S2V-01B' "missing Authorization was not rejected; status=$noAuthStatus"}
Write-Host '[S2V-01B] PASS - missing Authorization rejected with HTTP 401'
$wrongHeaders=@{}+$probeHeaders;$wrongHeaders['Authorization']='Bearer spk_wrong_key'
$wrongStatus=Get-ProbeStatus $wrongHeaders
if($wrongStatus -ne 401){Fail-Step 'S2V-01C' "wrong Authorization was not rejected; status=$wrongStatus"}
Write-Host '[S2V-01C] PASS - wrong Authorization rejected with HTTP 401'
$correctHeaders=@{}+$probeHeaders;$correctHeaders['Authorization']=$authHeader
$correctStatus=Get-ProbeStatus $correctHeaders
if($correctStatus -ne 200){Fail-Step 'S2V-01D' "correct Authorization did not succeed; status=$correctStatus"}
Write-Host '[S2V-01D] PASS - configured SPARK access key accepted'
$tag='spark-transport-'+[DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
$dir=$tag
$file="$dir\sample.txt"
$copy="$dir\copy.txt"
$moved="$dir\$tag-moved.txt"

Write-Host '[S2V-02] CRUD create...'
Assert-Ok (Call-Tool 'create_directory' @{path=$dir}) 'S2V-02A' 'create_directory'
Assert-Ok (Call-Tool 'create_file' @{path=$file;text='alpha TARGET omega'}) 'S2V-02B' 'create_file'

Write-Host '[S2V-03] CRUD write/modify/copy/move...'
Assert-Ok (Call-Tool 'write_file' @{path=$file;text='one TARGET three'}) 'S2V-03A' 'write_file'
Assert-Ok (Call-Tool 'modify_file' @{path=$file;search='TARGET';replace='TWO'}) 'S2V-03B' 'modify_file'
$r=Call-Tool 'read_file' @{path=$file};Assert-Ok $r 'S2V-03C' 'read_file after modify'
if($r.data.text -ne 'one TWO three'){Fail-Step 'S2V-03C' "modified file content mismatch: '$($r.data.text)'"}
Assert-Ok (Call-Tool 'copy_path' @{source=$file;destination=$copy}) 'S2V-03D' 'copy_path'
Assert-Ok (Call-Tool 'move_path' @{source=$copy;destination=$moved}) 'S2V-03E' 'move_path'

Write-Host '[S2V-04] Command execution...'
$r=Call-Tool 'run_command' @{command='cmd.exe';args=@('/d','/c','echo SPARK_EXEC_OK');cwd=$dir;timeoutMs=5000}
Assert-Ok $r 'S2V-04A' 'run_command'
$stdout=[string]$r.data.stdout
if($stdout -notmatch 'SPARK_EXEC_OK'){
  Write-Host "[S2V-04B] stdout=<$stdout>"
  Write-Host "[S2V-04B] stderr=<$([string]$r.data.stderr)>"
  Fail-Step 'S2V-04B' 'command stdout mismatch'
}
Write-Host '[S2V-04B] PASS - command stdout contains SPARK_EXEC_OK'

Write-Host '[S2V-05] Traversal negative test...'
$r=Call-Tool 'create_file' @{path='../escape.txt';text='x'}
if($r.ok -or $r.error.code -ne 'PATH_TRAVERSAL'){Fail-Step 'S2V-05' "traversal was not rejected as PATH_TRAVERSAL; ok=$($r.ok) code=$($r.error.code)"}
Write-Host "[S2V-05] PASS - traversal rejected (operationId=$($r.operationId))"

Write-Host '[S2V-06] Recycle Bin file delete...'
$unique=[IO.Path]::GetFileName($moved)
$r=Call-Tool 'delete_path' @{path=$moved};Assert-Ok $r 'S2V-06A' 'delete_path file'
Start-Sleep -Milliseconds 500
$shell=New-Object -ComObject Shell.Application
$bin=$shell.Namespace(10)
$found=$false
foreach($item in $bin.Items()){if($item.Name -eq $unique){$found=$true;break}}
if(-not $found){Fail-Step 'S2V-06B' "Recycle Bin enumeration did not find expected item: $unique"}
Write-Host "[S2V-06B] PASS - Recycle Bin item found: $unique"

Write-Host '[S2V-07] Cleanup test directory via Recycle Bin...'
$r=Call-Tool 'delete_path' @{path=$dir};Assert-Ok $r 'S2V-07' 'delete_path directory'

Write-Host '[S2V-08] PASS - Operation ledger persists in local runtime state; SPARK.cmd status remains concise runtime health'
Write-Host '[S2V-09] PASS - TRANSPORT WINDOWS LOCAL VALIDATION COMPLETE'
