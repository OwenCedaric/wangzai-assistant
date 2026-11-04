import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withManagedDevScratch } from '../../tools/managed-dev-scratch.mjs';
import { seedRendererPerformanceFixture, validatePerformanceFixtureSize, disposeRendererPerformanceFixture, probeRendererPerformanceFixture } from './performanceFixture.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
const usePackagedRuntime = process.argv.includes('--packaged');
const useRendererTrace = process.argv.includes('--trace');
const supportedTargets = new Set(['products', 'sales-orders', 'settings', 'purchase-orders']);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
};
const maximum = (values) => values.length ? Math.max(...values) : null;

export function parsePerformanceOptions(argv = process.argv.slice(2)) {
  const flags = new Set(['fixture', 'enforce', 'packaged', 'trace', 'in-process-gpu', 'help']);
  const values = new Set(['products', 'orders', 'shops', 'runs', 'target', 'stress-switches', 'recovery-export-rounds', 'timeout-ms', 'output-dir']);
  const args = new Map();
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(arg);
    if (!match || args.has(match[1]) || !(flags.has(match[1]) && match[2] === undefined || values.has(match[1]) && match[2] !== undefined)) {
      throw new Error(`PERFORMANCE_ARGUMENT_INVALID:${arg}`);
    }
    args.set(match[1], match[2] ?? true);
  }
  function integer(name, fallback, min, max) {
    const raw = args.has(name) ? args.get(name) : String(fallback);
    if (!/^\d+$/u.test(raw)) throw new Error(`PERFORMANCE_ARGUMENT_INVALID:${name}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`PERFORMANCE_ARGUMENT_RANGE:${name}`);
    return value;
  }
  const target = args.get('target') || 'products';
  if (!supportedTargets.has(target)) throw new Error('PERFORMANCE_TARGET_UNSUPPORTED');
  const result = {
    target, products: integer('products', 80, 0, 100000), orders: integer('orders', 24, 0, 500000),
    shops: integer('shops', 1, 1, 20), runs: integer('runs', 1, 1, 10),
    stressSwitches: integer('stress-switches', 0, 0, 1000), recoveryExportRounds: integer('recovery-export-rounds', 0, 0, 10),
    timeoutMs: integer('timeout-ms', 120000, 10000, 600000), fixture: true,
    enforce: args.has('enforce'), packaged: args.has('packaged'), trace: args.has('trace'),
    inProcessGpu: args.has('in-process-gpu'), help: args.has('help'),
    outputDirectory: args.get('output-dir') || path.join(workspaceRoot, '.codex-temp/performance-navigation'),
  };
  validatePerformanceFixtureSize(result);
  if (!result.help && target === 'purchase-orders' && Math.floor(result.orders / result.shops) < 40) {
    throw new Error('PERFORMANCE_PURCHASE_TWO_PAGES_PER_SHOP_REQUIRED');
  }
  if (!result.help && (target === 'products' && !result.products || target.endsWith('-orders') && !result.orders)) {
    throw new Error('PERFORMANCE_NONEMPTY_TARGET_FIXTURE_REQUIRED');
  }
  // Bound aggregate work as well as individual runs. Larger capacities are explicit single-run probes.
  if ((result.products + result.orders) * result.runs > 600000 || result.stressSwitches * result.runs > 1000) {
    throw new Error('PERFORMANCE_TOTAL_WORK_LIMIT');
  }
  const outputRoot = path.join(workspaceRoot, '.codex-temp');
  const relativeOutput = path.relative(outputRoot, path.resolve(result.outputDirectory));
  if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('PERFORMANCE_OUTPUT_OUTSIDE_EVIDENCE_ROOT');
  return result;
}

export async function preparePerformanceEvidenceDirectory(directory) {
  const resolved = path.resolve(directory);
  const evidenceRoot = path.join(workspaceRoot, '.codex-temp');
  const relative = path.relative(evidenceRoot, resolved);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'PERFORMANCE_OUTPUT_OUTSIDE_EVIDENCE_ROOT');
  const segments = path.relative(workspaceRoot, resolved).split(path.sep);
  let current = workspaceRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const metadata = await fs.lstat(current);
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'PERFORMANCE_OUTPUT_LINKED_DIRECTORY');
  }
  return resolved;
}

export function buildPerformanceReport(runs, options) {
  const expectedRunCount = options.runs;
  const expectedSwitchStressCount = options.stressSwitches;
  const expectedProducts = Math.ceil(options.products / options.shops);
  const expectedOrders = Math.ceil(options.orders / options.shops);
  const expectsListScroll = Boolean(options.target.endsWith('-orders') ? expectedOrders : expectedProducts);
  const hardFailures = [];
  const targetMisses = [];
  const automationContextViolations = [];
  const samples = runs.flatMap((run) => run.measurement?.samples || []);
  const runContexts = [];
  const frames = [];
  const longTaskPhaseSummary = {};
  const rendererTraceArtifacts = [];
  for (const [index, run] of runs.entries()) {
    const expectedProductVisibleRows = Math.min(run.measuredShop?.products ?? expectedProducts, 20);
    if (options.shops > 1 && !run.measuredShop) hardFailures.push(`run-${index + 1}:initial-shop-receipt-missing`);
    const measurement = run.measurement;
    if (run.cleanup?.verified !== true) hardFailures.push(`run-${index + 1}:process-or-port-cleanup-unverified`);
    if (run.error || run.exitCode !== 0 || !measurement) hardFailures.push(`run-${index + 1}:${run.error || 'PERFORMANCE_MEASUREMENT_MISSING'}`);
    if (!measurement) continue;
    if (measurement.performanceTarget !== options.target) hardFailures.push(`run-${index + 1}:target-mismatch`);
    if (options.target === 'purchase-orders') {
      const interactions = measurement.purchaseInteractions;
      const expectedShopIds = Array.from({ length: options.shops }, (_, i) => `ux-fixture-shop-${i + 1}`).concat('all');
      const switched = interactions?.samples?.filter(sample => sample.kind === 'shop') || [];
      if (interactions?.ok !== true || interactions.expectedSteps !== options.shops + 5
        || interactions.samples?.length !== options.shops + 5
        || JSON.stringify(switched.map(sample => sample.shopId)) !== JSON.stringify(expectedShopIds)
        || !['search', 'clear-search', 'page', 'selection'].every(kind => interactions.samples.some(sample => sample.kind === kind))) {
        hardFailures.push(`run-${index + 1}:purchase-interactions:${interactions?.error || 'coverage-missing'}`);
      }
      for (const sample of interactions?.samples || []) {
        if (!Number.isFinite(sample.durationMs) || sample.durationMs <= 0 || sample.context?.isVisible !== false
          || sample.context?.isFocused !== false || sample.context?.documentHasFocus !== false) {
          hardFailures.push(`run-${index + 1}:purchase-interaction-context-or-duration`);
        }
      }
    }
    if (measurement.samples?.length !== 10) hardFailures.push(`run-${index + 1}:navigation-sample-count`);
    const primarySamples = (measurement.samples || []).filter((sample) => sample.pageId === options.target);
    if (primarySamples.length !== (options.target === 'settings' ? 10 : 5)) hardFailures.push(`run-${index + 1}:business-page-sample-count`);
    if (primarySamples.filter((sample) => sample.isColdStart === true).length !== 1) hardFailures.push(`run-${index + 1}:cold-sample-missing-or-duplicated`);
    for (const sample of measurement.samples || []) {
      if (!Number.isFinite(sample.durationMs) || sample.durationMs <= 0) hardFailures.push(`run-${index + 1}:invalid-navigation-duration`);
      if (sample.pageId === 'purchase-orders' && sample.durationMs > 16000) {
        hardFailures.push(`run-${index + 1}:purchase-navigation-original-16s-deadline-exceeded`);
      }
      if (sample.pageId === 'products' && Number(sample.routeTableRowCount) !== expectedProductVisibleRows) {
        hardFailures.push(`run-${index + 1}:商品页每次必须完整渲染${expectedProductVisibleRows}行`);
      }
      if (sample.pageId === 'sales-orders' && (!Number.isInteger(sample.routeTableRowCount) || sample.routeTableRowCount < 1)) hardFailures.push(`run-${index + 1}:empty-orders-page`);
      if (sample.pageId === 'purchase-orders' && sample.routeTableRowCount !== Math.min(run.measuredShop?.orders ?? expectedOrders, 20)) {
        hardFailures.push(`run-${index + 1}:purchase-orders-incomplete-page`);
      }
      if (sample.pageId === options.target && (!Number.isFinite(sample.routeDomNodeCount) || sample.routeDomNodeCount < 1)) hardFailures.push(`run-${index + 1}:empty-business-page`);
    }
    const contexts = { run: index + 1, automationVisibility: measurement.automationVisibility,
      windowContext: measurement.windowContext, rendererContext: measurement.rendererContext,
      beforeScroll: measurement.scroll?.foregroundContextBeforeScroll, afterScroll: measurement.scroll?.foregroundContextAfterScroll };
    runContexts.push(contexts);
    if (measurement.automationVisibility !== 'hidden') automationContextViolations.push(`run-${index + 1}:not-hidden`);
    for (const position of ['beforeMeasurement', 'afterMeasurement']) {
      const context = measurement.windowContext?.[position];
      if (!context || context.isVisible !== false || context.isFocused !== false) automationContextViolations.push(`run-${index + 1}:window-${position}`);
    }
    for (const context of [measurement.rendererContext, ...(expectsListScroll ? [contexts.beforeScroll, contexts.afterScroll] : [])]) {
      if (!context || context.documentHasFocus !== false) automationContextViolations.push(`run-${index + 1}:documentHasFocus=true-or-missing`);
    }
    const scroll = measurement.scroll;
    if (expectsListScroll) {
      if (!scroll || !Array.isArray(scroll.frameSamples) || scroll.frameCount !== scroll.frameSamples.length
        || scroll.frameCount < 200 || scroll.durationMs < 5000 || scroll.scrollEventCount < 2
        || scroll.frameSamples.some((value) => !Number.isFinite(value) || value <= 0)) {
        hardFailures.push(`run-${index + 1}:incomplete-five-second-scroll`);
      } else {
        frames.push(...scroll.frameSamples);
        const runP5Fps = 1000 / percentile(scroll.frameSamples, 0.95);
        if (runP5Fps < 45) hardFailures.push(`run-${index + 1}:scroll-below-45-FPS`);
      }
    }
    if (expectedSwitchStressCount) {
      const stress = measurement.navigationStress;
      if (stress?.requestedSwitches !== expectedSwitchStressCount || stress?.completedSwitches !== expectedSwitchStressCount
        || stress?.switchDurations?.length !== expectedSwitchStressCount || stress.garbageCollectionAvailable !== true
        || stress.switchDurations.some((value) => !Number.isFinite(value) || value < 0)
        || !Number.isFinite(stress.heapBeforeBytes) || !Number.isFinite(stress.heapAfterBytes)
        || stress.heapDeltaBytes !== stress.heapAfterBytes - stress.heapBeforeBytes) hardFailures.push(`run-${index + 1}:stress-or-retained-heap-incomplete`);
    }
    for (const task of measurement.longTaskDetails || []) {
      const bucket = longTaskPhaseSummary[task.phase || 'unknown'] ||= { count: 0, totalMs: 0, maxMs: 0 };
      bucket.count += 1; bucket.totalMs += Number(task.durationMs) || 0; bucket.maxMs = Math.max(bucket.maxMs, Number(task.durationMs) || 0);
    }
    if (options.trace && !(measurement.rendererTrace?.bytes > 0)) hardFailures.push(`run-${index + 1}:trace-missing`);
    if (measurement.rendererTrace) rendererTraceArtifacts.push({ run: index + 1, ...measurement.rendererTrace });
    const endpoint = options.target === 'products' ? '/api/cache/products' : options.target.endsWith('-orders') ? '/api/cache/orders' : '/api/shops';
    if (!run.network?.some((row) => row.event === 'loaded')) hardFailures.push(`run-${index + 1}:network-guard-unverified`);
    if (!run.network?.some((row) => row.event === 'response' && row.pathname === endpoint && row.status >= 200 && row.status < 300)) {
      hardFailures.push(`run-${index + 1}:real-business-request-receipt-missing:${endpoint}`);
    }
    if (options.recoveryExportRounds && (run.recovery?.ok !== true || run.recovery?.meaningfulExport !== true
      || !(run.recovery?.totalCipherBytes > 0) || !(run.recovery?.exportedRecords > 0)
      || run.recovery?.authoritativeDatabases !== options.shops + 1
      || run.recovery?.rounds !== options.recoveryExportRounds)) hardFailures.push(`run-${index + 1}:recovery-export-incomplete-or-empty`);
  }
  if (runs.length !== expectedRunCount) hardFailures.push('PERFORMANCE_RUN_COVERAGE_INCOMPLETE');
  if (automationContextViolations.length) hardFailures.push('PERFORMANCE_AUTOMATION_CONTEXT_INVALID');
  const scrollFrameCount = frames.length;
  const scrollP5Fps = frames.length ? 1000 / percentile(frames, 0.95) : null;
  if (expectsListScroll && (scrollFrameCount < expectedRunCount * 200 || Number(scrollP5Fps) < 45)) hardFailures.push('PERFORMANCE_SCROLL_HARD_FLOOR');
  // 60 FPS is the documented experience goal, distinct from the existing 45 FPS hard floor.
  if (expectsListScroll && (scrollP5Fps === null || scrollP5Fps < 60)) targetMisses.push('PERFORMANCE_SCROLL_60_FPS_TARGET');
  const stressRows = runs.map((run) => run.measurement?.navigationStress).filter(Boolean);
  return { schemaVersion: 1, kind: 'electron-navigation-performance', targetsMet: !hardFailures.length && !targetMisses.length,
    hardFailures, targetMisses, automationContextViolations, expectedRunCount, completedRunCount: runs.filter((run) => run.measurement).length,
    target: options.target, fixture: { products: options.products, orders: options.orders, shops: options.shops,
      measuredShopId: runs[0]?.measuredShop?.shopId ?? 'ux-fixture-shop-1',
      measuredProducts: runs[0]?.measuredShop?.products ?? expectedProducts,
      measuredOrders: runs[0]?.measuredShop?.orders ?? expectedOrders },
    automationVisibility: 'hidden', expectScroll: expectsListScroll, scrollFrameCount, scrollP5Fps,
    coldP95Ms: percentile(samples.filter((sample) => sample.isColdStart).map((sample) => sample.durationMs), 0.95),
    warmP95Ms: percentile(samples.filter((sample) => !sample.isColdStart).map((sample) => sample.durationMs), 0.95),
    rendererHeapMaxDeltaBytes: maximum(stressRows.map((row) => row.heapDeltaBytes).filter(Number.isFinite)),
    rendererGarbageCollectionAvailable: stressRows.length ? stressRows.every((row) => row.garbageCollectionAvailable === true) : null,
    expectedSwitchStressCount, switchStressP95Ms: percentile(stressRows.flatMap((row) => row.switchDurations || []), 0.95),
    recoveryExportRounds: options.recoveryExportRounds, longTaskPhaseSummary, runContexts, rendererTraceArtifacts,
    latencyAndHeapThresholds: 'unconfirmed-report-only', releaseAcceptance: false, runs };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
async function allocatePorts() {
  const ports = new Set();
  while (ports.size < 3) ports.add(await freePort());
  const [localApi, bridge, cache] = [...ports];
  return { localApi, bridge, cache };
}
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(300, () => finish(true));
  });
}
async function verifyCleanup(row) {
  const pids = [...new Set([row.pid, ...(row.network || []).filter((item) => item.event === 'loaded').map((item) => item.pid)].filter(Number.isInteger))];
  const startedAt = Date.now();
  let alivePids = [];
  let openPorts = [];
  do {
    alivePids = pids.filter(isProcessAlive);
    openPorts = (await Promise.all(Object.values(row.ports).map(async (port) => await portIsOpen(port) ? port : null))).filter(Boolean);
    if (!alivePids.length && !openPorts.length) break;
    await pause(100);
  } while (Date.now() - startedAt < 5000);
  return { verified: pids.length > 0 && !alivePids.length && !openPorts.length, checkedPids: pids, alivePids, checkedPorts: Object.values(row.ports), openPorts };
}
async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function hashFile(file) { const bytes = await fs.readFile(file); return createHash('sha256').update(bytes).digest('hex'); }
function cleanEnvironment() {
  // Do not inherit production DB/profile paths, tokens, helper preload scripts or platform endpoints.
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/iu;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject); killer.once('exit', resolve);
    });
  } else child.kill('SIGTERM');
}
async function runChild(executable, args, { env, lease, timeoutMs, cwd = desktopRoot }) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  lease.trackChild(child);
  let output = '';
  let timedOut = false;
  child.stdout?.on('data', (chunk) => { output = (output + chunk.toString()).slice(-32000); });
  child.stderr?.on('data', (chunk) => { output = (output + chunk.toString()).slice(-32000); });
  const timer = setTimeout(() => { timedOut = true; void stopChild(child); }, timeoutMs);
  try {
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    if (timedOut) throw new Error('PERFORMANCE_RUNTIME_TIMEOUT');
    return { exitCode, output, pid: child.pid };
  } finally { clearTimeout(timer); await stopChild(child); }
}

async function runRecoveryExportWorkload({ fixtureManifest, options, env, lease }) {
  const result = await runChild(process.execPath, [path.join(desktopRoot, 'scripts/performance-recovery-export-workload.mjs'),
    `--fixture-manifest=${fixtureManifest}`, `--rounds=${options.recoveryExportRounds}`], { env, lease, timeoutMs: options.timeoutMs });
  if (result.exitCode !== 0) throw new Error('PERFORMANCE_RECOVERY_WORKLOAD_FAILED');
  return JSON.parse(result.output.trim().split(/\r?\n/u).findLast((line) => line.startsWith('{')) || '{}');
}

export async function runPerformanceNavigation(options) {
  const packageJson = JSON.parse(await fs.readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
  const useInProcessGpu = options.inProcessGpu;
  const sourceExecutable = path.join(desktopRoot, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const packagedExecutable = path.join(desktopRoot, packageJson.build.directories.output, 'win-unpacked', `${packageJson.build.win.executableName}.exe`);
  const executable = options.packaged ? packagedExecutable : sourceExecutable;
  return withManagedDevScratch({ workspaceRoot, purpose: 'test-scratch' }, async (lease) => {
    // Synthetic profiles are protected payloads, not disposable compiler intermediates.
    lease.retain();
    const runs = [];
    const ownedFixtures = [];
    let preflightFailure = '';
    try {
      try { await fs.access(executable); } catch { throw new Error(options.packaged ? '未找到已打包的性能运行时:electron-packaged-bridge' : 'PERFORMANCE_ELECTRON_RUNTIME_MISSING'); }
      // Formal packages reject test campaigns and require genuine signed entitlement. A fresh
      // synthetic profile has none: do not copy real credentials, disable enforce, or time an auth page.
      if (options.packaged) throw new Error('PERFORMANCE_PACKAGED_ISOLATED_AUTHORIZATION_UNAVAILABLE');
      await fs.access(path.join(workspaceRoot, 'frontend/dist/index.html'));
      const mainSource = await fs.readFile(path.join(desktopRoot, 'src/window/mainWindow.js'), 'utf8');
      assert.ok(mainSource.includes('offscreen: isPerformanceTest') && mainSource.includes('[performance] ready-hidden'), 'PERFORMANCE_HIDDEN_RUNTIME_CONTRACT_MISSING');
      for (let index = 0; index < options.runs; index += 1) {
        const dataRoot = path.join(lease.directory, `profile-${index + 1}`);
        const fixture = await seedRendererPerformanceFixture({ ...options, ownedRoot: lease.directory, dataRoot,
          onProgress: progress => console.log(JSON.stringify({ phase: 'seeding', ...progress })) });
        ownedFixtures.push(fixture);
        const initialShop = fixture.shopReceipts.find(receipt => receipt.shopId === fixture.initialShopId);
        assert.ok(initialShop, 'PERFORMANCE_FIXTURE_INITIAL_SHOP_RECEIPT_MISSING');
        const fixtureManifest = path.join(lease.directory, `fixture-${index + 1}.json`);
        await fs.writeFile(fixtureManifest, JSON.stringify(fixture), { flag: 'wx' });
        const ports = await allocatePorts();
        const testAuthorization = options.testAuthorization;
        let authorizationPort = null;
        if (testAuthorization) {
          const directory = path.resolve(testAuthorization.directory);
          assert.match(directory, /[\\/]\.managed-dev-scratch[\\/]run-[a-f0-9-]+[\\/]work[\\/]authorization$/iu);
          assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
          const config = JSON.parse(await fs.readFile(path.join(directory, 'client/resources/distribution.json'), 'utf8'));
          const address = new URL(config.license_center_url);
          assert.equal(config.license_mode, 'enforce'); assert.equal(config.campaign_code, 'test-fixture');
          assert.equal(address.hostname, '127.0.0.1'); assert.equal(address.protocol, 'http:');
          authorizationPort = Number(address.port);
          assert.ok(authorizationPort > 0 && authorizationPort <= 65535);
          await fs.mkdir(path.join(dataRoot, 'license'));
          // Same physical test device, but the new process must log in again.
          // No saved access/refresh/offline token is copied.
          await fs.copyFile(path.join(directory, 'desktop-auth-profile/license/license-device-id'),
            path.join(dataRoot, 'license/license-device-id'), fsConstants.COPYFILE_EXCL);
        }
        const networkLog = path.join(dataRoot, 'performance-network.jsonl');
        const traceFile = path.join(dataRoot, `renderer-trace-${index + 1}.json`);
        const guard = path.join(desktopRoot, 'scripts/performance-network-guard.cjs');
        const env = { ...cleanEnvironment(), WANGZAI_DESKTOP_DATA_DIR: dataRoot,
          WANGZAI_LICENSE_MODE: testAuthorization ? 'enforce' : 'off',
          ...(options.diagnostics ? { WANGZAI_PERFORMANCE_DIAGNOSTICS: '1' } : {}),
          ...(options.cpuProfile ? { WANGZAI_PERFORMANCE_CPU_PROFILE: '1' } : {}),
          ...(options.diagnosticCompletion ? { WANGZAI_PERFORMANCE_DIAGNOSTIC_WAIT: '1' } : {}),
          ...(options.target === 'purchase-orders' ? { WANGZAI_PERFORMANCE_PURCHASE_FIXTURE: JSON.stringify({
            shops: fixture.shopReceipts.map(({ shopId, orders }) => ({ shopId, orders })),
          }) } : {}),
          ...(testAuthorization ? { WANGZAI_ALLOW_TEST_FIXTURE_URLS: '1', WANGZAI_PERFORMANCE_LICENSE_DIRECTORY: testAuthorization.directory } : {}),
          LOCAL_API_PORT: String(ports.localApi), PURCHASE_SEARCH_BRIDGE_PORT: String(ports.bridge), WANGZAI_CACHE_AGENT_PORT: String(ports.cache),
          WANGZAI_PERFORMANCE_TARGET: options.target, WANGZAI_PERFORMANCE_PRODUCT_COUNT: String(initialShop.products),
          WANGZAI_PERFORMANCE_ORDER_COUNT: String(initialShop.orders), WANGZAI_PERFORMANCE_SWITCH_STRESS_COUNT: String(options.stressSwitches),
          WANGZAI_PERFORMANCE_ALLOWED_PORTS: [...Object.values(ports), ...(authorizationPort ? [authorizationPort] : [])].join(','), WANGZAI_PERFORMANCE_NETWORK_LOG: networkLog,
          NODE_OPTIONS: `--require="${guard.replaceAll('\\', '/')}"`,
          WANGZAI_PERFORMANCE_TRACE: options.trace ? '1' : '0', WANGZAI_PERFORMANCE_TRACE_FILE: traceFile };
        const launchArguments = ['--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows', '--js-flags=--expose-gc',
          path.join(desktopRoot, 'scripts/performance-authorized-entry.cjs'),
          '--performance-test', '--dashboard-visual-test'];
        if (useInProcessGpu) launchArguments.unshift('--in-process-gpu');
        const row = { run: index + 1, dataRoot, measuredShop: { shopId: initialShop.shopId, products: initialShop.products, orders: initialShop.orders },
          seedDurationMs: fixture.durationMs, seedCommitMode: fixture.seedCommitMode, reopened: fixture.reopened, ports, exitCode: null };
        runs.push(row);
        console.log(JSON.stringify({ phase: 'seeded', run: index + 1, products: fixture.products, orders: fixture.orders, shops: fixture.shops, seedMs: fixture.durationMs }));
        try {
          let recoveryPromise;
          // Added shop/search/page checks each retain the original 16-second
          // deadline. Budget their extra coverage separately from navigation;
          // do not relax any per-page latency, row-count or scroll requirement.
          const interactionBudgetMs = options.target === 'purchase-orders' ? (options.shops + 5) * 16000 : 0;
          const launch = runChild(executable, launchArguments, { env, lease,
            timeoutMs: options.timeoutMs + interactionBudgetMs + (options.diagnosticCompletion ? 120000 : 0) });
          if (options.recoveryExportRounds) recoveryPromise = runRecoveryExportWorkload({ fixtureManifest, options, env: cleanEnvironment(), lease });
          const [launched, recovered] = await Promise.allSettled([launch, recoveryPromise]);
          if (launched.status === 'rejected') throw launched.reason;
          if (recovered.status === 'rejected') throw recovered.reason;
          const result = launched.value;
          const recovery = recovered.value;
          Object.assign(row, { exitCode: result.exitCode, pid: result.pid, recovery });
          const log = await readOptional(path.join(dataRoot, 'logs/desktop-main.log'));
          const contextMarkers = ['[dashboard-visual] window-created ', '[performance] ready-hidden '];
          row.windowLaunchContexts = log.split(/\r?\n/u).flatMap((entry) => contextMarkers.filter((marker) => entry.includes(marker))
            .map((marker) => JSON.parse(entry.slice(entry.indexOf(marker) + marker.length))));
          const marker = '[performance] renderer-navigation ';
          const line = log.split(/\r?\n/u).findLast((entry) => entry.includes(marker));
          row.measurement = line ? JSON.parse(line.slice(line.indexOf(marker) + marker.length)) : null;
          if (!row.measurement) {
            const failure = log.split(/\r?\n/u).findLast((entry) => /\[smoke\] failed|\[bootstrap-failed\]/u.test(entry));
            row.error = failure || `PERFORMANCE_MEASUREMENT_MISSING:${result.output.slice(-1200)}`;
          }
        } catch (error) { row.error = error.message; }
        row.network = (await readOptional(networkLog)).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
        row.cleanup = await verifyCleanup(row);
        if (row.error || row.exitCode !== 0) break;
      }
    } catch (error) { preflightFailure = error.message; }
    const report = buildPerformanceReport(runs, options);
    if (preflightFailure) { report.hardFailures.unshift(preflightFailure); report.targetsMet = false; }
    report.runtime = { packageVersion: packageJson.version, node: process.version, platform: process.platform, arch: process.arch,
      cpuModel: os.cpus()[0]?.model || '', logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(),
      mode: options.packaged ? 'electron-packaged-bridge' : 'electron-source', rendererGpuMode: useInProcessGpu ? 'in-process' : 'separate-process',
      authorization: options.packaged ? 'unavailable-unverified' : options.testAuthorization ? 'real-isolated-license-center-enforce' : 'existing-source-license-off-isolated-test-only',
      frontendIndexSha256: await hashFile(path.join(workspaceRoot, 'frontend/dist/index.html')).catch(() => null),
      mainWindowSha256: await hashFile(path.join(desktopRoot, 'src/window/mainWindow.js')).catch(() => null) };
    report.diagnosticCompletion = Boolean(options.diagnosticCompletion);
    report.createdAt = new Date().toISOString();
    await fs.writeFile(path.join(lease.directory, 'navigation-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    // Export durable evidence before releasing the producer lease; consumers do not rely on scratch.
    const outputDirectory = await preparePerformanceEvidenceDirectory(options.outputDirectory || path.join(workspaceRoot, '.codex-temp/performance-navigation'));
    const reportPath = path.join(outputDirectory, `navigation-${lease.runId}.json`);
    const summary = { ...report, runs: report.runs.map(({ network = [], measurement, dataRoot, ...run }) => ({
      ...run, measurement, networkGuardLoaded: network.filter((row) => row.event === 'loaded').length,
      realResponses: network.filter((row) => row.event === 'response').map(({ method, pathname, status }) => ({ method, pathname, status })),
      blockedRequests: network.filter((row) => row.event === 'blocked').map(({ kind, pathname }) => ({ kind, pathname })),
    })) };
    if (options.trace) for (const [index, run] of runs.entries()) {
      if (!run.measurement?.rendererTrace) continue;
      const traceOutput = path.join(outputDirectory, `renderer-trace-${lease.runId}-${index + 1}.json`);
      await fs.copyFile(path.join(run.dataRoot, `renderer-trace-${index + 1}.json`), traceOutput, 1);
      summary.rendererTraceArtifacts[index] = { ...summary.rendererTraceArtifacts[index], path: traceOutput };
    }
    if (options.cpuProfile) for (const [index, run] of runs.entries()) {
      summary.runs[index].nodeCpuProfiles = [];
      for (const name of await fs.readdir(run.dataRoot)) {
        if (!/^node-\d+(?:-\d+)?\.cpuprofile$/.test(name)) continue;
        const destination = path.join(outputDirectory, `${lease.runId}-${name}`);
        await fs.copyFile(path.join(run.dataRoot, name), destination, fsConstants.COPYFILE_EXCL);
        summary.runs[index].nodeCpuProfiles.push(destination);
      }
      const cpuSource = path.join(run.dataRoot, 'purchase.cpuprofile');
      if (!(await readOptional(cpuSource))) continue;
      const cpuOutput = path.join(outputDirectory, `purchase-${lease.runId}-${index + 1}.cpuprofile`);
      await fs.copyFile(cpuSource, cpuOutput, fsConstants.COPYFILE_EXCL);
      summary.runs[index].cpuProfile = cpuOutput;
    }
    // Preserve failure logs before optionally releasing a large synthetic DB.
    // The seed recipe and durable count/scope receipts remain in the report.
    if (options.disposeCompletedFixtures) for (const [index, run] of runs.entries()) {
      const logSource = path.join(run.dataRoot, 'logs/desktop-main.log');
      if (!(await readOptional(logSource))) continue;
      const logOutput = path.join(outputDirectory, `desktop-${lease.runId}-${index + 1}.log`);
      await fs.copyFile(logSource, logOutput, fsConstants.COPYFILE_EXCL);
      summary.runs[index].desktopLog = logOutput;
    }
    if (options.cpuProfile) for (const [index, run] of runs.entries()) {
      if (!run.cleanup?.verified) continue;
      summary.runs[index].directRepositoryProbe = probeRendererPerformanceFixture(ownedFixtures[index]);
    }
    if (report.targetsMet || options.disposeCompletedFixtures && runs.length === ownedFixtures.length && runs.every(run => run.cleanup?.verified)) {
      summary.fixtureDisposal = ownedFixtures.map(fixture => disposeRendererPerformanceFixture(fixture, { ownedRoot: lease.directory }));
      report.fixtureDisposal = summary.fixtureDisposal;
    }
    await fs.writeFile(reportPath, JSON.stringify(summary, null, 2), { flag: 'wx' });
    return { report, reportPath };
  });
}

async function main() {
  const options = parsePerformanceOptions();
  if (options.help) {
    console.log('仅新建隔离profile，真实隐藏Electron页面；不读真实账号，不接外网。\n--fixture --products=0..100000 --orders=0..500000 --shops=1..20 --runs=1..10\n--target=products|sales-orders|settings --stress-switches=0..1000 --recovery-export-rounds=0..10\n--output-dir=<工作区.codex-temp内证据目录>\n--enforce --trace --in-process-gpu --packaged（缺少隔离授权时明确失败）');
    return;
  }
  // These CLI flags never override a packaged runtime's enforce policy.
  assert.equal(options.packaged, usePackagedRuntime); assert.equal(options.trace, useRendererTrace);
  const { report, reportPath } = await runPerformanceNavigation(options);
  const { hardFailures, targetMisses } = report;
  const enforce = options.enforce;
  console.log(JSON.stringify({ ok: !hardFailures.length, targetsMet: report.targetsMet, coldP95Ms: report.coldP95Ms,
    warmP95Ms: report.warmP95Ms, scrollP5Fps: report.scrollP5Fps, hardFailures, targetMisses, reportPath }));
  // Failed/missing/auth-blocked measurement is an error even without --enforce.
  if (hardFailures.length || enforce && (hardFailures.length || targetMisses.length || !report.targetsMet)) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
