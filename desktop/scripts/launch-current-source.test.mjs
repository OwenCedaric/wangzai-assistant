import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const launcherPath = path.join(scriptsRoot, 'launch-current-source.ps1');
const launcherSource = readFileSync(launcherPath, 'utf8').replace(/^\uFEFF/, '');
const shortcutInstallerPath = path.join(scriptsRoot, 'install-current-source-shortcut.ps1');
const shortcutInstallerSource = readFileSync(shortcutInstallerPath, 'utf8').replace(/^\uFEFF/, '');

test('source launcher disables only automatic browser prewarm for startup compatibility', () => {
  assert.match(launcherSource, /\$env:WANGZAI_BROWSER_PREWARM_DISABLED = '1'/);
  const main = readFileSync(path.join(scriptsRoot, '../src/main.js'), 'utf8');
  assert.match(main, /!app\.isPackaged && process\.env\.WANGZAI_BROWSER_PREWARM_DISABLED === '1'/);
  assert.doesNotMatch(main, /WANGZAI_DIAG_SKIP_BROWSER_PREWARM/);
});

test('current-source launcher remains valid in Windows PowerShell 5', () => {
  const command = [
    "$tokens = $null",
    "$errors = $null",
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${launcherPath.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)`,
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('normal launch immediately hands off to a hidden background stage', () => {
  assert.match(
    launcherSource,
    /if \(-not \$SmokeTest -and -not \$BackgroundLauncher\) \{[\s\S]*?Start-HiddenBackgroundLauncher[\s\S]*?exit 0/,
  );
  assert.match(
    launcherSource,
    /Start-Process[\s\S]*?-FilePath \$powerShellExecutable[\s\S]*?-WindowStyle Hidden/,
  );
  assert.match(launcherSource, /'-BackgroundLauncher'/);
});

test('frontend rebuild is conditional and validates existing assets', () => {
  assert.match(launcherSource, /function Test-FrontendDistributionCurrent/);
  assert.match(launcherSource, /LastWriteTimeUtc -gt \$buildTimestamp/);
  assert.match(
    launcherSource,
    /Test-Path -LiteralPath \(Join-Path \$frontendDistRoot \$relativePath\) -PathType Leaf/,
  );
  assert.match(
    launcherSource,
    /if \(\$ForceBuild -or -not \$distributionCurrent\) \{[\s\S]*?build:frontend/,
  );
  assert.match(launcherSource, /前端产物可直接使用，跳过重复构建/);
});

test('normal Electron launch is detached while smoke mode remains synchronous', () => {
  assert.doesNotMatch(launcherSource, /npm\.cmd[^\r\n]+dev:fast/);
  assert.match(
    launcherSource,
    /if \(\$SmokeTest\) \{[\s\S]*?Invoke-LoggedCommand[\s\S]*?'--smoke-test'/,
  );
  assert.match(
    launcherSource,
    /else \{[\s\S]*?Start-Process[\s\S]*?-FilePath \$electronExecutable[\s\S]*?-WindowStyle Hidden[\s\S]*?-PassThru/,
  );
});

test('desktop shortcut launches the canonical runtime profile through a hidden launcher', () => {
  assert.match(shortcutInstallerSource, /CreateShortcut\(\$ShortcutPath\)/);
  assert.match(shortcutInstallerSource, /\$shortcut\.TargetPath = \$powerShellExecutable/);
  assert.match(shortcutInstallerSource, /-WindowStyle Hidden -File/);
  assert.match(shortcutInstallerSource, /launch-current-source\.ps1/);
  assert.match(launcherSource, /current-version\.json/);
  assert.match(launcherSource, /\$env:WANGZAI_DESKTOP_DATA_DIR = \$dataRoot/);
  assert.match(launcherSource, /\$env:LOCAL_API_PORT = \[string\]\$identity\.ports\.localApi/);
  assert.match(launcherSource, /禁止从错误版本启动/);
  assert.doesNotMatch(shortcutInstallerSource, /TargetPath\s*=\s*.*cmd\.exe/iu);
  assert.match(shortcutInstallerSource, /consoleWindow = \$false/);
});
