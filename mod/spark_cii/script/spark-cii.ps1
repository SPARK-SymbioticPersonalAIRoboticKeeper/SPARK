[CmdletBinding()]
param(
    [ValidateSet('start','stop','status','probe','once','validate','disable','run')]
    [string]$Action = 'status',
    [int]$Port = 0,
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$Cli = Join-Path $ProjectRoot 'mod\spark_cii\src\cli.mjs'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$extra = @()
if ($ConfigPath) { $extra += @('--config', [System.IO.Path]::GetFullPath($ConfigPath)) }
if ($Port -gt 0) { $extra += @('--port', [string]$Port) }

function Get-CiiProcesses {
    $needle = [System.IO.Path]::GetFullPath($Cli)
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $_.CommandLine -match '(^|\s)run(\s|$)'
        })
}

switch ($Action) {
    'start' {
        # Fail closed before replacing the existing watcher, so the restart gap
        # cannot silently send an unprefixed Enter/Send from the active page.
        $prepare = & $Node $Cli protect @extra --json 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'CII cannot install fail-closed gate before watcher replacement.' }
        $existing = @(Get-CiiProcesses)
        if ($existing.Count -gt 0) {
            $active = $false
            try {
                $currentJson = & $Node $Cli probe @extra --json 2>$null
                if ($LASTEXITCODE -eq 0) {
                    $current = ($currentJson -join [Environment]::NewLine) | ConvertFrom-Json
                    $active = ($current.active -eq $true -and
                        @($current.targets | Where-Object { $_.state.stage -ne 'EGRESS_REQUEST_BOUNDARY' }).Count -eq 0)
                }
            } catch {}
            if ($active) {
                Write-Host "SPARK CII 0.0.3 EGRESS BOUNDARY ARMED (Prefix payload E2E not yet verified), PID=$($existing[0].ProcessId)"
                exit 0
            }
            # An old watcher may retain the pre-reboot CDP port. Replace only
            # processes whose command line has been verified by Get-CiiProcesses.
            Write-Host 'SPARK CII RECOVERING - replacing stale/disconnected watcher'
            foreach ($candidate in $existing) {
                $check = Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)" -ErrorAction SilentlyContinue
                if (-not $check -or $check.CreationDate -ne $candidate.CreationDate -or
                    $check.CommandLine -cne $candidate.CommandLine) { continue }
                Stop-Process -Id $candidate.ProcessId -Force -ErrorAction Stop
            }
            Start-Sleep -Milliseconds 350
            if (@(Get-CiiProcesses).Count -gt 0) { throw 'Stale CII watcher still running; no duplicate watcher started.' }
        }
        & $Node $Cli validate @extra
        if ($LASTEXITCODE -ne 0) { throw 'Cii configuration validation failed; no daemon started.' }
        $probe = & $Node $Cli probe @extra --json
        if ($LASTEXITCODE -ne 0) { throw 'CDP probe failed; no daemon started.' }
        $probeState = ($probe -join [Environment]::NewLine) | ConvertFrom-Json
        if (-not $probeState.targetCount) { throw 'No eligible CDP target; no daemon started.' }
        $argsForProcess = @($Cli, 'run') + $extra
        $process = Start-Process -FilePath $Node -ArgumentList $argsForProcess -PassThru -WindowStyle Hidden
        $ready = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            Start-Sleep -Milliseconds 200
            if ($process.HasExited) { throw "SPARK CII exited early (exitCode=$($process.ExitCode))." }
            $checkJson = & $Node $Cli probe @extra --json 2>$null
            if ($LASTEXITCODE -eq 0) {
                try {
                    $check = ($checkJson -join [Environment]::NewLine) | ConvertFrom-Json
                    if ($check.active -eq $true) { $ready = $true; break }
                } catch {}
            }
        }
        if (-not $ready) {
            $owned = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue
            if ($owned -and $owned.CommandLine -and
                $owned.CommandLine.IndexOf($Cli, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
            throw "CII watcher started but live injection could not be verified; startup refused."
        }
        Write-Host "SPARK CII 0.0.3 EGRESS BOUNDARY ARMED (Prefix payload E2E not yet verified), PID=$($process.Id)"
        exit 0
    }
    'stop' {
        # Shutdown is idempotent even when ChatGPT/CDP has already exited.
        # A stopped watcher and a disabled/closed ChatGPT page are independent checks.
        $original = @(Get-CiiProcesses)
        foreach ($candidate in $original) {
            $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)" -ErrorAction SilentlyContinue
            if (-not $current) { continue }
            if ($current.CreationDate -ne $candidate.CreationDate -or
                $current.CommandLine -cne $candidate.CommandLine) {
                throw 'CII watcher identity changed; refusing to stop an unrelated process.'
            }
            Stop-Process -Id $candidate.ProcessId -Force -ErrorAction Stop
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $remaining = @(Get-CiiProcesses)
            if ($remaining.Count -eq 0) { break }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($remaining.Count -ne 0) { throw 'CII watcher process still active after Stop.' }
        # CDP can disappear before Stop reaches the guard; this is a warning,
        # not permission to leave a live watcher or skip the remaining shutdown.
        try {
            $null = & $Node $Cli disable @extra 2>$null
            if ($LASTEXITCODE -ne 0) { Write-Host 'SPARK CII STOP: watcher gone; page disable unavailable (CDP may be closed).' }
        } catch {
            Write-Host 'SPARK CII STOP: watcher gone; page disable unavailable (CDP may be closed).'
        }
        Write-Host 'SPARK CII STOPPED - no managed watcher process remains'
        exit 0
    }
    'status' {
        $pids = @(Get-CiiProcesses | ForEach-Object { $_.ProcessId })
        if ($pids.Count -eq 0) {
            Write-Host 'SPARK CII INACTIVE - watcher process missing'
            exit 1
        }
        $probeJson = & $Node $Cli probe @extra --json 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "SPARK CII DISCONNECTED - CDP unavailable, watcher PID(s): $($pids -join ',')"
            exit 1
        }
        $probe = ($probeJson -join [Environment]::NewLine) | ConvertFrom-Json
        if ($probe.active -ne $true) {
            Write-Host "SPARK CII DEGRADED - no verified injection on all eligible pages (targets=$($probe.targetCount))"
            exit 1
        }
        $stage = @($probe.targets)[0].state.stage
        $observed = @($probe.targets | Where-Object {
            $_.state.dispatchBreakpoint.forwarded -gt 0
        }).Count
        $blocked = @($probe.targets | Where-Object {
            $_.state.dispatchBreakpoint.blocked -gt 0 -or $_.state.gate.blockedIntents -gt 0
        }).Count
        $version = '0.0.3'
        $label = if ($probe.healthy -eq $true) {
            "LOCAL_REQUEST_PREFIX_VERIFIED"
        } else {
            "EGRESS_BOUNDARY_ARMED_UNVERIFIED"
        }
        Write-Host "SPARK CII $version $label - $stage, windows=$($probe.targetCount), callframe-verified windows=$observed, blocked=$blocked; actual IPC/TLS/server receipt unverified; PID(s)=$($pids -join ',')"
        exit 0
    }
    default {
        & $Node $Cli $Action @extra
        exit $LASTEXITCODE
    }
}
