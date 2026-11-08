$ErrorActionPreference = "Stop"

$drive = $PSScriptRoot.Substring(0, 1).ToLowerInvariant()
$pathWithoutDrive = $PSScriptRoot.Substring(2).Replace('\', '/')
$linuxDeploy = "/mnt/$drive$pathWithoutDrive"

& wsl.exe -d Debian -u root --cd $linuxDeploy -- `
    docker compose stop
if ($LASTEXITCODE -ne 0) {
    throw "Jeepay failed to stop cleanly"
}

$pidFile = Join-Path $PSScriptRoot ".keepalive.pid"
if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile -Encoding utf8)
    $savedProcess = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
    if ($null -ne $savedProcess -and $savedProcess.ProcessName -eq "wsl") {
        Stop-Process -Id $savedPid
    }
    Remove-Item -LiteralPath $pidFile
}
