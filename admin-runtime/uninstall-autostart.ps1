$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'License Center 管理后台.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Output "管理后台自动启动已卸载：$shortcutPath"
} else {
    Write-Output '管理后台自动启动未安装。'
}
