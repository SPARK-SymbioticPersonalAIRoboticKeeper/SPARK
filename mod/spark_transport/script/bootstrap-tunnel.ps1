param([Parameter(Mandatory=$true)][string]$Version,[Parameter(Mandatory=$true)][string]$ClientDir)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not [System.IO.Path]::IsPathRooted($ClientDir)) { $ClientDir = Join-Path $root $ClientDir }
$exe = Join-Path $ClientDir 'tunnel-client.exe'
if (Test-Path $exe) { Write-Host "[S2-TUN-02] tunnel-client already installed: $exe"; exit 0 }
New-Item -ItemType Directory -Force -Path $ClientDir | Out-Null
$tag = $Version
$name = "tunnel-client-$Version-windows-amd64.zip"
$base = "https://github.com/openai/tunnel-client/releases/download/$tag"
$zip = Join-Path $env:TEMP $name
$sums = Join-Path $env:TEMP "SPARK-SHA256SUMS-$Version.txt"
Write-Host "[S2-TUN-02] Downloading full OpenAI tunnel-client: $name"
& curl.exe -fL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 "$base/$name" -o $zip
if ($LASTEXITCODE -ne 0) { throw "tunnel-client download failed or exceeded 120 second watchdog" }
& curl.exe -fL --connect-timeout 10 --max-time 60 --retry 2 --retry-delay 2 "$base/SHA256SUMS.txt" -o $sums
if ($LASTEXITCODE -ne 0) { throw "SHA256SUMS download failed or exceeded 60 second watchdog" }
$line = Get-Content $sums | Where-Object { $_ -match [regex]::Escape($name) } | Select-Object -First 1
if (-not $line) { throw "checksum entry not found for $name" }
$expected = ($line -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw "SHA256 mismatch: expected=$expected actual=$actual" }
Write-Host "[S2-TUN-03] SHA256 verified: $actual"
$extract = Join-Path $env:TEMP "SPARK-tunnel-$Version"
Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
Expand-Archive -Force $zip $extract
$found = Get-ChildItem -Path $extract -Recurse -Filter 'tunnel-client.exe' | Select-Object -First 1
if (-not $found) { throw "full tunnel-client.exe not found in archive" }
Copy-Item -Force $found.FullName $exe
Write-Host "[S2-TUN-04] Installed: $exe"
