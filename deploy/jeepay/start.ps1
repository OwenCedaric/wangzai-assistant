$ErrorActionPreference = "Stop"

$pidFile = Join-Path $PSScriptRoot ".keepalive.pid"
$keepaliveRunning = $false
if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile -Encoding utf8)
    $savedProcess = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
    $keepaliveRunning = $null -ne $savedProcess -and $savedProcess.ProcessName -eq "wsl"
}

if (-not $keepaliveRunning) {
    $keepalive = Start-Process `
        -FilePath "wsl.exe" `
        -ArgumentList @("-d", "Debian", "-u", "root", "--", "sleep", "infinity") `
        -WindowStyle Hidden `
        -PassThru
    Set-Content -LiteralPath $pidFile -Value $keepalive.Id -Encoding utf8 -NoNewline
}

$drive = $PSScriptRoot.Substring(0, 1).ToLowerInvariant()
$pathWithoutDrive = $PSScriptRoot.Substring(2).Replace('\', '/')
$linuxDeploy = "/mnt/$drive$pathWithoutDrive"

& wsl.exe -d Debian -u root --cd $linuxDeploy -- `
    docker compose up -d --no-build
if ($LASTEXITCODE -ne 0) {
    throw "Jeepay failed to start"
}

& wsl.exe -d Debian -u root --cd $linuxDeploy -- `
    docker compose ps
