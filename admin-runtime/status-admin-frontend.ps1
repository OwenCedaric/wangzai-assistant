param(
    [int]$Port = 5174
)

$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path -Parent $runtimeRoot) 'tools/owned-runtime.ps1')
$url = "http://127.0.0.1:$Port/"
$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue

try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    Write-Output "状态：正常 HTTP=$($response.StatusCode) URL=$url PID=$($listener.OwningProcess)"
    exit 0
} catch {
    Write-Output "状态：不可用 URL=$url"
    exit 1
}
