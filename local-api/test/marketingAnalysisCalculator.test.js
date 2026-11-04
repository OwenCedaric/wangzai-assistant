import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMarketingAnalysis } from '../src/domain/dataAnalysis/calculators/marketingAnalysisCalculator.js';

function metricMap(result) {
  return new Map(result.metrics.map((metric) => [metric.id, metric]));
}

test('marketing calculator uses selected cutoff, removes stale and de-duplicates current products', () => {
  const activities = [
    {
      activity_id: 'a1',
      title: '长期活动',
      joined_count: 3,
      available_count: 4,
      has_available_count: 1,
      raw_json: '{"date_start":"2026-06-01","date_end":"2026-07-31","action_type":"SALE"}',
    },
    {
      activity_id: 'a2',
      title: '已结束活动',
      joined_count: 1,
      available_count: 99,
      has_available_count: 1,
      raw_json: '{"date_start":"2026-05-01","date_end":"2026-06-15","action_type":"SALE"}',
    },
    {
      activity_id: 'a3',
      title: '未来活动',
      joined_count: 1,
      available_count: 2,
      has_available_count: 1,
      raw_json: '{"date_start":"2026-08-01","date_end":"2026-08-31","action_type":"SALE"}',
    },
    {
      activity_id: 'stale-a',
      is_stale: 1,
      raw_json: '{"date_start":"2026-06-01","date_end":"2026-07-31"}',
    },
  ];
  const products = [
    { id: 1, activity_id: 'a1', product_id: 'p1', stock: 0, activity_price: 10, updated_at: '2026-07-01' },
    { id: 2, activity_id: 'a1', product_id: 'p1', stock: 0, activity_price: 10, updated_at: '2026-07-02' },
    { id: 3, activity_id: 'a1', product_id: 'p2', stock: 5, activity_price: 20, updated_at: '2026-07-02' },
    { id: 4, activity_id: 'a2', product_id: 'p1', stock: 0, activity_price: 9, updated_at: '2026-06-01' },
    { id: 5, activity_id: 'a1', product_id: 'stale-p', is_stale: 1 },
  ];

  const result = calculateMarketingAnalysis({
    activities,
    products,
    range: { startDate: '2026-06-11', endDate: '2026-07-10' },
  });
  const metrics = metricMap(result);

  assert.equal(metrics.get('activityCount').value, 2);
  assert.equal(metrics.get('historyActivityCount').value, 3);
  assert.equal(metrics.get('activeActivityCount').value, 1);
  assert.equal(metrics.get('joinedActivityProductCount').value, 2);
  assert.equal(metrics.get('activeActivityRelationCount').value, 2);
  assert.equal(metrics.get('cachedActivityProductCount').value, 3);
  assert.equal(metrics.get('availableActivityProductCount').value, 4);
  assert.equal(result.productRows.length, 3);
  assert.equal(result.quality.activeRelationCount, 2);
});

test('marketing available count remains unavailable when official presence flag is absent', () => {
  const result = calculateMarketingAnalysis({
    activities: [
      {
        activity_id: 'a1',
        available_count: 0,
        raw_json: '{"date_start":"2026-01-01","date_end":"2026-12-31"}',
      },
    ],
    range: { endDate: '2026-07-10' },
  });
  const metric = metricMap(result).get('availableActivityProductCount');
  assert.equal(metric.value, null);
  assert.equal(metric.status, 'not_returned');
});

test('marketing product rows fill catalog identity and expose stock differences', () => {
  const result = calculateMarketingAnalysis({
    activities: [
      {
        activity_id: 'a1',
        has_available_count: 1,
        available_count: 0,
        raw_json: '{"date_start":"2026-01-01","date_end":"2026-12-31"}',
      },
    ],
    products: [
      {
        activity_id: 'a1',
        product_id: 'p1',
        name: 'p1',
        offer_id: '',
        sku: '',
        stock: 0,
        price: 100,
        activity_price: 80,
      },
    ],
    catalogProducts: [
      {
        product_id: 'p1',
        offer_id: 'offer-p1',
        sku: 'sku-p1',
        name: '真实商品名称',
        currency_code: 'CNY',
        stock_value: 7,
        stock_json: '{"present":7}',
      },
    ],
    range: { endDate: '2026-07-10' },
  });
  const row = result.productRows[0];
  assert.equal(row.name, '真实商品名称');
  assert.equal(row.catalogName, '真实商品名称');
  assert.equal(row.offerId, 'offer-p1');
  assert.equal(row.sku, 'sku-p1');
  assert.equal(row.activityStock, 0);
  assert.equal(row.currentStock, 7);
  assert.equal(row.stockMismatch, true);
  assert.equal(row.stockDifference, 7);
  assert.equal(row.currency, 'CNY');
});

test('marketing keeps missing joined count unavailable and converts activity dates in Moscow time', () => {
  const result = calculateMarketingAnalysis({
    activities: [
      {
        activity_id: 'a1',
        joined_count: null,
        has_available_count: 1,
        available_count: 0,
        raw_json: '{"date_start":"2026-06-17T21:00:00Z","date_end":"2026-06-30T21:00:00Z"}',
      },
    ],
    range: { startDate: '2026-06-18', endDate: '2026-07-01' },
  });
  assert.equal(result.activityRows[0].startDate, '2026-06-18');
  assert.equal(result.activityRows[0].endDate, '2026-07-01');
  assert.equal(result.activityRows[0].joinedCount, null);
  assert.equal(result.activityRows[0].joinedCountKnown, false);
});
