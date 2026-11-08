import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');

test('public source CI and real evidence acceptance remain distinct and both stay mandatory in the full suite', () => {
  const pkg = JSON.parse(read('local-api/package.json'));
  assert.equal(pkg.scripts['test:source'], 'node --test');
  assert.equal(pkg.scripts['test:evidence'], 'node --test acceptance/productRealSkuEvidence.acceptance.mjs');
  assert.equal(pkg.scripts.test, 'npm run test:source && npm run test:evidence');
  const sourceWorkflow = read('.github/workflows/source-checks.yml');
  const releaseWorkflow = read('.github/workflows/release-readiness.yml');
  assert.match(sourceWorkflow, /npm run test:source --prefix local-api/u);
  assert.match(releaseWorkflow, /npm run test:evidence --prefix local-api/u);
  assert.match(releaseWorkflow, /npm run evidence:sku --prefix local-api/u);
  assert.match(releaseWorkflow, /node tools\/release-readiness\.mjs --check/u);
  assert.doesNotMatch(sourceWorkflow + releaseWorkflow, /continue-on-error|test-skip-pattern|\|\|\s*true/u);
});

test('all four real evidence acceptance assertions survive the move byte-for-byte', () => {
  const content = readFileSync(new URL('local-api/acceptance/productRealSkuEvidence.acceptance.mjs', root));
  assert.equal(createHash('sha256').update(content).digest('hex'), '24bd3637b1b8d1366c8ee627e57ffeb20444cea579d9b425816e5564e959c2e3');
  assert.equal((content.toString().match(/^test\(/gmu) || []).length, 4);
  assert.doesNotMatch(content.toString(), /test\.(?:skip|todo)|skip\s*:/u);
});
