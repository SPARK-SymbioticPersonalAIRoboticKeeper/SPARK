# Persistent application data is separate from SPARK source, secrets and logs.
# Uses the Windows per-user app-data root; never creates .runtime/data or log/recovery.
function Get-SparkUserDataRoot {
  param([Parameter(Mandatory = $true)][string]$SourceRoot)
  $candidate = if ($env:SPARK_DATA_DIR) { $env:SPARK_DATA_DIR } else {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required for private SPARK application data.' }
    Join-Path $env:LOCALAPPDATA 'SPARK'
  }
  if (-not [IO.Path]::IsPathRooted($candidate)) { throw 'SPARK_DATA_DIR must be an absolute path.' }
  $full = [IO.Path]::GetFullPath($candidate).TrimEnd('\', '/')
  $source = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\', '/')
  if ($full -ieq $source -or $full.StartsWith(($source + '\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'SPARK data must be outside the source repository and outside .runtime or log.'
  }
  return $full
}

function Initialize-SparkUserData {
  param([Parameter(Mandatory = $true)][string]$SourceRoot)
  $dir = Get-SparkUserDataRoot -SourceRoot $SourceRoot
  if (Test-Path -LiteralPath $dir) {
    $entry = Get-Item -LiteralPath $dir -Force
    if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Existing SPARK user-data path is not a real directory.'
    }
  } else {
    New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
    $acl = Get-Acl -LiteralPath $dir
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($entry) }
    foreach ($principal in @(
      [Security.Principal.WindowsIdentity]::GetCurrent().User,
      [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
      [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    )) {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $principal, [Security.AccessControl.FileSystemRights]::FullControl,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $dir -AclObject $acl -ErrorAction Stop
  }
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($part in @($dir) + @(@('chatlog','audit','ui-state','route-recordings') | ForEach-Object { Join-Path $dir $_ })) {
    if (Test-Path -LiteralPath $part) {
      $item = Get-Item -LiteralPath $part -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Invalid SPARK user-data directory or reparse point.'
      }
    } else {
      New-Item -ItemType Directory -Path $part -ErrorAction Stop | Out-Null
    }
    $acl = Get-Acl -LiteralPath $part
    foreach ($rule in $acl.Access) {
      try { $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
      catch { throw 'Unresolvable identity in SPARK private data ACL.' }
      if ($allowed -notcontains $sid) { throw 'SPARK user-data ACL is not private.' }
    }
  }
  return $dir
}
