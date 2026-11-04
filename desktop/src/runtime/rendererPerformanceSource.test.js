import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(currentDirectory, '..', '..');

function assertProductionAsarFiles(files) {
  assert.ok(Array.isArray(files) && files.every((entry) => typeof entry === 'string'));
  const allowedPositivePatterns = new Set(['src/**/*', 'package.json', 'current-version.json']);
  const requiredExclusions = [
    '!src/**/*.test.js',
    '!src/**/*.spec.js',
    '!src/**/{__tests__,test,tests,fixture,fixtures}/**/*',
  ];
  for (const required of allowedPositivePatterns) {
    assert.ok(files.includes(required), `required production source/metadata is missing: ${required}`);
  }
  for (const entry of files.filter((pattern) => !pattern.startsWith('!'))) {
    assert.ok(allowedPositivePatterns.has(entry), `unapproved ASAR input: ${entry}`);
  }
  for (const excluded of requiredExclusions) {
    assert.ok(files.includes(excluded), `test/fixture exclusion is missing: ${excluded}`);
    assert.ok(files.indexOf(excluded) > files.indexOf('src/**/*'), 'source inclusions cannot reintroduce excluded test fixtures');
  }
}

test('renderer performance fixture includes an isolated five-second continuous list scroll probe', async () => {
  const source = await fs.readFile(path.join(desktopRoot, 'src', 'window', 'mainWindow.js'), 'utf8');

  assert.match(source, /const runContinuousListScroll = async/);
  assert.match(source, /const durationTargetMs = 5_000/);
  assert.match(source, /window\.scrollTo\(0, Math\.round\(maxScrollTop \* progress\)\)/);
  assert.match(source, /scroll = await runContinuousListScroll\(primaryPage\.tableSelector\)/);
  assert.match(source, /id: 'sales-orders', title: '销售订单', tableSelector: '\.sales-orders-table'/);
  assert.doesNotMatch(source, /id: 'purchase-browser'|内置拍单浏览器/);
  assert.match(source, /performanceTarget === 'settings'/);
  assert.match(source, /button\[aria-label="设置"\]/);
  assert.match(source, /PERFORMANCE_SETTINGS_CLOSE_BUTTON_MISSING/);
  assert.match(source, /settingsDialogIsReady/);
  assert.match(source, /dialog\?\.dataset\.settingsRenderReady !== 'true'/);
  assert.match(source, /const heapBeforeBytes = readHeap\(\)/);
  assert.match(source, /const collectRetainedHeap = async/);
  assert.match(source, /globalThis\.gc\(\)/);
  assert.match(source, /garbageCollectionAvailable/);
  assert.match(source, /completedSwitches/);
  assert.match(source, /const switchDurations = \[\]/);
  assert.match(source, /p95SwitchMs: p95\(switchDurations\)/);
  assert.match(source, /const expectedPrimaryVisibleRowCount/);
  assert.ok(
    source.indexOf('const primaryPage =') < source.indexOf('const primaryDatasetIsVisible ='),
    'primaryPage must be declared in the helper closure before primaryDatasetIsVisible references it',
  );
  assert.match(source, /Math\.min\(expectedCount, 20\)/);
  assert.match(source, /tbody tr\[data-product-row="true"\]/);
  assert.match(source, /visiblePrimaryProductRowCount\(tableSelector\) === expectedRows/);
  assert.match(source, /totalIsVisible && primaryRowsAreComplete\(primaryPage\.tableSelector\)/);
  assert.match(source, /primaryRowsAreComplete\(primaryPage\.tableSelector\)/);
  assert.match(source, /let performancePhase = 'setup'/);
  assert.match(source, /longTaskDetails: longTasks/);
  assert.match(source, /visibilityState: document\.visibilityState/);
  assert.match(source, /documentHasFocus: document\.hasFocus\(\)/);
  assert.match(source, /foregroundContextBeforeScroll/);
  assert.match(source, /foregroundContextAfterScroll/);
  assert.match(source, /windowContextBeforeMeasurement/);
  assert.match(source, /beforeMeasurement: windowContextBeforeMeasurement/);
  assert.match(source, /afterMeasurement:/);
  assert.match(source, /isVisible: window\.isVisible\(\)/);
  assert.match(source, /isFocused: window\.isFocused\(\)/);
  assert.match(source, /\[performance\] ready-hidden/);
  assert.match(source, /performance\.automationVisibility = "hidden"/);
  assert.match(source, /offscreen: isPerformanceTest/);
  assert.match(source, /window\.webContents\.setFrameRate\(120\)/);
  assert.doesNotMatch(source, /if \(isPerformanceTest\) \{\s*window\.show\(\);\s*window\.focus\(\);/);
  assert.doesNotMatch(source, /frameSamples\.filter/);
  assert.match(source, /const readResourceTimings = \(\) => performance\.getEntriesByType\('resource'\)/);
  assert.match(source, /const readRouteModuleLoadMs = \(pageId\) =>/);
  assert.match(source, /routeModuleLoadMs: completedPages\.has\(target\.id\)/);
  assert.match(source, /const readRouteRenderCommitTiming = \(pageId\) =>/);
  assert.match(source, /routeRenderCommitMs: routeRenderTiming\?\.durationMs/);
  assert.match(source, /routeRenderStartDelayMs: routeRenderTiming/);
  assert.match(source, /const readRouteRenderPhaseMs = \(pageId, phase\) =>/);
  assert.match(source, /const readRouteRenderPhaseTiming = \(pageId, phase\) =>/);
  assert.match(source, /routeModelPrepareMs: completedPages\.has\(target\.id\)/);
  assert.match(source, /routeReconcileMs: completedPages\.has\(target\.id\)/);
  assert.match(source, /__wangzaiRendererTreeTelemetryEnabled = true/);
  assert.match(source, /const readRendererTreeRenderStats = \(metric\) =>/);
  assert.match(source, /routeViewTreeRenderMs: routeViewTreeStats\?\.lastMs/);
  assert.match(source, /routeViewTreeFirstRenderMs: routeViewTreeStats\?\.firstMs/);
  assert.match(source, /routeViewTreeMaxRenderMs: routeViewTreeStats\?\.maxMs/);
  assert.match(source, /routeProductTableRowsTreeRenderMs: routeProductTableRowsTreeStats\?\.lastMs/);
  assert.match(source, /routeProductTableRowsFirstRenderMs: routeProductTableRowsTreeStats\?\.firstMs/);
  assert.match(source, /routeProductTableRowsMaxRenderMs: routeProductTableRowsTreeStats\?\.maxMs/);
  assert.match(source, /routeViewStartDelayMs: routeViewStartDelayStats\?\.lastMs/);
  assert.match(source, /const routeDataReadyCommitStats = completedPages\.has\(target\.id\)/);
  assert.match(source, /routeDataReadyCommitMs: routeDataReadyCommitStats\?\.lastMs/);
  assert.match(source, /const routeLocalLoadStartTiming = completedPages\.has\(target\.id\)/);
  assert.match(source, /routeLocalLoadStartDelayMs: routeLocalLoadStartTiming/);
  assert.match(source, /routeLocalApiReadMs: completedPages\.has\(target\.id\)/);
  assert.match(source, /readRouteRenderPhaseMs\(target\.id, 'local-api-read'\)/);
  assert.match(source, /routeLocalPagePrepMs: completedPages\.has\(target\.id\)/);
  assert.match(source, /const readActivePageDomMetrics = \(\) =>/);
  assert.match(source, /routeDomNodeCount: pageDomMetrics\?\.nodeCount/);
  assert.match(source, /routeWorkspaceTargetSlotMs: completedPages\.has\(target\.id\)/);
  assert.match(source, /routeDashboardTreeRenderMs:/);
  assert.match(source, /routeDomCommitMs: completedPages\.has\(target\.id\)/);
  assert.match(source, /routeViewCommitMs: completedPages\.has\(target\.id\)/);
  assert.match(source, /resourceTimings: completedPages\.has\(target\.id\)/);
  assert.match(source, /wangzaiSalesOrdersRoute === 'ready'/);
  assert.match(source, /process\.env\.WANGZAI_PERFORMANCE_TRACE !== "1"/);
  assert.match(source, /PERFORMANCE_TRACE_DEBUGGER_ALREADY_ATTACHED/);
  assert.match(source, /Tracing\.start/);
  assert.match(source, /Tracing\.end/);
  assert.match(source, /Tracing\.tracingComplete/);
  assert.match(source, /resolvedTracePath\.startsWith\(`\$\{resolvedDataRoot\}\$\{path\.sep\}`\)/);
  assert.match(source, /collectRendererPerformanceTrace\(/);
});

test('performance report enforces fixture scroll coverage and the 45 FPS hard floor', async () => {
  const source = await fs.readFile(path.join(desktopRoot, 'scripts', 'perf-electron-navigation.mjs'), 'utf8');

  assert.match(source, /scrollFrameCount/);
  assert.match(source, /expectScroll: expectsListScroll/);
  assert.match(source, /'products', 'sales-orders', 'settings'/);
  assert.match(source, /scrollP5Fps\) < 45/);
  assert.match(source, /expectedRunCount \* 200/);
  assert.match(source, /rendererHeapMaxDeltaBytes/);
  assert.match(source, /expectedSwitchStressCount/);
  assert.match(source, /switchStressP95Ms/);
  assert.match(source, /longTaskPhaseSummary/);
  assert.match(source, /recoveryExportRounds/);
  assert.match(source, /runRecoveryExportWorkload/);
  assert.match(source, /rendererGarbageCollectionAvailable/);
  assert.match(source, /const usePackagedRuntime = process\.argv\.includes\('--packaged'\)/);
  assert.match(source, /const useRendererTrace = process\.argv\.includes\('--trace'\)/);
  assert.match(source, /WANGZAI_PERFORMANCE_TRACE_FILE/);
  assert.match(source, /rendererTraceArtifacts/);
  assert.match(source, /runContexts/);
  assert.match(source, /automationContextViolations/);
  assert.match(source, /documentHasFocus=true/);
  assert.match(source, /automationVisibility: 'hidden'/);
  assert.match(source, /renderer-trace-/);
  assert.match(source, /electron-packaged-bridge/);
  assert.match(source, /未找到已打包的性能运行时/);
  assert.match(source, /rendererGpuMode: useInProcessGpu \? 'in-process' : 'separate-process'/);
  assert.match(source, /launchArguments\.unshift\('--in-process-gpu'\)/);
  assert.match(source, /--disable-background-timer-throttling/);
  assert.match(source, /--disable-renderer-backgrounding/);
  assert.match(source, /--disable-backgrounding-occluded-windows/);
  assert.match(source, /expectedProductVisibleRows/);
  assert.match(source, /sample\.pageId === 'products'/);
  assert.match(source, /Number\(sample\.routeTableRowCount\) !== expectedProductVisibleRows/);
  assert.match(source, /商品页每次必须完整渲染/);
  assert.match(source, /enforce && \(hardFailures\.length \|\| targetMisses\.length \|\| !report\.targetsMet\)/);
});

test('formal Windows packages clean stale browser chunks and embed the native CEF host', async () => {
  const desktopPackage = JSON.parse(await fs.readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
  const frontendPackage = JSON.parse(await fs.readFile(path.join(desktopRoot, '..', 'frontend', 'package.json'), 'utf8'));
  const verifier = await fs.readFile(path.join(desktopRoot, 'scripts', 'verify-package.mjs'), 'utf8');

  assert.equal(frontendPackage.scripts['build:clean'], 'npm run build:package');
  assert.equal(frontendPackage.scripts['build:package'], 'vite build --outDir dist-package --emptyOutDir');
  for (const scriptName of ['pack:win', 'dist:win', 'dist:win:installer', 'dist:win:portable']) {
    assert.match(desktopPackage.scripts[scriptName], /build:frontend:clean/);
  }
  assertProductionAsarFiles(desktopPackage.build.files);
  assert.equal(desktopPackage.build.extraResources.some((entry) => (
    /(?:purchase-capture|cross-border-bus)-(?:firefox-)?extension/u.test(String(entry.from || ''))
  )), false);
  assert.ok(desktopPackage.build.extraFiles.some((entry) => (
    entry.from === 'native/Wangzai.CefBrowserHost/publish'
    && entry.to === 'cef-browser-host'
  )));
  assert.ok(desktopPackage.build.extraResources.some((entry) => (
    entry.from === '../frontend/dist-package' && entry.to === 'frontend-dist'
  )));
  assert.match(verifier, /Wangzai\.CefBrowserHost\.exe/);
  assert.match(verifier, /cef-browser-host/);
  assert.match(verifier, /\/src\/purchaseBrowser\/purchaseBrowserProfileStore\.js/);
  assert.match(verifier, /PurchaseBrowserPage\|内置拍单浏览器/);

  await fs.access(path.join(desktopRoot, 'src', 'purchaseBrowser', 'cefPurchaseBrowserController.js'));
  await fs.access(path.join(desktopRoot, 'src', 'purchaseBrowser', 'cefBrowserRuntime.js'));
});

test('ASAR source allowlist admits build identity but rejects runtime data and fixture exposure', () => {
  const files = [
    'current-version.json',
    'package.json',
    'src/**/*',
    '!src/**/{__tests__,test,tests,fixture,fixtures}/**/*',
    '!src/**/*.spec.js',
    '!src/**/*.test.js',
  ];
  assert.doesNotThrow(() => assertProductionAsarFiles(files));
  for (const unsafe of ['**/*', '../**/*', 'resources/**/*', '.runtime-profile/**/*', 'data/**/*', 'src/**/*.test.js']) {
    assert.throws(() => assertProductionAsarFiles([...files, unsafe]), /unapproved ASAR input/);
  }
  assert.throws(() => assertProductionAsarFiles(files.filter((entry) => entry !== '!src/**/*.test.js')), /exclusion is missing/);
  assert.throws(() => assertProductionAsarFiles(files.filter((entry) => entry !== 'current-version.json')), /metadata is missing/);
});
