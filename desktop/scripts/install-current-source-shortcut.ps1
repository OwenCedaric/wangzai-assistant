param(
  [string]$ShortcutPath,
  [switch]$KeepLegacyShortcut
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$desktopRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $desktopRoot
$electronExecutable = Join-Path $desktopRoot 'node_modules\electron\dist\electron.exe'
$profileLauncher = Join-Path $PSScriptRoot 'launch-current-source.ps1'
$identityPath = Join-Path $desktopRoot 'current-version.json'
$identity = Get-Content -LiteralPath $identityPath -Raw -Encoding utf8 | ConvertFrom-Json
$actualWorkspaceName = Split-Path -Leaf $workspaceRoot
if ($actualWorkspaceName -ne [string]$identity.workspaceFolderName) {
  throw "禁止为错误版本创建快捷方式。当前目录：$workspaceRoot"
}
$powerShellExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$iconPath = Join-Path $desktopRoot 'resources\icon.ico'

if (-not $ShortcutPath) {
  $ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) '旺崽助手.lnk'
}

if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
  throw "Electron 可执行文件不存在：$electronExecutable"
}

if (-not (Test-Path -LiteralPath $profileLauncher -PathType Leaf)) {
  throw "当前 Profile 启动器不存在：$profileLauncher"
}

if (-not (Test-Path -LiteralPath $powerShellExecutable -PathType Leaf)) {
  throw "Windows PowerShell 不存在：$powerShellExecutable"
}

if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
  throw "旺崽助手图标不存在：$iconPath"
}

$shortcutDirectory = Split-Path -Parent $ShortcutPath
if (-not (Test-Path -LiteralPath $shortcutDirectory -PathType Container)) {
  New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $powerShellExecutable
$shortcut.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $profileLauncher + '"'
$shortcut.WorkingDirectory = $desktopRoot
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = "旺崽助手 $($identity.displayVersion)（$workspaceRoot）"
$shortcut.WindowStyle = 1
$shortcut.Save()

if (-not $KeepLegacyShortcut) {
  Get-ChildItem -LiteralPath $shortcutDirectory -Filter '*.lnk' -File | ForEach-Object {
    if ($_.FullName -eq $ShortcutPath) {
      return
    }
    $candidate = $shell.CreateShortcut($_.FullName)
    $candidateTarget = [string]$candidate.TargetPath
    $candidateArguments = [string]$candidate.Arguments
    $isDuplicateCurrentProfileShortcut =
      $candidateTarget -eq $powerShellExecutable -and
      $candidateArguments -eq $shortcut.Arguments
    $isWrongDirectElectronShortcut =
      $candidateTarget -eq $electronExecutable -and
      $candidateArguments -eq ('"' + $desktopRoot + '"')
    $isLegacyPowerShellShortcut =
      [System.IO.Path]::GetFileName($candidateTarget) -ieq 'powershell.exe' -and
      $candidateArguments -like '*launch-current-source.ps1*'
    if ($isDuplicateCurrentProfileShortcut -or $isWrongDirectElectronShortcut -or $isLegacyPowerShellShortcut) {
      Remove-Item -LiteralPath $_.FullName -Force
    }
  }
}

[pscustomobject]@{
  ok = $true
  shortcut = $ShortcutPath
  target = $powerShellExecutable
  arguments = $shortcut.Arguments
  workingDirectory = $desktopRoot
  edition = [string]$identity.editionId
  version = [string]$identity.displayVersion
  dataRoot = Join-Path $workspaceRoot ([string]$identity.sourceDataDirectory)
  localApiPort = [int]$identity.ports.localApi
  consoleWindow = $false
} | ConvertTo-Json -Compress
