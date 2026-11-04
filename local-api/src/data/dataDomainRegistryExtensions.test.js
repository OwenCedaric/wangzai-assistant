import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryExporter } from '../backup/recoveryExporter.js';
import { createRecoveryImporter } from '../backup/recoveryImporter.js';
import {
  createRecoveryProfileCore,
  createRecoveryProfileCoreImporter,
} from '../backup/recoveryProfileCore.js';
import { createAccountRemovalSqliteExecutor } from '../domain/accountRemoval/accountRemovalSqliteExecutor.js';
import { ACCOUNT_REMOVAL_SQLITE_RESOURCES } from '../domain/accountRemoval/accountRemovalSqliteCatalog.js';
import { ACCOUNT_OWNERSHIP_CATALOG } from '../domain/accountRemoval/accountOwnershipCatalog.js';
import { decryptSecret, encryptSecret } from '../security/secretCrypto.js';
import { createMigratedTestDb } from '../../test/testDb.js';
import {
  DATA_DOMAIN_REGISTRY,
  getDataDomainForTable,
} from './dataDomainRegistry.js';
import {
  DATA_DOMAIN_REGISTRY_EXTENSION_INPUTS,
  DATA_DOMAIN_REGISTRY_EXTENSION_TABLES,
} from './dataDomainRegistryExtensions.js';

const EXPECTED_EXTENSION_TABLES = Object.freeze([
  'product_acquiring_facts',
  'product_attribute_facts',
  'product_commission_facts',
  'product_detail_facts',
  'product_dimension_facts',
  'product_facet_observations',
  'product_identities',
  'product_image_facts',
  'product_price_facts',
  'product_status_facts',
  'product_stock_facts',
  'product_sync_outbox',
  'product_sync_page_proofs',
  'product_sync_quarantine',
  'product_sync_runs',
  'product_sync_stage_batches',
  'product_warehouse_stock_facts',
  'purchase_completion_history',
  'shared_catalog_attribute_values',
  'shared_catalog_attributes',
  'shared_catalog_categories',
  'shared_catalog_entity_sources',
  'shared_catalog_import_runs',
  'shared_catalog_quarantine',
  'shared_catalog_types',
  'shared_catalog_versions',
  'shop_bootstrap_runs',
  'shop_domain_sync_state',
  'shop_identity_tombstones',
]);

const REQUIRED_LIFECYCLE_FIELDS = Object.freeze([
  'retentionPolicy',
  'cachePolicy',
  'syncPolicy',
  'accountRemovalDisposition',
  'spaceReleaseDisposition',
  'domainRebuildDisposition',
  'rebuildStrategy',
  'provenancePolicy',
]);

test('migrations 058-062 register exactly 29 physical resources with explicit lifecycle and fail-closed clear semantics', () => {
  assert.deepEqual([...DATA_DOMAIN_REGISTRY_EXTENSION_TABLES].sort(), [...EXPECTED_EXTENSION_TABLES].sort());
  assert.equal(DATA_DOMAIN_REGISTRY_EXTENSION_INPUTS.length, 29);
  for (const extension of DATA_DOMAIN_REGISTRY_EXTENSION_INPUTS) {
    const registered = getDataDomainForTable(extension.canonicalTable);
    assert.ok(registered, extension.canonicalTable);
    assert.equal(registered.domain, extension.domain);
    assert.equal(registered.ordinaryCacheClear, 'preserve', extension.domain);
    assert.equal(Object.isFrozen(registered), true, extension.domain);
    for (const field of REQUIRED_LIFECYCLE_FIELDS) {
      assert.equal(typeof registered[field], 'string', `${extension.domain}.${field}`);
      assert.ok(registered[field].length > 0, `${extension.domain}.${field}`);
    }
    if (registered.scopeType === 'shop') {
      assert.equal(registered.primaryKey[0], 'shop_id', extension.domain);
      assert.equal(registered.accountRemovalDisposition, 'delete-with-shop', extension.domain);
    } else {
      assert.equal(registered.scopeType, 'profile', extension.domain);
      assert.equal(registered.accountRemovalDisposition, 'preserve', extension.domain);
    }
  }
  assert.deepEqual(
    DATA_DOMAIN_REGISTRY.filter((policy) => policy.ordinaryCacheClear === 'delete').map((policy) => policy.canonicalTable).sort(),
    ['ozon_cache_keys', 'ozon_response_cache'],
  );
  assert.equal(getDataDomainForTable('future_unknown_table'), null);
});

test('shop-owned 058-062 resources exactly match the reviewed Ozon deletion allowlist while shared catalog and tombstones remain unplannable', () => {
  const extensionShopEntries = DATA_DOMAIN_REGISTRY_EXTENSION_INPUTS.filter((entry) => entry.scopeType === 'shop');
  const extensionProfileEntries = DATA_DOMAIN_REGISTRY_EXTENSION_INPUTS.filter((entry) => entry.scopeType === 'profile');
  const allowlistIds = new Set(ACCOUNT_REMOVAL_SQLITE_RESOURCES.ozon_shop.map((entry) => entry.resourceId));
  assert.equal(extensionShopEntries.length, 20);
  assert.equal(extensionProfileEntries.length, 9);
  assert.deepEqual(
    extensionShopEntries.filter((entry) => !allowlistIds.has(`registry:${entry.domain}`)).map((entry) => entry.domain),
    [],
  );
  assert.deepEqual(
    extensionProfileEntries.filter((entry) => allowlistIds.has(`registry:${entry.domain}`)).map((entry) => entry.domain),
    [],
  );
  for (const policy of extensionProfileEntries) {
    const ownership = ACCOUNT_OWNERSHIP_CATALOG.find((entry) => entry.id === `registry:${policy.domain}`);
    assert.ok(ownership, policy.domain);
    assert.equal(ownership.ownerType, 'system', policy.domain);
    assert.equal(ownership.removable, false, policy.domain);
    assert.equal(ownership.verifyQuery.type, 'preserve', policy.domain);
  }

  const packagedSeed = ACCOUNT_OWNERSHIP_CATALOG.find(
    (entry) => entry.id === 'filesystem:software-category-tree-static',
  );
  assert.ok(packagedSeed);
  assert.equal(packagedSeed.ownerType, 'system');
  assert.equal(packagedSeed.removable, false);
  assert.equal(packagedSeed.verifyQuery.type, 'preserve');
  assert.equal(packagedSeed.resource, 'local-api/assets/ozonCategoryTree.zh.json packaged seed');

  const sharedCategoryIndex = ACCOUNT_OWNERSHIP_CATALOG.find(
    (entry) => entry.id === 'memory:local-api-software-category-name-index',
  );
  assert.ok(sharedCategoryIndex);
  assert.equal(sharedCategoryIndex.ownerType, 'system');
  assert.equal(sharedCategoryIndex.removable, false);
  assert.equal(sharedCategoryIndex.verifyQuery.type, 'preserve');
});

test('permanent Ozon shop SQLite deletion preserves shared catalog provenance and identity tombstones byte-for-byte', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare("INSERT INTO shops (id, name, status) VALUES ('shop-delete', 'Delete', 'active')").run();
    db.prepare("INSERT INTO shops (id, name, status) VALUES ('shop-keep', 'Keep', 'active')").run();
    db.prepare(`
      INSERT INTO shared_catalog_versions (
        catalog_id, platform, marketplace, locale, contract_version,
        mapper_version, source_kind, source_summary_json
      ) VALUES ('catalog-ru-1', 'ozon', 'ru', 'zh-CN', 'v3', 'mapper-v1', 'packaged_seed', '{}')
    `).run();
    db.prepare(`
      INSERT INTO shared_catalog_import_runs (
        import_id, catalog_id, source_kind, source_shop_id, source_ref_hash,
        contract_version, mapper_version, payload_hash, status, started_at, completed_at
      ) VALUES (
        'import-delete-provenance', 'catalog-ru-1', 'remote', 'shop-delete', ?,
        'v3', 'mapper-v1', ?, 'completed', ?, ?
      )
    `).run('a'.repeat(64), 'b'.repeat(64), '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:01.000Z');
    db.prepare(`
      INSERT INTO shop_identity_tombstones (
        tombstone_id, profile_id, former_shop_id, external_identity_hash,
        former_shop_incarnation, final_credential_revision, deletion_operation_id,
        metadata_json, deleted_at, created_at
      ) VALUES (
        'tombstone-older', 'default', 'shop-older', ?, 'inc-old', 3,
        'delete-op-older', '{}', ?, ?
      )
    `).run('c'.repeat(64), '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
    const preservedBefore = {
      versions: db.prepare('SELECT * FROM shared_catalog_versions ORDER BY catalog_id').all(),
      imports: db.prepare('SELECT * FROM shared_catalog_import_runs ORDER BY import_id').all(),
      tombstones: db.prepare('SELECT * FROM shop_identity_tombstones ORDER BY tombstone_id').all(),
    };

    const result = createAccountRemovalSqliteExecutor({ db }).execute({
      ownerType: 'ozon_shop',
      ownerId: 'shop-delete',
    });

    assert.equal(result.deletedRows['registry:shops'], 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shops WHERE id = 'shop-delete'").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shops WHERE id = 'shop-keep'").get().count, 1);
    assert.deepEqual(
      {
        versions: db.prepare('SELECT * FROM shared_catalog_versions ORDER BY catalog_id').all(),
        imports: db.prepare('SELECT * FROM shared_catalog_import_runs ORDER BY import_id').all(),
        tombstones: db.prepare('SELECT * FROM shop_identity_tombstones ORDER BY tombstone_id').all(),
      },
      preservedBefore,
    );
  } finally {
    db.close();
  }
});

test('profile-core recovery rewraps encrypted purchase completion history as a required shop-owned fact', () => {
  const source = createMigratedTestDb();
  const target = createMigratedTestDb();
  const shopId = 'shop-purchase-history-recovery';
  const timestamp = '2026-07-16T01:30:00.000Z';
  const encryptionKey = Buffer.alloc(32, 71);
  const dedupeKey = Buffer.alloc(32, 72);
  const aad = 'purchase-completion-history-recovery';
  try {
    source.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)').run(shopId, 'Source', 'active');
    source.prepare(`
      INSERT INTO purchase_completion_history (
        shop_id, source_task_id, source_receipt_id,
        source_account_ref_hash, order_number_hash, receipt_encrypted,
        receipt_hash, website_readback_hash, order_product_encrypted,
        order_product_hash, source_summary_encrypted, source_summary_hash,
        archive_origin, completed_at, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      shopId,
      'legacy-task-recovery',
      'legacy-receipt-recovery',
      'a'.repeat(64),
      'b'.repeat(64),
      encryptSecret(JSON.stringify({ orderNumber: 'PDD-RECOVERY-1', amount: '31.20' })),
      'c'.repeat(64),
      'd'.repeat(64),
      encryptSecret(JSON.stringify({ orderKey: 'ozon-order-1', productKey: 'ozon-product-1' })),
      'e'.repeat(64),
      encryptSecret(JSON.stringify({ sourceKind: 'purchase-browser', sourceHost: 'yangkeduo.com' })),
      'f'.repeat(64),
      'purchase-account-removal',
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    );

    const candidate = createRecoveryProfileCore({
      db: source,
      decryptShopSecret: decryptSecret,
    }).buildCandidate({
      encryptionKey,
      dedupeKey,
      aad,
    });
    assert.equal(candidate.domains.some((entry) => entry.domain === 'purchase-completion-history'), true);
    const restored = createRecoveryProfileCoreImporter({
      db: target,
      encryptShopSecret: encryptSecret,
    }).importCandidate({
      candidate,
      encryptionKey,
      aad,
    });
    assert.equal(restored.purchaseCompletionHistory, 1);
    const sourceRow = source.prepare('SELECT * FROM purchase_completion_history WHERE shop_id = ?').get(shopId);
    const targetRow = target.prepare('SELECT * FROM purchase_completion_history WHERE shop_id = ?').get(shopId);
    for (const field of ['receipt_encrypted', 'order_product_encrypted', 'source_summary_encrypted']) {
      assert.deepEqual(JSON.parse(decryptSecret(targetRow[field])), JSON.parse(decryptSecret(sourceRow[field])));
    }
    assert.deepEqual(
      Object.fromEntries(Object.entries(targetRow).filter(([key]) => !key.endsWith('_encrypted'))),
      Object.fromEntries(Object.entries(sourceRow).filter(([key]) => !key.endsWith('_encrypted'))),
    );
    assert.deepEqual(target.prepare('PRAGMA foreign_key_check;').all(), []);
  } finally {
    source.close();
    target.close();
  }
});

test('core-only recovery restores product identity before non-rebuildable user dimensions even when manifest order is reversed', () => {
  const source = createMigratedTestDb();
  const target = createMigratedTestDb();
  const shopId = 'shop-dimension-recovery';
  const identityId = 'product-identity-recovery';
  const observedAt = '2026-07-16T00:00:00.000Z';
  const encryptionKey = Buffer.alloc(32, 61);
  const dedupeKey = Buffer.alloc(32, 62);
  const aad = 'registry-extension-recovery';
  try {
    source.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)').run(shopId, 'Source', 'active');
    target.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)').run(shopId, 'Target', 'active');
    source.prepare(`
      INSERT INTO product_identities (
        product_identity_id, shop_id, product_id, offer_id, sku, source,
        mapper_version, observed_at, row_hash, created_at, updated_at
      ) VALUES (?, ?, '4674301534', 'mzr-20260520-638834907-9348', 'mzr-20260520-638834907-9348',
        'ozon', 'identity-v1', ?, ?, ?, ?)
    `).run(identityId, shopId, observedAt, 'd'.repeat(64), observedAt, observedAt);
    source.prepare(`
      INSERT INTO product_dimension_facts (
        product_identity_id, shop_id, source_type, source_priority,
        weight_g, length_mm, width_mm, height_mm,
        mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 'user', 100, 125, 310, 220, 90, 'manual-v1', ?, ?, ?)
    `).run(identityId, shopId, observedAt, 'e'.repeat(64), observedAt);

    const candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId,
      encryptionKey,
      dedupeKey,
      aad,
      mode: 'core-only',
    });
    assert.deepEqual(candidate.domains.map((entry) => entry.domain), [
      'product-identities',
      'product-dimension-facts',
    ]);
    const reversedCandidate = { ...candidate, domains: [...candidate.domains].reverse() };
    const restored = createRecoveryImporter({ db: target }).importShopCandidate({
      candidate: reversedCandidate,
      encryptionKey,
      aad,
      expectedShopId: shopId,
    });
    assert.deepEqual(restored.domains.map((entry) => entry.domain), [
      'product-identities',
      'product-dimension-facts',
    ]);
    assert.deepEqual(
      { ...target.prepare(`
        SELECT source_type, source_priority, weight_g, length_mm, width_mm, height_mm
        FROM product_dimension_facts
        WHERE shop_id = ? AND product_identity_id = ?
      `).get(shopId, identityId) },
      {
        source_type: 'user',
        source_priority: 100,
        weight_g: 125,
        length_mm: 310,
        width_mm: 220,
        height_mm: 90,
      },
    );
    assert.deepEqual(target.prepare('PRAGMA foreign_key_check;').all(), []);
  } finally {
    source.close();
    target.close();
  }
});

test('standard recovery keeps normalized canonical attributes instead of applying the legacy raw-payload exclusion', () => {
  const source = createMigratedTestDb();
  const target = createMigratedTestDb();
  const shopId = 'shop-attribute-recovery';
  const identityId = 'product-identity-attribute';
  const observedAt = '2026-07-16T00:05:00.000Z';
  const attributes = [{ id: 85, name: '颜色', values: [{ dictionary_value_id: 1, value: '红色' }] }];
  const encryptionKey = Buffer.alloc(32, 63);
  const dedupeKey = Buffer.alloc(32, 64);
  const aad = 'registry-extension-attribute-recovery';
  try {
    source.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)').run(shopId, 'Source', 'active');
    target.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)').run(shopId, 'Target', 'active');
    source.prepare(`
      INSERT INTO product_identities (
        product_identity_id, shop_id, product_id, source, mapper_version,
        observed_at, row_hash, created_at, updated_at
      ) VALUES (?, ?, 'product-attribute-1', 'ozon', 'identity-v1', ?, ?, ?, ?)
    `).run(identityId, shopId, observedAt, 'f'.repeat(64), observedAt, observedAt);
    source.prepare(`
      INSERT INTO product_attribute_facts (
        product_identity_id, shop_id, attributes_json, mapper_version,
        observed_at, row_hash, updated_at
      ) VALUES (?, ?, ?, 'attributes-v1', ?, ?, ?)
    `).run(identityId, shopId, JSON.stringify(attributes), observedAt, '1'.repeat(64), observedAt);

    const candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId,
      encryptionKey,
      dedupeKey,
      aad,
      mode: 'standard',
    });
    assert.deepEqual(candidate.domains.map((entry) => entry.domain), [
      'product-identities',
      'product-attribute-facts',
    ]);
    createRecoveryImporter({ db: target }).importShopCandidate({
      candidate,
      encryptionKey,
      aad,
      expectedShopId: shopId,
    });
    assert.deepEqual(
      JSON.parse(target.prepare(`
        SELECT attributes_json FROM product_attribute_facts
        WHERE shop_id = ? AND product_identity_id = ?
      `).get(shopId, identityId).attributes_json),
      attributes,
    );
  } finally {
    source.close();
    target.close();
  }
});

test('standard recovery round-trips every normalized product fact table in dependency-safe order', () => {
  const source = createMigratedTestDb();
  const target = createMigratedTestDb();
  const shopId = 'shop-all-normalized-facts';
  const identityId = 'product-all-normalized-facts';
  const observedAt = '2026-07-16T00:10:00.000Z';
  const mapperVersion = 'normalized-recovery-v1';
  const encryptionKey = Buffer.alloc(32, 65);
  const dedupeKey = Buffer.alloc(32, 66);
  const aad = 'registry-extension-all-normalized-recovery';
  try {
    source.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)').run(shopId, 'Source', 'active');
    target.prepare('INSERT INTO shops (id, name, status) VALUES (?, ?, ?)').run(shopId, 'Target', 'active');
    source.prepare(`
      INSERT INTO product_identities (
        product_identity_id, shop_id, product_id, offer_id, source, mapper_version,
        observed_at, row_hash, created_at, updated_at
      ) VALUES (?, ?, 'normalized-product-1', 'normalized-offer-1', 'ozon', ?, ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, '2'.repeat(64), observedAt, observedAt);
    source.prepare(`
      INSERT INTO product_status_facts (
        product_identity_id, shop_id, visibility, mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 'visible', ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, '3'.repeat(64), observedAt);
    source.prepare(`
      INSERT INTO product_detail_facts (
        product_identity_id, shop_id, name, category_id, mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 'Normalized Product', 'category-1', ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, '4'.repeat(64), observedAt);
    source.prepare(`
      INSERT INTO product_dimension_facts (
        product_identity_id, shop_id, source_type, source_priority, weight_g,
        length_mm, width_mm, height_mm, mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 'user', 100, 500, 400, 300, 200, ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, '5'.repeat(64), observedAt);
    source.prepare(`
      INSERT INTO product_price_facts (
        product_identity_id, shop_id, amount_minor, currency_code, mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 12345, 'RUB', ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, '6'.repeat(64), observedAt);
    source.prepare(`
      INSERT INTO product_commission_facts (
        product_identity_id, shop_id, fulfillment_type, rate_ppm, status,
        mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 'FBO', 150000, 'returned', ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, '7'.repeat(64), observedAt);
    source.prepare(`
      INSERT INTO product_acquiring_facts (
        product_identity_id, shop_id, fee_minor, currency_code, rate_ppm, status,
        mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 125, 'RUB', 10000, 'returned', ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, '8'.repeat(64), observedAt);
    source.prepare(`
      INSERT INTO product_stock_facts (
        product_identity_id, shop_id, present_quantity, status,
        mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 19, 'returned', ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, '9'.repeat(64), observedAt);
    source.prepare(`
      INSERT INTO product_warehouse_stock_facts (
        product_identity_id, shop_id, warehouse_key, warehouse_id, fulfillment_type,
        present_quantity, reserved_quantity, mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 'warehouse-1', 'warehouse-1', 'FBO', 19, 2, ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, 'a'.repeat(64), observedAt);
    source.prepare(`
      INSERT INTO product_image_facts (
        product_identity_id, shop_id, image_index, image_url, is_primary,
        mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 0, 'https://example.invalid/image.jpg', 1, ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, 'b'.repeat(64), observedAt);
    source.prepare(`
      INSERT INTO product_attribute_facts (
        product_identity_id, shop_id, attributes_json, mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, '[{"id":85,"value":"red"}]', ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, 'c'.repeat(64), observedAt);
    source.prepare(`
      INSERT INTO product_facet_observations (
        product_identity_id, shop_id, facet, status, mapper_version, observed_at, row_hash, updated_at
      ) VALUES (?, ?, 'commissions', 'returned', ?, ?, ?, ?)
    `).run(identityId, shopId, mapperVersion, observedAt, 'd'.repeat(64), observedAt);

    const candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId,
      encryptionKey,
      dedupeKey,
      aad,
      mode: 'standard',
    });
    const normalizedDomains = DATA_DOMAIN_REGISTRY_EXTENSION_INPUTS
      .filter((policy) => policy.canonicalTable.startsWith('product_') && policy.backup !== 'excluded')
      .map((policy) => policy.domain)
      .sort();
    assert.deepEqual(candidate.domains.map((entry) => entry.domain).sort(), normalizedDomains);
    assert.equal(candidate.domains[0].domain, 'product-identities');
    assert.ok(
      candidate.domains.findIndex((entry) => entry.domain === 'product-dimension-facts')
        < candidate.domains.findIndex((entry) => entry.domain === 'product-status-facts'),
    );

    createRecoveryImporter({ db: target }).importShopCandidate({
      candidate: { ...candidate, domains: [...candidate.domains].reverse() },
      encryptionKey,
      aad,
      expectedShopId: shopId,
    });
    for (const tableName of [
      'product_identities',
      'product_status_facts',
      'product_detail_facts',
      'product_dimension_facts',
      'product_price_facts',
      'product_commission_facts',
      'product_acquiring_facts',
      'product_stock_facts',
      'product_warehouse_stock_facts',
      'product_image_facts',
      'product_attribute_facts',
      'product_facet_observations',
    ]) {
      assert.equal(
        target.prepare(`SELECT COUNT(*) AS count FROM "${tableName}" WHERE shop_id = ?`).get(shopId).count,
        1,
        tableName,
      );
    }
    assert.equal(
      target.prepare('SELECT rate_ppm FROM product_commission_facts WHERE shop_id = ?').get(shopId).rate_ppm,
      150000,
    );
    assert.equal(
      JSON.parse(target.prepare('SELECT attributes_json FROM product_attribute_facts WHERE shop_id = ?').get(shopId).attributes_json)[0].value,
      'red',
    );
    assert.deepEqual(target.prepare('PRAGMA foreign_key_check;').all(), []);
  } finally {
    source.close();
    target.close();
  }
});
