import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptRecoveryChunk } from './recoveryChunkCodec.js';
import {
  assertRequiredDataBackupShopDomainCoverage,
  assertRequiredRecoveryShopDomainCoverage,
  createRecoveryExporter,
  DATA_BACKUP_OZON_LOGICAL_SLICE_DOMAINS,
  selectRecoveryShopPolicies,
} from './recoveryExporter.js';
import { DATA_DOMAIN_REGISTRY } from '../data/dataDomainRegistry.js';
import { ACCOUNT_OWNERSHIP_CATALOG } from '../domain/accountRemoval/accountOwnershipCatalog.js';
import { createOrderRepository } from '../db/repositories/orderRepository.js';
import { createProductRepository } from '../db/repositories/productRepository.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';

const encryptionKey = Buffer.alloc(32, 5);
const dedupeKey = Buffer.alloc(32, 6);
const aad = 'wangzai-recovery:v1:account-opaque:shop-opaque';

test('recovery exporter emits only registered shop domains, preserves required records, and removes optional raw payloads', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('shop-a', 'Shop A', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('shop-b', 'Shop B', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`
      INSERT INTO purchase_order_overrides (id, shop_id, order_key, note, raw_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('override-a', 'shop-a', 'order-a', 'keep-manual-note', '{"manual":"required"}', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`
      INSERT INTO ozon_products (id, shop_id, product_key, name, raw_json, remote_hash, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('product-a', 'shop-a', 'product-a', 'Product A', '{"redundant":"not-exported"}', 'remote-a', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`
      INSERT INTO ozon_products (id, shop_id, product_key, name, raw_json, remote_hash, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('product-b', 'shop-b', 'product-b', 'SHOP_B_PRIVATE_SENTINEL', '{"private":"shop-b"}', 'remote-b', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`
      INSERT INTO ozon_response_cache (id, domain, shop_id, endpoint_key, cache_key, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('cache-a', 'products', 'shop-a', 'products.list', 'cache-a', '{"excluded":true}', '2026-07-11T00:00:00.000Z');

    const candidate = createRecoveryExporter({ db }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    assert.deepEqual(candidate.domains.map((domain) => domain.domain), ['products', 'purchase-overrides']);
    assert.equal(candidate.domains.some((domain) => domain.table === 'ozon_response_cache'), false);
    assert.equal(candidate.totalCipherBytes <= candidate.quotaBytes, true);

    const productDomain = candidate.domains.find((domain) => domain.domain === 'products');
    const productChunk = candidate.chunks.find((chunk) => chunk.chunkId === productDomain.chunkId);
    const productRecord = decryptRecoveryChunk({ encrypted: productChunk, encryptionKey, aad }).records[0];
    assert.equal(productRecord.value.raw_json, undefined);
    assert.equal(productRecord.value.name, 'Product A');
    assert.equal(productRecord.value.name.includes('SHOP_B_PRIVATE_SENTINEL'), false);

    const manualDomain = candidate.domains.find((domain) => domain.domain === 'purchase-overrides');
    assert.equal(manualDomain.schemaVersion, 1);
    const manualChunk = candidate.chunks.find((chunk) => chunk.chunkId === manualDomain.chunkId);
    const manualRecord = decryptRecoveryChunk({ encrypted: manualChunk, encryptionKey, aad }).records[0];
    assert.equal(manualRecord.value.raw_json, '{"manual":"required"}');
    assert.equal(manualRecord.value.note, 'keep-manual-note');
  } finally {
    db.close();
  }
});

test('required domains retain id when id is part of the registered recovery primary key', () => {
  const db = createMigratedTestDb();
  try {
    const now = '2026-08-19T00:00:00.000Z';
    db.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('shop-image-backup', 'Image Backup Shop', 'active', now, now);
    db.prepare(`
      INSERT INTO product_image_assets (
        id, tenant_id, user_id, shop_id, sha256, mime_type, byte_length,
        storage_scope, variant, source_type, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'pimg-backup-primary-key',
      'tenant-backup',
      'user-backup',
      'shop-image-backup',
      'ab'.repeat(32),
      'image/webp',
      1024,
      'permanent',
      'published',
      'generated',
      'published',
      now,
      now,
    );

    const candidate = createRecoveryExporter({ db }).buildShopCandidate({
      shopId: 'shop-image-backup', encryptionKey, dedupeKey, aad,
      mode: 'core-only',
      includeDomains: ['product-image-assets'],
    });
    const manifest = candidate.domains.find((domain) => domain.domain === 'product-image-assets');
    const encrypted = candidate.chunks.find((chunk) => chunk.chunkId === manifest.chunkId);
    const [record] = decryptRecoveryChunk({ encrypted, encryptionKey, aad }).records;

    assert.equal(record.key, 'shop_id:shop-image-backup|id:pimg-backup-primary-key');
    assert.equal(record.value.id, 'pimg-backup-primary-key');
    assert.equal(record.value.shop_id, 'shop-image-backup');
  } finally {
    db.close();
  }
});

test('core-only policy coverage includes every required generic shop domain and admits future registry entries', () => {
  const expected = DATA_DOMAIN_REGISTRY
    .filter((policy) => policy.scopeType === 'shop' && policy.backup === 'required')
    .filter((policy) => policy.storageAdapter !== 'secret-vault')
    .filter((policy) => policy.recoveryChannel !== 'profile-core')
    .map((policy) => policy.domain)
    .sort();
  const coverage = assertRequiredRecoveryShopDomainCoverage(DATA_DOMAIN_REGISTRY);
  assert.deepEqual([...coverage.domains], expected);
  assert.deepEqual(
    selectRecoveryShopPolicies({ registry: DATA_DOMAIN_REGISTRY, mode: 'core-only' })
      .map((policy) => policy.domain)
      .sort(),
    expected,
  );

  const template = DATA_DOMAIN_REGISTRY.find((policy) => policy.domain === 'purchase-overrides');
  const futureRegistry = [
    ...DATA_DOMAIN_REGISTRY,
    {
      ...template,
      domain: 'future-required-user-fact',
      canonicalTable: 'future_required_user_fact',
    },
  ];
  assert.equal(
    selectRecoveryShopPolicies({ registry: futureRegistry, mode: 'core-only' })
      .some((policy) => policy.domain === 'future-required-user-fact'),
    true,
  );
  assert.equal(
    assertRequiredRecoveryShopDomainCoverage(futureRegistry).domains
      .includes('future-required-user-fact'),
    true,
  );
});

test('data backup coverage fail-closes across generic, secret-vault, and profile-core shop domains', () => {
  const expected = DATA_DOMAIN_REGISTRY
    .filter((policy) => policy.scopeType === 'shop' && policy.backup === 'required')
    .map((policy) => policy.domain)
    .sort();
  const coverage = assertRequiredDataBackupShopDomainCoverage(DATA_DOMAIN_REGISTRY);
  assert.deepEqual([...coverage.domains], expected);
  assert.deepEqual(
    [...coverage.logicalResources],
    Object.keys(DATA_BACKUP_OZON_LOGICAL_SLICE_DOMAINS).sort(),
  );

  const template = DATA_DOMAIN_REGISTRY.find(
    (policy) => policy.domain === 'purchase-completion-history',
  );
  assert.throws(
    () => assertRequiredDataBackupShopDomainCoverage([
      ...DATA_DOMAIN_REGISTRY,
      {
        ...template,
        domain: 'future-required-profile-core-shop-fact',
        canonicalTable: 'future_required_profile_core_shop_fact',
      },
    ]),
    /DATA_BACKUP_REQUIRED_SHOP_DOMAIN_COVERAGE_MISMATCH/u,
  );

  const logicalTemplate = ACCOUNT_OWNERSHIP_CATALOG.find(
    (entry) => entry.id === 'logical:purchase-browser-tasks-shop-links',
  );
  assert.throws(
    () => assertRequiredDataBackupShopDomainCoverage(DATA_DOMAIN_REGISTRY, [
      ...ACCOUNT_OWNERSHIP_CATALOG,
      { ...logicalTemplate, id: 'logical:future-required-shop-user-slice' },
    ]),
    /DATA_BACKUP_REQUIRED_SHOP_LOGICAL_SLICE_COVERAGE_MISMATCH/u,
  );
});

test('a typical 1000-product and 500-order shop recovery candidate stays below the 5 MiB operating target', () => {
  const db = createMigratedTestDb();
  try {
    const shopRepository = createShopRepository(db);
    const shopId = saveUnitShop(shopRepository, 'shop-typical-recovery-size');
    const productRepository = createProductRepository(db);
    const orderRepository = createOrderRepository(db);
    productRepository.upsertProducts({
      shopId,
      visibility: 'IN_SALE',
      rows: Array.from({ length: 1000 }, (_item, index) => ({
        product_id: index + 1,
        offer_id: `typical-offer-${index + 1}`,
        sku: `typical-sku-${index + 1}`,
        name: `典型商品 ${index + 1}`,
        visibility: 'IN_SALE',
        price: String(10 + (index % 100)),
        stocks: { present: index % 30 },
        // This raw field represents a commonly large rehydratable API payload.
        raw: { response: 'x'.repeat(1024) },
      })),
    });
    orderRepository.upsertOrders({
      shopId,
      source: 'FBS',
      rows: Array.from({ length: 500 }, (_item, index) => ({
        posting_number: `TYPICAL-POSTING-${String(index + 1).padStart(4, '0')}`,
        order_id: `typical-order-${index + 1}`,
        status: 'awaiting_packaging',
        in_process_at: '2026-07-01T00:00:00.000Z',
        shipment_date: '2026-07-02T00:00:00.000Z',
        products: [{
          offer_id: `typical-offer-${(index % 1000) + 1}`,
          sku: `typical-sku-${(index % 1000) + 1}`,
          quantity: 1,
          price: '12.50',
        }],
        analytics_data: { region: 'RU' },
        financial_data: { products: [] },
        raw: { response: 'y'.repeat(1024) },
      })),
    });

    const candidate = createRecoveryExporter({ db }).buildShopCandidate({
      shopId,
      encryptionKey,
      dedupeKey,
      aad,
    });
    assert.equal(candidate.domains.some((domain) => domain.domain === 'products'), true);
    assert.equal(candidate.domains.some((domain) => domain.domain === 'orders'), true);
    assert.equal(candidate.totalCipherBytes < 5 * 1024 * 1024, true);
    assert.equal(candidate.totalCipherBytes <= candidate.quotaBytes, true);
  } finally {
    db.close();
  }
});

test('recovery exporter fails closed when required core or optional shop data exceeds the per-shop quota', () => {
  const db = createMigratedTestDb();
  try {
    db.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('shop-quota', 'Quota Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`
      INSERT INTO purchase_order_overrides (id, shop_id, order_key, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('override-quota', 'shop-quota', 'order-quota', 'required manual fact', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
    db.prepare(`
      INSERT INTO ozon_products (id, shop_id, product_key, name, remote_hash, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'product-quota',
      'shop-quota',
      'product-quota',
      'Optional product retained only when the quota permits it',
      'remote-quota',
      '2026-07-11T00:00:00.000Z',
      '2026-07-11T00:00:00.000Z',
      '2026-07-11T00:00:00.000Z',
    );

    const exportOptions = { shopId: 'shop-quota', encryptionKey, dedupeKey, aad };
    const candidate = createRecoveryExporter({ db }).buildShopCandidate(exportOptions);
    assert.ok(candidate.requiredCoreBytes > 0);
    assert.ok(candidate.totalCipherBytes > candidate.requiredCoreBytes);

    assert.throws(
      () => createRecoveryExporter({ db, quotaBytes: candidate.requiredCoreBytes - 1 }).buildShopCandidate(exportOptions),
      /BACKUP_REQUIRED_DATA_OVER_QUOTA/
    );
    assert.throws(
      () => createRecoveryExporter({ db, quotaBytes: candidate.requiredCoreBytes }).buildShopCandidate(exportOptions),
      /BACKUP_QUOTA_EXCEEDED_LOCAL_PREFLIGHT/
    );
  } finally {
    db.close();
  }
});
