import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withManagedDevScratch } from '../../tools/managed-dev-scratch.mjs';
import { parsePerformanceOptions, buildPerformanceReport } from './perf-electron-navigation.mjs';
import { seedRendererPerformanceFixture, disposeRendererPerformanceFixture } from './performanceFixture.mjs';
import { runFixtureRecoveryExport } from './performance-recovery-export-workload.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function successfulRun() {
  const foreground = { documentHasFocus: false };
  return { exitCode: 0, cleanup: { verified: true }, network: [{ event: 'loaded' },
    { event: 'response', pathname: '/api/cache/products', status: 200 }], measurement: {
    performanceTarget: 'products', automationVisibility: 'hidden', rendererContext: foreground,
    windowContext: { beforeMeasurement: { isVisible: false, isFocused: false }, afterMeasurement: { isVisible: false, isFocused: false } },
    samples: Array.from({ length: 10 }, (_, index) => ({ pageId: index % 2 ? 'dashboard' : 'products',
      isColdStart: index === 0, durationMs: 5, routeTableRowCount: 20, routeDomNodeCount: 100 })),
    scroll: { durationMs: 5000, frameSamples: Array(500).fill(10), frameCount: 500, scrollEventCount: 100,
      foregroundContextBeforeScroll: foreground, foregroundContextAfterScroll: foreground },
    longTaskDetails: [],
  } };
}

test('CLI rejects invalid counts, unknown arguments, empty business datasets and unbounded aggregate work', () => {
  for (const args of [['--orders=5oops'], ['--products=-1'], ['--shops=0'], ['--shops=21'], ['--products=100001'],
    ['--runs=11'], ['--target=unknown'], ['--products=0'], ['--products=2', '--products=3'], ['--profile=real'],
    ['--products=100000', '--orders=200000', '--runs=10'], ['--output-dir=G:/']]) {
    assert.throws(() => parsePerformanceOptions(args), /PERFORMANCE_/);
  }
  const options = parsePerformanceOptions(['--fixture', '--products=100000', '--orders=200000', '--shops=10']);
  assert.equal(options.products, 100000); assert.equal(options.orders, 200000); assert.equal(options.shops, 10);
});

test('valid telemetry is accepted but missing/auth-only/partial/nonbusiness measurements never pass', () => {
  const options = parsePerformanceOptions([]);
  assert.equal(buildPerformanceReport([successfulRun()], options).targetsMet, true);
  const mutations = [
    (row) => { row.measurement = null; row.error = 'authorization-unavailable'; },
    (row) => { row.exitCode = 1; },
    (row) => { row.measurement.samples[0].routeTableRowCount = 19; },
    (row) => { row.measurement.samples[0].routeDomNodeCount = 0; },
    (row) => { row.measurement.samples.pop(); },
    (row) => { row.measurement.scroll.frameSamples = Array(199).fill(25); row.measurement.scroll.frameCount = 199; },
    (row) => { row.measurement.scroll.frameSamples = Array(201).fill(25); row.measurement.scroll.frameCount = 201; },
    (row) => { row.measurement.scroll.durationMs = 100; },
    (row) => { row.measurement.rendererContext.documentHasFocus = true; },
    (row) => { row.measurement.windowContext.beforeMeasurement.isVisible = true; },
    (row) => { row.network = [{ event: 'loaded' }, { event: 'response', pathname: '/api/cache/products', status: 403 }]; },
    (row) => { row.cleanup = { verified: false, alivePids: [123] }; },
  ];
  for (const mutate of mutations) {
    const row = successfulRun(); mutate(row);
    const report = buildPerformanceReport([row], options);
    assert.equal(report.targetsMet, false);
    assert.ok(report.hardFailures.length > 0);
  }
  assert.equal(buildPerformanceReport([], options).targetsMet, false);
  assert.equal(buildPerformanceReport([successfulRun()], { ...options, runs: 2 }).targetsMet, false);
});

test('purchase acceptance requires full pages, all shop switches, search, pagination and selection evidence', () => {
  assert.throws(() => parsePerformanceOptions(['--target=purchase-orders', '--orders=39']), /TWO_PAGES/);
  const options = parsePerformanceOptions(['--target=purchase-orders', '--orders=40']);
  const row = successfulRun();
  row.measurement.performanceTarget = 'purchase-orders';
  row.network[1].pathname = '/api/cache/orders';
  row.measurement.samples.forEach(sample => { if (sample.pageId === 'products') sample.pageId = 'purchase-orders'; });
  assert.equal(buildPerformanceReport([row], options).targetsMet, false);
  row.measurement.purchaseInteractions = { ok: true, expectedSteps: 6,
    samples: [
      { kind: 'shop', shopId: 'ux-fixture-shop-1' }, { kind: 'shop', shopId: 'all' },
      { kind: 'search' }, { kind: 'clear-search' }, { kind: 'page' }, { kind: 'selection' },
    ].map(sample => ({ ...sample, durationMs: 5, context: { isVisible: false, isFocused: false, documentHasFocus: false } })),
  };
  assert.equal(buildPerformanceReport([row], options).targetsMet, true);
  row.measurement.samples[0].durationMs = 16001;
  assert.ok(buildPerformanceReport([row], { ...options, diagnosticCompletion: true }).hardFailures.some(message => message.includes('16s-deadline')));
  row.measurement.samples[0].durationMs = 5;
  row.measurement.purchaseInteractions.samples.pop();
  assert.equal(buildPerformanceReport([row], options).targetsMet, false);
});

test('stress, garbage collection and recovery coverage cannot be silently omitted', () => {
  const options = { ...parsePerformanceOptions([]), stressSwitches: 10, recoveryExportRounds: 2 };
  assert.ok(buildPerformanceReport([successfulRun()], options).hardFailures.some((error) => error.includes('stress')));
  const run = successfulRun();
  run.measurement.navigationStress = { requestedSwitches: 10, completedSwitches: 10, switchDurations: Array(10).fill(5),
    garbageCollectionAvailable: true, heapBeforeBytes: 1000000, heapAfterBytes: 1000123, heapDeltaBytes: 123 };
  run.recovery = { ok: true, rounds: 2, meaningfulExport: true, totalCipherBytes: 1024, exportedRecords: 1, authoritativeDatabases: 2 };
  const report = buildPerformanceReport([run], options);
  assert.equal(report.targetsMet, true);
  assert.equal(report.rendererHeapMaxDeltaBytes, 123);
  assert.equal(report.latencyAndHeapThresholds, 'unconfirmed-report-only');
  run.measurement.navigationStress.completedSwitches = 9;
  assert.equal(buildPerformanceReport([run], options).targetsMet, false);
});

test('uneven multi-shop counts follow the persisted initial selection, not the first seeded shop', async () => {
  await withManagedDevScratch({ workspaceRoot, purpose: 'test-scratch' }, async lease => {
    lease.retain();
    const fixture = await seedRendererPerformanceFixture({ ownedRoot: lease.directory,
      dataRoot: path.join(lease.directory, 'profile'), products: 3, orders: 3, shops: 2 });
    assert.equal(fixture.initialShopId, 'ux-fixture-shop-2');
    const run = successfulRun();
    run.measuredShop = fixture.shopReceipts.find(receipt => receipt.shopId === fixture.initialShopId);
    for (const sample of run.measurement.samples) if (sample.pageId === 'products') sample.routeTableRowCount = 1;
    const options = parsePerformanceOptions(['--products=3', '--orders=3', '--shops=2']);
    const report = buildPerformanceReport([run], options);
    assert.equal(report.targetsMet, true);
    assert.equal(report.fixture.measuredProducts, 1);
    assert.equal(report.fixture.measuredShopId, fixture.initialShopId);
    delete run.measuredShop;
    assert.equal(buildPerformanceReport([run], options).targetsMet, false);
    disposeRendererPerformanceFixture(fixture, { ownedRoot: lease.directory });
  });
});

test('network preload records real isolated HTTP responses and blocks non-owned ports without contacting them', async () => {
  await withManagedDevScratch({ workspaceRoot, purpose: 'test-scratch' }, async (lease) => {
    let received = 0;
    const server = http.createServer((_request, response) => { received += 1; response.end('fixture'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const logPath = path.join(lease.directory, 'network.jsonl');
      const guard = path.join(workspaceRoot, 'desktop/scripts/performance-network-guard.cjs');
      const code = `
        import { createRequire } from 'node:module';
        const {installElectronGuard} = createRequire(import.meta.url)(${JSON.stringify(guard)});
        const denied = await fetch('http://127.0.0.1:9/must-not-connect').then(()=>false,e=>e.code==='PERFORMANCE_NON_FIXTURE_NETWORK_BLOCKED');
        let nativeCalls=0, invalidNativeRejected=false;
        try { installElectronGuard({}); } catch { invalidNativeRejected=true; }
        const electron={app:{},net:{fetch:async()=>{nativeCalls++;return new Response('native');},request:()=>{nativeCalls++;}}};
        installElectronGuard(electron);
        const nativeDenied=await electron.net.fetch('https://example.invalid/private').then(()=>false,e=>e.code==='PERFORMANCE_NON_FIXTURE_NETWORK_BLOCKED');
        let nativeRequestDenied=false;
        try {electron.net.request('https://example.invalid/private');} catch(e) {nativeRequestDenied=e.code==='PERFORMANCE_NON_FIXTURE_NETWORK_BLOCKED';}
        const nativeAllowed=(await electron.net.fetch('http://127.0.0.1:${port}/native')).status===200;
        const response = await fetch('http://127.0.0.1:${port}/api/cache/products');
        console.log(JSON.stringify({denied,nativeDenied,nativeRequestDenied,nativeAllowed,nativeCalls,invalidNativeRejected,status:response.status,body:await response.text()}));`;
      const child = spawn(process.execPath, ['--require', guard, '--input-type=module', '-e', code], { windowsHide: true,
        env: { ...process.env, WANGZAI_PERFORMANCE_ALLOWED_PORTS: String(port), WANGZAI_PERFORMANCE_NETWORK_LOG: logPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      lease.trackChild(child);
      let output = '', errors = '';
      child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { errors += chunk; });
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(exit, 0, errors);
      assert.deepEqual(JSON.parse(output), { denied: true, nativeDenied: true, nativeRequestDenied: true,
        nativeAllowed: true, nativeCalls: 1, invalidNativeRejected: true, status: 200, body: 'fixture' });
      assert.equal(received, 1);
      const log = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(log.some((row) => row.event === 'blocked' && row.port === 9));
      assert.ok(log.some((row) => row.event === 'response' && row.pathname === '/api/cache/products' && row.status === 200));
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

test('recovery workload rejects arbitrary DB paths and reads authoritative fixture shops without changing them', async () => {
  assert.throws(() => runFixtureRecoveryExport({ fixtureManifest: 'arbitrary.json' }));
  await withManagedDevScratch({ workspaceRoot, purpose: 'test-scratch' }, async (lease) => {
    lease.retain();
    const fixture = await seedRendererPerformanceFixture({ ownedRoot: lease.directory,
      dataRoot: path.join(lease.directory, 'profile'), products: 3, orders: 2, shops: 2 });
    const fixtureManifest = path.join(lease.directory, 'fixture.json');
    await fs.writeFile(fixtureManifest, JSON.stringify(fixture), { flag: 'wx' });
    const before = await Promise.all(fixture.shopReceipts.map((receipt) => fs.readFile(receipt.route.databasePath)));
    const result = runFixtureRecoveryExport({ fixtureManifest, rounds: 2 });
    assert.equal(result.ok, true); assert.equal(result.rounds, 2); assert.equal(result.authoritativeDatabases, 3);
    assert.equal(result.meaningfulExport, result.exportedRecords > 0 && result.totalCipherBytes > 0);
    assert.equal(result.cacheRowsAreNotBackupAcceptance, true);
    for (const [index, receipt] of fixture.shopReceipts.entries()) assert.deepEqual(await fs.readFile(receipt.route.databasePath), before[index]);
    const stale = structuredClone(fixture);
    stale.shopReceipts[0].route.scopeToken.shopIncarnation = 'wrong-incarnation';
    await fs.writeFile(fixtureManifest, JSON.stringify(stale));
    assert.throws(() => runFixtureRecoveryExport({ fixtureManifest }), /SHOP_/);
  });
});
