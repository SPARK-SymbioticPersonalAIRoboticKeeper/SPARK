param([string]$ConfigPath)
$ErrorActionPreference='Stop'

function Fail([string]$Message){
  [Console]::Error.WriteLine("[INIT-ERROR] $Message")
  exit 1
}

$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if(-not $ConfigPath){$ConfigPath=Join-Path $root '.runtime\config\spark.local.json'}
try{$ConfigPath=[System.IO.Path]::GetFullPath($ConfigPath)}catch{Fail 'Invalid config path.'}
$onlyConfig=[IO.Path]::GetFullPath((Join-Path $root '.runtime\config\spark.local.json'))
if ($ConfigPath -ine $onlyConfig) { Fail 'User configuration must reside in .runtime/config/spark.local.json.' }

$example=Join-Path $root 'mod\spark_transport\config\spark.example.json'
$authCli=Join-Path $root 'mod\spark_transport\src\auth-cli.mjs'
$directory=Split-Path -Parent $ConfigPath
$secretDir=Join-Path $root '.runtime\secrets'
$accessTokenPath=Join-Path $secretDir 'Access_token'
function Initialize-PrivateData {
  $privateRoot = Join-Path $root '.runtime'
  if (-not (Test-Path -LiteralPath $privateRoot -PathType Container)) {
    if (Test-Path -LiteralPath $privateRoot) { Fail 'The .runtime private root is not a directory.' }
    New-Item -ItemType Directory -Path $privateRoot -ErrorAction Stop | Out-Null
    $acl = Get-Acl -LiteralPath $privateRoot
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($oldAccess in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($oldAccess) }
    $principals = @(
      [Security.Principal.WindowsIdentity]::GetCurrent().User,
      [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
      [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    )
    foreach ($principal in $principals) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $principal, [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $privateRoot -AclObject $acl -ErrorAction Stop
  }
  if (([IO.File]::GetAttributes($privateRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail 'The .runtime root cannot be a symlink or reparse point.'
  }
  $privateAcl = Get-Acl -LiteralPath $privateRoot
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($entry in $privateAcl.Access) {
    $sid = $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($allowed -notcontains $sid) {
      Fail 'The .runtime root ACL exposes private data outside the current user/SYSTEM/Administrators.'
    }
  }
  $privateConfig=Join-Path $privateRoot 'config'
  $privateSecrets=Join-Path $privateRoot 'secrets'
  foreach ($p in @($privateConfig, $privateSecrets)) {
    if (Test-Path -LiteralPath $p) {
      if (-not (Test-Path -LiteralPath $p -PathType Container)) { Fail 'Durable private path is not a directory.' }
      if (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail 'Durable private data directory cannot be a symlink.'
      }
    } else {
      New-Item -ItemType Directory -Path $p -ErrorAction Stop | Out-Null
    }
  }
}

Initialize-PrivateData
. (Join-Path $PSScriptRoot 'spark-data-path.ps1')
$env:SPARK_DATA_DIR=Initialize-SparkUserData -SourceRoot $root
$configExists=Test-Path -LiteralPath $ConfigPath -PathType Leaf
$accessTokenExists=Test-Path -LiteralPath $accessTokenPath -PathType Leaf

if($configExists -and $accessTokenExists){
  Write-Host '[INIT-00] PASS - SPARK is already initialized; existing files were preserved.'
  Write-Host '[INIT-01] Existing private config preserved.'
  Write-Host '[INIT-02] Existing Access_token preserved (value hidden).'
  return
}
if($configExists -xor $accessTokenExists){
  $missing=if($configExists){'Access_token'}else{'private config'}
  Fail "Incomplete initialization state; existing files were preserved. Missing: $missing."
}

if(-not (Test-Path -LiteralPath $example -PathType Leaf)){Fail 'Example config not found.'}
if(-not (Get-Command node.exe -ErrorAction SilentlyContinue)){Fail 'Node.js is required.'}

try{
  $generatedRaw=& node.exe $authCli generate --json
  if($LASTEXITCODE -ne 0){Fail 'Access_token generation failed.'}
  $generated=$generatedRaw | ConvertFrom-Json
  if(-not $generated.token){Fail 'Access_token generation returned incomplete data.'}
}catch{
  Fail 'Access_token generation failed.'
}

try{
  $config=Get-Content -LiteralPath $example -Raw | ConvertFrom-Json
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
  $json=$config | ConvertTo-Json -Depth 32
  [System.IO.File]::WriteAllText($ConfigPath,$json+[Environment]::NewLine,[System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($accessTokenPath,([string]$generated.token)+[Environment]::NewLine,[System.Text.UTF8Encoding]::new($false))
}catch{
  Fail 'Initialization could not create the required local files.'
}

if(-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)){Fail 'Private config creation failed.'}
if(-not (Test-Path -LiteralPath $accessTokenPath -PathType Leaf)){Fail 'Access_token creation failed.'}

Write-Host '[INIT-01] PASS - Private config created.'
Write-Host '[INIT-02] PASS - 256-bit Access_token created (value hidden).'
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. Edit transport.allowedRoot and tunnel.id in the private config.'
Write-Host '  2. Put the OpenAI Web API secret key in .runtime\secrets\API_secret_key.'
Write-Host '  3. Configure the ChatGPT App Authentication with Access token and Bearer scheme.'
Write-Host '  4. Paste the spk_ value from .runtime\secrets\Access_token into that App connection.'
Write-Host '  5. Run out\SPARK.ps1 start.'
