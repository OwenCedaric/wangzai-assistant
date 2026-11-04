import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DATA_DOMAIN_REGISTRY,
  classifyStorageTable,
  getDataDomain,
  getDataDomainForTable,
  getStorageTableClassification,
  validateDataDomainRegistry,
} from './dataDomainRegistry.js';
import { createMigratedTestDb } from '../../test/testDb.js';
import { DATA_DOMAIN_LIFECYCLE_FIELDS } from './dataDomainLifecycleDefaults.js';

test('data domain registry validates every current SQLite table and never guesses unknown ownership', () => {
  const db = createMigratedTestDb();
  try {
    const tableNames = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
    const missing = tableNames.filter((table) => !getDataDomainForTable(table));
    assert.deepEqual(missing, []);
    const invalidPrimaryKeys = DATA_DOMAIN_REGISTRY
      .filter((policy) => tableNames.includes(policy.canonicalTable))
      .map((policy) => ({
        domain: policy.domain,
        missing: policy.primaryKey.filter((column) => !db.prepare(`PRAGMA table_info("${policy.canonicalTable}")`).all().some((item) => item.name === column)),
      }))
      .filter((item) => item.missing.length);
    assert.deepEqual(invalidPrimaryKeys, []);
    assert.equal(classifyStorageTable('ozon_scheduler_trace_events'), 'technical_runtime');
    assert.equal(classifyStorageTable('purchase_order_overrides'), 'manual_account');
    assert.equal(classifyStorageTable('ozon_products'), 'canonical_fact');
    assert.equal(getDataDomain('products').schemaVersion, 2);
    assert.deepEqual(getDataDomain('products').legacyPrimaryKeys[1], [
      'shop_id',
      'product_key',
    ]);
    assert.equal(classifyStorageTable('not_registered'), 'unclassified');
    for (const policy of DATA_DOMAIN_REGISTRY) {
      for (const field of DATA_DOMAIN_LIFECYCLE_FIELDS) {
        assert.equal(typeof policy[field], 'string', `${policy.domain}.${field}`);
        assert.ok(policy[field].trim(), `${policy.domain}.${field}`);
      }
    }
    assert.deepEqual(getStorageTableClassification('purchase_order_overrides'), {
      registered: true,
      domain: 'purchase-overrides',
      ownerScope: 'shop',
      lifecycle: 'preserve',
      dataClass: 'fact',
      source: 'user',
      backup: 'required',
      rebuildable: false,
      ordinaryCacheClear: 'preserve',
    });
    assert.deepEqual(getStorageTableClassification('ozon_products'), {
      registered: true,
      domain: 'products',
      ownerScope: 'shop',
      lifecycle: 'preserve',
      dataClass: 'fact',
      source: 'ozon',
      backup: 'optional',
      rebuildable: true,
      ordinaryCacheClear: 'preserve',
    });
    assert.deepEqual(getStorageTableClassification('not_registered'), {
      registered: false,
      domain: null,
      ownerScope: 'unclassified',
      lifecycle: 'unclassified',
      dataClass: null,
      source: null,
      backup: null,
      rebuildable: null,
      ordinaryCacheClear: null,
    });
    assert.throws(() => getDataDomain('not_registered'), /DATA_DOMAIN_UNREGISTERED/);
  } finally {
    db.close();
  }
});

test('profit report caches are rebuildable shop-scoped Ozon data', () => {
  assert.deepEqual(getStorageTableClassification('ozon_finance_statement_reports'), {
    registered: true,
    domain: 'finance-statement-reports',
    ownerScope: 'shop',
    lifecycle: 'cache',
    dataClass: 'cache',
    source: 'ozon',
    backup: 'excluded',
    rebuildable: true,
    ordinaryCacheClear: 'preserve',
  });
  assert.deepEqual(getDataDomain('finance-statement-reports').primaryKey, [
    'shop_id',
    'period_id',
  ]);
  assert.deepEqual(getStorageTableClassification('ozon_finance_balance_snapshots'), {
    registered: true,
    domain: 'finance-balance-snapshots',
    ownerScope: 'shop',
    lifecycle: 'cache',
    dataClass: 'cache',
    source: 'ozon',
    backup: 'excluded',
    rebuildable: true,
    ordinaryCacheClear: 'preserve',
  });
  assert.deepEqual(getDataDomain('finance-balance-snapshots').primaryKey, [
    'shop_id',
    'id',
  ]);
});

test('data domain registry rejects unsafe scope and backup declarations at startup validation', () => {
  assert.deepEqual(validateDataDomainRegistry(DATA_DOMAIN_REGISTRY), {
    ok: true,
    domains: DATA_DOMAIN_REGISTRY.length,
    tables: DATA_DOMAIN_REGISTRY.length,
  });
  assert.throws(() => validateDataDomainRegistry([{
    domain: 'bad-shop-domain', canonicalTable: 'bad_table', scopeType: 'shop', dataClass: 'fact',
    source: 'user', backup: 'required', primaryKey: ['id'],
  }]), /DATA_DOMAIN_SHOP_SCOPE_KEY_REQUIRED/);
  assert.throws(() => validateDataDomainRegistry([{
    domain: 'bad-runtime-domain', canonicalTable: 'bad_runtime', scopeType: 'system', dataClass: 'runtime',
    source: 'system', backup: 'required', primaryKey: ['id'],
  }]), /DATA_DOMAIN_REBUILDABLE_MUST_NOT_BACKUP/);
  assert.throws(() => validateDataDomainRegistry([{
    domain: 'bad-cache-clear-domain', canonicalTable: 'bad_fact', scopeType: 'shop', dataClass: 'fact',
    source: 'ozon', backup: 'optional', primaryKey: ['shop_id', 'id'], rebuildable: true,
    ordinaryCacheClear: 'delete',
  }]), /DATA_DOMAIN_ORDINARY_CACHE_CLEAR_UNSAFE/);
  assert.throws(() => validateDataDomainRegistry([{
    domain: 'missing-lifecycle', canonicalTable: 'missing_lifecycle', scopeType: 'system', dataClass: 'config',
    source: 'system', backup: 'excluded', primaryKey: ['id'], rebuildable: true,
  }]), /DATA_DOMAIN_LIFECYCLE_REQUIRED/);
  assert.deepEqual(
    DATA_DOMAIN_REGISTRY
      .filter((policy) => policy.ordinaryCacheClear === 'delete')
      .map((policy) => policy.canonicalTable)
      .sort(),
    ['ozon_cache_keys', 'ozon_response_cache'],
  );
});
