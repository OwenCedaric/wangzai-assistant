import { describe, expect, it } from 'vitest';
import {
  buildMarketDatasetMetrics,
  isProductPerformanceZeroAmountConflict,
  sumMarketNumbers,
} from './dataAnalysisMarketMetrics.js';

function metricByLabel(metrics, label) {
  return metrics.find((metric) => metric.label === label);
}

describe('dataAnalysisMarketMetrics business accuracy', () => {
  it('fails closed instead of turning a completely missing field into zero', () => {
    const records = [{ title: 'A' }, { title: 'B' }];
    expect(sumMarketNumbers(records, 'revenue')).toBeNull();
    expect(metricByLabel(buildMarketDatasetMetrics('keywords', records), '搜索 GMV')).toMatchObject({
      value: null,
      status: 'not_returned',
      coverage: { totalRows: 2, returnedRows: 0, missingRows: 2 },
    });
  });

  it('uses ordered units as the product-performance average-price weight', () => {
    const records = [
      { id: 'a', orderedProducts: 10, orderAmount: 1_000, averagePurchasePrice: 100 },
      { id: 'b', orderedProducts: 1, orderAmount: 0, averagePurchasePrice: 1_000 },
    ];
    const metrics = buildMarketDatasetMetrics('product-performance', records);
    expect(metricByLabel(metrics, '已订购商品')).toMatchObject({ value: 11, status: 'confirmed' });
    expect(metricByLabel(metrics, '订购金额')).toMatchObject({
      value: 1_000,
      status: 'partial',
      sourceConflictRows: 1,
    });
    expect(metricByLabel(metrics, '成交加权均价')).toMatchObject({
      status: 'confirmed',
      aggregation: 'weighted-average',
      coverage: { coveredWeight: 11, totalWeight: 11 },
    });
    expect(metricByLabel(metrics, '成交加权均价').value).toBeCloseTo(181.8181818, 7);
    expect(isProductPerformanceZeroAmountConflict(records[1])).toBe(true);
  });

  it('uses market sales as the missing-item average-price weight', () => {
    const records = [
      { id: 'a', sales: 10, averagePrice: 100, revenue: 1_000 },
      { id: 'b', sales: 20, averagePrice: 200, revenue: 4_000 },
      { id: 'c', averagePrice: 9_999 },
    ];
    const metrics = buildMarketDatasetMetrics('missing-items', records);
    const average = metricByLabel(metrics, '销量加权均价');
    expect(average.value).toBeCloseTo(166.6666667, 7);
    expect(average).toMatchObject({
      status: 'confirmed',
      coverage: { coveredWeight: 30, totalWeight: 30, returnedRows: 2, totalRows: 3 },
    });
  });

  it('marks partially returned sums instead of presenting them as complete totals', () => {
    const metric = metricByLabel(buildMarketDatasetMetrics('keywords', [
      { title: 'A', orders: 3 },
      { title: 'B' },
    ]), '下单量');
    expect(metric).toMatchObject({
      value: 3,
      status: 'partial',
      coverage: { returnedRows: 1, missingRows: 1, totalRows: 2 },
    });
  });
});
