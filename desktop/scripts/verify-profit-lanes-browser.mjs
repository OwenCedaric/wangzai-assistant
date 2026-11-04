import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setPriority, constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { withManagedDevScratch } from '../../tools/managed-dev-scratch.mjs';
import { build } from '../../frontend/node_modules/esbuild/lib/main.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const count = Number(process.argv.find(value => value.startsWith('--orders='))?.split('=')[1] || 2000);
assert.ok(Number.isSafeInteger(count) && count >= 10 && count <= 200000);
try { setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* optional */ }
const sourcePaths = ['frontend/src/features/profit/model/useProfitCalculationLanes.js',
  'frontend/src/features/profit/model/profitCalculationSignatures.js', 'frontend/src/services/profitShopCalculationLanes.js',
  'frontend/src/features/profit/model/__fixtures__/useProfitCalculationLanes.baseline.js',
  'frontend/src/features/profit/model/__fixtures__/profitShopCalculationLanes.baseline.js',
  'frontend/src/services/profitLedgerService.js', 'frontend/src/test/profitLanes.browser.fixture.jsx'];
const hashSources = () => sourcePaths.map(file => ({ path: file, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
await withManagedDevScratch({ workspaceRoot: root, purpose: 'test-scratch', ttlMs: 3600000 }, async lease => {
  const before = hashSources();
  const directory = path.join(lease.directory, 'profit-browser'); fs.mkdirSync(directory);
  await build({ entryPoints: [path.join(root, 'frontend/src/test/profitLanes.browser.fixture.jsx')],
    outfile: path.join(directory, 'bundle.js'), bundle: true, format: 'esm', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'unsafe-inline\'; connect-src \'none\'"><style>body{font:14px sans-serif;padding:24px}table{border-collapse:collapse}th,td{padding:5px 10px;border:1px solid #ddd}</style><div id="root"></div><script type="module" src="bundle.js"></script>');
  const executable = path.join(root, 'desktop/node_modules/electron/dist/electron.exe');
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const processes = []; let log = '';
  // Each implementation gets a fresh process and profile. Otherwise the old
  // hook's retained heap can distort the candidate's cold-start measurement.
  for (const mode of ['baseline', 'candidate']) {
    const child = spawn(executable, [path.join(root, 'desktop/scripts/profit-lanes-browser-host.cjs'), directory, String(count), mode], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data; process.stdout.write(data); });
    await lease.trackChild(child);
    const resultPath = path.join(directory, `result-${mode}.json`);
    const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : { complete: false, error: 'RESULT_MISSING' };
    processes.push({ ...result, mode, exitCode: child.exitCode, pid: child.pid });
    if (child.exitCode !== 0) break;
  }
  assert.deepEqual(hashSources(), before, 'source changed during measurement');
  const receipt = { kind: 'isolated-rendered-hook-not-full-client', orders: count, shops: 10,
    freshProcessPerImplementation: true, processes, stages: processes.flatMap(item => item.stages || []),
    complete: processes.length === 2 && processes.every(item => item.complete && item.exitCode === 0),
    executedAt: new Date().toISOString(), sourceFiles: before, fullClientAcceptance: false };
  const output = path.join(root, '.codex-temp/five-readiness-20260906/calculation'); fs.mkdirSync(output, { recursive: true });
  const name = `chromium-${count}-${lease.runId}`;
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(receipt, null, 2));
  fs.writeFileSync(path.join(output, `${name}.log`), log);
  assert.equal(receipt.complete, true);
  assert.ok(processes.every(item => item.hidden && !item.focused && item.networkCalls === 0 && item.blockedRequests === 0));
  assert.equal(receipt.stages.length, 4);
  assert.ok(receipt.stages.every(stage => stage.matchedLedgerHashes === count && stage.visibleRows === 20));
  console.log(JSON.stringify({ passed: true, orders: count, evidence: path.join(output, `${name}.json`) }));
});
