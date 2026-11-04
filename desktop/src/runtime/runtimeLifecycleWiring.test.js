import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const desktopRoot = path.resolve(import.meta.dirname, '..', '..');

function functionBody(source, functionName) {
  const start = source.indexOf(`async function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must be wired in desktop main`);
  const nextFunction = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

test('desktop main wires real Tray and powerMonitor transitions without releasing the profile lock on suspend', () => {
  const source = fs.readFileSync(path.join(desktopRoot, 'src', 'main.js'), 'utf8');
  const mainWindowSource = fs.readFileSync(
    path.join(desktopRoot, 'src', 'window', 'mainWindow.js'),
    'utf8',
  );
  const suspendBody = functionBody(source, 'suspendRuntimeForPowerEvent');
  const resumeBody = functionBody(source, 'resumeRuntimeAfterPowerEvent');

  assert.match(source, /powerMonitor\.on\('suspend'/u);
  assert.match(source, /powerMonitor\.on\('resume'/u);
  assert.match(source, /desktopTray = new Tray\(trayIconPath\)/u);
  assert.match(source, /closeToTrayEnabled: !IS_AUTOMATION_TEST/u);
  assert.match(source, /runtimeLifecycle\.bindWindow\(mainWindow\)/u);
  assert.match(source, /runtimeLifecycle\.shouldKeepAliveWithoutWindows\(\)/u);
  assert.match(source, /app\.on\("second-instance", restoreStartupSurface\)/u);
  assert.match(source, /focusStartupSplashWindow\(startupSplashWindow\)/u);
  assert.match(source, /showStartupSplash\(\);[\s\S]*?services\.startAll\(\)/u);
  assert.match(source, /const mainWindow = await windows\.create\(runtimeInfo\);[\s\S]*?closeStartupSplash\(\)/u);

  assert.match(suspendBody, /services\.stopAll\(\)/u);
  assert.match(suspendBody, /profileLockRetained: Boolean\(profileLock\)/u);
  assert.doesNotMatch(suspendBody, /profileLock\?*\.release|profileLock\.release/u);
  assert.match(resumeBody, /services\.startAll\(\)/u);
  assert.doesNotMatch(resumeBody, /resumeAfterSuspend|resumeJitter|stagger/u);
  assert.match(resumeBody, /shopIsolation: true/u);
  assert.match(resumeBody, /configureRuntimeBindings\(\)/u);
  assert.match(source, /existingLicenseRuntime: desktopLicenseRuntime/u);
  assert.match(source, /onRendererRecoveryFailed: \(error\) => \{[\s\S]*?dialog\.showErrorBox\(/u);
  const desktopIpcSource = fs.readFileSync(path.join(desktopRoot, 'src', 'runtime', 'desktopIpc.js'), 'utf8');
  assert.match(desktopIpcSource, /existingRuntime: existingLicenseRuntime/u);
  assert.match(source, /profileLock\?\.release\(\)/u);
  assert.match(mainWindowSource, /await window\.loadURL\(`app:\/\/\$\{appHost\}\/index\.html`\)/u);
  assert.match(
    mainWindowSource,
    /if \(!isAutomationTest && !window\.isDestroyed\(\) && !window\.isVisible\(\)\) \{[\s\S]*?window\.show\(\);[\s\S]*?window\.focus\(\)/u,
  );
});

test('packaged tray icon is an explicit non-empty resource and package verification requires it', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  const iconEntry = packageJson.build.extraResources.find(
    (entry) => entry.from === 'resources/icon.png' && entry.to === 'tray/icon.png',
  );
  assert.ok(iconEntry);
  assert.ok(fs.statSync(path.join(desktopRoot, 'resources', 'icon.png')).size > 0);
  const verifySource = fs.readFileSync(path.join(desktopRoot, 'scripts', 'verify-package.mjs'), 'utf8');
  assert.match(verifySource, /path\.join\(resourcesRoot, 'tray', 'icon\.png'\)/u);
  assert.match(verifySource, /'\/src\/runtime\/runtimeLifecycleController\.js'/u);
});
