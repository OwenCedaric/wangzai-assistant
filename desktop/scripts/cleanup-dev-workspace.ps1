[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Apply,
  [switch]$Deep
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$managedRoot = Join-Path $workspaceRoot '.managed-dev-scratch'
$managerScript = Join-Path $workspaceRoot 'tools\managed-dev-scratch-cli.mjs'

# Compatibility only: Deep must never re-enable the old workspace-wide sweep.
if ($Deep) {
  Write-Warning 'Deep no longer broadens cleanup. Only registered completed managed scratch is eligible.'
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Managed scratch cleanup requires the development Node.js runtime.' }
$arguments = @($managerScript, 'cleanup', '--workspace', $workspaceRoot)
if ($Apply -and $PSCmdlet.ShouldProcess($managedRoot, 'Reclaim verified disposable managed scratch only')) {
  $arguments += '--apply'
}
& $nodeCommand.Source @arguments
$cleanupExitCode = $LASTEXITCODE
if ($null -eq $cleanupExitCode) { exit 1 }
exit $cleanupExitCode
