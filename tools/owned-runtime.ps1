Set-StrictMode -Version Latest

function Save-OwnedRuntimeProcess {
    param([Parameter(Mandatory)]$Process, [Parameter(Mandatory)][string]$StatePath)
    $Process.Refresh()
    $record = @{
        version = 1
        processId = $Process.Id
        startedAtTicks = [string]$Process.StartTime.ToUniversalTime().Ticks
        executablePath = $Process.Path
        statePath = [IO.Path]::GetFullPath($StatePath)
    }
    $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Get-OwnedRuntimeProcess {
    param([Parameter(Mandatory)][string]$StatePath)
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
    $record = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($record.version -ne 1 -or $record.statePath -ne [IO.Path]::GetFullPath($StatePath)) {
        throw '运行记录不是本脚本创建的记录；请人工确认旧进程，不会自动停止。'
    }
    $ownedProcess = Get-Process -Id ([int]$record.processId) -ErrorAction SilentlyContinue
    if ($null -eq $ownedProcess) { return $null }
    if ([string]$ownedProcess.StartTime.ToUniversalTime().Ticks -ne $record.startedAtTicks -or
        $ownedProcess.Path -ne $record.executablePath) {
        throw 'PID 已被其他进程使用，拒绝操作该进程。'
    }
    return $ownedProcess
}
