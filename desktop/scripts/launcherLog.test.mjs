import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(scriptsRoot, 'launcherLog.ps1');
const launcherPath = path.join(scriptsRoot, 'launch-current-source.ps1');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const argumentsFor = command => [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(command, 'utf16le').toString('base64'),
];
const prelude = `$ErrorActionPreference = 'Stop'; . ${quote(helperPath)};`;

function fixtureRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'wangzai-launcher-log-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
    assert.ok(path.basename(root).startsWith('wangzai-launcher-log-test-'));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function run(command) {
  const result = spawnSync('powershell.exe', argumentsFor(`${prelude}${command}`), {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result;
}

function runConcurrent(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', argumentsFor(`${prelude}${command}`), { windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(output || `PowerShell exited ${code}`)));
  });
}

function assertBoundedLogs(root, name, maximumBytes = 256, slots = 3) {
  const names = readdirSync(root).filter(entry => entry === name || entry.startsWith(`${name}.`));
  assert.equal(names.length, slots + 1);
  for (const entry of names) {
    assert.ok(statSync(path.join(root, entry)).size <= maximumBytes, `${entry} exceeded the byte budget`);
    assert.doesNotMatch(readFileSync(path.join(root, entry), 'utf8'), /\uFFFD/u);
  }
}

test('launcher log helper and caller remain valid Windows PowerShell 5 source', () => {
  for (const file of [helperPath, launcherPath]) {
    run(`$tokens=$null; $parseErrors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(file)}, [ref]$tokens, [ref]$parseErrors); if ($parseErrors.Count) { throw ($parseErrors | Out-String) }`);
  }
});

test('launcher rotates oversized UTF-8 messages within fixed slots and preserves other files', t => {
  const root = fixtureRoot(t);
  const logPath = path.join(root, 'current-source-launch.log');
  writeFileSync(path.join(root, 'keep-evidence.log'), 'untouched fixture evidence');
  const text = Buffer.from(`${'启动🙂'.repeat(500)} latest-marker`, 'utf8').toString('base64');
  run(`$message=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quote(text)})); Add-RotatingLauncherLog -LiteralPath ${quote(logPath)} -Message $message -MaximumBytes 256 -RotationCount 3`);
  assertBoundedLogs(root, 'current-source-launch.log');
  assert.match(readFileSync(logPath, 'utf8'), /latest-marker/u);
  assert.equal(readFileSync(path.join(root, 'keep-evidence.log'), 'utf8'), 'untouched fixture evidence');
});

test('two independent launcher processes serialize rotations of the same diagnostic file', async t => {
  const root = fixtureRoot(t);
  const logPath = path.join(root, 'current-source-smoke.log');
  await Promise.all(['first', 'second'].map(writer => runConcurrent(
    `for ($i=0; $i -lt 24; $i++) { Add-RotatingLauncherLog -LiteralPath ${quote(logPath)} -Message (${quote(writer)} + ':' + $i + ':' + ('x' * 96)) -MaximumBytes 256 -RotationCount 3 }`,
  )));
  assertBoundedLogs(root, 'current-source-smoke.log');
  const retained = readdirSync(root).map(name => readFileSync(path.join(root, name), 'utf8')).join('');
  assert.match(retained, /(?:first|second):23:/u);
});

test('launcher helper rejects non-whitelisted files and junction directories without touching their contents', t => {
  const root = fixtureRoot(t);
  const protectedPath = path.join(root, 'business.sqlite');
  writeFileSync(protectedPath, 'not a real database - preserve');
  const outside = path.join(root, 'outside');
  const junction = path.join(root, 'junction');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'current-source-launch.log'), 'preserve outside fixture');
  symlinkSync(outside, junction, 'junction');
  run(`try { Add-RotatingLauncherLog -LiteralPath ${quote(protectedPath)} -Message 'denied'; throw 'EXPECTED_REJECTION' } catch { if ($_.Exception.Message -ne 'LAUNCHER_LOG_TARGET_FORBIDDEN') { throw } }; try { Add-RotatingLauncherLog -LiteralPath ${quote(path.join(junction, 'current-source-launch.log'))} -Message 'denied'; throw 'EXPECTED_REJECTION' } catch { if ($_.Exception.Message -ne 'LAUNCHER_LOG_REPARSE_POINT_FORBIDDEN') { throw } }; Write-Output 'expected-rejections-verified'`);
  assert.equal(readFileSync(protectedPath, 'utf8'), 'not a real database - preserve');
  assert.equal(readFileSync(path.join(outside, 'current-source-launch.log'), 'utf8'), 'preserve outside fixture');
});

test('log-write failure cannot change the real launcher command exit code or stop following startup work', t => {
  const root = fixtureRoot(t);
  const blocked = path.join(root, 'blocked');
  writeFileSync(blocked, 'preserve fixture');
  const command = `
    $tokens=$null; $parseErrors=$null;
    $ast=[System.Management.Automation.Language.Parser]::ParseFile(${quote(launcherPath)}, [ref]$tokens, [ref]$parseErrors);
    foreach ($functionName in @('Write-LaunchLog', 'Invoke-LoggedCommand')) {
      $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName}, $true);
      . ([scriptblock]::Create($definition.Extent.Text));
    }
    $logPath=${quote(path.join(blocked, 'current-source-launch.log'))};
    Write-LaunchLog 'fixture startup continues';
    $code=Invoke-LoggedCommand -FilePath ${quote(process.execPath)} -ArgumentList @('-e', 'console.log(42);process.exit(7)');
    if ($code -ne 7) { throw "COMMAND_EXIT_CODE_CHANGED:$code" };
    Write-Output 'fixture startup reached the next step';
  `;
  const result = run(command);
  assert.match(result.stdout, /fixture startup reached the next step/u);
  assert.equal(readFileSync(blocked, 'utf8'), 'preserve fixture');
});

test('both launcher diagnostics and command output use the bounded best-effort writer', () => {
  const source = readFileSync(launcherPath, 'utf8');
  assert.match(source, /Join-Path \$PSScriptRoot 'launcherLog\.ps1'/u);
  assert.match(source, /function Write-LaunchLog[\s\S]*?Write-LauncherLogSafely/u);
  assert.match(source, /function Invoke-LoggedCommand[\s\S]*?ForEach-Object[\s\S]*?Write-LauncherLogSafely/u);
  assert.doesNotMatch(source, /(?:Out-File|Add-Content)[^\r\n]*\$logPath/u);
});
