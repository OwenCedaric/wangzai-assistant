import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateProductAnalysis } from '../src/domain/dataAnalysis/calculators/productAnalysisCalculator.js';

function metricMap(result) {
  return new Map(result.metrics.map((metric) => [metric.id, metric]));
}

test('product calculator uses snapshot states and keeps archived stock out of candidate inventory', () => {
  const rows = [
    {
      product_id: 'sale-1',
      offer_id: 'offer-sale',
      name: '出售中商品',
      visibility: 'ALL',
      snapshot_visibilities_json: '["ALL","IN_SALE"]',
      price_value: 0,
      price_json: '{"price":88,"currency_code":"CNY"}',
      stock_value: 0,
      stock_json: '{"present":0,"stocks":[{"present":0}]}',
      category_id: '10',
      type_id: '100',
      hydrated_at: '2026-07-10',
      prices_synced_at: '2026-07-10',
      stocks_synced_at: '2026-07-10',
    },
    {
      product_id: 'supply-1',
      offer_id: 'offer-supply',
      name: '待销售商品',
      visibility: 'ALL',
      snapshot_visibilities_json: '["ALL","TO_SUPPLY"]',
      price_value: 50,
      currency_code: 'CNY',
      stock_value: 0,
      stock_json: '{"present":null,"stocks":[]}',
      category_id: '11',
      type_id: '101',
      prices_synced_at: '2026-07-10',
      stocks_synced_at: '2026-07-10',
    },
    {
      product_id: 'archive-1',
      offer_id: 'offer-archive',
      name: '归档商品',
      visibility: 'ALL',
      snapshot_visibilities_json: '["ALL","ARCHIVED","TO_SUPPLY"]',
      price_value: 120,
      currency_code: 'CNY',
      stock_value: 30,
      stock_json: '{"present":30}',
      category_id: '12',
    },
    {
      product_id: 'failed-1',
      offer_id: 'offer-failed',
      name: '校验失败商品',
      visibility: 'VALIDATION_STATE_FAIL',
      snapshot_visibilities_json: '["ALL","VALIDATION_STATE_FAIL"]',
      price_value: 20,
      currency_code: 'CNY',
      stock_value: 0,
      stock_json: '{"present":0}',
      category_id: '13',
    },
  ];

  const result = calculateProductAnalysis({
    rows,
    salesProductRanking: [
      { key: 'offer-sale', offerId: 'offer-sale', name: '销量商品', quantity: 9 },
      { key: 'offer-archive', offerId: 'offer-archive', name: '归档销量', quantity: 100 },
    ],
  });
  const metrics = metricMap(result);

  assert.equal(metrics.get('activeProductCount').value, 2);
  assert.equal(metrics.get('inSaleProductCount').value, 1);
  assert.equal(metrics.get('toSupplyProductCount').value, 1);
  assert.equal(metrics.get('archivedProductCount').value, 1);
  assert.equal(metrics.get('productErrorCount').value, 1);
  assert.equal(metrics.get('stockUnits').value, 0);
  assert.equal(metrics.get('stockUnits').status, 'partial');
  assert.equal(metrics.get('archivedStockUnits').value, 30);
  assert.equal(metrics.get('outOfStockCount').value, 1);
  assert.equal(metrics.get('outOfStockCount').status, 'partial');
  assert.equal(metrics.get('inSaleOutOfStockCount').value, 1);
  assert.equal(metrics.get('averageProductPrice').value, 69);
  assert.deepEqual(result.stockRiskRows.map((row) => row.productId), ['sale-1']);
  assert.deepEqual(result.replenishmentRanking.map((row) => row.productId), ['sale-1']);
});

test('product quality separates sync attempts, usable prices, known stocks and category identity', () => {
  const result = calculateProductAnalysis({
    rows: [
      {
        product_id: '1',
        visibility: 'ALL',
        snapshot_visibilities_json: '["ALL","IN_SALE"]',
        price_value: 0,
        price_json: '{"price":64,"currency_code":"CNY"}',
        stock_value: 0,
        stock_json: '{"present":0,"stocks":[{"present":0}]}',
        category_id: '20',
        type_id: '200',
        resolved_category_name: '已解析类目一',
        prices_synced_at: '2026-07-10',
        stocks_synced_at: '2026-07-10',
      },
      {
        product_id: '2',
        visibility: 'ARCHIVED',
        snapshot_visibilities_json: '["ARCHIVED"]',
        price_value: 0,
        price_json: '{"price":0}',
        stock_value: 0,
        stock_json: '{"present":null,"stocks":[]}',
        resolved_category_name: '已解析类目',
        hydrated_at: '2026-07-10',
      },
    ],
  });

  assert.deepEqual(
    {
      scopeLabel: result.quality.scopeLabel,
      total: result.quality.total,
      candidateTotal: result.quality.candidateTotal,
      syncAttemptedCount: result.quality.syncAttemptedCount,
      hydratedCount: result.quality.hydratedCount,
      priceSyncCount: result.quality.priceSyncCount,
      priceKnownCount: result.quality.priceKnownCount,
      priceUsableCount: result.quality.priceUsableCount,
      stockKnownCount: result.quality.stockKnownCount,
      categoryIdKnownCount: result.quality.categoryIdKnownCount,
      categoryNameReturnedCount: result.quality.categoryNameReturnedCount,
      categoryKnownCount: result.quality.categoryKnownCount,
      completeCount: result.quality.completeCount,
    },
    {
      scopeLabel: '全部商品缓存',
      total: 2,
      candidateTotal: 1,
      syncAttemptedCount: 2,
      hydratedCount: 1,
      priceSyncCount: 1,
      priceKnownCount: 2,
      priceUsableCount: 1,
      stockKnownCount: 1,
      categoryIdKnownCount: 1,
      categoryNameReturnedCount: 0,
      categoryKnownCount: 2,
      completeCount: 1,
    }
  );
  assert.equal(result.quality.completeCoveragePercent, 50);
  assert.equal(result.quality.directPriceUsableCount, 0);
  assert.equal(result.quality.priceFallbackCount, 1);
  assert.equal(result.inventoryQuality.total, 1);
  assert.equal(result.inventoryQuality.completeCount, 1);
  assert.equal(result.inventoryQuality.completeCoveragePercent, 100);
});

test('product calculator keeps legacy direct-only ALL rows compatible', () => {
  const result = calculateProductAnalysis({
    rows: [{ product_id: 'legacy', visibility: 'ALL', price_value: 10, stock_value: 0 }],
  });
  const metrics = metricMap(result);
  assert.equal(metrics.get('activeProductCount').value, 1);
  assert.equal(metrics.get('outOfStockCount').value, 1);
});

test('product calculator separates numeric stock payload coverage from explicit official no-stock result', () => {
  const result = calculateProductAnalysis({
    rows: [
      {
        product_id: 'no-stock',
        visibility: 'ALL',
        snapshot_visibilities_json: '["ALL","TO_SUPPLY"]',
        price_value: 10,
        stock_value: 0,
        stock_json: '{"present":null,"stocks":[]}',
        raw_json: '{"has_fbo_stocks":false,"has_fbs_stocks":false,"quants":[]}',
        category_id: '10',
        resolved_category_name: '已解析类目',
      },
    ],
  });
  const metrics = metricMap(result);
  assert.equal(result.quality.stockKnownCount, 0);
  assert.equal(result.quality.stockResultKnownCount, 1);
  assert.equal(result.quality.completeCount, 1);
  assert.equal(metrics.get('outOfStockCount').value, 1);
  assert.equal(result.stockRiskRows.length, 1);
});
