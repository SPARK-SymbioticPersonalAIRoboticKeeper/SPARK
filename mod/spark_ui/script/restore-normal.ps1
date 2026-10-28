[CmdletBinding()]
param([string]$NodePath = '')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeDirectory = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot '..\..\log\system'))
$ActivePath = Join-Path $RuntimeDirectory 'active.json'
$CliPath = Join-Path $ProjectRoot 'src\cli.mjs'

function Resolve-ChatGptPackage {
    foreach ($name in @('OpenAI.ChatGPT', 'OpenAI.Codex')) {
        $package = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue |
            Sort-Object Version -Descending |
            Select-Object -First 1
        if ($package) { return $package }
    }
    throw 'The OpenAI ChatGPT desktop package was not found.'
}

function Resolve-ChatGptExecutable {
    param([string]$InstallRoot)
    foreach ($relative in @('app\ChatGPT.exe', 'ChatGPT.exe')) {
        $candidate = Join-Path $InstallRoot $relative
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw "ChatGPT.exe was not found under the verified package root: $InstallRoot"
}

if (-not $NodePath) {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { $NodePath = $command.Source }
}
if (-not $NodePath) {
    $candidate = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $candidate) { $NodePath = $candidate }
}

$active = if (Test-Path -LiteralPath $ActivePath) {
    Get-Content -LiteralPath $ActivePath -Raw | ConvertFrom-Json
} else { $null }

if ($active -and ($active.PSObject.Properties.Name -contains 'watcherPid') -and $active.watcherPid) {
    $watcher = Get-CimInstance Win32_Process -Filter "ProcessId=$($active.watcherPid)" -ErrorAction SilentlyContinue
    $watcherPath = Join-Path $ProjectRoot 'src\watch.mjs'
    if ($watcher -and $watcher.ExecutablePath -and $watcher.CommandLine -and
        $watcher.CommandLine.IndexOf($watcherPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Stop-Process -Id $watcher.ProcessId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
    }
}

if ($active -and $NodePath -and (Test-Path -LiteralPath $NodePath)) {
    try {
        $restoreArguments = @($CliPath, 'restore', '--host', $active.host, '--port', $active.port, '--timeout', 15000)
        if (($active.PSObject.Properties.Name -contains 'themePath') -and $active.themePath) {
            $restoreArguments += @('--theme', $active.themePath)
        }
        & $NodePath @restoreArguments | Out-Null
    }
    catch {}
}

$package = Resolve-ChatGptPackage
$InstallRoot = [System.IO.Path]::GetFullPath($package.InstallLocation)
$Executable = Resolve-ChatGptExecutable -InstallRoot $InstallRoot
$processes = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase)
})

foreach ($item in $processes) {
    $recheck = Get-CimInstance Win32_Process -Filter "ProcessId=$($item.ProcessId)" -ErrorAction SilentlyContinue
    if ($recheck -and $recheck.ExecutablePath -and
        $recheck.ExecutablePath.StartsWith($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 1
Start-Process -FilePath $Executable | Out-Null
Remove-Item -LiteralPath $ActivePath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $RuntimeDirectory 'watcher.json') -Force -ErrorAction SilentlyContinue

[pscustomobject]@{
    product = 'SPARK ChatGPT UI'
    restoredAt = [DateTime]::UtcNow.ToString('o')
    normalLaunch = $true
    debugPortClosedByRestart = $true
} | ConvertTo-Json
