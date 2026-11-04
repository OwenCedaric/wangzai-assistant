$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
throw '旧测试核心自启动已禁用。V2 统一使用管理系统无状态能力接口。'
$startupRoot = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupRoot '旺崽测试核心服务器.lnk'
$startScript = Join-Path $PSScriptRoot 'start-test-core.ps1'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = (Get-Command powershell.exe).Source
$shortcut.Arguments = "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = '登录 Windows 后启动旺崽薄客户端核心服务器与公网入口'
$shortcut.Save()
Write-Output "测试核心服务器自动启动已安装：$shortcutPath"
