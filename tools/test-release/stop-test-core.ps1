$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$pidFile = Join-Path $workspaceRoot 'artifacts\test-core-runtime\gateway.pid'
if (Test-Path -LiteralPath $pidFile) {
    $runningPid = [int](Get-Content -LiteralPath $pidFile -Raw -Encoding utf8)
    if (Get-Process -Id $runningPid -ErrorAction SilentlyContinue) {
        Stop-Process -Id $runningPid -Force
    }
    Remove-Item -LiteralPath $pidFile -Force
}
Write-Output '测试核心服务器已停止。'
