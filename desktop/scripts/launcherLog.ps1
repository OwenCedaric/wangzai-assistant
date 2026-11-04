# This helper only owns the two current-source launcher logs and their numbered
# rotation slots. It must never discover or clean any other workspace files.
$script:launcherLogUnavailable = $false

function Write-LauncherLogSafely {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [AllowEmptyString()][string]$Message
  )

  if ($script:launcherLogUnavailable) { return }
  try {
    Add-RotatingLauncherLog -LiteralPath $LiteralPath -Message $Message
  } catch {
    # Diagnostics are best-effort. Disk-full, file locks or unsafe paths must
    # not change the command's exit code or prevent the application starting.
    $script:launcherLogUnavailable = $true
    Write-Warning 'Launcher diagnostic log unavailable; startup will continue.'
  }
}

function Add-RotatingLauncherLog {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [AllowEmptyString()][string]$Message,
    [ValidateRange(4, 1073741824)][int]$MaximumBytes = 8MB,
    [ValidateRange(1, 10)][int]$RotationCount = 3
  )

  $resolvedLog = [System.IO.Path]::GetFullPath($LiteralPath)
  $logName = [System.IO.Path]::GetFileName($resolvedLog)
  if ($logName -notin @('current-source-launch.log', 'current-source-smoke.log')) {
    throw 'LAUNCHER_LOG_TARGET_FORBIDDEN'
  }
  $logDirectory = [System.IO.Path]::GetDirectoryName($resolvedLog)
  if (-not [System.IO.Directory]::Exists($logDirectory)) {
    throw 'LAUNCHER_LOG_DIRECTORY_MISSING'
  }

  $encoding = [System.Text.UTF8Encoding]::new($false)
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $mutexKey = [System.BitConverter]::ToString(
      $hasher.ComputeHash($encoding.GetBytes($resolvedLog.ToLowerInvariant()))
    ).Replace('-', '')
  } finally {
    $hasher.Dispose()
  }
  # The visible first stage and hidden second stage can write the same log.
  $mutex = [System.Threading.Mutex]::new($false, "Local\WangzaiLauncherLog-$mutexKey")
  $acquired = $false
  try {
    try { $acquired = $mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] {
      $acquired = $true
    }
    if (-not $acquired) { throw 'LAUNCHER_LOG_LOCK_TIMEOUT' }

    # Recheck exact paths under the mutex. Do not follow junctions/symlinks to
    # external data when rotating or appending one of these managed files.
    $directoryToCheck = $logDirectory
    while ($directoryToCheck) {
      $attributes = [System.IO.File]::GetAttributes($directoryToCheck)
      if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'LAUNCHER_LOG_REPARSE_POINT_FORBIDDEN'
      }
      $directoryToCheck = [System.IO.Path]::GetDirectoryName($directoryToCheck)
    }
    $managedPaths = @($resolvedLog)
    for ($slot = 1; $slot -le $RotationCount; $slot++) {
      $managedPaths += "$resolvedLog.$slot"
    }
    foreach ($managedPath in $managedPaths) {
      if (Test-Path -LiteralPath $managedPath) {
        $attributes = [System.IO.File]::GetAttributes($managedPath)
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
          ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
          throw 'LAUNCHER_LOG_MANAGED_PATH_INVALID'
        }
      }
    }

    $bytes = $encoding.GetBytes($Message + [System.Environment]::NewLine)
    for ($offset = 0; $offset -lt $bytes.Length;) {
      $end = [math]::Min($offset + $MaximumBytes, $bytes.Length)
      while ($end -lt $bytes.Length -and ($bytes[$end] -band 0xC0) -eq 0x80) {
        $end--
      }
      $count = $end - $offset
      $currentBytes = if ([System.IO.File]::Exists($resolvedLog)) {
        ([System.IO.FileInfo]::new($resolvedLog)).Length
      } else { 0 }
      if ($currentBytes -gt 0 -and $currentBytes + $count -gt $MaximumBytes) {
        [System.IO.File]::Delete("$resolvedLog.$RotationCount")
        for ($slot = $RotationCount - 1; $slot -ge 1; $slot--) {
          $source = "$resolvedLog.$slot"
          if ([System.IO.File]::Exists($source)) {
            [System.IO.File]::Move($source, "$resolvedLog.$($slot + 1)")
          }
        }
        [System.IO.File]::Move($resolvedLog, "$resolvedLog.1")
      }
      $stream = [System.IO.File]::Open(
        $resolvedLog,
        [System.IO.FileMode]::Append,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::Read
      )
      try { $stream.Write($bytes, $offset, $count) } finally { $stream.Dispose() }
      $offset = $end
    }
  } finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
