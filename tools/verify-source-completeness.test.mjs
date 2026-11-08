import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditSourceCompleteness, compareOriginalSources, discoverSourceFiles } from './verify-source-completeness.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text = '// synthetic fixture') => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  return { root, write };
}

test('finds omitted source in a new top-level project even if the existing inventory is satisfied', t => {
  const { root, write } = fixture(t);
  write('src/main.js'); write('new-tool/start.ps1');
  const report = auditSourceCompleteness({ root, manifest: { files: [{ path: 'src/main.js' }] }, tracked: new Set(['src/main.js']) });
  assert.equal(report.ok, false);
  assert.ok(report.failures.some(f => f.path === 'new-tool/start.ps1' && f.reason === 'source-not-in-inventory'));
  assert.ok(report.failures.some(f => f.path === 'new-tool/start.ps1' && f.reason === 'source-not-tracked'));
});

test('inventories operational scripts without reading runtime data or downloaded dependencies', t => {
  const { root, write } = fixture(t);
  for (const name of ['admin-runtime/start.ps1', 'test-runtime/scripts/prepare.py', 'server/.env.example', 'node_modules/vendor/index.js', 'test-runtime/private/generated.py', '.selfhost/copy.py']) write(name);
  assert.deepEqual(discoverSourceFiles(root), ['admin-runtime/start.ps1', 'server/.env.example', 'test-runtime/scripts/prepare.py']);
});

test('original comparison detects missing untracked operational source and accepts relocated evidence test', t => {
  const original = fixture(t), published = fixture(t);
  original.write('test-runtime/start.ps1');
  original.write('test-runtime/private/local-secret.py');
  original.write('deploy/generated/local-config.py');
  original.write('local-api/test/productRealSkuEvidence.test.js');
  published.write('local-api/acceptance/productRealSkuEvidence.acceptance.mjs');
  const missing = compareOriginalSources({ originalRoot: original.root, publicRoot: published.root,
    mappings: { 'test-runtime': 'test-runtime', 'local-api': 'local-api', 'deploy': 'deploy' } });
  assert.deepEqual(missing, [{ path: 'test-runtime/start.ps1', reason: 'original-source-not-published' }]);
});
