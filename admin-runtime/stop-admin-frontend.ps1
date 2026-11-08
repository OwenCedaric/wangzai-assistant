$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path -Parent $runtimeRoot) 'tools/owned-runtime.ps1')
$pidFile = Join-Path $runtimeRoot 'admin-frontend.pid'

if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    Write-Output '管理后台没有 PID 记录。'
    exit 0
}

$process = Get-OwnedRuntimeProcess -StatePath $pidFile
if ($process) {
    Stop-Process -Id $process.Id -Force
    Write-Output "管理后台已停止：PID=$($process.Id)"
} else {
    Write-Output "管理后台进程已经结束：PID=$($process.Id)"
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
