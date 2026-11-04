import assert from 'node:assert/strict';
import test from 'node:test';
import { getDataDomain } from '../data/dataDomainRegistry.js';
import { buildRecoveryChunk, decryptRecoveryChunk, encryptRecoveryChunk } from './recoveryChunkCodec.js';
import { createRecoveryExporter } from './recoveryExporter.js';
import { createRecoveryImporter } from './recoveryImporter.js';
import { buildRecoveryRecordKey } from './recoveryExporter.js';
import { createMarketingRepository } from '../db/repositories/marketingRepository.js';
import { createMigratedTestDb } from '../../test/testDb.js';

const encryptionKey = Buffer.alloc(32, 31);
const dedupeKey = Buffer.alloc(32, 32);
const aad = 'wangzai-recovery:v1:account-opaque:shop-opaque';

function seedSource(db) {
  db.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('shop-a', 'Source Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
  db.prepare(`
    INSERT INTO purchase_order_overrides (id, shop_id, order_key, note, raw_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('override-a', 'shop-a', 'order-a', 'manual-note', '{"manual":true}', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
  db.prepare(`
    INSERT INTO ozon_products (id, shop_id, product_key, name, raw_json, remote_hash, last_seen_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('product-a', 'shop-a', 'product-a', 'Product A', '{"rehydratable":"excluded"}', 'remote-a', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
}

function seedStagingProfileCore(db) {
  db.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('shop-a', 'Restored Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
  db.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('shop-b', 'Unrelated Shop', 'active', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
  db.prepare(`
    INSERT INTO purchase_order_overrides (id, shop_id, order_key, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('override-b', 'shop-b', 'order-b', 'keep-shop-b-manual-note', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z');
}

function replaceDomainCandidate(candidate, domainName, { schemaVersion, records }) {
  const currentManifest = candidate.domains.find((domain) => domain.domain === domainName);
  assert.ok(currentManifest, `missing ${domainName} candidate domain`);
  const chunk = buildRecoveryChunk({
    domain: domainName,
    domainSchemaVersion: schemaVersion,
    partitionKey: 'scope:current',
    records,
  });
  const encrypted = encryptRecoveryChunk({ chunk, encryptionKey, dedupeKey, aad });
  const manifest = {
    ...currentManifest,
    recordCount: chunk.recordCount,
    recordsRootHash: chunk.recordsRootHash,
    plainCanonicalSha256: chunk.plainCanonicalSha256,
    chunkId: encrypted.chunkId,
    cipherBytes: encrypted.cipherBytes,
    cipherSha256: encrypted.cipherSha256,
  };
  return {
    ...candidate,
    domains: candidate.domains.map((domain) => domain.domain === domainName ? manifest : domain),
    chunks: candidate.chunks.map((item) => item.chunkId === currentManifest.chunkId ? encrypted : item),
  };
}

test('recovery importer restores an encrypted shop candidate into a separate staging database only', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedSource(source);
    seedStagingProfileCore(staging);
    const candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    const result = createRecoveryImporter({ db: staging }).importShopCandidate({
      candidate, encryptionKey, aad, expectedShopId: 'shop-a',
    });
    assert.equal(result.mode, 'staging-only');
    assert.equal(staging.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides WHERE shop_id = ?').get('shop-a').count, 1);
    assert.equal(staging.prepare('SELECT note FROM purchase_order_overrides WHERE shop_id = ?').get('shop-a').note, 'manual-note');
    const product = staging.prepare('SELECT name, raw_json FROM ozon_products WHERE shop_id = ?').get('shop-a');
    assert.equal(product.name, 'Product A');
    assert.equal(product.raw_json, null);
    assert.equal(
      staging.prepare('SELECT note FROM purchase_order_overrides WHERE shop_id = ? AND order_key = ?').get('shop-b', 'order-b').note,
      'keep-shop-b-manual-note',
    );
    assert.equal(staging.prepare('SELECT COUNT(*) AS count FROM ozon_products WHERE shop_id = ?').get('shop-b').count, 0);
  } finally {
    source.close();
    staging.close();
  }
});

test('product image assets export and restore with their registered id intact', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    const now = '2026-08-19T00:00:00.000Z';
    source.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('shop-image-roundtrip', 'Image Source Shop', 'active', now, now);
    staging.prepare(`INSERT INTO shops (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run('shop-image-roundtrip', 'Image Target Shop', 'active', now, now);
    source.prepare(`
      INSERT INTO product_image_assets (
        id, tenant_id, user_id, shop_id, sha256, mime_type, byte_length,
        storage_scope, variant, source_type, object_key, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'pimg-roundtrip-primary-key',
      'tenant-roundtrip',
      'user-roundtrip',
      'shop-image-roundtrip',
      'cd'.repeat(32),
      'image/webp',
      2048,
      'permanent',
      'published',
      'generated',
      'wangzai/assets/roundtrip.webp',
      'published',
      now,
      now,
    );

    const candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-image-roundtrip',
      encryptionKey,
      dedupeKey,
      aad,
      mode: 'core-only',
      includeDomains: ['product-image-assets'],
    });
    const result = createRecoveryImporter({ db: staging }).importShopCandidate({
      candidate,
      encryptionKey,
      aad,
      expectedShopId: 'shop-image-roundtrip',
    });
    const restored = staging.prepare(`
      SELECT id, shop_id, sha256, object_key, status
      FROM product_image_assets WHERE id = ?
    `).get('pimg-roundtrip-primary-key');

    assert.equal(result.mode, 'staging-only');
    assert.deepEqual({ ...restored }, {
      id: 'pimg-roundtrip-primary-key',
      shop_id: 'shop-image-roundtrip',
      sha256: 'cd'.repeat(32),
      object_key: 'wangzai/assets/roundtrip.webp',
      status: 'published',
    });
  } finally {
    source.close();
    staging.close();
  }
});

test('recovery importer rejects candidate scope mismatch before writing staging data', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedSource(source);
    seedStagingProfileCore(staging);
    const candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    assert.throws(
      () => createRecoveryImporter({ db: staging }).importShopCandidate({ candidate, encryptionKey, aad, expectedShopId: 'shop-b' }),
      /RESTORE_CANDIDATE_SCOPE_MISMATCH/,
    );
    assert.equal(staging.prepare('SELECT COUNT(*) AS count FROM ozon_products').get().count, 0);
  } finally {
    source.close();
    staging.close();
  }
});

test('recovery importer requires profile core to be restored before a shop generation', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedSource(source);
    const candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    assert.throws(
      () => createRecoveryImporter({ db: staging }).importShopCandidate({ candidate, encryptionKey, aad, expectedShopId: 'shop-a' }),
      /RESTORE_PROFILE_CORE_REQUIRED/,
    );
  } finally {
    source.close();
    staging.close();
  }
});

test('standard marketing recovery exports typed V2 facts and compact view state, then restores all three shop domains', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedStagingProfileCore(source);
    seedStagingProfileCore(staging);
    const timestamp = '2026-07-13T00:00:00.000Z';
    source.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, source_tone, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end,
        raw_json, remote_hash, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-shared', 'official', '平台活动', 'primary', '平台活动', 'Official activity', '说明',
      1, 2, 1, '7 月活动', '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.000Z',
      'marketing-activity-official', timestamp, timestamp, timestamp,
    );
    source.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, source_tone, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end,
        raw_json, remote_hash, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-shared', 'seller', '商家自主', 'warning', '自主活动', 'Seller activity', '说明',
      3, 4, 1, '7 月活动', '2026-07-02T00:00:00.000Z', '2026-07-30T23:59:59.000Z',
      'marketing-activity-seller', timestamp, timestamp, timestamp,
    );
    source.prepare(`
      INSERT INTO ozon_marketing_activity_products (
        shop_id, activity_id, source_type, product_id, offer_id, sku, ozon_sku, name, row_status,
        source_activity_price, activity_price, price, stock, review, status_tone, review_tone,
        raw_json, remote_hash, is_stale, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 0, ?, ?, ?)
    `).run(
      'shop-a', 'activity-shared', 'official', 'product-1', 'offer-1', 'legacy-sku-1', 'ozon-sku-1', '营销商品', '已添加',
      '88.80', '87.70', '99.90', '8', '正常', 'success', 'success',
      'marketing-product-official', timestamp, timestamp, timestamp,
    );
    source.prepare(`
      INSERT INTO marketing_view_state (
        shop_id, selected_activity_id, selected_source_type, product_scope,
        selected_product_ids_json, activity_total, joined_activity_total,
        joined_product_total, issue_product_total, summary_initialized,
        cached_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-shared', 'official', 'all', JSON.stringify(['product-1']),
      2, 2, 1, 0, 1, timestamp, timestamp, timestamp,
    );

    const candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    assert.deepEqual(
      candidate.domains
        .filter((domain) => domain.domain.startsWith('marketing-'))
        .map((domain) => domain.domain)
        .sort(),
      ['marketing-activities', 'marketing-activity-products', 'marketing-view-state'],
    );
    const activityManifest = candidate.domains.find((domain) => domain.domain === 'marketing-activities');
    const productManifest = candidate.domains.find((domain) => domain.domain === 'marketing-activity-products');
    const viewManifest = candidate.domains.find((domain) => domain.domain === 'marketing-view-state');
    const activityChunk = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === activityManifest.chunkId), encryptionKey, aad,
    });
    const productChunk = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === productManifest.chunkId), encryptionKey, aad,
    });
    const viewChunk = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === viewManifest.chunkId), encryptionKey, aad,
    });
    assert.equal(activityChunk.header.domainSchemaVersion, 2);
    assert.equal(activityChunk.records.length, 2);
    assert.equal(activityChunk.records.every((record) => record.key.includes('source_type:')), true);
    assert.equal(activityChunk.records[0].value.date_start.startsWith('2026-07'), true);
    assert.equal(productChunk.header.domainSchemaVersion, 2);
    assert.equal(productChunk.records[0].value.ozon_sku, 'ozon-sku-1');
    assert.equal(viewChunk.header.domainSchemaVersion, 3);
    assert.deepEqual(viewChunk.records[0].value.selected_product_ids_json, JSON.stringify(['product-1']));
    assert.equal(viewChunk.records[0].value.joined_product_total, 1);
    assert.equal(viewChunk.records[0].value.summary_initialized, 1);

    const result = createRecoveryImporter({ db: staging }).importShopCandidate({
      candidate, encryptionKey, aad, expectedShopId: 'shop-a',
    });
    assert.equal(result.ok, true);
    assert.equal(staging.prepare(`
      SELECT COUNT(*) AS count FROM ozon_marketing_activities
      WHERE shop_id = ? AND activity_id = ?
    `).get('shop-a', 'activity-shared').count, 2);
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT source_tone, date_start, date_end
      FROM ozon_marketing_activities
      WHERE shop_id = ? AND activity_id = ? AND source_type = ?
    `).get('shop-a', 'activity-shared', 'official')), {
      source_tone: 'primary',
      date_start: '2026-07-01T00:00:00.000Z',
      date_end: '2026-07-31T23:59:59.000Z',
    });
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT sku, ozon_sku FROM ozon_marketing_activity_products
      WHERE shop_id = ? AND activity_id = ? AND source_type = ?
    `).get('shop-a', 'activity-shared', 'official')), {
      sku: 'legacy-sku-1',
      ozon_sku: 'ozon-sku-1',
    });
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT selected_source_type, product_scope, selected_product_ids_json,
        activity_total, joined_activity_total, joined_product_total, issue_product_total, summary_initialized
      FROM marketing_view_state WHERE shop_id = ?
    `).get('shop-a')), {
      selected_source_type: 'official',
      product_scope: 'all',
      selected_product_ids_json: JSON.stringify(['product-1']),
      activity_total: 2,
      joined_activity_total: 2,
      joined_product_total: 1,
      issue_product_total: 0,
      summary_initialized: 1,
    });
  } finally {
    source.close();
    staging.close();
  }
});

test('recovery importer accepts V1 marketing record keys and upgrades source type, dates, and ozon SKU before staging insert', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedStagingProfileCore(source);
    seedStagingProfileCore(staging);
    const timestamp = '2026-07-13T00:00:00.000Z';
    source.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end,
        raw_json, remote_hash, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v1', 'official', '平台活动', 'V1 activity', 'V1 activity', '',
      1, 2, 1, '', '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.000Z',
      'hash-v1-activity', timestamp, timestamp, timestamp,
    );
    source.prepare(`
      INSERT INTO ozon_marketing_activity_products (
        shop_id, activity_id, source_type, product_id, offer_id, sku, ozon_sku, name, row_status,
        source_activity_price, activity_price, price, stock, review, status_tone, review_tone,
        raw_json, remote_hash, is_stale, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 0, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v1', 'official', 'product-v1', 'offer-v1', 'legacy-sku-v1', 'ozon-sku-v1', 'V1 product', '已添加',
      '', '', '99', '1', '正常', 'success', 'success',
      'hash-v1-product', timestamp, timestamp, timestamp,
    );
    let candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    const activityPolicy = getDataDomain('marketing-activities');
    const productPolicy = getDataDomain('marketing-activity-products');
    const activityManifest = candidate.domains.find((domain) => domain.domain === activityPolicy.domain);
    const productManifest = candidate.domains.find((domain) => domain.domain === productPolicy.domain);
    const activityCurrent = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === activityManifest.chunkId), encryptionKey, aad,
    });
    const productCurrent = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === productManifest.chunkId), encryptionKey, aad,
    });
    const activityV1Records = activityCurrent.records.map((record) => {
      const value = {
        ...record.value,
        raw_json: JSON.stringify({
          dateStart: record.value.date_start,
          dateEnd: record.value.date_end,
          sourceTone: 'legacy-warning',
        }),
      };
      delete value.source_type;
      delete value.source_tone;
      delete value.date_start;
      delete value.date_end;
      return {
        key: buildRecoveryRecordKey(activityPolicy, value, { primaryKey: ['shop_id', 'activity_id'] }),
        value,
      };
    });
    const productV1Records = productCurrent.records.map((record) => {
      const value = {
        ...record.value,
        raw_json: JSON.stringify({ ozonSku: record.value.ozon_sku }),
      };
      delete value.source_type;
      delete value.ozon_sku;
      return {
        key: buildRecoveryRecordKey(productPolicy, value, { primaryKey: ['shop_id', 'activity_id', 'product_id'] }),
        value,
      };
    });
    candidate = replaceDomainCandidate(candidate, activityPolicy.domain, {
      schemaVersion: 1,
      records: activityV1Records,
    });
    candidate = replaceDomainCandidate(candidate, productPolicy.domain, {
      schemaVersion: 1,
      records: productV1Records,
    });

    const result = createRecoveryImporter({ db: staging }).importShopCandidate({
      candidate, encryptionKey, aad, expectedShopId: 'shop-a',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT source_type, source_tone, date_start, date_end
      FROM ozon_marketing_activities WHERE shop_id = ? AND activity_id = ?
    `).get('shop-a', 'activity-v1')), {
      source_type: 'official',
      source_tone: 'legacy-warning',
      date_start: '2026-07-01T00:00:00.000Z',
      date_end: '2026-07-31T23:59:59.000Z',
    });
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT source_type, sku, ozon_sku
      FROM ozon_marketing_activity_products WHERE shop_id = ? AND product_id = ?
    `).get('shop-a', 'product-v1')), {
      source_type: 'official',
      sku: 'legacy-sku-v1',
      ozon_sku: 'ozon-sku-v1',
    });
  } finally {
    source.close();
    staging.close();
  }
});

test('recovery importer accepts the historical raw-free V1 marketing projection without losing its source type', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedStagingProfileCore(source);
    seedStagingProfileCore(staging);
    const timestamp = '2026-07-13T00:00:00.000Z';
    source.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, source_tone, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end,
        raw_json, remote_hash, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v1-raw-free', 'sellerActions', '商家自主', 'warning', 'V1 seller activity', 'V1 seller activity', '',
      1, 2, 1, '', '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.000Z',
      'hash-v1-raw-free-activity', timestamp, timestamp, timestamp,
    );
    source.prepare(`
      INSERT INTO ozon_marketing_activity_products (
        shop_id, activity_id, source_type, product_id, offer_id, sku, ozon_sku, name, row_status,
        source_activity_price, activity_price, price, stock, review, status_tone, review_tone,
        raw_json, remote_hash, is_stale, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 0, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v1-raw-free', 'sellerActions', 'product-v1-raw-free', 'offer-v1-raw-free',
      'legacy-sku-v1-raw-free', 'ozon-sku-v1-raw-free', 'V1 raw-free product', '已添加',
      '', '', '99', '1', '正常', 'success', 'success',
      'hash-v1-raw-free-product', timestamp, timestamp, timestamp,
    );
    let candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    const activityPolicy = getDataDomain('marketing-activities');
    const productPolicy = getDataDomain('marketing-activity-products');
    const activityManifest = candidate.domains.find((domain) => domain.domain === activityPolicy.domain);
    const productManifest = candidate.domains.find((domain) => domain.domain === productPolicy.domain);
    const activityCurrent = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === activityManifest.chunkId), encryptionKey, aad,
    });
    const productCurrent = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === productManifest.chunkId), encryptionKey, aad,
    });
    const activityV1Records = activityCurrent.records.map((record) => {
      const value = { ...record.value };
      delete value.source_tone;
      delete value.date_start;
      delete value.date_end;
      assert.equal(Object.hasOwn(value, 'raw_json'), false);
      return {
        key: buildRecoveryRecordKey(activityPolicy, value, { primaryKey: ['shop_id', 'activity_id'] }),
        value,
      };
    });
    const productV1Records = productCurrent.records.map((record) => {
      const value = { ...record.value };
      delete value.ozon_sku;
      assert.equal(Object.hasOwn(value, 'raw_json'), false);
      return {
        key: buildRecoveryRecordKey(productPolicy, value, { primaryKey: ['shop_id', 'activity_id', 'product_id'] }),
        value,
      };
    });
    candidate = replaceDomainCandidate(candidate, activityPolicy.domain, {
      schemaVersion: 1,
      records: activityV1Records,
    });
    candidate = replaceDomainCandidate(candidate, productPolicy.domain, {
      schemaVersion: 1,
      records: productV1Records,
    });

    const result = createRecoveryImporter({ db: staging }).importShopCandidate({
      candidate, encryptionKey, aad, expectedShopId: 'shop-a',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT source_type, source_tone, date_start, date_end
      FROM ozon_marketing_activities WHERE shop_id = ? AND activity_id = ?
    `).get('shop-a', 'activity-v1-raw-free')), {
      source_type: 'seller',
      source_tone: '',
      date_start: '',
      date_end: '',
    });
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT source_type, sku, ozon_sku
      FROM ozon_marketing_activity_products WHERE shop_id = ? AND product_id = ?
    `).get('shop-a', 'product-v1-raw-free')), {
      source_type: 'seller',
      sku: 'legacy-sku-v1-raw-free',
      ozon_sku: 'legacy-sku-v1-raw-free',
    });
  } finally {
    source.close();
    staging.close();
  }
});

test('recovery importer rejects a supplied unknown V1 marketing source type instead of defaulting it to official', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedStagingProfileCore(source);
    seedStagingProfileCore(staging);
    const timestamp = '2026-07-13T00:00:00.000Z';
    source.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, source_tone, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end,
        raw_json, remote_hash, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v1-invalid-source', 'official', '平台活动', '', 'V1 activity', 'V1 activity', '',
      0, 0, 0, '', '', '', 'hash-v1-invalid-source', timestamp, timestamp, timestamp,
    );
    let candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    const policy = getDataDomain('marketing-activities');
    const manifest = candidate.domains.find((domain) => domain.domain === policy.domain);
    const current = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === manifest.chunkId), encryptionKey, aad,
    });
    const v1Records = current.records.map((record) => {
      const value = { ...record.value, source_type: 'unknown-source' };
      return {
        key: buildRecoveryRecordKey(policy, value, { primaryKey: ['shop_id', 'activity_id'] }),
        value,
      };
    });
    candidate = replaceDomainCandidate(candidate, policy.domain, { schemaVersion: 1, records: v1Records });

    assert.throws(
      () => createRecoveryImporter({ db: staging }).importShopCandidate({
        candidate, encryptionKey, aad, expectedShopId: 'shop-a',
      }),
      /RESTORE_MARKETING_SOURCE_TYPE_INVALID/,
    );
    assert.equal(
      staging.prepare('SELECT COUNT(*) AS count FROM ozon_marketing_activities WHERE shop_id = ?').get('shop-a').count,
      0,
    );
  } finally {
    source.close();
    staging.close();
  }
});

test('recovery importer rejects an unknown V2 marketing source type and rolls back prior domain inserts', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedStagingProfileCore(source);
    seedStagingProfileCore(staging);
    const timestamp = '2026-07-13T00:00:00.000Z';
    source.prepare(`
      INSERT INTO purchase_order_overrides (id, shop_id, order_key, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('rollback-before-marketing', 'shop-a', 'order-before-marketing', 'must roll back', timestamp, timestamp);
    source.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, source_tone, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end,
        raw_json, remote_hash, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v2-invalid-source', 'official', '平台活动', '', 'V2 activity', 'V2 activity', '',
      0, 0, 0, '', '', '', 'hash-v2-invalid-source', timestamp, timestamp, timestamp,
    );
    let candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    const policy = getDataDomain('marketing-activities');
    const manifest = candidate.domains.find((domain) => domain.domain === policy.domain);
    const current = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === manifest.chunkId), encryptionKey, aad,
    });
    const v2Records = current.records.map((record) => {
      const value = { ...record.value, source_type: 'unknown-source' };
      return {
        key: buildRecoveryRecordKey(policy, value, { primaryKey: policy.primaryKey }),
        value,
      };
    });
    candidate = replaceDomainCandidate(candidate, policy.domain, { schemaVersion: 2, records: v2Records });
    const purchaseDomain = candidate.domains.find((domain) => domain.domain === 'purchase-overrides');
    candidate = {
      ...candidate,
      domains: [purchaseDomain, ...candidate.domains.filter((domain) => domain !== purchaseDomain)],
    };

    assert.throws(
      () => createRecoveryImporter({ db: staging }).importShopCandidate({
        candidate, encryptionKey, aad, expectedShopId: 'shop-a',
      }),
      /RESTORE_MARKETING_SOURCE_TYPE_INVALID/,
    );
    assert.equal(
      staging.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides WHERE shop_id = ?').get('shop-a').count,
      0,
    );
    assert.equal(
      staging.prepare('SELECT COUNT(*) AS count FROM ozon_marketing_activities WHERE shop_id = ?').get('shop-a').count,
      0,
    );
  } finally {
    source.close();
    staging.close();
  }
});

test('recovery importer restores V1 marketing view state and derives its missing summary from restored facts', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedStagingProfileCore(source);
    seedStagingProfileCore(staging);
    const timestamp = '2026-07-13T00:00:00.000Z';
    source.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, source_tone, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end,
        raw_json, remote_hash, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v1-view', 'seller', '商家自主', 'warning', 'V1 seller view', 'V1 seller view', '',
      1, 0, 0, '', '', '', 'hash-v1-view-activity', timestamp, timestamp, timestamp,
    );
    source.prepare(`
      INSERT INTO ozon_marketing_activity_products (
        shop_id, activity_id, source_type, product_id, offer_id, sku, ozon_sku, name, row_status,
        source_activity_price, activity_price, price, stock, review, status_tone, review_tone,
        raw_json, remote_hash, is_stale, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 0, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v1-view', 'seller', 'product-v1-view', 'offer-v1-view', 'sku-v1-view', 'ozon-v1-view',
      'V1 view product', '已添加', '', '', '99', '1', '正常', 'success', 'success',
      'hash-v1-view-product', timestamp, timestamp, timestamp,
    );
    source.prepare(`
      INSERT INTO marketing_view_state (
        shop_id, selected_activity_id, selected_source_type, product_scope,
        selected_product_ids_json, activity_total, joined_activity_total,
        joined_product_total, issue_product_total, cached_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v1-view', 'seller', 'available', JSON.stringify(['product-v1-view']),
      3, 2, 1, 1, timestamp, timestamp, timestamp,
    );
    let candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    const viewPolicy = getDataDomain('marketing-view-state');
    const viewManifest = candidate.domains.find((domain) => domain.domain === viewPolicy.domain);
    const current = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === viewManifest.chunkId), encryptionKey, aad,
    });
    assert.equal(current.header.domainSchemaVersion, 3);
    const v1Records = current.records.map((record) => {
      const value = { ...record.value };
      value.selected_source_type = ' sellerActions ';
      delete value.activity_total;
      delete value.joined_activity_total;
      delete value.joined_product_total;
      delete value.issue_product_total;
      delete value.summary_initialized;
      return {
        key: buildRecoveryRecordKey(viewPolicy, value, { primaryKey: ['shop_id'] }),
        value,
      };
    });
    candidate = replaceDomainCandidate(candidate, viewPolicy.domain, {
      schemaVersion: 1,
      records: v1Records,
    });

    const result = createRecoveryImporter({ db: staging }).importShopCandidate({
      candidate, encryptionKey, aad, expectedShopId: 'shop-a',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT selected_activity_id, selected_source_type, product_scope,
        selected_product_ids_json, activity_total, joined_activity_total,
        joined_product_total, issue_product_total, summary_initialized, cached_at
      FROM marketing_view_state WHERE shop_id = ?
    `).get('shop-a')), {
      selected_activity_id: 'activity-v1-view',
      selected_source_type: 'seller',
      product_scope: 'available',
      selected_product_ids_json: JSON.stringify(['product-v1-view']),
      activity_total: 0,
      joined_activity_total: 0,
      joined_product_total: 0,
      issue_product_total: 0,
      summary_initialized: 0,
      cached_at: timestamp,
    });
    assert.deepEqual(
      createMarketingRepository(staging).readSnapshot({ shopId: 'shop-a' }).snapshot.marketingSummary,
      {
        activityTotal: 1,
        joinedActivityTotal: 1,
        joinedProductTotal: 1,
        issueProductTotal: 0,
      },
    );
  } finally {
    source.close();
    staging.close();
  }
});

test('recovery importer treats a historical V2 view state without provenance as fact-derived, not zero summary', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedStagingProfileCore(source);
    seedStagingProfileCore(staging);
    const timestamp = '2026-07-13T00:00:00.000Z';
    source.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, source_tone, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end,
        raw_json, remote_hash, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v2-view', 'official', '平台活动', 'primary', 'V2 view', 'V2 view', '',
      1, 0, 0, '', '', '', 'hash-v2-view-activity', timestamp, timestamp, timestamp,
    );
    source.prepare(`
      INSERT INTO ozon_marketing_activity_products (
        shop_id, activity_id, source_type, product_id, offer_id, sku, ozon_sku, name, row_status,
        source_activity_price, activity_price, price, stock, review, status_tone, review_tone,
        raw_json, remote_hash, is_stale, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 0, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v2-view', 'official', 'product-v2-view', 'offer-v2-view', 'sku-v2-view', 'ozon-v2-view',
      'V2 view product', '已添加', '', '', '99', '1', '正常', 'success', 'success',
      'hash-v2-view-product', timestamp, timestamp, timestamp,
    );
    source.prepare(`
      INSERT INTO marketing_view_state (
        shop_id, selected_activity_id, selected_source_type, product_scope,
        selected_product_ids_json, activity_total, joined_activity_total,
        joined_product_total, issue_product_total, cached_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-v2-view', 'official', 'joined', JSON.stringify(['product-v2-view']),
      0, 0, 0, 0, timestamp, timestamp, timestamp,
    );
    let candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    const viewPolicy = getDataDomain('marketing-view-state');
    const viewManifest = candidate.domains.find((domain) => domain.domain === viewPolicy.domain);
    const current = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === viewManifest.chunkId), encryptionKey, aad,
    });
    const v2Records = current.records.map((record) => {
      const value = { ...record.value };
      value.selected_source_type = '   ';
      delete value.summary_initialized;
      return {
        key: buildRecoveryRecordKey(viewPolicy, value, { primaryKey: ['shop_id'] }),
        value,
      };
    });
    candidate = replaceDomainCandidate(candidate, viewPolicy.domain, { schemaVersion: 2, records: v2Records });

    const result = createRecoveryImporter({ db: staging }).importShopCandidate({
      candidate, encryptionKey, aad, expectedShopId: 'shop-a',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.assign({}, staging.prepare(`
      SELECT selected_source_type, activity_total, joined_activity_total, joined_product_total, issue_product_total, summary_initialized
      FROM marketing_view_state WHERE shop_id = ?
    `).get('shop-a')), {
      selected_source_type: '',
      activity_total: 0,
      joined_activity_total: 0,
      joined_product_total: 0,
      issue_product_total: 0,
      summary_initialized: 0,
    });
    assert.deepEqual(
      createMarketingRepository(staging).readSnapshot({ shopId: 'shop-a' }).snapshot.marketingSummary,
      {
        activityTotal: 1,
        joinedActivityTotal: 1,
        joinedProductTotal: 1,
        issueProductTotal: 0,
      },
    );
  } finally {
    source.close();
    staging.close();
  }
});

test('recovery importer rejects an unknown selected view source type and rolls back prior domain inserts', () => {
  const source = createMigratedTestDb();
  const staging = createMigratedTestDb();
  try {
    seedStagingProfileCore(source);
    seedStagingProfileCore(staging);
    const timestamp = '2026-07-13T00:00:00.000Z';
    source.prepare(`
      INSERT INTO purchase_order_overrides (id, shop_id, order_key, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('rollback-before-selected-source', 'shop-a', 'order-before-selected-source', 'must roll back', timestamp, timestamp);
    source.prepare(`
      INSERT INTO ozon_marketing_activities (
        shop_id, activity_id, source_type, source_label, source_tone, title, original_title, description,
        joined_count, available_count, has_available_count, estimate, date_start, date_end,
        raw_json, remote_hash, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-invalid-selected-source', 'official', '平台活动', 'primary',
      'selected source guard', 'selected source guard', '',
      0, 0, 0, '', '', '', 'hash-invalid-selected-source', timestamp, timestamp, timestamp,
    );
    source.prepare(`
      INSERT INTO marketing_view_state (
        shop_id, selected_activity_id, selected_source_type, product_scope,
        selected_product_ids_json, activity_total, joined_activity_total,
        joined_product_total, issue_product_total, summary_initialized,
        cached_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'shop-a', 'activity-invalid-selected-source', 'official', 'joined', '[]',
      1, 0, 0, 0, 1, timestamp, timestamp, timestamp,
    );
    let candidate = createRecoveryExporter({ db: source }).buildShopCandidate({
      shopId: 'shop-a', encryptionKey, dedupeKey, aad,
    });
    const viewPolicy = getDataDomain('marketing-view-state');
    const viewManifest = candidate.domains.find((domain) => domain.domain === viewPolicy.domain);
    const current = decryptRecoveryChunk({
      encrypted: candidate.chunks.find((chunk) => chunk.chunkId === viewManifest.chunkId), encryptionKey, aad,
    });
    const invalidRecords = current.records.map((record) => {
      const value = { ...record.value, selected_source_type: 'unknown-selected-source' };
      return {
        key: buildRecoveryRecordKey(viewPolicy, value, { primaryKey: viewPolicy.primaryKey }),
        value,
      };
    });
    candidate = replaceDomainCandidate(candidate, viewPolicy.domain, {
      schemaVersion: 3,
      records: invalidRecords,
    });
    const purchaseDomain = candidate.domains.find((domain) => domain.domain === 'purchase-overrides');
    candidate = {
      ...candidate,
      domains: [purchaseDomain, ...candidate.domains.filter((domain) => domain !== purchaseDomain)],
    };

    assert.throws(
      () => createRecoveryImporter({ db: staging }).importShopCandidate({
        candidate, encryptionKey, aad, expectedShopId: 'shop-a',
      }),
      /RESTORE_MARKETING_SELECTED_SOURCE_TYPE_INVALID/,
    );
    assert.equal(
      staging.prepare('SELECT COUNT(*) AS count FROM purchase_order_overrides WHERE shop_id = ?').get('shop-a').count,
      0,
    );
    assert.equal(
      staging.prepare('SELECT COUNT(*) AS count FROM ozon_marketing_activities WHERE shop_id = ?').get('shop-a').count,
      0,
    );
    assert.equal(
      staging.prepare('SELECT COUNT(*) AS count FROM marketing_view_state WHERE shop_id = ?').get('shop-a').count,
      0,
    );
  } finally {
    source.close();
    staging.close();
  }
});
