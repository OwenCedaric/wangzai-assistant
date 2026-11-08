$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path -Parent $runtimeRoot) 'tools/owned-runtime.ps1')
$pidFile = Join-Path $runtimeRoot 'test-server.pid'
$localUrl = 'http://127.0.0.1:18000/health'
$publicUrl = $env:WANGZAI_TEST_PUBLIC_HEALTH_URL

$process = Get-OwnedRuntimeProcess -StatePath $pidFile
Write-Output "进程：$(if ($null -ne $process) { "运行中 PID=$($process.Id)" } else { '未运行' })"
foreach ($url in @($localUrl, $publicUrl) | Where-Object { $_ }) {
    try {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $health = Invoke-RestMethod -Uri $url -TimeoutSec 10
        $watch.Stop()
        Write-Output "$url 正常 $($watch.ElapsedMilliseconds)ms database=$($health.database)"
    } catch {
        Write-Output "$url 不可用：$($_.Exception.Message)"
    }
}
