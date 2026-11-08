$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path -Parent $runtimeRoot) 'tools/owned-runtime.ps1')
$pidFile = Join-Path $runtimeRoot 'test-server.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output '测试服务器未运行。'
    exit 0
}
$process = Get-OwnedRuntimeProcess -StatePath $pidFile
if ($process) {
    Stop-Process -Id $process.Id
    $process.WaitForExit(10000) | Out-Null
}
Remove-Item -LiteralPath $pidFile -Force
Write-Output '测试服务器已停止。'
