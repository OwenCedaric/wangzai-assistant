import { describe, expect, it } from 'vitest';
import {
  analyzeOzonProductRecords,
  parseOzonProductMetric,
} from './smartToolOzonProductAnalysis.js';

describe('smartToolOzonProductAnalysis', () => {
  it('parses Russian-formatted and plain numeric metrics', () => {
    expect(parseOzonProductMetric('3 027,23 ₽')).toBe(3027.23);
    expect(parseOzonProductMetric('2,085,762.85')).toBe(2085762.85);
    expect(parseOzonProductMetric(42)).toBe(42);
    expect(parseOzonProductMetric('未返回')).toBeNull();
  });

  it('calculates medians, price bands, coverage and stable top products from real fields only', () => {
    const analysis = analyzeOzonProductRecords([
      { id: '1', title: 'A', brand: 'Alpha', seller: 'S1', price: 1000, revenue: 2000, sales: 2 },
      { id: '2', title: 'B', brand: 'Alpha', seller: 'S2', price: 3000, revenue: 5000, sales: 5 },
      { id: '3', title: 'C', brand: 'Beta', seller: 'S2', price: 5000, revenue: 5000, sales: 4 },
      { id: '4', title: 'D', brand: '', seller: '', price: null, revenue: null, sales: null },
    ], { query: 'платье', capturedAt: '2026-07-29T06:00:00.000Z' });

    expect(analysis).toMatchObject({
      query: 'платье',
      recordCount: 4,
      brandCount: 2,
      sellerCount: 2,
      priceStats: { count: 3, min: 1000, max: 5000, average: 3000, median: 3000 },
      revenueStats: { count: 3, total: 12000, average: 4000, median: 5000 },
    });
    expect(analysis.priceBands.find((band) => band.key === '1000-2999')).toMatchObject({ count: 1, percent: 33 });
    expect(analysis.fieldCoverage.find((field) => field.key === 'price')).toMatchObject({ count: 3, total: 4, percent: 75 });
    expect(analysis.fieldCoverage.find((field) => field.key === 'stock')).toMatchObject({ count: 0, percent: 0 });
    expect(analysis.topProducts.map((record) => record.id).slice(0, 3)).toEqual(['2', '3', '1']);
    expect(analysis.topBrands[0]).toMatchObject({ name: 'Alpha', count: 2, revenue: 7000 });
  });

  it('does not fabricate statistics when a field is absent', () => {
    const analysis = analyzeOzonProductRecords([
      { id: '1', title: 'Only identity' },
      { id: '2', title: 'Still identity' },
    ]);

    expect(analysis.priceStats).toMatchObject({ count: 0, min: null, max: null, average: null, median: null });
    expect(analysis.revenueStats).toMatchObject({ count: 0, total: null, average: null, median: null });
    expect(analysis.insights).toEqual([]);
  });

  it('uses previous-period and lost-revenue fields only when they are actually returned', () => {
    const analysis = analyzeOzonProductRecords([
      { id: '1', revenue: 1200, previousRevenue: 1000, revenuePotential: 1500, lostProfit: 300 },
      { id: '2', revenue: 800, previousRevenue: 1000, revenuePotential: 900, lostProfit: 100 },
      { id: '3', revenue: 500 },
    ]);

    expect(analysis.periodComparison).toMatchObject({
      comparableCount: 2,
      currentRevenueTotal: 2000,
      previousRevenueTotal: 2000,
      revenueGrowthPercent: 0,
      revenuePotentialTotal: 2400,
      lostProfitTotal: 400,
    });
    expect(analysis.insights.map((item) => item.key)).toEqual(
      expect.arrayContaining(['period-growth', 'lost-profit'])
    );
  });
});
