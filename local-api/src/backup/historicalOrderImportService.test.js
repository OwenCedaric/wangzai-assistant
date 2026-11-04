import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderRepository } from '../db/repositories/orderRepository.js';
import { createProductRepository } from '../db/repositories/productRepository.js';
import { createPurchaseOrderOverrideRepository } from '../db/repositories/purchaseOrderOverrideRepository.js';
import { createShopRepository } from '../db/repositories/shopRepository.js';
import { createMigratedTestDb, saveUnitShop } from '../../test/testDb.js';
import { createHistoricalOrderImportService } from './historicalOrderImportService.js';

function createFixture() {
  const db = createMigratedTestDb();
  saveUnitShop(createShopRepository(db), 'shop-order-history');
  const products = createProductRepository(db);
  products.upsertProducts({
    shopId: 'shop-order-history',
    rows: [
      { product_id: '1001', offer_id: 'offer-1', sku: '9001', name: 'Product 1', price: '99' },
      { product_id: '1002', offer_id: 'offer-2', sku: '9002', name: 'Product 2', price: '88' },
    ],
  });
  const orders = createOrderRepository(db);
  orders.upsertOrders({
    shopId: 'shop-order-history',
    rows: [
      {
        posting_number: 'ORDER-ONE-1',
        order_id: 'order-id-1',
        status: 'delivered',
        products: [{ product_id: '1001', offer_id: 'offer-1', sku: '9001', quantity: 1 }],
      },
      {
        posting_number: 'ORDER-MULTI-1',
        order_id: 'order-id-2',
        status: 'delivered',
        products: [
          { product_id: '1001', offer_id: 'offer-1', sku: '9001', quantity: 1 },
          { product_id: '1002', offer_id: 'offer-2', sku: '9002', quantity: 1 },
        ],
      },
      {
        posting_number: 'ORDER-UNKNOWN-1',
        order_id: 'order-id-3',
        status: 'delivered',
        products: [{ product_id: '9999', offer_id: 'missing-offer', sku: '9999', quantity: 1 }],
      },
    ],
  });
  return {
    db,
    orders,
    service: createHistoricalOrderImportService({ db }),
  };
}

function confirm(service, preview) {
  return service.confirm({
    shopId: 'shop-order-history',
    importId: preview.importId,
    previewFingerprint: preview.previewFingerprint,
  });
}

test('official Ozon backfill runs before historical order matching', async () => {
  const { db, orders } = createFixture();
  try {
    let requested = null;
    const service = createHistoricalOrderImportService({
      db,
      refreshOrdersByPostingNumbers: async (input) => {
        requested = input;
        orders.upsertOrders({
          shopId: input.shopId,
          rows: [{
            posting_number: 'ORDER-BACKFILL-1',
            order_id: 'order-backfill-1',
            status: 'delivered',
            products: [{ product_id: '1001', offer_id: 'offer-1', sku: '9001' }],
          }],
        });
        return { ok: true, foundCount: 1, notFoundCount: 0, failedCount: 0 };
      },
    });
    const preview = await service.preflightWithOzon({
      shopId: 'shop-order-history',
      rows: [{ orderNumber: 'ORDER-BACKFILL-1', purchaseCostCny: '12' }],
    });
    assert.deepEqual(requested.postingNumbers, ['ORDER-BACKFILL-1']);
    assert.deepEqual(preview.officialLookup, {
      requestedCount: 1,
      foundCount: 1,
      notFoundCount: 0,
      failedCount: 0,
    });
    assert.equal(preview.rows[0].status, 'ready_insert');
    assert.equal(preview.rows[0].selectedProduct.productId, '1001');
  } finally {
    db.close();
  }
});
test('historical order import accepts Ozon订单号, auto-matches one product, keeps zero, and feeds profit override fields', () => {
  const { db, orders, service } = createFixture();
  try {
    const preview = service.preflight({
      shopId: 'shop-order-history',
      source: { fileName: 'C:\\private\\历史订单.xlsx', fileType: 'xlsx' },
      rows: [{
        Ozon订单号: 'ORDER-ONE-1',
        采购成本: '0',
        跨境巴士成本: '2.34',
        国内运费: '1.2',
        长: '12.3',
        宽: '4',
        高: '5.5',
        重量: '0.25',
        采购平台: '1688',
        采购单号: 'PURCHASE-1',
      }],
    });

    assert.equal(preview.ok, true);
    assert.equal(preview.sourceType, 'historical_order_import');
    assert.deepEqual(preview.source, { fileName: '历史订单.xlsx', fileType: 'xlsx' });
    assert.deepEqual(preview.summary, {
      insert: 1,
      update: 0,
      unchanged: 0,
      selectionRequired: 0,
      orderNotFound: 0,
      productUnmatched: 0,
      invalid: 0,
      duplicate: 0,
      noData: 0,
    });
    assert.equal(preview.rows[0].matchMode, 'automatic');
    assert.equal(preview.rows[0].selectedProduct.productId, '1001');
    assert.deepEqual(preview.rows[0].values, {
      purchaseCostCny: 0,
      crossBorderCostCny: 2.34,
      domesticFreightCny: 1.2,
      lengthCm: 12.3,
      widthCm: 4,
      heightCm: 5.5,
      weightKg: 0.25,
      currencyCode: 'CNY',
      sourcePlatform: '1688',
      purchaseOrderNumber: 'PURCHASE-1',
    });

    const completed = confirm(service, preview);
    assert.equal(completed.verified, true);
    assert.equal(completed.summary.committed, 1);

    const fact = db.prepare(`
      SELECT * FROM historical_order_facts
      WHERE shop_id = ? AND posting_number = ?
    `).get('shop-order-history', 'ORDER-ONE-1');
    assert.equal(fact.source_type, 'historical_order_import');
    assert.equal(fact.product_id, '1001');
    assert.equal(fact.purchase_cost_minor, 0);
    assert.equal(fact.cross_border_cost_minor, 234);
    assert.equal(fact.domestic_freight_minor, 120);
    assert.deepEqual([fact.length_mm, fact.width_mm, fact.height_mm, fact.weight_g], [123, 40, 55, 250]);

    const override = db.prepare(`
      SELECT source_cost_cny, raw_json FROM purchase_order_overrides
      WHERE shop_id = ? AND posting_number = ?
    `).get('shop-order-history', 'ORDER-ONE-1');
    const raw = JSON.parse(override.raw_json);
    assert.equal(override.source_cost_cny, 0);
    assert.equal(raw.manualProfitSourcePurchaseCostCny, 0);
    assert.equal(raw.manualProfitLogisticsFeeCny, 1.2);
    assert.equal(raw.manualProfitCrossBorderBusFeeCny, 2.34);
    assert.equal(raw.historicalOrderImport.sourceType, 'historical_order_import');

    const profitOverride = createPurchaseOrderOverrideRepository(db)
      .getOverride({ shopId: 'shop-order-history', orderKey: 'ORDER-ONE-1' });
    assert.equal(profitOverride.sourceCostCny, 0);
    assert.equal(profitOverride.manualProfitSourcePurchaseCostCny, 0);
    assert.equal(profitOverride.manualProfitLogisticsFeeCny, 1.2);
    assert.equal(profitOverride.manualProfitCrossBorderBusFeeCny, 2.34);

    const orderDto = orders.listOrders({ shopId: 'shop-order-history', postingNumber: 'ORDER-ONE-1' }).rows[0];
    assert.deepEqual(orderDto.historicalOrderImport, {
      sourceType: 'historical_order_import',
      orderNumber: 'ORDER-ONE-1',
      orderId: 'order-id-1',
      productIdentityId: fact.product_identity_id,
      productId: '1001',
      offerId: 'offer-1',
      sku: '9001',
      productName: 'Product 1',
      purchaseCostCny: 0,
      crossBorderCostCny: 2.34,
      domesticFreightCny: 1.2,
      packagingCostCny: null,
      otherCostCny: null,
      currencyCode: 'CNY',
      lengthCm: 12.3,
      widthCm: 4,
      heightCm: 5.5,
      weightKg: 0.25,
      sourcePlatform: '1688',
      sourceUrl: '',
      purchaseOrderNumber: 'PURCHASE-1',
      trackingNumber: '',
      note: '',
      originImportId: preview.importId,
      updatedAt: fact.updated_at,
    });

    assert.equal(confirm(service, preview).idempotent, true);
    const history = service.history({ shopId: 'shop-order-history' });
    assert.equal(history.imports.length, 1);
    assert.equal(history.imports[0].status, 'completed');
  } finally {
    db.close();
  }
});

test('migration 070 keeps historical user facts independent from rebuildable product identities', () => {
  const { db, service } = createFixture();
  try {
    const productForeignKeys = db.prepare("PRAGMA foreign_key_list('historical_order_facts')").all()
      .filter((row) => row.table === 'product_identities');
    assert.deepEqual(productForeignKeys, []);

    const preview = service.preflight({
      shopId: 'shop-order-history',
      rows: [{ orderNumber: 'ORDER-ONE-1', purchaseCostCny: '1' }],
    });
    confirm(service, preview);
    const identityId = db.prepare(`
      SELECT product_identity_id FROM historical_order_facts WHERE posting_number = ?
    `).get('ORDER-ONE-1').product_identity_id;
    db.prepare('DELETE FROM product_identities WHERE product_identity_id = ?').run(identityId);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM historical_order_facts WHERE posting_number = ?')
        .get('ORDER-ONE-1').count,
      1,
    );
  } finally {
    db.close();
  }
});

test('multi-product orders require an explicit candidate selection and never guess', () => {
  const { db, service } = createFixture();
  try {
    const needsSelection = service.preflight({
      shopId: 'shop-order-history',
      rows: [{ orderNumber: 'ORDER-MULTI-1', purchaseCostCny: '10' }],
    });
    assert.equal(needsSelection.rows[0].status, 'selection_required');
    assert.equal(needsSelection.rows[0].errorCode, 'HISTORICAL_ORDER_IMPORT_PRODUCT_SELECTION_REQUIRED');
    assert.deepEqual(needsSelection.rows[0].productCandidates.map((row) => row.productId), ['1001', '1002']);
    assert.equal(confirm(service, needsSelection).summary.committed, 0);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM historical_order_facts WHERE posting_number = ?')
        .get('ORDER-MULTI-1').count,
      0,
    );

    const selected = service.preflight({
      shopId: 'shop-order-history',
      columns: [
        { sourceHeader: 'Ozon订单号', field: 'orderNumber' },
        { sourceHeader: '采购成本', field: 'purchaseCostCny' },
      ],
      rows: [{ orderNumber: 'ORDER-MULTI-1', selectedProductId: '1002', purchaseCostCny: '10' }],
    });
    assert.equal(selected.rows[0].status, 'ready_insert');
    assert.equal(selected.rows[0].matchMode, 'selected');
    assert.equal(selected.rows[0].selectedProduct.productId, '1002');
    assert.equal(confirm(service, selected).summary.committed, 1);
    assert.equal(
      db.prepare('SELECT product_id FROM historical_order_facts WHERE posting_number = ?')
        .get('ORDER-MULTI-1').product_id,
      '1002',
    );

    const wrongSelection = service.preflight({
      shopId: 'shop-order-history',
      rows: [{ orderNumber: 'ORDER-MULTI-1', selectedProductId: '9999', purchaseCostCny: '1' }],
    });
    assert.equal(wrongSelection.rows[0].status, 'invalid');
    assert.equal(wrongSelection.rows[0].errorCode, 'HISTORICAL_ORDER_IMPORT_SELECTED_PRODUCT_NOT_IN_ORDER');
  } finally {
    db.close();
  }
});

test('preflight classifies missing orders, unmatched products, duplicate orders, no-data, and non-positive measures', () => {
  const { db, service } = createFixture();
  try {
    const preview = service.preflight({
      shopId: 'shop-order-history',
      rows: [
        { orderNumber: 'ORDER-ONE-1', purchaseCostCny: '1' },
        { orderNumber: 'ORDER-ONE-1', purchaseCostCny: '2' },
        { orderNumber: 'ORDER-MISSING-1', purchaseCostCny: '3' },
        { orderNumber: 'ORDER-UNKNOWN-1', purchaseCostCny: '4' },
        { orderNumber: 'ORDER-MULTI-1' },
        { orderNumber: 'ORDER-MULTI-1', selectedProductId: '1001', lengthCm: 0 },
        { orderNumber: { unsafe: true }, purchaseCostCny: '1' },
      ],
    });
    assert.deepEqual(preview.rows.map((row) => row.status), [
      'ready_insert',
      'duplicate',
      'order_not_found',
      'product_unmatched',
      'no_data',
      'invalid',
      'invalid',
    ]);
    assert.equal(preview.rows[5].errorCode, 'HISTORICAL_ORDER_IMPORT_MEASURE_MUST_BE_POSITIVE');
    assert.equal(preview.rows[6].errorCode, 'HISTORICAL_ORDER_IMPORT_IDENTIFIER_INVALID');

    const invalidMeasure = service.preflight({
      shopId: 'shop-order-history',
      rows: [{ orderNumber: 'ORDER-ONE-1', weightKg: '-1' }],
    });
    assert.equal(invalidMeasure.rows[0].status, 'invalid');
    assert.equal(invalidMeasure.rows[0].errorCode, 'HISTORICAL_ORDER_IMPORT_MEASURE_INVALID');
  } finally {
    db.close();
  }
});

test('blank fields never overwrite confirmed facts or profit projections, while an explicit zero does', () => {
  const { db, service } = createFixture();
  try {
    const first = service.preflight({
      shopId: 'shop-order-history',
      rows: [{
        orderNumber: 'ORDER-ONE-1',
        purchaseCostCny: '12.34',
        crossBorderCostCny: '2',
        lengthCm: '10',
        note: 'first',
      }],
    });
    confirm(service, first);

    const partial = service.preflight({
      shopId: 'shop-order-history',
      rows: [{
        orderNumber: 'ORDER-ONE-1',
        purchaseCostCny: '',
        crossBorderCostCny: '   ',
        lengthCm: '',
        note: 'second',
      }],
    });
    assert.deepEqual(partial.rows[0].appliedValues, { note: 'second' });
    confirm(service, partial);
    let fact = db.prepare('SELECT * FROM historical_order_facts WHERE posting_number = ?').get('ORDER-ONE-1');
    assert.equal(fact.purchase_cost_minor, 1234);
    assert.equal(fact.cross_border_cost_minor, 200);
    assert.equal(fact.length_mm, 100);
    assert.equal(fact.note, 'second');

    const zero = service.preflight({
      shopId: 'shop-order-history',
      rows: [{ orderNumber: 'ORDER-ONE-1', purchaseCostCny: 0 }],
    });
    assert.deepEqual(zero.rows[0].appliedValues, { purchaseCostCny: 0 });
    confirm(service, zero);
    fact = db.prepare('SELECT * FROM historical_order_facts WHERE posting_number = ?').get('ORDER-ONE-1');
    assert.equal(fact.purchase_cost_minor, 0);
    const override = db.prepare('SELECT source_cost_cny, raw_json FROM purchase_order_overrides WHERE posting_number = ?')
      .get('ORDER-ONE-1');
    assert.equal(override.source_cost_cny, 0);
    assert.equal(JSON.parse(override.raw_json).manualProfitSourcePurchaseCostCny, 0);
  } finally {
    db.close();
  }
});

test('confirm fails closed when Ozon order evidence changes after preflight', () => {
  const { db, orders, service } = createFixture();
  try {
    const preview = service.preflight({
      shopId: 'shop-order-history',
      rows: [{ orderNumber: 'ORDER-ONE-1', purchaseCostCny: '1' }],
    });
    orders.upsertOrders({
      shopId: 'shop-order-history',
      rows: [{
        posting_number: 'ORDER-ONE-1',
        order_id: 'order-id-1',
        status: 'delivered',
        products: [{ product_id: '1001', offer_id: 'offer-1', sku: '9001', quantity: 2 }],
      }],
    });
    assert.throws(
      () => confirm(service, preview),
      (error) => error?.code === 'HISTORICAL_ORDER_IMPORT_PREVIEW_STALE',
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM historical_order_facts WHERE posting_number = ?')
        .get('ORDER-ONE-1').count,
      0,
    );
  } finally {
    db.close();
  }
});
