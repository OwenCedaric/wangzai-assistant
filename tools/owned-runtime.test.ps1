$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'owned-runtime.ps1')
$fixtureDirectory = Join-Path ([IO.Path]::GetTempPath()) ('wangzai-runtime-test-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $fixtureDirectory)
$stateFile = Join-Path $fixtureDirectory 'owner.pid'
$copiedFile = Join-Path $fixtureDirectory 'copied.pid'
try {
    $fixtureProcess = Get-Process -Id $PID
    Save-OwnedRuntimeProcess -Process $fixtureProcess -StatePath $stateFile
    $verified = Get-OwnedRuntimeProcess -StatePath $stateFile
    if ($verified.Id -ne $fixtureProcess.Id) { throw 'Current process identity did not round-trip' }
    Copy-Item -LiteralPath $stateFile -Destination $copiedFile
    $rejected = $false
    try { Get-OwnedRuntimeProcess -StatePath $copiedFile | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Copied process record was accepted for a different runtime' }
    $record = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $record.startedAtTicks = '0'
    $record | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    $rejected = $false
    try { Get-OwnedRuntimeProcess -StatePath $stateFile | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Reused PID record was accepted' }
    Write-Output 'PASS: process identity, record scope, reused PID rejection; no process stopped.'
} finally {
    foreach ($fixtureFile in @($stateFile, $copiedFile)) {
        if (Test-Path -LiteralPath $fixtureFile) { Remove-Item -LiteralPath $fixtureFile }
    }
    Remove-Item -LiteralPath $fixtureDirectory
}
