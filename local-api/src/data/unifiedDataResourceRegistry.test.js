import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCOUNT_OWNERSHIP_CATALOG } from '../domain/accountRemoval/accountOwnershipCatalog.js';
import { DATA_DOMAIN_REGISTRY, loadUnifiedDataResourceRegistry } from './dataDomainRegistry.js';
import {
  assertAccountRemovalAllowlistReconciled,
  DATA_RESOURCE_REGISTRY,
  DATA_RESOURCE_REGISTRY_VALIDATION,
  getAccountRemovalResourceIds,
  getDataResource,
  getOrdinaryCacheClearResourceIds,
  listDataResources,
  validateDataResourceRegistry,
} from './unifiedDataResourceRegistry.js';

test('unified registry covers every SQLite, file, memory, browser, runtime and remote resource', () => {
  assert.equal(DATA_RESOURCE_REGISTRY.length, ACCOUNT_OWNERSHIP_CATALOG.length);
  assert.equal(DATA_RESOURCE_REGISTRY_VALIDATION.ok, true);
  assert.equal(DATA_RESOURCE_REGISTRY_VALIDATION.resources, ACCOUNT_OWNERSHIP_CATALOG.length);
  assert.equal(DATA_RESOURCE_REGISTRY_VALIDATION.sqliteDomains, DATA_DOMAIN_REGISTRY.length);
  assert.deepEqual(
    DATA_RESOURCE_REGISTRY.map((entry) => [entry.id, entry.storageKind]),
    ACCOUNT_OWNERSHIP_CATALOG.map((entry) => [entry.id, entry.storageKind]),
  );
  assert.ok(DATA_RESOURCE_REGISTRY.some((entry) => entry.physicalResourceType === 'sqlite-table'));
  for (const storageKind of ['filesystem', 'memory', 'runtime', 'backup-remote', 'browser-profile']) {
    assert.ok(DATA_RESOURCE_REGISTRY.some((entry) => entry.storageKind === storageKind));
  }
  for (const entry of DATA_RESOURCE_REGISTRY) {
    assert.equal(getDataResource(entry.id), entry);
    assert.ok(entry.retentionPolicy);
    assert.ok(entry.cachePolicy);
    assert.ok(entry.syncPolicy);
    assert.ok(entry.accountRemovalDisposition);
    assert.ok(entry.rebuildStrategy);
    assert.ok(entry.provenancePolicy);
    assert.ok(entry.sourceEvidence);
    assert.ok(entry.verifyQuery);
  }
});

test('DataDomainRegistry exposes the unified physical-resource extension without a module cycle', async () => {
  const loaded = await loadUnifiedDataResourceRegistry();
  assert.equal(loaded.validation.ok, true);
  assert.equal(loaded.resources, DATA_RESOURCE_REGISTRY);
  assert.equal(loaded.version, DATA_RESOURCE_REGISTRY_VALIDATION.version);
});

test('unknown resources are fail-closed and can never enter cache or deletion allowlists', () => {
  const unknown = listDataResources({ ownerType: 'unknown' });
  assert.ok(unknown.length >= 0);
  for (const entry of unknown) {
    assert.equal(entry.protectionMode, 'fail-closed');
    assert.equal(entry.removable, false);
    assert.equal(entry.ordinaryCacheClearDisposition, 'preserve');
    assert.equal(entry.accountRemovalDisposition, 'prohibited-unknown-owner-protect');
  }
  const clearIds = new Set(getOrdinaryCacheClearResourceIds());
  assert.equal(unknown.some((entry) => clearIds.has(entry.id)), false);
});

test('account deletion allowlists reconcile exactly against the unified registry', () => {
  for (const ownerType of ['ozon_shop', 'cross_border_bus', 'promotion_account', 'purchase_account', 'model_api_account']) {
    const ids = getAccountRemovalResourceIds(ownerType);
    const result = assertAccountRemovalAllowlistReconciled(ownerType, [...ids].reverse());
    assert.equal(result.ok, true);
    assert.deepEqual(result.resourceIds, ids);
    assert.throws(
      () => assertAccountRemovalAllowlistReconciled(ownerType, ids.slice(1)),
      /DATA_RESOURCE_DELETE_ALLOWLIST_DRIFT/u,
    );
    assert.throws(
      () => assertAccountRemovalAllowlistReconciled(ownerType, [...ids, 'filesystem:not-registered']),
      /DATA_RESOURCE_DELETE_ALLOWLIST_UNKNOWN/u,
    );
  }
});

test('registry validation rejects unsafe unknown and ordinary-cache policies', () => {
  // Keep this negative contract executable even after every production entry
  // has acquired a typed owner.  Relabel one existing id as a synthetic
  // unknown and make it removable; validation must fail before any allowlist
  // can be derived from it.
  const unsafeUnknown = DATA_RESOURCE_REGISTRY.map((entry, index) => (
    index === 0
      ? {
          ...entry,
          owner: { ...entry.owner, type: 'unknown' },
          removable: true,
          ordinaryCacheClearDisposition: 'preserve',
          accountRemovalDisposition: 'prohibited-unknown-owner-protect',
        }
      : entry
  ));
  assert.throws(() => validateDataResourceRegistry(unsafeUnknown), /DATA_RESOURCE_UNKNOWN_MUST_PROTECT/u);

  const clearIndex = DATA_RESOURCE_REGISTRY.findIndex(
    (entry) => entry.ordinaryCacheClearDisposition === 'delete',
  );
  assert.ok(clearIndex >= 0);
  const unsafeClear = DATA_RESOURCE_REGISTRY.map((entry, index) => (
    index === clearIndex ? { ...entry, dataClass: 'fact' } : entry
  ));
  assert.throws(() => validateDataResourceRegistry(unsafeClear), /DATA_RESOURCE_CACHE_CLEAR_UNSAFE/u);
});
