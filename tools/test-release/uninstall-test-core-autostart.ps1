$ErrorActionPreference = 'Stop'
$startupRoot = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupRoot '旺崽测试核心服务器.lnk'
Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
Write-Output '测试核心服务器自动启动已卸载。'
