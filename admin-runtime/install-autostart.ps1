$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$startupRoot = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupRoot 'License Center 管理后台.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = (Get-Command powershell.exe).Source
$shortcut.Arguments = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $runtimeRoot 'start-admin-frontend.ps1')`""
$shortcut.WorkingDirectory = $runtimeRoot
$shortcut.Description = '登录 Windows 后启动 License Center 管理后台'
$shortcut.Save()
Write-Output "管理后台自动启动已安装：$shortcutPath"
