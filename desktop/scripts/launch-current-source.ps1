param(
  [switch]$SmokeTest,
  [switch]$BackgroundLauncher,
  [switch]$ForceBuild
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$desktopRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $desktopRoot
$frontendRoot = Join-Path $workspaceRoot 'frontend'
$frontendDistRoot = Join-Path $frontendRoot 'dist'
$frontendIndexPath = Join-Path $frontendDistRoot 'index.html'
$electronExecutable = Join-Path $desktopRoot 'node_modules\electron\dist\electron.exe'
$identityPath = Join-Path $desktopRoot 'current-version.json'
$identity = Get-Content -LiteralPath $identityPath -Raw -Encoding utf8 | ConvertFrom-Json
$actualWorkspaceName = Split-Path -Leaf $workspaceRoot
if ($actualWorkspaceName -ne [string]$identity.workspaceFolderName) {
  throw "禁止从错误版本启动。当前目录：$workspaceRoot；要求目录：$($identity.workspaceFolderName)"
}
$dataRoot = Join-Path $workspaceRoot ([string]$identity.sourceDataDirectory)
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
$env:WANGZAI_DESKTOP_DATA_DIR = $dataRoot
$env:PURCHASE_SEARCH_BRIDGE_PORT = [string]$identity.ports.purchaseBridge
$env:LOCAL_API_PORT = [string]$identity.ports.localApi
$env:WANGZAI_CACHE_AGENT_PORT = [string]$identity.ports.cacheAgent
$env:WANGZAI_OZON_PUSH_GATEWAY_PORT = [string]$identity.ports.ozonPushGateway
$env:WANGZAI_CURRENT_EDITION_ID = [string]$identity.editionId
# Local startup compatibility: native browser prewarm reproduced an access
# violation on this host. Keep user-requested browser opens, not eager startup.
$env:WANGZAI_BROWSER_PREWARM_DISABLED = '1'
$logPath = Join-Path $desktopRoot $(if ($SmokeTest) { 'current-source-smoke.log' } else { 'current-source-launch.log' })
. (Join-Path $PSScriptRoot 'launcherLog.ps1')

function Write-LaunchLog {
  param([string]$Message)

  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
  Write-LauncherLogSafely -LiteralPath $logPath -Message "[$timestamp] $Message"
}

function Start-ManagedDevScratchCleanup {
  try {
    # Optional development-only maintenance, after Electron has been launched.
    # Never invoke the retired broad workspace cleanup or scan legacy folders.
    $managedRoot = Join-Path $workspaceRoot '.managed-dev-scratch'
    if (-not (Test-Path -LiteralPath $managedRoot -PathType Container)) { return }
    $managerScript = Join-Path $workspaceRoot 'tools\managed-dev-scratch-cli.mjs'
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand -or -not (Test-Path -LiteralPath $managerScript -PathType Leaf)) { return }
    Start-Process -FilePath $nodeCommand.Source -ArgumentList @(
      ('"' + $managerScript + '"'), 'cleanup', '--apply', '--automatic'
    ) -WorkingDirectory $workspaceRoot -WindowStyle Hidden | Out-Null
  } catch {
    Write-LaunchLog 'Managed development scratch maintenance was deferred; application startup is unaffected.'
  }
}

function Start-HiddenBackgroundLauncher {
  $powerShellExecutable = (Get-Process -Id $PID).Path
  if (-not $powerShellExecutable) {
    $powerShellExecutable = Join-Path $PSHOME 'powershell.exe'
  }

  $scriptArgument = '"' + $PSCommandPath + '"'
  $arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    $scriptArgument,
    '-BackgroundLauncher'
  )
  if ($ForceBuild) {
    $arguments += '-ForceBuild'
  }

  Start-Process `
    -FilePath $powerShellExecutable `
    -ArgumentList $arguments `
    -WorkingDirectory $desktopRoot `
    -WindowStyle Hidden | Out-Null
}

# The desktop shortcut still points at PowerShell. Hand normal launches to a
# hidden second stage immediately so Windows Terminal does not remain visible
# while a conditional frontend build or the desktop application is running.
if (-not $SmokeTest -and -not $BackgroundLauncher) {
  try {
    Write-LaunchLog "当前版本：$($identity.displayVersion)；源码：$workspaceRoot；数据：$dataRoot"
    Start-HiddenBackgroundLauncher
    exit 0
  } catch {
    $message = $_.Exception.Message
    Write-LaunchLog "隐藏启动器创建失败：$message"
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
      "旺崽助手启动失败。`n`n$message`n`n日志：$logPath",
      '旺崽助手启动失败'
    ) | Out-Null
    exit 1
  }
}

# FROZEN-FOR-REMOVAL: the old current-source launcher overrode the desktop
# profile with workspace JSON/SQLite paths. That produced a second profit
# ledger cache, so the same application could show an empty order list after
# switching launch modes. Keep the marker for the later cleanup pass, but do
# not activate that data path again. Current-source and packaged launches now
# derive JSON/SQLite paths from the same desktop profile root.
$legacyWorkspaceDataOverrideState = 'frozen-for-removal'
Remove-Item Env:WANGZAI_DESKTOP_LOCAL_DATA_DIR -ErrorAction SilentlyContinue
Remove-Item Env:LOCAL_API_DB_PATH -ErrorAction SilentlyContinue

function Invoke-LoggedCommand {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList
  )

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $FilePath @ArgumentList 2>&1 | ForEach-Object {
      Write-LauncherLogSafely -LiteralPath $logPath -Message ([string]$_)
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($null -eq $exitCode) {
    return 1
  }
  return $exitCode
}

function Test-FrontendDistributionCurrent {
  param([switch]$SkipSourceFreshness)
  if (-not (Test-Path -LiteralPath $frontendIndexPath -PathType Leaf)) {
    return $false
  }

  $indexFile = Get-Item -LiteralPath $frontendIndexPath
  if ($indexFile.Length -lt 100) {
    return $false
  }

  $indexContents = Get-Content -LiteralPath $frontendIndexPath -Raw -Encoding utf8
  if ($indexContents -notmatch '<script[^>]+src=["''][^"'']+assets/') {
    return $false
  }

  $assetReferences = [regex]::Matches(
    $indexContents,
    '(?:src|href)=["''](?<path>/(?:assets/[^"''?#]+|favicon\.png))["'']'
  )
  foreach ($assetReference in $assetReferences) {
    $relativePath = $assetReference.Groups['path'].Value.TrimStart('/').Replace(
      '/',
      [System.IO.Path]::DirectorySeparatorChar
    )
    if (-not (Test-Path -LiteralPath (Join-Path $frontendDistRoot $relativePath) -PathType Leaf)) {
      return $false
    }
  }

  if (-not $SkipSourceFreshness) {
    $buildTimestamp = $indexFile.LastWriteTimeUtc
    $sourceDirectories = @(
      (Join-Path $frontendRoot 'src'),
      (Join-Path $frontendRoot 'public')
    )
    foreach ($sourceDirectory in $sourceDirectories) {
      if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
        continue
      }

      $newerSource = Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse | Where-Object {
        $_.FullName -notmatch '(?i)[\\/](?:__tests__|test|tests|fixtures?)[\\/]' -and
        $_.Name -notmatch '(?i)\.(?:test|spec)\.[^.]+$' -and
        $_.LastWriteTimeUtc -gt $buildTimestamp
      } | Select-Object -First 1
      if ($newerSource) {
        return $false
      }
    }

    $rootBuildInputs = @(
      'index.html',
      'localDataPlugin.js',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.node.json',
      'vite.config.js',
      '.env',
      '.env.local',
      '.env.production',
      '.env.production.local'
    )
    foreach ($inputName in $rootBuildInputs) {
      $inputPath = Join-Path $frontendRoot $inputName
      if (
        (Test-Path -LiteralPath $inputPath -PathType Leaf) -and
        (Get-Item -LiteralPath $inputPath).LastWriteTimeUtc -gt $buildTimestamp
      ) {
        return $false
      }
    }
  }

  return $true
}

try {
  Set-Location -LiteralPath $desktopRoot
  Write-LaunchLog "旧工作区数据覆盖链路：$legacyWorkspaceDataOverrideState"
  Write-LaunchLog "当前版本：$($identity.displayVersion)；版本标识：$($identity.editionId)"
  Write-LaunchLog "固定端口：bridge=$($identity.ports.purchaseBridge) local-api=$($identity.ports.localApi) cache=$($identity.ports.cacheAgent) push=$($identity.ports.ozonPushGateway)"
  Write-LaunchLog '本地文件与 SQLite 数据源：当前桌面 profile'

  $distributionCurrent = Test-FrontendDistributionCurrent
  if ($ForceBuild -or -not $distributionCurrent) {
    $buildReason = if ($ForceBuild) { '已请求强制构建' } else { '前端源码较新或现有产物不可用' }
    Write-LaunchLog "开始构建前端：$buildReason。"
    $buildExitCode = Invoke-LoggedCommand -FilePath 'npm.cmd' -ArgumentList @('run', 'build:frontend')
    if ($buildExitCode -ne 0) {
      throw "前端构建失败，退出码：$buildExitCode"
    }
    # Source files can be touched by a formatter/sync process while Vite is
    # writing dist. The post-build check validates the generated asset graph;
    # source freshness is checked on the next launch, not against a build that
    # has already completed successfully.
    if (-not (Test-FrontendDistributionCurrent -SkipSourceFreshness)) {
      throw '前端构建结束，但产物完整性检查未通过。'
    }
    Write-LaunchLog '前端构建完成。'
  } else {
    Write-LaunchLog '前端产物可直接使用，跳过重复构建。'
  }

  if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
    throw "Electron 可执行文件不存在：$electronExecutable"
  }

  if ($SmokeTest) {
    Write-LaunchLog '开始同步执行源码冒烟测试。'
    $desktopExitCode = Invoke-LoggedCommand `
      -FilePath $electronExecutable `
      -ArgumentList @('.', '--smoke-test')
    if ($desktopExitCode -ne 0) {
      throw "桌面端冒烟测试退出异常，退出码：$desktopExitCode"
    }
    Write-LaunchLog '桌面端源码冒烟测试通过。'
  } else {
    $desktopProcess = Start-Process `
      -FilePath $electronExecutable `
      -ArgumentList @('.') `
      -WorkingDirectory $desktopRoot `
      -WindowStyle Hidden `
      -PassThru
    Write-LaunchLog "Electron 已脱离启动器运行，进程号：$($desktopProcess.Id)。"
    Start-ManagedDevScratchCleanup
  }
} catch {
  $message = $_.Exception.Message
  Write-LaunchLog "启动失败：$message"
  Add-Type -AssemblyName PresentationFramework
  $dialogMessage = "旺崽助手当前源码启动失败。`n`n$message`n`n日志：$logPath"
  [System.Windows.MessageBox]::Show($dialogMessage, '旺崽助手启动失败') | Out-Null
  exit 1
}
