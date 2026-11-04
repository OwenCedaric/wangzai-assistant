import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';
import { createProductRepository } from '../db/repositories/productRepository.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { createHistoricalProductImportService } from './historicalProductImportService.js';

function createFixture(productRows = []) {
  const db = createMigratedTestDb();
  saveUnitShop(createShopRepository(db), 'shop-history');
  const productRepository = createProductRepository(db);
  productRepository.upsertProducts({
    shopId: 'shop-history',
    rows: productRows.length
      ? productRows
      : [
          { product_id: '1001', offer_id: 'offer-1', sku: '9001', name: 'Product 1', price: '99' },
          { product_id: '1002', offer_id: 'offer-2', sku: '9002', name: 'Product 2', price: '88' },
        ],
  });
  const service = createHistoricalProductImportService({ db });
  return { db, productRepository, service };
}

function productKey(db, productId) {
  return db.prepare('SELECT product_key FROM ozon_products WHERE shop_id = ? AND product_id = ?')
    .get('shop-history', productId).product_key;
}

function insertCostProfile(db, {
  productId,
  sourceType = 'manual',
  purchaseCostMinor = null,
  crossBorderCostMinor = null,
  otherCostMinor = null,
  note = null,
} = {}) {
  const identity = db.prepare(`
    SELECT product_key, product_id, offer_id, sku
    FROM ozon_products WHERE shop_id = ? AND product_id = ?
  `).get('shop-history', productId);
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO product_manual_cost_profiles (
      id, shop_id, product_key, product_id, offer_id, sku, source_type,
      purchase_cost_minor, cross_border_cost_minor, other_cost_minor,
      currency_code, note, row_hash, observed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CNY', ?, ?, ?, ?, ?)
  `).run(
    `cost:${sourceType}:${productId}:${Date.now()}:${Math.random()}`,
    'shop-history',
    identity.product_key,
    identity.product_id,
    identity.offer_id,
    identity.sku,
    sourceType,
    purchaseCostMinor,
    crossBorderCostMinor,
    otherCostMinor,
    note,
    `hash:${Date.now()}:${Math.random()}`,
    timestamp,
    timestamp,
    timestamp,
  );
}

test('historical import keeps zero, ignores blanks/unknown columns, confirms with readback, and records history', () => {
  const { db, service } = createFixture();
  try {
    const preview = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'preserve',
      source: { fileName: 'C:\\private\\历史商品.xlsx', fileType: 'xlsx' },
      columns: [
        { sourceHeader: '商品ID', field: 'productId' },
        { sourceHeader: '采购成本', field: 'purchaseCostCny' },
        { sourceHeader: '跨境成本', field: 'crossBorderCostCny' },
        { sourceHeader: '其他成本', field: 'otherCostCny' },
        { sourceHeader: '绝不落库', field: 'unknownTarget' },
      ],
      // UI rows are canonical even though columns retain the original Chinese
      // headers for mapping audit.
      rows: [{
        productId: '1001',
        purchaseCostCny: '0',
        crossBorderCostCny: '   ',
        otherCostCny: '1.25',
        unknownTarget: 'sensitive-value',
      }],
    });

    assert.equal(preview.ok, true);
    assert.deepEqual(preview.source, { fileName: '历史商品.xlsx', fileType: 'xlsx' });
    assert.deepEqual(preview.summary, {
      insert: 1,
      update: 0,
      unchanged: 0,
      conflict: 0,
      unmatched: 0,
      invalid: 0,
      duplicate: 0,
      noData: 0,
    });
    assert.deepEqual(preview.rows[0].values, {
      purchaseCostCny: 0,
      otherCostCny: 1.25,
      currencyCode: 'CNY',
    });

    const confirmed = service.confirm({
      shopId: 'shop-history',
      importId: preview.importId,
      previewFingerprint: preview.previewFingerprint,
      conflictMode: 'preserve',
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.verified, true);
    assert.equal(confirmed.importId, preview.importId);
    assert.equal(confirmed.previewFingerprint, preview.previewFingerprint);
    assert.equal(confirmed.summary.committed, 1);

    const saved = db.prepare(`
      SELECT purchase_cost_minor, cross_border_cost_minor, other_cost_minor,
             source_type, origin_import_id
      FROM product_manual_cost_profiles
      WHERE shop_id = ? AND product_key = ? AND source_type = 'historical_import'
    `).get('shop-history', productKey(db, '1001'));
    assert.equal(saved.purchase_cost_minor, 0);
    assert.equal(saved.cross_border_cost_minor, null);
    assert.equal(saved.other_cost_minor, 125);
    assert.equal(saved.origin_import_id, preview.importId);

    const repeated = service.confirm({
      shopId: 'shop-history',
      importId: preview.importId,
      previewFingerprint: preview.previewFingerprint,
      conflictMode: 'preserve',
    });
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.verified, true);

    const history = service.history({ shopId: 'shop-history' });
    assert.equal(history.imports.length, 1);
    assert.equal(history.imports[0].status, 'completed');
    assert.equal(history.imports[0].result.verified, true);
  } finally {
    db.close();
  }
});

test('historical preflight classifies duplicates, unmatched identities, conflicts, ambiguity, no-data, and unsafe identity types', () => {
  const { db, productRepository, service } = createFixture();
  try {
    productRepository.upsertProducts({
      shopId: 'shop-history',
      rows: [{ product_id: '1003', offer_id: 'offer-3', sku: '9001', name: 'Product 3' }],
    });
    const preview = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'preserve',
      rows: [
        { productId: '1001', purchaseCostCny: '1' },
        { offerId: 'offer-1', purchaseCostCny: '2' },
        { productId: '9999', purchaseCostCny: '3' },
        { productId: '1001', offerId: 'offer-2', purchaseCostCny: '4' },
        { sku: '9001', purchaseCostCny: '5' },
        { productId: '1002', unmappedHistoricalColumn: 'not-staged' },
        { productId: 1e21, purchaseCostCny: '6' },
        { productId: { lossy: '1002' }, purchaseCostCny: '7' },
      ],
    });

    assert.deepEqual(preview.summary, {
      insert: 1,
      update: 0,
      unchanged: 0,
      conflict: 0,
      unmatched: 1,
      invalid: 4,
      duplicate: 1,
      noData: 1,
    });
    assert.deepEqual(
      preview.rows.map((row) => [row.status, row.errorCode]),
      [
        ['ready_insert', null],
        ['duplicate', 'HISTORICAL_IMPORT_PRODUCT_DUPLICATE'],
        ['unmatched', 'HISTORICAL_IMPORT_PRODUCT_NOT_FOUND'],
        ['invalid', 'HISTORICAL_IMPORT_PRODUCT_IDENTITY_CONFLICT'],
        ['invalid', 'HISTORICAL_IMPORT_PRODUCT_IDENTITY_AMBIGUOUS'],
        ['no_data', 'HISTORICAL_IMPORT_ROW_NO_DATA'],
        ['invalid', 'HISTORICAL_IMPORT_IDENTITY_VALUE_INVALID'],
        ['invalid', 'HISTORICAL_IMPORT_IDENTITY_VALUE_INVALID'],
      ],
    );
    const staged = db.prepare('SELECT normalized_patch_json FROM historical_import_rows WHERE import_id = ? AND row_index = 5')
      .get(preview.importId);
    assert.equal(staged.normalized_patch_json, '{}');
  } finally {
    db.close();
  }
});

test('manual values outrank historical import while preserve/overwrite only affect historical fields', () => {
  const { db, service } = createFixture();
  try {
    const initial = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'preserve',
      rows: [{ productId: '1001', purchaseCostCny: '10' }],
    });
    service.confirm({
      shopId: 'shop-history',
      importId: initial.importId,
      previewFingerprint: initial.previewFingerprint,
      conflictMode: 'preserve',
    });

    const preserved = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'preserve',
      rows: [{ productId: '1001', purchaseCostCny: '20', crossBorderCostCny: '2' }],
    });
    assert.equal(preserved.rows[0].status, 'conflict');
    assert.deepEqual(preserved.rows[0].appliedValues, { crossBorderCostCny: 2 });
    service.confirm({
      shopId: 'shop-history',
      importId: preserved.importId,
      previewFingerprint: preserved.previewFingerprint,
      conflictMode: 'preserve',
    });

    insertCostProfile(db, { productId: '1001', purchaseCostMinor: 3000, note: 'manual wins' });
    const overwritten = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'overwrite',
      rows: [{
        productId: '1001',
        purchaseCostCny: '40',
        crossBorderCostCny: '4',
        otherCostCny: '3',
      }],
    });
    assert.equal(overwritten.rows[0].status, 'conflict');
    assert.deepEqual(overwritten.rows[0].appliedValues, {
      crossBorderCostCny: 4,
      otherCostCny: 3,
    });
    assert.equal(overwritten.rows[0].conflicts[0].reason, 'manual_value_has_priority');
    service.confirm({
      shopId: 'shop-history',
      importId: overwritten.importId,
      previewFingerprint: overwritten.previewFingerprint,
      conflictMode: 'overwrite',
    });

    const historical = db.prepare(`
      SELECT purchase_cost_minor, cross_border_cost_minor, other_cost_minor
      FROM product_manual_cost_profiles
      WHERE shop_id = ? AND product_key = ? AND source_type = 'historical_import'
    `).get('shop-history', productKey(db, '1001'));
    assert.deepEqual({ ...historical }, {
      purchase_cost_minor: 1000,
      cross_border_cost_minor: 400,
      other_cost_minor: 300,
    });
    const manual = db.prepare(`
      SELECT purchase_cost_minor, note FROM product_manual_cost_profiles
      WHERE shop_id = ? AND product_key = ? AND source_type = 'manual'
    `).get('shop-history', productKey(db, '1001'));
    assert.equal(manual.purchase_cost_minor, 3000);
    assert.equal(manual.note, 'manual wins');
  } finally {
    db.close();
  }
});

test('CNY cost fields reject foreign currency and never partially merge into a legacy non-CNY profile', () => {
  const { db, service } = createFixture();
  try {
    const unsupported = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'preserve',
      rows: [{ productId: '1001', purchaseCostCny: '10', currencyCode: 'USD' }],
    });
    assert.equal(unsupported.rows[0].status, 'invalid');
    assert.equal(unsupported.rows[0].errorCode, 'HISTORICAL_IMPORT_CURRENCY_UNSUPPORTED');

    insertCostProfile(db, {
      productId: '1001',
      sourceType: 'historical_import',
      purchaseCostMinor: 1000,
    });
    // Simulate a database created before the CNY CHECK existed. The current
    // runtime must fail closed even if such a legacy row is encountered.
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare(`
      UPDATE product_manual_cost_profiles SET currency_code = 'USD'
      WHERE shop_id = ? AND product_key = ? AND source_type = 'historical_import'
    `).run('shop-history', productKey(db, '1001'));
    db.exec('PRAGMA ignore_check_constraints = OFF');

    const preview = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'overwrite',
      rows: [{
        productId: '1001',
        purchaseCostCny: '20',
        crossBorderCostCny: '2',
      }],
    });
    assert.equal(preview.rows[0].status, 'conflict');
    assert.deepEqual(preview.rows[0].appliedValues, {});
    assert.equal(
      preview.rows[0].conflicts.every((item) => item.reason === 'existing_currency_incompatible'),
      true,
    );
    const confirmed = service.confirm({
      shopId: 'shop-history',
      importId: preview.importId,
      previewFingerprint: preview.previewFingerprint,
      conflictMode: 'overwrite',
    });
    assert.equal(confirmed.summary.committed, 0);
    const saved = db.prepare(`
      SELECT purchase_cost_minor, cross_border_cost_minor, currency_code
      FROM product_manual_cost_profiles
      WHERE shop_id = ? AND product_key = ? AND source_type = 'historical_import'
    `).get('shop-history', productKey(db, '1001'));
    assert.deepEqual({ ...saved }, {
      purchase_cost_minor: 1000,
      cross_border_cost_minor: null,
      currency_code: 'USD',
    });
  } finally {
    db.close();
  }
});

test('confirm rejects before-hash and shop-incarnation drift and rolls back earlier rows atomically', () => {
  const { db, service } = createFixture();
  try {
    const preview = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'preserve',
      rows: [
        { productId: '1001', purchaseCostCny: '11' },
        { productId: '1002', purchaseCostCny: '22' },
      ],
    });
    insertCostProfile(db, {
      productId: '1002',
      sourceType: 'historical_import',
      purchaseCostMinor: 999,
    });
    assert.throws(
      () => service.confirm({
        shopId: 'shop-history',
        importId: preview.importId,
        previewFingerprint: preview.previewFingerprint,
        conflictMode: 'preserve',
      }),
      (error) => error.code === 'HISTORICAL_IMPORT_PREVIEW_STALE',
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS total FROM product_manual_cost_profiles
      WHERE shop_id = ? AND product_key = ? AND source_type = 'historical_import'
    `).get('shop-history', productKey(db, '1001')).total, 0);
    assert.equal(db.prepare('SELECT status FROM historical_import_runs WHERE import_id = ?')
      .get(preview.importId).status, 'previewed');

    const incarnationPreview = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'preserve',
      rows: [{ productId: '1001', otherCostCny: '1' }],
    });
    db.prepare("UPDATE shops SET shop_incarnation = 'incarnation:rebound' WHERE id = ?")
      .run('shop-history');
    assert.throws(
      () => service.confirm({
        shopId: 'shop-history',
        importId: incarnationPreview.importId,
        previewFingerprint: incarnationPreview.previewFingerprint,
        conflictMode: 'preserve',
      }),
      (error) => error.code === 'HISTORICAL_IMPORT_SHOP_INCARNATION_STALE',
    );
  } finally {
    db.close();
  }
});

test('confirm recomputes the fingerprint from normalized staging and rejects staged-row drift', () => {
  const { db, service } = createFixture();
  try {
    const preview = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'preserve',
      rows: [{ productId: '1001', purchaseCostCny: '12' }],
    });
    db.prepare(`
      UPDATE historical_import_rows
      SET applied_patch_json = '{"purchaseCostMinor":999}'
      WHERE import_id = ? AND row_index = 0
    `).run(preview.importId);
    assert.throws(
      () => service.confirm({
        shopId: 'shop-history',
        importId: preview.importId,
        previewFingerprint: preview.previewFingerprint,
        conflictMode: 'preserve',
      }),
      (error) => error.code === 'HISTORICAL_IMPORT_PREVIEW_STALE',
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS total FROM product_manual_cost_profiles
      WHERE shop_id = ? AND product_key = ?
    `).get('shop-history', productKey(db, '1001')).total, 0);
  } finally {
    db.close();
  }
});

test('large previews remain fully staged but cap public row details', () => {
  const { db, service } = createFixture();
  try {
    const preview = service.preflight({
      shopId: 'shop-history',
      conflictMode: 'preserve',
      rows: Array.from({ length: 201 }, (_, index) => ({ ignoredColumn: `row-${index}` })),
    });
    assert.equal(preview.rowCount, 201);
    assert.equal(preview.rows.length, 200);
    assert.equal(preview.rowsTruncated, true);
    assert.equal(preview.summary.noData, 201);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM historical_import_rows WHERE import_id = ?')
      .get(preview.importId).total, 201);

    const confirmed = service.confirm({
      shopId: 'shop-history',
      importId: preview.importId,
      previewFingerprint: preview.previewFingerprint,
      conflictMode: 'preserve',
    });
    assert.equal(confirmed.rowCount, 201);
    assert.equal(confirmed.rows.length, 200);
    assert.equal(confirmed.rowsTruncated, true);
    assert.equal(confirmed.summary.skipped, 201);
  } finally {
    db.close();
  }
});
