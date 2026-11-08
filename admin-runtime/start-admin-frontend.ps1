param(
    [int]$Port = 5174
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path -Parent $runtimeRoot) 'tools/owned-runtime.ps1')
$managementRoot = Split-Path -Parent $runtimeRoot
$frontendRoot = Join-Path $managementRoot 'admin'
$viteEntry = Join-Path $frontendRoot 'node_modules\vite\bin\vite.js'
$pidFile = Join-Path $runtimeRoot 'admin-frontend.pid'
$logRoot = Join-Path $runtimeRoot 'logs'
$stdoutLog = Join-Path $logRoot 'admin-frontend.stdout.log'
$stderrLog = Join-Path $logRoot 'admin-frontend.stderr.log'
$healthUrl = "http://127.0.0.1:$Port/"

if (-not (Test-Path -LiteralPath $viteEntry -PathType Leaf)) {
    throw "Vite 入口不存在，请先在 frontend 目录运行 npm install：$viteEntry"
}

$recordedProcess = Get-OwnedRuntimeProcess -StatePath $pidFile
try {
    $existing = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
    if ($existing.StatusCode -eq 200 -and $null -ne $recordedProcess) {
        Write-Output "管理后台已经运行：$healthUrl"
        exit 0
    }
} catch {
    # 没有健康的页面服务时继续启动。
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    throw "端口 $Port 已被 PID=$($listener.OwningProcess) 占用，但管理后台健康检查失败。"
}

if (Test-Path -LiteralPath $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$process = Start-Process -FilePath $node `
    -ArgumentList @(('"' + $viteEntry + '"'), '--host' , '127.0.0.1', '--port', [string]$Port) `
    -WorkingDirectory $frontendRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
Save-OwnedRuntimeProcess -Process $process -StatePath $pidFile

for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            Write-Output "管理后台已启动：$healthUrl PID=$($process.Id)"
            exit 0
        }
    } catch {
        if ($process.HasExited) { break }
    }
}

if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
throw "管理后台启动失败，请查看：$stderrLog"
