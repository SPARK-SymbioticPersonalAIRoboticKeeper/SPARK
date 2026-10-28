# SPARK run logs use only an approved location: repo/log/<category> or an explicit external path.
# SPARK_LOG_DIR > private config logging.logDir > repo/log/system (user approved).
function Get-SparkLogDirectory {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Root, [switch]$InitializeApprovedDisposableState)

  $candidate = [string]$env:SPARK_LOG_DIR
  if (-not $candidate) {
    $configs = @()
    if ($env:SPARK_CONFIG) { $configs += [string]$env:SPARK_CONFIG }
    $configs += (Join-Path $Root '.runtime\config\spark.local.json')
    foreach ($configPath in $configs) {
      if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { continue }
      $config = Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      if ($config.logging -and $config.logging.logDir) {
        $candidate = [string]$config.logging.logDir
      }
      break
    }
  }

  if (-not $candidate) {
    $candidate = Join-Path $Root 'log\system'
  }

  if (-not [System.IO.Path]::IsPathRooted($candidate)) {
    throw 'logging.logDir / SPARK_LOG_DIR must be an absolute path.'
  }
  $full = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\', '/')
  $sourceRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $logRoot = Join-Path $sourceRoot 'log'
  $underRepo = $full -ieq $sourceRoot -or
    $full.StartsWith($sourceRoot + [System.IO.Path]::DirectorySeparatorChar,
      [System.StringComparison]::OrdinalIgnoreCase)
  $underAllowedLog = $full.StartsWith($logRoot + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase)
  if ($underRepo -and -not $underAllowedLog) {
    throw 'SPARK logs inside the source repository are allowed only under log/<category>.'
  }
  if ($InitializeApprovedDisposableState -and
      $full -ieq [System.IO.Path]::GetFullPath((Join-Path $sourceRoot 'log\system')).TrimEnd('\', '/')) {
    # Only the pre-approved disposable log directories may be recreated.
    # Persistent tunnel profiles and credentials remain in .runtime.
    $logParent = Join-Path $sourceRoot 'log'
    $made = @()
    foreach ($dir in @($logParent, $full)) {
      if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        if (Test-Path -LiteralPath $dir) { throw 'Approved log path is not a directory.' }
        New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
        $made += $dir
      }
      if (([System.IO.File]::GetAttributes($dir) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Approved log directory must not be a symlink or reparse point.'
      }
    }
    foreach ($dir in $made) {
      # Secure newly created log paths; never change ACLs of existing paths.
      $acl = Get-Acl -LiteralPath $dir
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($oldRule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($oldRule) }
      $principals = @(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
        [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
      )
      foreach ($principal in $principals) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
          $principal,
          [System.Security.AccessControl.FileSystemRights]::FullControl,
          ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
          [System.Security.AccessControl.PropagationFlags]::None,
          [System.Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
      }
      Set-Acl -LiteralPath $dir -AclObject $acl -ErrorAction Stop
      $actual = Get-Acl -LiteralPath $dir
      if (-not $actual.AreAccessRulesProtected) { throw 'New log directory ACL is not private.' }
    }
    # Never recreate durable audit or PAL recovery under disposable log/system.
    # The corresponding directories are provisioned under .runtime/data by init.
  }
  if (-not [System.IO.Directory]::Exists($full)) {
    throw 'Log directory must already exist: only the approved local log/system may be recreated at startup.'
  }
  return $full
}
