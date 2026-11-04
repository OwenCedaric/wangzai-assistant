import { describe, expect, it } from 'vitest';
import { augmentMarketOpportunityDatasetViews } from './dataAnalysisMarketOpportunity.js';

describe('augmentMarketOpportunityDatasetViews', () => {
  it('builds category and brand opportunity views from real missing-item fields', () => {
    const result = augmentMarketOpportunityDatasetViews([{
      id: 'missing-items',
      dataset: 'missing-items',
      recordCount: 3,
      newestCapturedAt: '2026-07-22T13:00:00.000Z',
      records: [
        { id: '1', title: '鞋子 A', category: '鞋靴', brand: 'A', sales: 10, averagePrice: 100, revenue: 1000, growth: 10 },
        { id: '2', title: '鞋子 B', category: '鞋靴', brand: 'B', sales: 20, averagePrice: 200, revenue: 2000, growth: 20 },
        { id: '3', title: '玩具 C', category: '玩具', brand: 'A', sales: 5, averagePrice: 50, revenue: 500, growth: -5 },
      ],
    }]);

    const categories = result.find((dataset) => dataset.dataset === 'categories');
    const brands = result.find((dataset) => dataset.dataset === 'brands');
    expect(categories).toMatchObject({ recordCount: 2, derivedFrom: 'missing-items' });
    expect(categories.records[0]).toMatchObject({ title: '鞋靴', sourceRecordCount: 2, sales: 30, revenue: 3000 });
    expect(categories.records[0].averagePrice).toBeCloseTo(166.6666667, 7);
    expect(categories.records[0].growth).toBeCloseTo(16.6666667, 7);
    expect(brands).toMatchObject({ recordCount: 2, derivedFrom: 'missing-items' });
    expect(brands.records.find((record) => record.title === 'A')).toMatchObject({ sourceRecordCount: 2, sales: 15, revenue: 1500 });
    expect(brands.records.find((record) => record.title === 'A').averagePrice).toBeCloseTo(83.3333333, 7);
    expect(brands.records.find((record) => record.title === 'A').growth).toBeCloseTo(5, 7);
  });

  it('keeps an actual category dataset instead of replacing it with a derived view', () => {
    const actualCategories = { id: 'categories', dataset: 'categories', recordCount: 1, records: [{ title: '官方类目' }] };
    const result = augmentMarketOpportunityDatasetViews([
      actualCategories,
      { id: 'missing-items', dataset: 'missing-items', recordCount: 1, records: [{ title: '商品', category: '派生类目', brand: '品牌' }] },
    ]);
    expect(result.find((dataset) => dataset.dataset === 'categories')).toBe(actualCategories);
  });
});
