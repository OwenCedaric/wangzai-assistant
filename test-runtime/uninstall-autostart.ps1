$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) '旺崽测试服务器.lnk'
Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
Write-Output '旺崽测试服务器自动启动已移除。'
