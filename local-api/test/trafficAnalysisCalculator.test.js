import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTrafficAnalysis } from '../src/domain/dataAnalysis/calculators/trafficAnalysisCalculator.js';

test('traffic funnel uses official ordered units and keeps matched local orders as a separate check', () => {
  const result = calculateTrafficAnalysis({
    rows: [
      { report_date: '2026-06-11', visitor_sessions: 100, product_views: 120, cart_adds: 10, ordered_units: 3, revenue_rub: 50, updated_at: '2026-07-10T13:00:00Z' },
      { report_date: '2026-06-12', visitor_sessions: 100, product_views: 140, cart_adds: 8, ordered_units: 4, revenue_rub: 60, updated_at: '2026-07-10T13:00:00Z' },
    ],
    orderRows: [
      { id: 'before', in_process_at: '2026-06-10T09:00:00Z', updated_at: '2026-07-10T13:00:00Z' },
      { id: 'in-1', in_process_at: '2026-06-11T09:00:00Z', updated_at: '2026-07-10T13:00:00Z' },
      { id: 'in-2', in_process_at: '2026-06-12T09:00:00Z', updated_at: '2026-07-10T13:00:00Z' },
      { id: 'after', in_process_at: '2026-06-13T09:00:00Z', updated_at: '2026-07-10T13:00:00Z' },
    ],
  });

  const metrics = new Map(result.metrics.map((metric) => [metric.id, metric]));
  assert.equal(metrics.get('trafficOrderCount').value, 7);
  assert.equal(metrics.get('trafficOrderCount').source.id, 'analytics');
  assert.equal(metrics.get('trafficOrderConversionRate').value, 3.5);
  assert.equal(metrics.get('trafficMatchedOrderCount').value, 2);
  assert.equal(metrics.get('trafficMatchedOrderCount').source.id, 'orders');
  assert.deepEqual(result.coverage, {
    startDate: '2026-06-11',
    endDate: '2026-06-12',
    dayCount: 2,
    continuous: true,
  });
  assert.equal(result.dailyTrend.find((row) => row.date === '2026-06-11').orderedUnits, 3);
  assert.equal(result.dailyTrend.find((row) => row.date === '2026-06-11').matchedOrderCount, 1);
});

test('traffic comparison is hidden when official snapshot coverage days differ', () => {
  const result = calculateTrafficAnalysis({
    rows: [
      { report_date: '2026-07-01', visitor_sessions: 100, product_views: 120, cart_adds: 10, ordered_units: 3, revenue_rub: 50 },
      { report_date: '2026-07-02', visitor_sessions: 90, product_views: 100, cart_adds: 8, ordered_units: 2, revenue_rub: 40 },
    ],
    comparisonRows: [
      { report_date: '2026-06-30', visitor_sessions: 80, product_views: 90, cart_adds: 5, ordered_units: 1, revenue_rub: 20 },
    ],
  });
  const sessions = result.metrics.find((metric) => metric.id === 'trafficSessionCount');
  assert.equal(sessions.comparisonValue, null);
  assert.equal(sessions.delta, null);
  assert.equal(result.quality.comparisonComparable, false);
});

test('traffic daily trend preserves missing fields while keeping confirmed zero values', () => {
  const result = calculateTrafficAnalysis({
    rows: [
      {
        report_date: '2026-07-10',
        visitor_sessions: null,
        product_views: 0,
        cart_adds: null,
        ordered_units: 0,
        revenue_rub: null,
      },
    ],
  });

  assert.deepEqual(result.dailyTrend[0], {
    date: '2026-07-10',
    visitorSessions: null,
    productViews: 0,
    cartAdds: null,
    orderedUnits: 0,
    matchedOrderCount: 0,
    revenueRub: null,
    revenueCurrency: null,
  });

  const metrics = new Map(result.metrics.map((metric) => [metric.id, metric]));
  assert.equal(metrics.get('trafficSessionCount').value, null);
  assert.equal(metrics.get('trafficSessionCount').status, 'not_returned');
  assert.equal(metrics.get('trafficProductViewCount').value, 0);
  assert.equal(metrics.get('trafficProductViewCount').status, 'confirmed');
  assert.equal(metrics.get('trafficOrderCount').value, 0);
  assert.equal(metrics.get('trafficOrderCount').status, 'confirmed');
  assert.equal(metrics.get('trafficCartConversionRate').status, 'not_returned');
});

test('traffic daily trend aggregates multiple shops into one point per date', () => {
  const result = calculateTrafficAnalysis({
    rows: [
      {
        shop_id: 'shop-a',
        report_date: '2026-08-03',
        visitor_sessions: 19,
        product_views: 29,
        cart_adds: 0,
        ordered_units: 0,
        revenue_rub: 0,
        raw_metrics_json: JSON.stringify({ sourceCurrency: 'RUB' }),
      },
      {
        shop_id: 'shop-b',
        report_date: '2026-08-03',
        visitor_sessions: 3569,
        product_views: 8377,
        cart_adds: 45,
        ordered_units: 2,
        revenue_rub: 10219.6053,
        raw_metrics_json: JSON.stringify({ sourceCurrency: 'RUB' }),
      },
      {
        shop_id: 'shop-c',
        report_date: '2026-08-03',
        visitor_sessions: 6414,
        product_views: 8466,
        cart_adds: 41,
        ordered_units: 27,
        revenue_rub: 8622.7903,
        raw_metrics_json: JSON.stringify({ sourceCurrency: 'RUB' }),
      },
      {
        shop_id: 'shop-a',
        report_date: '2026-08-04',
        visitor_sessions: 24,
        product_views: 30,
        cart_adds: 0,
        ordered_units: 0,
        revenue_rub: 0,
        raw_metrics_json: JSON.stringify({ sourceCurrency: 'RUB' }),
      },
    ],
    orderRows: [
      { id: 'order-1', in_process_at: '2026-08-03T09:00:00Z' },
      { id: 'order-2', in_process_at: '2026-08-03T10:00:00Z' },
    ],
  });

  assert.equal(result.rowCount, 4);
  assert.equal(result.dailyTrend.length, 2);
  assert.deepEqual(result.dailyTrend[0], {
    date: '2026-08-03',
    visitorSessions: 10002,
    productViews: 16872,
    cartAdds: 86,
    orderedUnits: 29,
    matchedOrderCount: 2,
    revenueRub: 18842.3956,
    revenueCurrency: 'RUB',
  });
  assert.deepEqual(result.dailyTrend[1], {
    date: '2026-08-04',
    visitorSessions: 24,
    productViews: 30,
    cartAdds: 0,
    orderedUnits: 0,
    matchedOrderCount: 0,
    revenueRub: 0,
    revenueCurrency: 'RUB',
  });
});

test('traffic comparison is hidden when equal row counts contain date gaps', () => {
  const result = calculateTrafficAnalysis({
    rows: [
      { report_date: '2026-07-01', visitor_sessions: 10 },
      { report_date: '2026-07-03', visitor_sessions: 20 },
    ],
    comparisonRows: [
      { report_date: '2026-06-01', visitor_sessions: 10 },
      { report_date: '2026-06-02', visitor_sessions: 20 },
    ],
  });
  assert.equal(result.coverage.continuous, false);
  assert.equal(result.quality.comparisonComparable, false);
  assert.equal(result.metrics.find((metric) => metric.id === 'trafficSessionCount').delta, null);
});
