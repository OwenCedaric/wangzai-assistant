param(
    [int]$Port = 18000
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path -Parent $runtimeRoot) 'tools/owned-runtime.ps1')
$managementRoot = Split-Path -Parent $runtimeRoot
$backendRoot = Join-Path $managementRoot 'server'
$python = Join-Path $backendRoot '.venv\Scripts\pythonw.exe'
$database = Join-Path $runtimeRoot 'data\license_center_test.sqlite3'
$pidFile = Join-Path $runtimeRoot 'test-server.pid'
$logRoot = Join-Path $runtimeRoot 'logs'
$stdoutLog = Join-Path $logRoot 'test-server.stdout.log'
$stderrLog = Join-Path $logRoot 'test-server.stderr.log'

if (-not (Test-Path -LiteralPath $database -PathType Leaf)) {
    throw '测试数据库不存在，请先运行 scripts\prepare_test_database.py。'
}
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    throw "后端 Python 不存在：$python"
}
if (Test-Path -LiteralPath $pidFile) {
    $existingProcess = Get-OwnedRuntimeProcess -StatePath $pidFile
    if ($null -ne $existingProcess) {
        Write-Output "测试服务器已经运行，PID=$($existingProcess.Id)"
        exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw '测试服务端口已被其他进程占用，拒绝把其他服务当作启动成功。'
}
$env:DATABASE_URL = 'sqlite:///' + ($database -replace '\\', '/')
$env:TRUSTED_HOSTS = 'localhost,127.0.0.1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

$process = Start-Process -FilePath $python `
    -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', [string]$Port) `
    -WorkingDirectory $backendRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
Save-OwnedRuntimeProcess -Process $process -StatePath $pidFile

$healthUrl = "http://127.0.0.1:$Port/health"
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($health.status -eq 'ok' -and $health.database -eq 'ok') {
            Write-Output "测试服务器已启动：$healthUrl PID=$($process.Id)"
            exit 0
        }
    } catch {
        if ($process.HasExited) { break }
    }
}

if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
throw "测试服务器启动失败，请查看：$stderrLog"
