import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CURRENT_DISCOVERY_REVIEWS, CATALOG_RELOCATION_REVIEWS, verifyCurrentDiscoveryReviews, resolveReviewedCatalogRelocation } from './accountOwnershipCurrentDiscoveryReviews.js';
import { ACCOUNT_OWNERSHIP_CATALOG } from './accountOwnershipCatalog.js';

const workspace = new URL('../../../../', import.meta.url);
function scan() {
  const files = [...CURRENT_DISCOVERY_REVIEWS, ...CATALOG_RELOCATION_REVIEWS].flatMap(record => [record, ...record.supportingSources]);
  return {
    sourceByFile: new Map(files.map(binding => [binding.sourceFile, readFileSync(new URL(binding.sourceFile, workspace), 'utf8')])),
    discoveredStateFacts: CURRENT_DISCOVERY_REVIEWS.map(record => ({
      sourceFile: record.sourceFile, sourceSymbol: record.sourceSymbol,
      structured: { kind: record.kind, declaration: record.sourceSymbol },
    })),
  };
}
const drift = /ACCOUNT_OWNERSHIP_CURRENT_DISCOVERY_DRIFT/u;

test('current discovery review covers exact sources without mutating or reclassifying the frozen Catalog', () => {
  const input = scan();
  const before = [...input.sourceByFile];
  const results = verifyCurrentDiscoveryReviews(input);
  assert.equal(results.length, 6);
  assert.deepEqual([...input.sourceByFile], before);
  const marketing = results.filter(record => record.classification === 'relocated-catalog-resource');
  assert.deepEqual(marketing.map(record => record.catalogResourceId), [
    'memory:renderer-marketing-activity-runtime-cache', 'runtime:renderer-marketing-view-state-write-queue',
  ]);
  for (const record of results) {
    assert.ok(Object.isFrozen(record));
    assert.equal('deletePrimitive' in record, false);
    assert.equal('ownerType' in record, false, 'source review does not override existing owner classification');
  }
});

test('every reviewed discovery rejects changed code, removed guards and supporting source drift', () => {
  for (const record of CURRENT_DISCOVERY_REVIEWS) {
    for (const binding of [record, ...record.supportingSources]) {
      const input = scan();
      input.sourceByFile.set(binding.sourceFile, input.sourceByFile.get(binding.sourceFile) + '\nconst unexpectedOwnerCache = new Map();\n');
      assert.throws(() => verifyCurrentDiscoveryReviews(input), drift);
      input.sourceByFile.delete(binding.sourceFile);
      assert.throws(() => verifyCurrentDiscoveryReviews(input), drift);
    }
    for (const guard of record.requiredSourceStatements) {
      const input = scan();
      const source = input.sourceByFile.get(record.sourceFile);
      assert.ok(source.includes(guard));
      input.sourceByFile.set(record.sourceFile, source.replace(guard, `// ${guard}`));
      assert.throws(() => verifyCurrentDiscoveryReviews(input), drift);
    }
  }
});

test('reviews never exempt a different file, symbol or kind, and reject duplicate discoveries', () => {
  for (let index = 0; index < CURRENT_DISCOVERY_REVIEWS.length; index++) {
    const input = scan();
    const original = input.discoveredStateFacts[index];
    input.discoveredStateFacts.push(original);
    assert.throws(() => verifyCurrentDiscoveryReviews(input), drift);
    input.discoveredStateFacts.pop();
    input.discoveredStateFacts[index] = { ...original, structured: { kind: 'unexpected', declaration: original.sourceSymbol } };
    assert.throws(() => verifyCurrentDiscoveryReviews(input), drift);
    for (const changed of [{ sourceFile: 'frontend/src/services/unreviewed.js' }, { sourceSymbol: 'orphanOwnerRuntime' }]) {
      input.discoveredStateFacts[index] = { ...original, ...changed };
      const result = verifyCurrentDiscoveryReviews(input);
      assert.equal(result.length, 5);
      assert.ok(result.every(record => record.discovery !== input.discoveredStateFacts[index]));
    }
  }
});

test('relocation cannot accept modified ownership, deletion scope, resource identity or re-export source', () => {
  for (const record of CATALOG_RELOCATION_REVIEWS) {
    const input = scan();
    const entry = ACCOUNT_OWNERSHIP_CATALOG.find(entry => entry.id === record.catalogResourceId);
    assert.equal(resolveReviewedCatalogRelocation(entry, input.sourceByFile).sourceFile, record.sourceFile);
    for (const changes of [
      { id: `${entry.id}-unreviewed` }, { ownerType: 'ozon_shop' }, { deletePrimitive: 'unsafe-bulk-delete' },
      { sourceEvidence: { ...entry.sourceEvidence, sourceSymbol: 'unreviewedCache' } },
    ]) {
      assert.equal(resolveReviewedCatalogRelocation({ ...entry, ...changes }, input.sourceByFile), null);
    }
    for (const binding of [record, ...record.supportingSources]) {
      const changed = scan();
      changed.sourceByFile.set(binding.sourceFile, changed.sourceByFile.get(binding.sourceFile) + '\n// unreviewed change\n');
      assert.throws(() => resolveReviewedCatalogRelocation(entry, changed.sourceByFile), drift);
    }
  }
});
