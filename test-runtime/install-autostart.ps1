$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$startupRoot = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupRoot '旺崽测试服务器.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = (Get-Command powershell.exe).Source
$shortcut.Arguments = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $runtimeRoot 'start-test-server.ps1')`""
$shortcut.WorkingDirectory = $runtimeRoot
$shortcut.Description = '登录 Windows 后启动旺崽隔离测试服务器'
$shortcut.Save()
Write-Output "自动启动已安装：$shortcutPath"
