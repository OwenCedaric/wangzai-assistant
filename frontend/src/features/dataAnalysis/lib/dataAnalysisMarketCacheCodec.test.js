import { describe, expect, it } from 'vitest';
import { compactMarketData } from './dataAnalysisMarketCacheCodec.js';
import { mergeLiveMarketDataWithCache } from './dataAnalysisMarketCacheMerge.js';

function opportunitySection(records, metrics = []) {
  return {
    id: 'opportunity',
    title: '市场机会',
    status: 'ready',
    statusLabel: '已接入',
    datasetCount: 1,
    recordCount: records.length,
    datasets: ['missing-items'],
    metrics,
    records,
  };
}

describe('dataAnalysisMarketCacheCodec business metadata', () => {
  it('preserves metric coverage, aggregation and source-conflict metadata through compaction', () => {
    const metric = {
      label: '成交加权均价',
      value: 125.5,
      unit: '',
      kind: 'money',
      status: 'partial',
      aggregation: 'weighted-average',
      detail: '按 8 件已返回销量加权',
      sourceConflictRows: 2,
      coverage: {
        totalRows: 3,
        returnedRows: 2,
        missingRows: 1,
        percent: 66.6666667,
        totalWeight: 10,
        coveredWeight: 8,
        weightField: 'orderedProducts',
      },
    };

    const compacted = compactMarketData({
      sections: {
        opportunity: opportunitySection([
          { id: 'sku-1', dataset: 'missing-items', title: '商品 A', revenue: 100 },
        ], [metric]),
      },
    });

    expect(compacted.sections.opportunity.metrics[0]).toEqual(metric);
  });

  it('rebuilds section totals from the merged live and cached records', () => {
    const liveData = {
      status: 'ready',
      sections: {
        opportunity: opportunitySection([
          { id: 'sku-live', dataset: 'missing-items', title: '商品 A', revenue: 100 },
        ], [{ label: '返回 GMV', value: 100, kind: 'money', status: 'confirmed' }]),
      },
      datasetViews: [],
    };
    const cachedData = {
      status: 'ready',
      sections: {
        opportunity: opportunitySection([
          { id: 'sku-cache', dataset: 'missing-items', title: '商品 B' },
        ], [{ label: '返回 GMV', value: null, kind: 'money', status: 'not_returned' }]),
      },
      datasetViews: [],
    };

    const merged = mergeLiveMarketDataWithCache(liveData, cachedData).data;
    const gmv = merged.sections.opportunity.metrics.find((metric) => metric.label === '返回 GMV');

    expect(merged.sections.opportunity.recordCount).toBe(2);
    expect(gmv).toMatchObject({
      value: 100,
      status: 'partial',
      aggregation: 'sum-returned',
      coverage: { totalRows: 2, returnedRows: 1, missingRows: 1 },
    });
  });
});
