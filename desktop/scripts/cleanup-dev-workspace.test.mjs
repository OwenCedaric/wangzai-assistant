import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withManagedDevScratch } from '../../tools/managed-dev-scratch.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptSource = fs.readFileSync(path.join(workspace, 'desktop/scripts/cleanup-dev-workspace.ps1'), 'utf8');
const quote = value => `'${value.replaceAll("'", "''")}'`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangzai-cleanup-contract-'));
  for (const name of ['desktop/scripts', 'tools', 'artifacts', '.tmp', '.runtime-profile', '.runtime', '.runtime-update-backups', '安装包', 'desktop/dist-current-5.0', 'desktop/native/Wangzai.CefBrowserHost/publish']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'protected-sentinel'), 'preserve');
  }
  for (const name of ['desktop/scripts/cleanup-dev-workspace.ps1', 'tools/managed-dev-scratch.mjs', 'tools/managed-dev-scratch-cli.mjs']) {
    fs.copyFileSync(path.join(workspace, name), path.join(root, name));
  }
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(root).startsWith('wangzai-cleanup-contract-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function run(root, flags) {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'desktop/scripts/cleanup-dev-workspace.ps1'), ...flags], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const name of ['artifacts', '.tmp', '.runtime-profile', '.runtime', '.runtime-update-backups', '安装包', 'desktop/dist-current-5.0', 'desktop/native/Wangzai.CefBrowserHost/publish']) {
    assert.equal(fs.readFileSync(path.join(root, name, 'protected-sentinel'), 'utf8'), 'preserve');
  }
  return result;
}

test('legacy cleanup source has no wide directory enumeration or direct removal branch', () => {
  assert.doesNotMatch(scriptSource, /Remove-Item|Get-ChildItem|cleanupTargets|artifactsRoot/u);
  assert.match(scriptSource, /managed-dev-scratch-cli\.mjs/u);
  assert.match(scriptSource, /ShouldProcess/u);
});

test('Apply plus legacy Deep is limited to registered expired scratch in an isolated workspace', async t => {
  const root = fixture(t);
  let output;
  await withManagedDevScratch({ workspaceRoot: root, purpose: 'native-build', ttlMs: 60_000 }, async scope => {
    output = scope.directory; fs.writeFileSync(path.join(output, 'scratch.bin'), 'disposable');
  }, { now: () => 1_000_000 });
  run(root, ['-Apply', '-Deep']);
  assert.equal(fs.existsSync(output), false);
});

test('WhatIf and default preview preserve even registered expired scratch', async t => {
  const root = fixture(t);
  let output;
  await withManagedDevScratch({ workspaceRoot: root, purpose: 'native-build', ttlMs: 60_000 }, async scope => {
    output = scope.directory;
  }, { now: () => 1_000_000 });
  run(root, []); assert.equal(fs.existsSync(output), true);
  run(root, ['-Apply', '-Deep', '-WhatIf']); assert.equal(fs.existsSync(output), true);
});

test('source launcher cleanup is optional, hidden and scheduled only after normal Electron launch', () => {
  const source = fs.readFileSync(path.join(workspace, 'desktop/scripts/launch-current-source.ps1'), 'utf8');
  assert.match(source, /function Start-ManagedDevScratchCleanup/u);
  assert.match(source, /managed-dev-scratch-cli\.mjs/u);
  assert.doesNotMatch(source, /cleanup-dev-workspace\.ps1/u);
  assert.match(source, /Start-Process[\s\S]*?-FilePath \$electronExecutable[\s\S]*?Start-ManagedDevScratchCleanup/u);
  assert.match(source, /function Start-ManagedDevScratchCleanup[\s\S]*?catch/u);
});

test('cleaner remains syntactically valid in Windows PowerShell 5', () => {
  const script = path.join(workspace, 'desktop/scripts/cleanup-dev-workspace.ps1');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$tokens,[ref]$errors); if ($errors.Count) { throw ($errors | Out-String) }`], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('optional managed cleanup launch failure never stops subsequent application startup work', async t => {
  const root = fixture(t);
  await withManagedDevScratch({ workspaceRoot: root, purpose: 'test-scratch' }, async () => {});
  const launcher = path.join(workspace, 'desktop/scripts/launch-current-source.ps1');
  const command = `$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null;
    $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(launcher)},[ref]$tokens,[ref]$errors);
    $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-ManagedDevScratchCleanup'},$true);
    . ([scriptblock]::Create($definition.Extent.Text));
    $workspaceRoot=${quote(root)};
    function Start-Process { throw 'fixture-only cleanup launch failure' }
    function Write-LaunchLog { param([string]$Message) Write-Output 'cleanup-deferred' }
    Start-ManagedDevScratchCleanup;
    Write-Output 'application-startup-continues';`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /cleanup-deferred/u);
  assert.match(result.stdout, /application-startup-continues/u);
});
