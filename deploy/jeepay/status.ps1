$ErrorActionPreference = "Stop"

$drive = $PSScriptRoot.Substring(0, 1).ToLowerInvariant()
$pathWithoutDrive = $PSScriptRoot.Substring(2).Replace('\', '/')
$linuxDeploy = "/mnt/$drive$pathWithoutDrive"

& wsl.exe -d Debian -u root --cd $linuxDeploy -- `
    docker compose ps
if ($LASTEXITCODE -ne 0) {
    throw "Jeepay status check failed"
}
