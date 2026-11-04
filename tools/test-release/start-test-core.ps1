param(
    [int]$Port = 18100,
    [int]$PublicPort = 10001
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
throw '旧 test-core-gateway 已禁用：该实现会在服务器创建 server-execution.sqlite，不符合薄客户端 V2。'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimeRoot = Join-Path $workspaceRoot 'artifacts\test-core-runtime'
$privateRoot = Join-Path $runtimeRoot 'private'
$logRoot = Join-Path $runtimeRoot 'logs'
$configPath = Join-Path $privateRoot 'test-core.config.json'
$pidFile = Join-Path $runtimeRoot 'gateway.pid'
$stdoutLog = Join-Path $logRoot 'gateway.stdout.log'
$stderrLog = Join-Path $logRoot 'gateway.stderr.log'
$gatewayScript = Join-Path $PSScriptRoot 'test-core-gateway.mjs'

New-Item -ItemType Directory -Force -Path $privateRoot, $logRoot | Out-Null
if (-not (Test-Path -LiteralPath $configPath)) {
    $clientId = 'wztest-' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
    [ordered]@{
        host = '127.0.0.1'
        port = $Port
        managementBaseUrl = 'http://127.0.0.1:18000'
        clientId = $clientId
        localApiRoot = (Join-Path $workspaceRoot 'local-api')
        runtimeRoot = $runtimeRoot
        workerPortStart = 18120
        workerPortEnd = 18219
        workerIdleMinutes = 60
        maxRequestBytes = 41943040
        publicUrl = "https://license.example.invalid:$PublicPort"
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $configPath -Encoding utf8
}

$config = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json
if ([int]$config.port -ne $Port) {
    throw "核心服务器配置端口与启动参数不一致：$($config.port) != $Port"
}
if (Test-Path -LiteralPath $pidFile) {
    $runningPid = [int](Get-Content -LiteralPath $pidFile -Raw -Encoding utf8)
    if (Get-Process -Id $runningPid -ErrorAction SilentlyContinue) {
        Write-Output "测试核心服务器已经运行，PID=$runningPid"
        exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$env:WANGZAI_TEST_CORE_CONFIG = $configPath
$process = Start-Process -FilePath $node `
    -ArgumentList @($gatewayScript) `
    -WorkingDirectory $workspaceRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding utf8

$healthUrl = "http://127.0.0.1:$Port/health"
for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($health.ok -eq $true -and $health.service -eq 'wangzai-test-core-gateway') {
            & tailscale.exe funnel --bg --yes "--https=$PublicPort" $healthUrl.Replace('/health', '') | Out-Null
            Write-Output "测试核心服务器已启动：$healthUrl PID=$($process.Id)"
            Write-Output "公网核心地址：$($config.publicUrl)"
            exit 0
        }
    } catch {
        if ($process.HasExited) { break }
    }
}

if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
throw "测试核心服务器启动失败，请查看：$stderrLog"
