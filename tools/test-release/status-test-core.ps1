$ErrorActionPreference = 'Continue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimeRoot = Join-Path $workspaceRoot 'artifacts\test-core-runtime'
$pidFile = Join-Path $runtimeRoot 'gateway.pid'
$configPath = Join-Path $runtimeRoot 'private\test-core.config.json'
$pidValue = if (Test-Path -LiteralPath $pidFile) { [int](Get-Content -LiteralPath $pidFile -Raw -Encoding utf8) } else { 0 }
$running = $pidValue -gt 0 -and [bool](Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
try { $local = Invoke-RestMethod -Uri 'http://127.0.0.1:18100/health' -TimeoutSec 3 } catch { $local = $null }
try { $public = Invoke-RestMethod -Uri 'https://license.example.invalid:10001/health' -TimeoutSec 10 } catch { $public = $null }
[pscustomobject]@{
    Running = $running
    ProcessId = $pidValue
    ConfigPresent = Test-Path -LiteralPath $configPath
    LocalHealthy = $local.ok -eq $true
    PublicHealthy = $public.ok -eq $true
    ActiveWorkers = $local.workers
} | Format-List
