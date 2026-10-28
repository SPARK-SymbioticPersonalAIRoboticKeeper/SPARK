param(
  [switch]$EnsureStarted
)

$ErrorActionPreference = 'Stop'
# Early startup exceptions were invisible from hidden Windows PowerShell. Persist a safe diagnostic.
trap {
  try {
    $earlyRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    $earlyLog=Join-Path $earlyRoot 'log\system\spark-tray.log'
    if(Test-Path -LiteralPath (Split-Path -Parent $earlyLog) -PathType Container){
      [IO.File]::AppendAllText($earlyLog,('[TRAY-CRASH] '+[DateTime]::UtcNow.ToString('o')+' '+$_.Exception.GetType().Name+': '+$_.Exception.Message+[Environment]::NewLine))
    }
  }catch{}
  break
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.Windows.Forms.dll', 'System.Drawing.dll') -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Reflection;
public static class SparkTrayNative {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool DestroyIcon(IntPtr handle);
}

public static class SparkTrayShellProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct NotifyIdentifier {
        public UInt32 cbSize;
        public IntPtr hWnd;
        public UInt32 uID;
        public Guid guidItem;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IconRect {
        public Int32 left;
        public Int32 top;
        public Int32 right;
        public Int32 bottom;
    }
    [DllImport("shell32.dll", ExactSpelling=true)]
    private static extern Int32 Shell_NotifyIconGetRect(ref NotifyIdentifier identifier, out IconRect rect);
    public static Int32 GetRegistrationState(NotifyIcon icon) {
        if (icon == null || !icon.Visible) return Int32.MinValue;
        var flags = BindingFlags.NonPublic | BindingFlags.Instance;
        var windowField = typeof(NotifyIcon).GetField("window", flags);
        var idField = typeof(NotifyIcon).GetField("id", flags);
        if (windowField == null || idField == null) return Int32.MinValue;
        var window = windowField.GetValue(icon) as NativeWindow;
        if (window == null || window.Handle == IntPtr.Zero) return Int32.MinValue;
        var key = new NotifyIdentifier {
            cbSize = (UInt32)Marshal.SizeOf(typeof(NotifyIdentifier)),
            hWnd = window.Handle,
            uID = Convert.ToUInt32(idField.GetValue(icon)),
            guidItem = Guid.Empty
        };
        IconRect rect;
        return Shell_NotifyIconGetRect(ref key, out rect);
    }
}
'@

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$runtime = Join-Path $root 'log\system'
$launcher = Join-Path $root 'out\SPARK.vbs'
$autostartScript = Join-Path $PSScriptRoot 'spark-autostart.ps1'
$exitRequest = Join-Path $runtime 'spark-tray-exit.request'
. (Join-Path $PSScriptRoot 'spark-log-path.ps1')
$logDir = Get-SparkLogDirectory -Root $root
$lifecycleLogPath = Join-Path $logDir 'spark-lifecycle.log'
$trayLogPath = Join-Path $logDir 'spark-tray.log'
$pidPath = Join-Path $runtime 'spark-tray.pid'
$iconPath = Join-Path $root 'doc\spark_icon1.png'
$configCandidates = @(
  (Join-Path $root '.runtime\config\spark.local.json')
)

New-Item -ItemType Directory -Path $runtime -Force | Out-Null

function Write-TrayLog([string]$Message) {
  try {
    Add-Content -LiteralPath $trayLogPath -Encoding UTF8 -Value ("[TRAY] {0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $Message) -ErrorAction Stop
  } catch {
    # Tray logging is best-effort. A locked/missing log must never crash the UI.
  }
}

function Get-HealthUrl {
  foreach ($candidate in $configCandidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $config = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
      $hostName = if ($config.transport.host) { [string]$config.transport.host } else { '127.0.0.1' }
      $urlHost = if ($hostName -eq '::1') { '[::1]' } else { $hostName }
      $port = if ($config.transport.port) { [int]$config.transport.port } else { 8765 }
      $healthPath = if ($config.transport.healthPath) { [string]$config.transport.healthPath } else { '/health' }
      return "http://${urlHost}:$port$healthPath"
    } catch {}
  }
  return 'http://127.0.0.1:8765/health'
}

$healthUrl = Get-HealthUrl

function Test-SparkRunning {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    return ($response.status -eq 'ok')
  } catch {
    return $false
  }
}

function Invoke-Lifecycle([string]$Action) {
  try {
    Write-TrayLog "$Action requested"
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = Join-Path $env:WINDIR 'System32\wscript.exe'
    $psi.Arguments = '"' + $launcher + '" ' + $Action
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    [void][System.Diagnostics.Process]::Start($psi)
  } catch {
    Write-TrayLog ("$Action launch failed: " + $_.Exception.Message)
    try {
      $notifyIcon.BalloonTipTitle = 'SPARK'
      $notifyIcon.BalloonTipText = "$Action could not be launched."
      $notifyIcon.ShowBalloonTip(3000)
    } catch {}
  }
}

function Open-LifecycleLog {
  try {
    if (-not (Test-Path -LiteralPath $lifecycleLogPath -PathType Leaf)) {
      [System.IO.File]::WriteAllText($lifecycleLogPath, '', [System.Text.UTF8Encoding]::new($false))
    }
    Start-Process notepad.exe -ArgumentList @($lifecycleLogPath)
  } catch {
    Write-TrayLog ("open log failed: " + $_.Exception.Message)
  }
}

function New-StatusIcon([System.Drawing.Color]$IndicatorColor) {
  if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    return ([System.Drawing.SystemIcons]::Application.Clone())
  }

  $source = $null
  $bitmap = $null
  $graphics = $null
  $brush = $null
  $outline = $null
  $rawIcon = [IntPtr]::Zero
  try {
    $source = [System.Drawing.Image]::FromFile($iconPath)
    $bitmap = [System.Drawing.Bitmap]::new(32, 32)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($source, 0, 0, 32, 32)

    $brush = [System.Drawing.SolidBrush]::new($IndicatorColor)
    $outline = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 1.5)
    $graphics.FillEllipse($brush, 20, 20, 11, 11)
    $graphics.DrawEllipse($outline, 20, 20, 11, 11)

    $rawIcon = $bitmap.GetHicon()
    return ([System.Drawing.Icon]::FromHandle($rawIcon).Clone())
  }
  finally {
    if ($rawIcon -ne [IntPtr]::Zero) { [void][SparkTrayNative]::DestroyIcon($rawIcon) }
    if ($outline) { $outline.Dispose() }
    if ($brush) { $brush.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ($source) { $source.Dispose() }
  }
}

$createdNew = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\SPARK.SimpleTray', [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  exit 0
}

$runningIcon = New-StatusIcon ([System.Drawing.Color]::LimeGreen)
$stoppedIcon = New-StatusIcon ([System.Drawing.Color]::IndianRed)
$notifyIcon = [System.Windows.Forms.NotifyIcon]::new()
$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$statusItem = [System.Windows.Forms.ToolStripMenuItem]::new('Status: Checking...')
$startItem = [System.Windows.Forms.ToolStripMenuItem]::new('Start')
$restartItem = [System.Windows.Forms.ToolStripMenuItem]::new('Restart')
$stopItem = [System.Windows.Forms.ToolStripMenuItem]::new('Stop')
$autoMenuItem = [System.Windows.Forms.ToolStripMenuItem]::new('AutoStart')
$autoOnItem = [System.Windows.Forms.ToolStripMenuItem]::new('ON')
$autoOffItem = [System.Windows.Forms.ToolStripMenuItem]::new('OFF')
$autoOnItem.CheckOnClick = $false
$autoOffItem.CheckOnClick = $false
[void]$autoMenuItem.DropDownItems.Add($autoOnItem)
[void]$autoMenuItem.DropDownItems.Add($autoOffItem)
$autoSeparator = [System.Windows.Forms.ToolStripSeparator]::new()
$openLogItem = [System.Windows.Forms.ToolStripMenuItem]::new('Open Log')
$exitItem = [System.Windows.Forms.ToolStripMenuItem]::new('Exit Tray')
$separator1 = [System.Windows.Forms.ToolStripSeparator]::new()
$separator2 = [System.Windows.Forms.ToolStripSeparator]::new()
$timer = [System.Windows.Forms.Timer]::new()
$lastRunning = $null
$lastRegistrationProbeUtc = [DateTime]::MinValue
$lastTrayHeartbeatUtc = [DateTime]::MinValue
$lastIconRepairUtc = [DateTime]::MinValue
$missingRegistrationChecks = 0
$registrationState = 'unchecked'

$statusItem.Enabled = $false
[void]$menu.Items.Add($statusItem)
[void]$menu.Items.Add($separator1)
[void]$menu.Items.Add($startItem)
[void]$menu.Items.Add($restartItem)
[void]$menu.Items.Add($stopItem)
[void]$menu.Items.Add($autoSeparator)
[void]$menu.Items.Add($autoMenuItem)
[void]$menu.Items.Add($separator2)
[void]$menu.Items.Add($openLogItem)
[void]$menu.Items.Add($exitItem)

$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Text = 'SPARK - Checking'
$notifyIcon.Icon = $stoppedIcon
$notifyIcon.Visible = $true

function Update-AutostartStatus {
  # Read the actual owned Startup shortcut; do not trust the current checkbox state.
  $autoOnItem.Checked = $false
  $autoOffItem.Checked = $false
  try {
    $state = (& $autostartScript -Action status | Out-String).Trim()
    if ($state -notmatch '^SPARK AUTOSTART (ON|OFF)(?:\s|$)') {
      throw 'AutoStart status is unavailable or the Startup entry is not owned by SPARK.'
    }
    $enabled = ($Matches[1] -eq 'ON')
    $autoOnItem.Checked = $enabled
    $autoOffItem.Checked = -not $enabled
    $autoOnItem.Enabled = $true
    $autoOffItem.Enabled = $true
    $autoMenuItem.ToolTipText = $(if ($enabled) { 'AutoStart ON (after Windows login)' } else { 'AutoStart OFF' })
  } catch {
    # A failure or conflicting startup entry must NOT be falsely shown as OFF.
    $autoOnItem.Enabled = $false
    $autoOffItem.Enabled = $false
    $autoMenuItem.ToolTipText = 'AutoStart status unavailable. See spark-tray.log.'
    Write-TrayLog ('autostart status failed: ' + $_.Exception.GetType().Name)
  }
}
function Set-AutostartMode([string]$mode) {
  try {
    if ($mode -notin @('on', 'off')) { throw 'Invalid AutoStart mode.' }
    $result = (& $autostartScript -Action $mode | Out-String).Trim()
    if ($result -notmatch ('^SPARK AUTOSTART ' + $mode.ToUpperInvariant() + '(?:\s|$)')) {
      throw 'AutoStart change could not be verified.'
    }
    Write-TrayLog ('autostart ' + $mode + ' result=' + $result)
  } catch {
    Write-TrayLog ('autostart ' + $mode + ' failed: ' + $_.Exception.Message)
    $notifyIcon.BalloonTipTitle = 'SPARK AutoStart'
    $notifyIcon.BalloonTipText = 'Could not change AutoStart. See spark-tray.log.'
    $notifyIcon.ShowBalloonTip(5000)
  }
  Update-AutostartStatus
}

function Update-Status {
  $running = Test-SparkRunning
  $changed = ($null -eq $script:lastRunning -or $script:lastRunning -ne $running)
  if ($running) {
    $statusItem.Text = 'Status: Running'
    $notifyIcon.Text = 'SPARK - Running'
    if ($changed) { $notifyIcon.Icon = $runningIcon }
    $startItem.Enabled = $false
    $restartItem.Enabled = $true
    $stopItem.Enabled = $true
  } else {
    $statusItem.Text = 'Status: Stopped'
    $notifyIcon.Text = 'SPARK - Stopped'
    if ($changed) { $notifyIcon.Icon = $stoppedIcon }
    $startItem.Enabled = $true
    $restartItem.Enabled = $false
    $stopItem.Enabled = $false
  }

  if ($null -eq $script:lastRunning -or $script:lastRunning -ne $running) {
    Write-TrayLog ("status=" + $(if ($running) { 'running' } else { 'stopped' }))
    $script:lastRunning = $running
  }
}

function Test-TrayShellRegistration {
  $now = [DateTime]::UtcNow
  $result = [int]::MinValue
  try { $result = [SparkTrayShellProbe]::GetRegistrationState($notifyIcon) }
  catch {
    $script:registrationState = 'probe-error'
    Write-TrayLog ("shell registration probe failed: " + $_.Exception.GetType().Name)
    return
  }

  # S_OK=0 (main taskbar) and S_FALSE=1 (overflow area) both mean registered.
  if ($result -eq [int]::MinValue) {
    $script:registrationState = 'probe-unsupported'
    $script:missingRegistrationChecks = 0
  } elseif ($result -ge 0) {
    $script:registrationState = $(if ($result -eq 0) { 'main' } else { 'overflow' })
    $script:missingRegistrationChecks = 0
  } else {
    $script:registrationState = 'missing'
    $script:missingRegistrationChecks++
    if ($script:missingRegistrationChecks -ge 2 -and
        ($now - $script:lastIconRepairUtc).TotalSeconds -ge 30) {
      $script:lastIconRepairUtc = $now
      Write-TrayLog ("icon missing from Windows Shell (HRESULT=$result); re-registering")
      try {
        $notifyIcon.Visible = $false
        $notifyIcon.Icon = $(if ($script:lastRunning) { $runningIcon } else { $stoppedIcon })
        $notifyIcon.Visible = $true
        $after = [SparkTrayShellProbe]::GetRegistrationState($notifyIcon)
        if ($after -ge 0) {
          $script:missingRegistrationChecks = 0
          $script:registrationState = 'recovered'
          Write-TrayLog ("icon registration recovered (HRESULT=$after)")
        } else {
          Write-TrayLog ("icon registration still unavailable (HRESULT=$after)")
        }
      } catch {
        Write-TrayLog ("icon registration refresh failed: " + $_.Exception.GetType().Name)
      }
    }
  }

  if (($now - $script:lastTrayHeartbeatUtc).TotalSeconds -ge 60) {
    $script:lastTrayHeartbeatUtc = $now
    Write-TrayLog ("heartbeat shell=" + $script:registrationState + " transport=" +
      $(if ($script:lastRunning) { 'running' } else { 'stopped' }))
  }
}

$startItem.Add_Click({ Invoke-Lifecycle 'start' })
$restartItem.Add_Click({ Invoke-Lifecycle 'restart' })
$stopItem.Add_Click({ Invoke-Lifecycle 'stop' })
$autoOnItem.Add_Click({ Set-AutostartMode 'on' })
$autoOffItem.Add_Click({ Set-AutostartMode 'off' })
$menu.Add_Opening({ Update-AutostartStatus })
$autoMenuItem.Add_DropDownOpening({ Update-AutostartStatus })
$openLogItem.Add_Click({ Open-LifecycleLog })
$notifyIcon.Add_DoubleClick({ Open-LifecycleLog })
$exitItem.Add_Click({
  Write-TrayLog 'tray exit requested'
  try { Set-Content -LiteralPath $exitRequest -Value ([DateTime]::UtcNow.ToString('o')) -Encoding ASCII -ErrorAction Stop } catch {
    Write-TrayLog ('exit request could not stop supervisor: ' + $_.Exception.GetType().Name)
  }
  $notifyIcon.Visible = $false
  $timer.Stop()
  [System.Windows.Forms.Application]::Exit()
})

$timer.Interval = 3000
$timer.Add_Tick({
  # A registered NotifyIcon can outlive its Shell entry. The WinForms default
  # TaskbarCreated handler covers Explorer restart, while this probe repairs
  # missed Shell_NotifyIcon registrations without restarting the ChatGPT app.
  try {
    Update-Status
    $now = [DateTime]::UtcNow
    if (($now - $script:lastRegistrationProbeUtc).TotalSeconds -ge 12) {
      $script:lastRegistrationProbeUtc = $now
      Test-TrayShellRegistration
    }
  } catch {
    Write-TrayLog ("tray tick failed: " + $_.Exception.GetType().Name)
  }
})
$timer.Start()

try {
  Set-Content -LiteralPath $pidPath -Encoding ASCII -Value $PID -ErrorAction Stop
} catch {
  Write-TrayLog ("pid file write failed: " + $_.Exception.Message)
}
Write-TrayLog "tray started pid=$PID health=$healthUrl"
Update-AutostartStatus
Update-Status
Test-TrayShellRegistration

if ($EnsureStarted -and -not (Test-SparkRunning)) {
  Invoke-Lifecycle 'start'
}

try {
  [System.Windows.Forms.Application]::Run()
}
finally {
  $timer.Stop()
  $notifyIcon.Visible = $false
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  $notifyIcon.Dispose()
  $menu.Dispose()
  $runningIcon.Dispose()
  $stoppedIcon.Dispose()
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
