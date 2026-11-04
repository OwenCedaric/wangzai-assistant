import { describe, expect, it } from 'vitest';
import {
  buildMarketSourceSummary,
  countHiddenMarketDatasets,
  getPrimaryMarketDatasetViews,
  getVisibleMarketColumns,
  marketDatasetId,
  marketDatasetLabel,
  marketDatasetRecords,
} from './dataAnalysisMarketView.js';

describe('dataAnalysisMarketView', () => {
  it('is null-safe while the first cache read is still pending', () => {
    expect(marketDatasetId(null)).toBe('');
    expect(marketDatasetLabel(null)).toBe('市场数据');
    expect(getPrimaryMarketDatasetViews()).toEqual([]);
  });

  it('keeps only the current actionable datasets in stable UI order', () => {
    const datasets = [
      { dataset: 'products', records: [{ id: 'store-product' }] },
      { dataset: 'brands', records: [{ title: '品牌' }] },
      { dataset: 'keywords', records: [{ title: '关键词', searches: 1 }] },
      { dataset: 'market-products', records: [{ id: 'market-product' }] },
      { dataset: 'product-performance', records: [{ id: 'performance' }] },
      { dataset: 'trends', records: [{ date: '2026-07-23' }] },
    ];

    expect(getPrimaryMarketDatasetViews(datasets).map(marketDatasetId)).toEqual([
      'keywords',
      'product-performance',
      'brands',
    ]);
    expect(countHiddenMarketDatasets(datasets)).toBe(3);
  });

  it('removes keyword directory rows only when measurable keyword rows exist', () => {
    const dataset = {
      dataset: 'keywords',
      records: [
        { title: '目录' },
        { title: '遥控汽车', searches: 1200 },
      ],
    };
    expect(marketDatasetRecords(dataset)).toEqual([{ title: '遥控汽车', searches: 1200 }]);
    expect(marketDatasetRecords({ dataset: 'keywords', records: [{ title: '目录' }] })).toHaveLength(1);
  });

  it('builds visible columns and store source summaries without UI state', () => {
    const columns = [
      { label: '名称', alwaysVisible: true },
      { label: '品牌', field: 'brand' },
      { label: '销量', field: 'sales' },
    ];
    expect(getVisibleMarketColumns([{ brand: 'A' }], columns).map((column) => column.label)).toEqual(['名称', '品牌']);
    expect(buildMarketSourceSummary([{ id: 'products', rowCount: 12 }])[0]).toMatchObject({
      label: '全部缓存商品',
      value: '12 条',
    });
  });
});
