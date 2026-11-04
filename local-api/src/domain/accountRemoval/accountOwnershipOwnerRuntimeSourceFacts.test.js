import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getAccountOwnershipCatalog } from './accountOwnershipCatalog.js';
import { ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS } from './accountOwnershipSystemSourceFacts.js';
import {
  ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS,
  ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS_VERSION,
  discoverAccountOwnershipOwnerRuntimeSourceFacts,
  verifyAccountOwnershipOwnerRuntimeSourceFacts,
} from './accountOwnershipOwnerRuntimeSourceFacts.js';

const workspaceRoot = new URL('../../../../', import.meta.url);
const drift = /ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACT_DRIFT/u;

function currentScan() {
  const sourceFiles = new Set(ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS.flatMap((fact) => [fact.sourceFile, fact.rendererBinding.sourceFile]));
  const sourceByFile = new Map([...sourceFiles].map((file) => [file, readFileSync(new URL(file, workspaceRoot), 'utf8')]));
  return {
    sourceByFile,
    discoveredStateFacts: discoverAccountOwnershipOwnerRuntimeSourceFacts(sourceByFile),
    catalog: getAccountOwnershipCatalog(),
  };
}

function withChangedSource(scan, sourceFile, source) {
  const sourceByFile = new Map(scan.sourceByFile);
  sourceByFile.set(sourceFile, source);
  return { ...scan, sourceByFile, discoveredStateFacts: discoverAccountOwnershipOwnerRuntimeSourceFacts(sourceByFile) };
}

test('six post-B0 owner task Sets are source-bound to exact owner resources and consumer barriers, never system preservation', () => {
  const scan = currentScan();
  const before = structuredClone(scan.catalog);
  const actual = verifyAccountOwnershipOwnerRuntimeSourceFacts(scan);
  assert.equal(actual.length, 6);
  assert.deepEqual(actual.map((fact) => fact.sourceSymbol), [
    'productSourceLinkTasks', 'purchaseSourceLinkTasks', 'salesSourceLinkTasks',
    'productMaterialHydrations', 'purchaseOrderOverrideReads', 'crossBorderSettingsReads',
  ]);
  assert.deepEqual(actual.map((fact) => fact.ownerType), [
    'ozon_shop', 'ozon_shop', 'ozon_shop', 'ozon_shop', 'ozon_shop', 'cross_border_bus',
  ]);
  assert.ok(Object.isFrozen(ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS));
  for (const fact of actual) {
    assert.equal(fact.version, ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS_VERSION);
    assert.equal(fact.kind, 'set');
    assert.equal(fact.declaration, `const ${fact.sourceSymbol} = new Set();`);
    assert.equal(fact.preserveSystem, false);
    assert.notEqual(fact.disposition, 'preserve system');
    assert.equal(ACCOUNT_OWNERSHIP_SYSTEM_SOURCE_FACTS.some((system) => system.sourceFile === fact.sourceFile && system.sourceSymbol === fact.sourceSymbol), false);
    assert.ok(Object.isFrozen(fact));
    assert.ok(Object.isFrozen(fact.requiredSourceStatements));
    assert.ok(Object.isFrozen(fact.rendererBinding));
    assert.ok(Object.isFrozen(fact.rendererBinding.requiredSourceStatements));
    assert.match(fact.sourceSHA256, /^[A-F0-9]{64}$/u);
    assert.equal(scan.catalog.some((entry) => entry.id === fact.id), false, 'source proof must not add a deletion resource or change the frozen barrier DTO');
  }
  assert.deepEqual(scan.catalog, before, 'source facts must not mutate frozen ownership, selectors, or delete scope');
});

test('owner task source facts fail for missing, duplicate, renamed, relocated or Map discovery without weakening unrelated scanner rules', () => {
  const scan = currentScan();
  assert.equal(scan.discoveredStateFacts.length, 6);
  for (let index = 0; index < scan.discoveredStateFacts.length; index += 1) {
    const current = scan.discoveredStateFacts[index];
    for (const replacement of [
      { ...current, sourceFile: 'frontend/src/services/unreviewedOwnerTasks.js' },
      { ...current, sourceSymbol: `${current.sourceSymbol}Renamed` },
      { ...current, kind: 'map' },
      { ...current, declaration: current.declaration.replace('new Set()', 'new Set(ownerRows)') },
    ]) {
      const discoveries = [...scan.discoveredStateFacts];
      discoveries[index] = replacement;
      assert.throws(() => verifyAccountOwnershipOwnerRuntimeSourceFacts({ ...scan, discoveredStateFacts: discoveries }), drift);
    }
    assert.throws(() => verifyAccountOwnershipOwnerRuntimeSourceFacts({
      ...scan, discoveredStateFacts: scan.discoveredStateFacts.filter((_, item) => item !== index),
    }), drift);
    assert.throws(() => verifyAccountOwnershipOwnerRuntimeSourceFacts({
      ...scan, discoveredStateFacts: [...scan.discoveredStateFacts, current],
    }), drift);
  }
  const [first] = ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS;
  const duplicateFile = withChangedSource(scan, 'frontend/src/services/unreviewedOwnerTasks.js', first.declaration);
  assert.throws(() => verifyAccountOwnershipOwnerRuntimeSourceFacts(duplicateFile), drift);
});

test('every reviewed owner fence, task exclusion, drain, post-release guard and settled cleanup is bound to the complete source hash', () => {
  const scan = currentScan();
  for (const fact of ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS) {
    const source = scan.sourceByFile.get(fact.sourceFile);
    for (const statement of [fact.declaration, ...fact.requiredSourceStatements]) {
      assert.ok(source.includes(statement), `${fact.sourceSymbol}: missing production statement ${statement}`);
      for (const replacement of [`// ${statement}`, `/* ${statement} */`]) {
        assert.throws(() => verifyAccountOwnershipOwnerRuntimeSourceFacts(withChangedSource(scan, fact.sourceFile, source.replace(statement, replacement))), drift, statement);
      }
    }
    for (const changedSource of [
      source.replace(fact.declaration, fact.declaration.replace('new Set()', 'new Map()')),
      `${source}\nconst unreviewedOwnerReadTasks = new Set();\n`,
      `${source}\n// Source drift outside the listed guard lines is also unreviewed.\n`,
    ]) {
      assert.throws(() => verifyAccountOwnershipOwnerRuntimeSourceFacts(withChangedSource(scan, fact.sourceFile, changedSource)), drift);
    }
  }
});

test('owner source facts fail when the real caller stops draining or changes owner/lease release, or Catalog ownership changes', () => {
  const scan = currentScan();
  for (const fact of ACCOUNT_OWNERSHIP_OWNER_RUNTIME_SOURCE_FACTS) {
    const binding = fact.rendererBinding;
    const source = scan.sourceByFile.get(binding.sourceFile);
    for (const statement of binding.requiredSourceStatements) {
      assert.ok(source.includes(statement));
      assert.throws(() => verifyAccountOwnershipOwnerRuntimeSourceFacts(withChangedSource(scan, binding.sourceFile, source.replace(statement, `// ${statement}`))), drift);
    }
    const missingSource = new Map(scan.sourceByFile);
    missingSource.delete(fact.sourceFile);
    assert.throws(() => verifyAccountOwnershipOwnerRuntimeSourceFacts({ ...scan, sourceByFile: missingSource }), drift);
    for (const change of [{ ownerType: 'system' }, { availability: 'future-contract' }, { id: 'unknown-owner-resource' }]) {
      const catalog = structuredClone(scan.catalog);
      Object.assign(catalog.find((entry) => entry.id === fact.ownerResourceId), change);
      assert.throws(() => verifyAccountOwnershipOwnerRuntimeSourceFacts({ ...scan, catalog }), drift);
    }
  }
  assert.throws(() => verifyAccountOwnershipOwnerRuntimeSourceFacts({ ...scan, catalog: [] }), drift);
});
