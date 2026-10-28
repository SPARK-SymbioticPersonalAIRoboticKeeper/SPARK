[CmdletBinding()]
param(
    [ValidateRange(0, 3600)]
    [int]$DelaySeconds = 0,

    [string]$Theme = 'dark-red',

    [string]$ThemePath = '',

    [string]$NodePath = '',

    [string]$TransportHealthUrl = 'http://127.0.0.1:8765/health',

    [switch]$DisableProgress,

    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot '..\..'))
. (Join-Path $RepoRoot 'out/spark/script\spark-log-path.ps1')
$LogDirectory = Get-SparkLogDirectory -Root $RepoRoot
$RuntimeDirectory = Join-Path $RepoRoot 'log\system'
$ActivePath = Join-Path $RuntimeDirectory 'active.json'
. (Join-Path $RepoRoot 'out\spark\script\spark-data-path.ps1')
$DurableUiStateDir = Join-Path (Get-SparkUserDataRoot -SourceRoot $RepoRoot) 'ui-state'
$LastRunPath = Join-Path $DurableUiStateDir 'last-run.json'
$CliPath = Join-Path $ProjectRoot 'src\cli.mjs'
$WatcherPath = Join-Path $ProjectRoot 'src\watch.mjs'

function Resolve-ThemeConfigPath {
    param(
        [string]$Selection,
        [string]$ExplicitPath
    )

    if ($ExplicitPath) {
        return [System.IO.Path]::GetFullPath($ExplicitPath)
    }

    $normalized = if ($Selection) { $Selection.Trim().ToLowerInvariant() } else { 'dark-red' }
    switch ($normalized) {
        { $_ -in @('rainbow', 'rainbow-map', 'default-theme') } {
            return Join-Path $ProjectRoot 'config\default-theme.json'
        }
        { $_ -in @('', 'dark-red', 'darkred', 'dark-red-theme', 'default') } {
            return Join-Path $ProjectRoot 'config\dark-red-theme.json'
        }
        default {
            if ($Selection -notmatch '[\\/]' -and $Selection -notmatch '\.json$') {
                throw "Unknown theme '$Selection'. Use rainbow, dark-red, or a JSON file path."
            }

            if ([System.IO.Path]::IsPathRooted($Selection)) {
                return [System.IO.Path]::GetFullPath($Selection)
            }

            $projectCandidate = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Selection))
            if (Test-Path -LiteralPath $projectCandidate -PathType Leaf) {
                return $projectCandidate
            }
            return [System.IO.Path]::GetFullPath($Selection)
        }
    }
}

$ThemePath = Resolve-ThemeConfigPath -Selection $Theme -ExplicitPath $ThemePath

function Write-JsonFile {
    param([string]$Path, [object]$Value)
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "The approved operational state directory must already exist: $directory"
    }
    $temporary = "$Path.$PID.tmp"
    $Value | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-Sha256 {
    param([string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '').ToUpperInvariant()
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Resolve-NodePath {
    param([string]$Requested)
    if ($Requested) {
        $resolved = [System.IO.Path]::GetFullPath($Requested)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw "Node executable not found: $resolved"
        }
        return $resolved
    }

    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $bundled = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }

    throw 'Node.js 22 or newer was not found. Install Node.js or pass -NodePath explicitly.'
}

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

function Get-ChatGptProcesses {
    param([string]$InstallRoot)
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase)
    })
}

function Test-SameVerifiedChatGptProcess {
    param(
        [object]$Expected,
        [object]$Actual,
        [string]$InstallRoot
    )

    if (-not $Expected -or -not $Actual -or
        -not $Expected.ExecutablePath -or -not $Actual.ExecutablePath -or
        -not $Expected.CreationDate -or -not $Actual.CreationDate) {
        return $false
    }
    if (-not $Actual.ExecutablePath.StartsWith($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $Actual.ExecutablePath.Equals($Expected.ExecutablePath, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $Actual.Name.Equals($Expected.Name, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }

    $creationDelta = [Math]::Abs((
        $Actual.CreationDate.ToUniversalTime() - $Expected.CreationDate.ToUniversalTime()
    ).TotalMilliseconds)
    return $creationDelta -le 1
}

function Stop-VerifiedChatGptProcessIfPresent {
    param(
        [object]$Expected,
        [string]$InstallRoot
    )

    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($Expected.ProcessId)" -ErrorAction SilentlyContinue
    if (-not (Test-SameVerifiedChatGptProcess -Expected $Expected -Actual $current -InstallRoot $InstallRoot)) {
        Write-Verbose "ChatGPT process $($Expected.ProcessId) already exited or changed identity."
        return
    }

    $process = Get-Process -Id $Expected.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) {
        Write-Verbose "ChatGPT process $($Expected.ProcessId) already exited."
        return
    }

    try {
        $processPath = $process.Path
        $processStart = $process.StartTime.ToUniversalTime()
        $currentStart = $current.CreationDate.ToUniversalTime()
        if (-not $processPath.Equals($current.ExecutablePath, [System.StringComparison]::OrdinalIgnoreCase) -or
            [Math]::Abs(($processStart - $currentStart).TotalMilliseconds) -gt 1) {
            Write-Verbose "ChatGPT process $($Expected.ProcessId) changed identity before termination."
            return
        }

        $process.Kill()
    }
    catch {
        $after = Get-CimInstance Win32_Process -Filter "ProcessId=$($Expected.ProcessId)" -ErrorAction SilentlyContinue
        if (-not (Test-SameVerifiedChatGptProcess -Expected $Expected -Actual $after -InstallRoot $InstallRoot)) {
            Write-Verbose "ChatGPT process $($Expected.ProcessId) exited during termination."
            return
        }
        throw
    }
    finally {
        $process.Dispose()
    }
}

function Stop-VerifiedChatGptProcesses {
    param([string]$InstallRoot)
    $items = @(Get-ChatGptProcesses -InstallRoot $InstallRoot)
    $main = @($items | Where-Object {
        $_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -notmatch '--type='
    })

    foreach ($item in $main) {
        $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        Start-Sleep -Milliseconds 250
        $remaining = @(Get-ChatGptProcesses -InstallRoot $InstallRoot)
    } until ($remaining.Count -eq 0 -or [DateTime]::UtcNow -ge $deadline)

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        foreach ($item in $remaining) {
            Stop-VerifiedChatGptProcessIfPresent -Expected $item -InstallRoot $InstallRoot
        }
        Start-Sleep -Milliseconds 250
        $remaining = @(Get-ChatGptProcesses -InstallRoot $InstallRoot)
    } until ($remaining.Count -eq 0 -or [DateTime]::UtcNow -ge $deadline)

    if ($remaining.Count -ne 0) {
        throw "ChatGPT processes did not exit: $($remaining.ProcessId -join ', ')"
    }
}

function Stop-ExistingThemeWatcher {
    if (-not (Test-Path -LiteralPath $ActivePath -PathType Leaf)) { return }
    try {
        $existingActive = Get-Content -LiteralPath $ActivePath -Raw | ConvertFrom-Json
    }
    catch { return }
    if (-not ($existingActive.PSObject.Properties.Name -contains 'watcherPid') -or -not $existingActive.watcherPid) { return }

    $existingWatcher = Get-CimInstance Win32_Process -Filter "ProcessId=$($existingActive.watcherPid)" -ErrorAction SilentlyContinue
    if (-not $existingWatcher -or -not $existingWatcher.CommandLine -or -not $existingWatcher.ExecutablePath) { return }
    if ($existingWatcher.CommandLine.IndexOf($WatcherPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return }
    if (-not $existingWatcher.ExecutablePath.EndsWith('node.exe', [System.StringComparison]::OrdinalIgnoreCase)) { return }

    Stop-Process -Id $existingWatcher.ProcessId -Force -ErrorAction Stop
    Start-Sleep -Milliseconds 300
}

function Get-FreeLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Wait-CdpEndpoint {
    param([int]$Port, [int]$TimeoutSeconds = 60)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 1
            if (@($targets).Count -gt 0) { return @($targets) }
        }
        catch {}
        Start-Sleep -Milliseconds 300
    } until ([DateTime]::UtcNow -ge $deadline)
    throw "CDP endpoint did not become ready on 127.0.0.1:$Port."
}

$NodePath = Resolve-NodePath -Requested $NodePath
if (-not (Test-Path -LiteralPath $ThemePath -PathType Leaf)) {
    throw "Theme config not found: $ThemePath"
}
$validateOutput = & $NodePath $CliPath validate --theme $ThemePath --json 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "Theme config validation failed: $($validateOutput -join [Environment]::NewLine)"
}
if ($ValidateOnly) {
    $validateOutput
    return
}
Write-Host "[UI-01] PASS - Theme config validated: $Theme"

$package = Resolve-ChatGptPackage
$InstallRoot = [System.IO.Path]::GetFullPath($package.InstallLocation)
$Executable = Resolve-ChatGptExecutable -InstallRoot $InstallRoot
Write-Host "[UI-02] PASS - ChatGPT package resolved: $($package.PackageFullName)"
$baseline = [ordered]@{
    schemaVersion = 2
    capturedAt = [DateTime]::UtcNow.ToString('o')
    product = 'SPARK ChatGPT UI'
    projectRoot = $ProjectRoot
    themeSelection = $Theme
    themePath = $ThemePath
    themeSha256 = Get-Sha256 -Path $ThemePath
    packageFullName = $package.PackageFullName
    installRoot = $InstallRoot
    executable = $Executable
    processes = @(Get-ChatGptProcesses -InstallRoot $InstallRoot | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
    recovery = "Run script\restore-normal.ps1 from $ProjectRoot"
}
if (-not (Test-Path -LiteralPath $RuntimeDirectory -PathType Container)) {
    throw "The approved operational directory must already exist: $RuntimeDirectory"
}
# Keep at most one current and one previous runtime baseline. Do not add a
# timestamped backup directory or create unbounded baseline-*.json history.
if (-not (Test-Path -LiteralPath $DurableUiStateDir -PathType Container)) {
    throw "The approved durable UI state directory must already exist: $DurableUiStateDir"
}
$baselineCurrent = Join-Path $DurableUiStateDir 'baseline-current.json'
$baselinePrevious = Join-Path $DurableUiStateDir 'baseline-previous.json'
if (Test-Path -LiteralPath $baselineCurrent -PathType Leaf) {
    # Verify the current snapshot parses before preserving it as the previous.
    $priorSnapshot = Get-Content -LiteralPath $baselineCurrent -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $priorSnapshot -or $priorSnapshot.schemaVersion -ne 2) {
        throw 'Existing UI baseline is invalid; refusing to overwrite without verified recovery'
    }
    Copy-Item -LiteralPath $baselineCurrent -Destination $baselinePrevious -Force -ErrorAction Stop
}
Write-JsonFile -Path $baselineCurrent -Value $baseline

if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }

$port = Get-FreeLoopbackPort
$started = $null
$watcher = $null
try {
    Stop-ExistingThemeWatcher
    Stop-VerifiedChatGptProcesses -InstallRoot $InstallRoot

    $started = Start-Process -FilePath $Executable -ArgumentList @(
        '--remote-debugging-address=127.0.0.1',
        "--remote-debugging-port=$port"
    ) -PassThru

    $targets = Wait-CdpEndpoint -Port $port -TimeoutSeconds 60
    Write-Host "[UI-03] PASS - ChatGPT CDP ready: 127.0.0.1:$port"
    $active = [ordered]@{
        schemaVersion = 2
        launchedAt = [DateTime]::UtcNow.ToString('o')
        product = 'SPARK ChatGPT UI'
        packageFullName = $package.PackageFullName
        appPid = $started.Id
        host = '127.0.0.1'
        port = $port
        endpoint = "http://127.0.0.1:$port/json/list"
        themeSelection = $Theme
        themePath = $ThemePath
        security = 'Loopback only. Any local process can still access this unauthenticated CDP endpoint.'
        recovery = "Run script\restore-normal.ps1 from $ProjectRoot"
    }
    Write-JsonFile -Path $ActivePath -Value $active

    $applyOutput = & $NodePath $CliPath apply --host 127.0.0.1 --port $port --theme $ThemePath --timeout 60000 --json 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Theme apply failed: $($applyOutput -join [Environment]::NewLine)"
    }

    $statusOutput = & $NodePath $CliPath status --host 127.0.0.1 --port $port --theme $ThemePath --timeout 60000 --json 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Theme status failed: $($statusOutput -join [Environment]::NewLine)"
    }
    Write-Host "[UI-04] PASS - Theme applied and verified: $Theme"

    $watcherArguments = @(
        $WatcherPath,
        '--host', '127.0.0.1',
        '--port', $port,
        '--theme', $ThemePath,
        '--interval', 1500,
        '--unavailable-exit', 30000
    )
    if(-not $DisableProgress){
        $watcherArguments += @('--transport-health', $TransportHealthUrl)
    }
    $watcher = Start-Process -FilePath $NodePath -ArgumentList $watcherArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LogDirectory 'watcher-out.log') -RedirectStandardError (Join-Path $LogDirectory 'watcher-error.log')
    $active['watcherPid'] = $watcher.Id
    $active['progressEnabled'] = (-not $DisableProgress)
    if(-not $DisableProgress){$active['transportHealthUrl'] = $TransportHealthUrl}
    Write-JsonFile -Path $ActivePath -Value $active
    Write-Host "[UI-05] PASS - UI watcher started, PID=$($watcher.Id)"

    $result = [ordered]@{
        success = $true
        completedAt = [DateTime]::UtcNow.ToString('o')
        active = $active
        configValidation = ($validateOutput -join [Environment]::NewLine)
        targets = @($targets | Select-Object id, type, title, url)
        apply = ($applyOutput -join [Environment]::NewLine)
        status = ($statusOutput -join [Environment]::NewLine)
    }
    Write-JsonFile -Path $LastRunPath -Value $result
    Write-Host '[UI-06] PASS - ChatGPT UI startup complete'
}
catch {
    $failure = [ordered]@{
        success = $false
        failedAt = [DateTime]::UtcNow.ToString('o')
        message = $_.Exception.Message
        recoveryAttempted = $true
    }
    Write-JsonFile -Path $LastRunPath -Value $failure

    if ($watcher) {
        $watcherExact = Get-CimInstance Win32_Process -Filter "ProcessId=$($watcher.Id)" -ErrorAction SilentlyContinue
        if ($watcherExact -and $watcherExact.ExecutablePath -eq $NodePath -and
            $watcherExact.CommandLine -and $watcherExact.CommandLine.IndexOf($WatcherPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Stop-Process -Id $watcher.Id -Force -ErrorAction SilentlyContinue
        }
    }

    if ($started) {
        $exact = Get-CimInstance Win32_Process -Filter "ProcessId=$($started.Id)" -ErrorAction SilentlyContinue
        if ($exact -and $exact.ExecutablePath -eq $Executable) {
            Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        }
    }
    Start-Process -FilePath $Executable | Out-Null
    throw
}
