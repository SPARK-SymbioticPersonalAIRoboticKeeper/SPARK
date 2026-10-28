param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('start', 'restart', 'status', 'stop')]
  [string]$Action,
  [switch]$NoErrorDialog
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'log\system'
$entryPath = Join-Path $root 'out\SPARK.ps1'
. (Join-Path $PSScriptRoot 'spark-log-path.ps1')
$logDir = Get-SparkLogDirectory -Root $root
$logPath = Join-Path $logDir 'spark-lifecycle.log'
$mutex = $null
$hasLock = $false
$restartMutex = $null
$hasRestartLock = $false
$resultCode = 1

function Write-LifecycleLog([string]$Message) {
  $stream = $null
  $writer = $null
  try {
    $stream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Append,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
    $writer.WriteLine($Message)
    $writer.Flush()
  } finally {
    if ($writer) { $writer.Dispose() }
    elseif ($stream) { $stream.Dispose() }
  }
}

# Capture child command output without redirecting a native stdout handle to a file.
# Long-lived Transport/Tunnel/UI descendants can inherit a cmd.exe file handle
# and keep spark-action.log locked after the lifecycle command has exited.
function Write-LifecycleOutput([string]$Content) {
  if ([string]::IsNullOrEmpty($Content)) { return }
  $stream = $null
  $writer = $null
  try {
    $stream = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Append,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
    $writer.Write($Content)
    $writer.Flush()
  } finally {
    if ($writer) { $writer.Dispose() }
    elseif ($stream) { $stream.Dispose() }
  }
}

function Receive-ActionOutput([object[]]$Streams, [object]$Budget) {
  foreach ($entry in $Streams) {
    if ($entry.eof -or -not $entry.pending.IsCompleted) { continue }
    $count = $entry.pending.GetAwaiter().GetResult()
    if ($count -eq 0) {
      $entry.eof = $true
      continue
    }
    $chunk = [string]::new($entry.buffer, 0, $count)
    $available = $Budget.limit - $Budget.count
    if ($available -gt 0) {
      $toWrite = $chunk.Substring(0, [Math]::Min($available, $chunk.Length))
      Write-LifecycleOutput $toWrite
      $Budget.count += $toWrite.Length
    }
    if ($chunk.Length -gt $available) { $Budget.truncated = $true }
    $entry.pending = $entry.reader.ReadAsync($entry.buffer, 0, $entry.buffer.Length)
  }
}

function Test-CompletedLegacyWorker([object]$Candidate, [string]$Transcript, [string]$WorkerPath) {
  # The old worker can retain its output pipe and mutex after Startup complete.
  # Only that exact, completed invocation is eligible; never reclaim by age alone.
  if (-not $Candidate -or $Candidate.ProcessId -eq $PID -or
      -not $Candidate.CreationDate -or -not $Candidate.CommandLine -or
      $Candidate.ExecutablePath -ine (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')) {
    return $false
  }
  $escapedPath = [regex]::Escape($WorkerPath)
  if ($Candidate.CommandLine -notmatch ('(?i)-File\s+(?:"' + $escapedPath + '"|' + $escapedPath + ')(?:\s|$)') -or
      $Candidate.CommandLine -notmatch '(?i)-Action\s+(start|restart)(?:\s|$)') {
    return $false
  }
  $candidateAction = $Matches[1].ToLowerInvariant()
  $headers = [regex]::Matches($Transcript, '(?m)^==== (.+?) SPARK (start|restart|status|stop) ====\s*$')
  if ($headers.Count -eq 0) { return $false }
  $lastHeader = $headers[$headers.Count - 1]
  if ($lastHeader.Groups[2].Value -ne $candidateAction) { return $false }
  $tail = $Transcript.Substring($lastHeader.Index + $lastHeader.Length).Trim()
  if (-not $tail.EndsWith('[S2-11] PASS - Startup complete.', [System.StringComparison]::Ordinal) -or
      $tail -notmatch '\[S2-10\] PASS - ChatGPT \+ ChatGPT UI runtime active') {
    return $false
  }
  $headerTime = [datetime]::MinValue
  if (-not [datetime]::TryParse($lastHeader.Groups[1].Value,
      [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None,
      [ref]$headerTime)) { return $false }
  $created = [datetime]$Candidate.CreationDate
  return ([math]::Abs(($created - $headerTime).TotalSeconds) -le 10 -and
    ((Get-Date) - $created).TotalSeconds -ge 60)
}

function Try-RecoverCompletedLegacyWorker {
  if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) { return $false }
  $before = [System.IO.File]::ReadAllText($logPath)
  $workerPath = Join-Path $root 'out\spark\script\spark-hidden-action.ps1'
  $candidates = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
    Where-Object { Test-CompletedLegacyWorker $_ $before $workerPath })
  if ($candidates.Count -ne 1) { return $false }
  $candidate = $candidates[0]
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)" -ErrorAction Stop
  if (-not $current -or $current.CreationDate -ne $candidate.CreationDate -or
      $current.CommandLine -ne $candidate.CommandLine -or
      -not (Test-CompletedLegacyWorker $current $before $workerPath) -or
      [System.IO.File]::ReadAllText($logPath) -cne $before) { return $false }

  # Capture process identity and the completed transcript before stopping it.
  # Temporary process-stop receipt is disposable and not a PAL recovery artifact.
  $receiptPath = Join-Path $runtime ('completed-worker-' + [guid]::NewGuid().ToString('N') + '.json')
  $receipt = [ordered]@{ capturedAt=(Get-Date).ToString('o'); reason='Completed legacy worker retains lifecycle mutex';
    processId=$current.ProcessId; creationDate=$current.CreationDate; executablePath=$current.ExecutablePath;
    commandLine=$current.CommandLine; transcriptLength=$before.Length;
    completedTranscriptSha256=(Get-FileHash -LiteralPath $logPath -Algorithm SHA256).Hash } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($receiptPath, $receipt, [System.Text.UTF8Encoding]::new($false))
  if ([System.IO.File]::ReadAllText($receiptPath) -cne $receipt) { throw 'Legacy-worker recovery receipt verification failed.' }
  # Recheck the exact process again immediately before termination.
  $again = Get-CimInstance Win32_Process -Filter "ProcessId=$($current.ProcessId)" -ErrorAction Stop
  if (-not $again -or $again.CreationDate -ne $current.CreationDate -or
      $again.CommandLine -ne $current.CommandLine -or $again.ExecutablePath -ine $current.ExecutablePath -or
      [System.IO.File]::ReadAllText($logPath) -cne $before) { return $false }
  $process = Get-Process -Id $again.ProcessId -ErrorAction Stop
  try {
    if ($process.Path -ine $again.ExecutablePath -or
        [math]::Abs(($process.StartTime - [datetime]$again.CreationDate).TotalMilliseconds) -gt 1) { return $false }
    $process.Kill()
    if (-not $process.WaitForExit(3000)) { throw 'Completed legacy worker did not exit.' }
  } finally { $process.Dispose() }
  return $true
}

try {
  [void](New-Item -ItemType Directory -Path $runtime -Force)

  # Deduplicate repeated Explorer double-click / tray requests while the first start is in flight.
  if ($Action -in @('start', 'restart')) {
    $requestMutexName = if ($Action -eq 'start') { 'Local\SPARK.StartRequest' } else { 'Local\SPARK.RestartRequest' }
    $restartMutex = [System.Threading.Mutex]::new($false, $requestMutexName)
    try { $hasRestartLock = $restartMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $hasRestartLock = $true }
    if (-not $hasRestartLock) {
      Write-LifecycleLog ("[LAUNCHER] {0:yyyy-MM-dd HH:mm:ss} duplicate {1} ignored; existing {1} is running" -f (Get-Date), $Action)
      $restartMutex.Dispose()
      $restartMutex = $null
      exit 0
    }
  }

  $mutex = [System.Threading.Mutex]::new($false, 'Local\SPARK.Lifecycle')
  # A concurrent status/start/stop is not a restart failure; wait for its lock.
  try { $hasLock = $mutex.WaitOne(15000) }
  catch [System.Threading.AbandonedMutexException] { $hasLock = $true }
  if (-not $hasLock -and (Try-RecoverCompletedLegacyWorker)) {
    try { $hasLock = $mutex.WaitOne(3000) }
    catch [System.Threading.AbandonedMutexException] { $hasLock = $true }
  }
  if (-not $hasLock) {
    Write-LifecycleLog ("[LAUNCHER] {0:yyyy-MM-dd HH:mm:ss} action={1} queued behind existing lifecycle action" -f (Get-Date), $Action)
    try { $hasLock = $mutex.WaitOne(300000) }
    catch [System.Threading.AbandonedMutexException] { $hasLock = $true }
  }
  if (-not $hasLock) {
    $resultCode = 3
    throw 'Lifecycle lock was not released within the configured timeout. The previous SPARK action may be stuck. See spark-lifecycle.log.'
  }

  Write-LifecycleLog ("==== {0} SPARK {1} ====" -f (Get-Date), $Action)
  # Use asynchronous, bounded pipe reads. Never open spark-action.log for native
  # redirection: a persistent child can retain that file handle indefinitely.
  # Crucially, do not wait for pipe EOF; wait for the authoritative PowerShell child exit.
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $entryPath + '" ' + $Action
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Console]::OutputEncoding
  $psi.StandardErrorEncoding = [Console]::OutputEncoding
  $child = [System.Diagnostics.Process]::new()
  $child.StartInfo = $psi
  try {
    if (-not $child.Start()) { throw 'SPARK.ps1 could not be launched.' }
    $streams = @(
      [pscustomobject]@{ reader=$child.StandardOutput; buffer=[char[]]::new(4096); pending=$null; eof=$false },
      [pscustomobject]@{ reader=$child.StandardError; buffer=[char[]]::new(4096); pending=$null; eof=$false }
    )
    foreach ($entry in $streams) {
      $entry.pending = $entry.reader.ReadAsync($entry.buffer, 0, $entry.buffer.Length)
    }
    $budget = [pscustomobject]@{ limit=2097152; count=0; truncated=$false }
    $deadline = (Get-Date).AddMinutes(10)
    do {
      $exited = $child.WaitForExit(200)
      Receive-ActionOutput $streams $budget
      if (-not $exited -and (Get-Date) -gt $deadline) {
        throw "SPARK $Action exceeded the lifecycle timeout; child PID=$($child.Id)."
      }
    } while (-not $exited)
    $resultCode = $child.ExitCode

    # Persistent descendants may keep their inherited pipes open. Drain already
    # available output briefly but never block waiting for those descendants.
    $drainUntil = (Get-Date).AddMilliseconds(750)
    do {
      Receive-ActionOutput $streams $budget
      if (@($streams | Where-Object { -not $_.eof }).Count -eq 0) { break }
      Start-Sleep -Milliseconds 30
    } while ((Get-Date) -lt $drainUntil)
    Write-LifecycleLog ''
    if ($budget.truncated) { Write-LifecycleLog '[LAUNCHER] child output truncated at 2 MiB.' }
  } finally {
    $child.Dispose()
  }
  Write-LifecycleLog ("[LAUNCHER] {0:yyyy-MM-dd HH:mm:ss} action={1} completed exitCode={2}" -f (Get-Date), $Action, $resultCode)
  if ($resultCode -ne 0) { throw "SPARK $Action failed (exit $resultCode). Log: $logPath" }
}
catch {
  if ($resultCode -eq 0 -or $resultCode -eq 1) { $resultCode = 1 }
  $failure = $_.Exception.Message
  try { Write-LifecycleLog ("[LAUNCHER] {0:yyyy-MM-dd HH:mm:ss} action={1} error: {2}" -f (Get-Date), $Action, $failure) } catch {}
  [Console]::Error.WriteLine($failure)
  if (-not $NoErrorDialog) {
    $dialogTitle = if ($Action -eq 'restart') { 'SPARK reconnect failed' } else { 'SPARK ' + $Action + ' failed' }
    # An indefinite error popup hidden behind a window can hold Lifecycle mutex forever.
    try { [void]((New-Object -ComObject WScript.Shell).Popup($failure, 8, $dialogTitle, 16)) } catch {}
  }
}
finally {
  if ($hasLock -and $mutex) { try { $mutex.ReleaseMutex() } catch {} }
  if ($mutex) { $mutex.Dispose() }
  if ($hasRestartLock -and $restartMutex) { try { $restartMutex.ReleaseMutex() } catch {} }
  if ($restartMutex) { $restartMutex.Dispose() }
}
exit $resultCode
