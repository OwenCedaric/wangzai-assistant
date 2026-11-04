import {
  collectDataAnalysisMarketRubDates,
  convertDataAnalysisDashboardToCny,
  convertDataAnalysisMarketToCny,
  convertPerformanceAnalysisToCny,
} from './dataAnalysisCurrency.js';
import { describe, expect, it } from 'vitest';

function rate(value) {
  return { rubToCnyRate: value, source: '测试日汇率', date: '2026-07-10' };
}

describe('dataAnalysisCurrency', () => {
  it('keeps sales, traffic and finance money displayed as RMB after conversion', () => {
    const dashboard = {
      range: { endDate: '2026-07-10' },
      overview: {
        metrics: [
          { id: 'salesAmount', unit: 'money', value: 100, currency: 'RUB', status: 'confirmed', breakdown: [{ currency: 'RUB', value: 100 }] },
          { id: 'financeNetAmount', unit: 'money', value: 200, currency: 'RUB', status: 'confirmed', breakdown: [{ currency: 'RUB', value: 200 }] },
          { id: 'trafficRevenueRub', unit: 'money', value: 300, currency: 'RUB', status: 'confirmed', breakdown: [{ currency: 'RUB', value: 300 }] },
        ],
        trend: [{ date: '2026-07-10', sales: { breakdown: [{ currency: 'RUB', value: 100 }] } }],
      },
      sales: {
        metrics: [
          { id: 'salesAmount', label: '订单销售额', unit: 'money', value: 100, currency: 'RUB', status: 'confirmed', breakdown: [{ currency: 'RUB', value: 100 }] },
        ],
        trend: [{ date: '2026-07-10', sales: { breakdown: [{ currency: 'RUB', value: 100 }] }, orderCount: 1, effectiveOrderCount: 1 }],
        productRanking: [{ key: 'a', sales: { breakdown: [{ currency: 'RUB', value: 50 }] } }],
      },
      finance: {
        metrics: [
          { id: 'financeNetAmount', unit: 'money', value: 200, currency: 'RUB', status: 'confirmed', breakdown: [{ currency: 'RUB', value: 200 }] },
          { id: 'financeIncomeAmount', unit: 'money', value: 200, currency: 'RUB', status: 'confirmed', breakdown: [{ currency: 'RUB', value: 200 }] },
          { id: 'financeDeductionAmount', unit: 'money', value: 0, currency: 'RUB', status: 'confirmed', breakdown: [{ currency: 'RUB', value: 0 }] },
        ],
        currencyConversionRows: [{ operationDate: '2026-07-10', amount: 200, currency: 'RUB' }],
        comparisonCurrencyConversionRows: [],
      },
      traffic: {
        metrics: [
          { id: 'trafficRevenueRub', unit: 'money', value: 300, currency: 'RUB', status: 'confirmed', breakdown: [{ currency: 'RUB', value: 300 }] },
        ],
        dailyTrend: [{ date: '2026-07-10', revenueRub: 300 }],
        comparisonDailyTrend: [],
      },
    };

    const converted = convertDataAnalysisDashboardToCny(dashboard, { todayKey: '2026-07-10', realtime: rate(0.1) });

    expect(converted.sales.metrics[0].currency).toBe('CNY');
    expect(converted.sales.metrics[0].value).toBe(10);
    expect(converted.sales.trend[0].sales.breakdown).toEqual([{ currency: 'CNY', value: 10 }]);
    expect(converted.sales.productRanking[0].sales.breakdown).toEqual([{ currency: 'CNY', value: 5 }]);
    expect(converted.finance.metrics.find((metric) => metric.id === 'financeNetAmount').value).toBe(20);
    expect(converted.traffic.metrics.find((metric) => metric.id === 'trafficRevenueRub').value).toBe(30);
    expect(converted.overview.metrics.every((metric) => metric.currency === 'CNY')).toBe(true);
    expect(converted.overview.trend).toEqual(converted.sales.trend);
    expect(converted.overview.trend[0].sales.breakdown).toEqual([{ currency: 'CNY', value: 10 }]);
  });

  it('keeps an existing CNY average-order metric even when it has no breakdown', () => {
    const converted = convertDataAnalysisDashboardToCny(
      {
        range: { endDate: '2026-07-10' },
        overview: { metrics: [] },
        sales: {
          metrics: [
            { id: 'effectiveOrderCount', unit: 'count', value: 2, status: 'confirmed' },
            { id: 'salesAmount', unit: 'money', value: 100, currency: 'CNY', status: 'confirmed', breakdown: [{ currency: 'CNY', value: 100 }] },
            { id: 'averageOrderValue', unit: 'money', value: 50, currency: 'CNY', status: 'confirmed', breakdown: [] },
          ],
          trend: [{ date: '2026-07-10', effectiveOrderCount: 2, sales: { status: 'confirmed', breakdown: [{ currency: 'CNY', value: 100 }] } }],
          productRanking: [],
        },
        finance: { metrics: [], currencyConversionRows: [], comparisonCurrencyConversionRows: [] },
        traffic: { metrics: [], dailyTrend: [], comparisonDailyTrend: [] },
      },
      {}
    );
    expect(converted.sales.metrics.find((metric) => metric.id === 'averageOrderValue').value).toBe(50);
  });

  it('does not turn a missing historical exchange rate into zero or a confirmed amount', () => {
    const converted = convertDataAnalysisDashboardToCny(
      {
        range: { endDate: '2026-07-10' },
        overview: { metrics: [] },
        sales: { metrics: [], trend: [], productRanking: [] },
        finance: {
          metrics: [
            { id: 'financeNetAmount', unit: 'money', value: 100, currency: 'RUB', status: 'confirmed' },
            { id: 'financeIncomeAmount', unit: 'money', value: 100, currency: 'RUB', status: 'confirmed' },
            { id: 'financeDeductionAmount', unit: 'money', value: 0, currency: 'RUB', status: 'confirmed' },
          ],
          currencyConversionRows: [{ operationDate: '2026-07-01', amount: 100, currency: 'RUB' }],
          comparisonCurrencyConversionRows: [],
        },
        traffic: {
          metrics: [{ id: 'trafficRevenueRub', unit: 'money', value: 100, currency: 'RUB', status: 'confirmed' }],
          dailyTrend: [{ date: '2026-07-01', revenueRub: 100 }],
          comparisonDailyTrend: [],
        },
      },
      { todayKey: '2026-07-11', realtime: rate(0.1), dailyRates: new Map() }
    );
    expect(converted.finance.metrics.find((metric) => metric.id === 'financeNetAmount').value).toBeNull();
    expect(converted.finance.metrics.find((metric) => metric.id === 'financeNetAmount').status).toBe('currency_unconfirmed');
    expect(converted.traffic.metrics.find((metric) => metric.id === 'trafficRevenueRub').value).toBeNull();
  });

  it('does not recreate a traffic revenue comparison when snapshot coverage is not comparable', () => {
    const converted = convertDataAnalysisDashboardToCny(
      {
        range: { endDate: '2026-07-10' },
        overview: { metrics: [], trend: [] },
        sales: { metrics: [], trend: [], productRanking: [] },
        finance: { metrics: [], currencyConversionRows: [], comparisonCurrencyConversionRows: [] },
        traffic: {
          metrics: [
            {
              id: 'trafficRevenueRub',
              unit: 'money',
              value: 300,
              currency: 'RUB',
              status: 'confirmed',
              comparisonValue: null,
              delta: null,
            },
          ],
          dailyTrend: [{ date: '2026-07-10', revenueRub: 300 }],
          comparisonDailyTrend: [{ date: '2026-07-09', revenueRub: 200 }],
          quality: { comparisonComparable: false },
        },
      },
      {
        todayKey: '2026-07-10',
        realtime: rate(0.1),
        dailyRates: new Map([
          ['2026-07-09', { ...rate(0.1), date: '2026-07-09' }],
        ]),
      }
    );

    const revenue = converted.traffic.metrics.find((metric) => metric.id === 'trafficRevenueRub');
    expect(revenue.value).toBe(30);
    expect(revenue.comparisonValue).toBeNull();
    expect(revenue.delta).toBeNull();
  });

  it('converts advertising money with each statistics day rate before summing', () => {
    const converted = convertPerformanceAnalysisToCny(
      {
        statisticsRead: true,
        metrics: [
          { id: 'adSpend', unit: 'money', currency: 'RUB', value: 300, status: 'confirmed' },
          { id: 'adRevenue', unit: 'money', currency: 'RUB', value: 600, status: 'confirmed' },
          { id: 'adClicks', unit: 'count', value: 10, status: 'confirmed' },
          { id: 'adCpc', unit: 'money', currency: 'RUB', value: 30, status: 'confirmed' },
        ],
        dailyTrend: [
          { date: '2026-07-09', spent: 100, revenue: 200 },
          { date: '2026-07-10', spent: 200, revenue: 400 },
        ],
        campaigns: [],
      },
      {
        dailyRates: new Map([
          ['2026-07-09', { rubToCnyRate: 0.08, source: '测试日汇率', date: '2026-07-09' }],
          ['2026-07-10', { rubToCnyRate: 0.09, source: '测试日汇率', date: '2026-07-10' }],
        ]),
      },
      '2026-07-10'
    );
    expect(converted.metrics.find((metric) => metric.id === 'adSpend').value).toBe(26);
    expect(converted.metrics.find((metric) => metric.id === 'adRevenue').value).toBe(52);
    expect(converted.metrics.find((metric) => metric.id === 'adCpc').value).toBe(2.6);
  });

  it('converts product, after-sales and marketing money without exposing RUB', () => {
    const dashboard = {
      range: { endDate: '2026-07-10' },
      overview: { metrics: [] },
      sales: { metrics: [], trend: [], productRanking: [] },
      products: {
        metrics: [{
          id: 'averageProductPrice',
          unit: 'money',
          value: 100,
          currency: 'RUB',
          status: 'confirmed',
          breakdown: [{ currency: 'RUB', value: 100 }],
        }],
        priceBands: [{ id: '0-20', min: 0, max: 20, openEnded: false, count: 2, currency: 'RUB' }],
      },
      finance: { metrics: [], currencyConversionRows: [], comparisonCurrencyConversionRows: [] },
      traffic: { metrics: [], dailyTrend: [], comparisonDailyTrend: [] },
      afterSales: {
        metrics: [{
          id: 'returnProductAmount',
          unit: 'money',
          value: 50,
          currency: 'RUB',
          status: 'confirmed',
          breakdown: [{ currency: 'RUB', value: 50 }],
        }],
        recentRows: [{ returnId: 'r-1', amount: 50, currency: 'RUB', createdAt: '2026-07-10T08:00:00Z' }],
        dataQuality: { amountCurrencyBreakdown: [{ currency: 'RUB', value: 50 }] },
      },
      marketing: {
        metrics: [],
        productRows: [{ productId: 'p-1', price: 200, activityPrice: 150, currency: 'RUB' }],
        activityPriceAmount: {
          value: 150,
          currency: 'RUB',
          status: 'confirmed',
          breakdown: [{ currency: 'RUB', value: 150 }],
        },
      },
    };

    const converted = convertDataAnalysisDashboardToCny(dashboard, {
      todayKey: '2026-07-10',
      realtime: rate(0.1),
    });

    expect(converted.products.metrics[0]).toMatchObject({ value: 10, currency: 'CNY' });
    expect(converted.products.priceBands[0]).toMatchObject({ label: '￥0–￥2', currency: 'CNY' });
    expect(converted.afterSales.metrics[0]).toMatchObject({ value: 5, currency: 'CNY' });
    expect(converted.afterSales.recentRows[0]).toMatchObject({ amount: 5, currency: 'CNY' });
    expect(converted.marketing.productRows[0]).toMatchObject({ price: 20, activityPrice: 15, currency: 'CNY', discountAmount: 5 });
    expect(converted.marketing.activityPriceAmount).toMatchObject({ value: 15, currency: 'CNY' });
    expect(JSON.stringify(converted)).not.toContain('₽');
  });

  it('converts market records and metrics using the captured business date', () => {
    const market = {
      datasetViews: [{
        id: 'product-performance',
        dataset: 'product-performance',
        newestCapturedAt: '2026-07-10T09:00:00Z',
        records: [{
          id: 'p-1',
          dataset: 'product-performance',
          title: '遥控汽车',
          date: '2026-07-09',
          currency: 'RUB',
          orderAmount: 1000,
          averagePurchasePrice: 200,
          averageDailyRevenue: 100,
          followMinPrice: 900,
          followMaxPrice: 1100,
        }],
        metrics: [
          { label: '订购金额', value: 1000, kind: 'money' },
          { label: '平均购买价格', value: 200, kind: 'money' },
        ],
      }],
      sections: {},
    };
    const dates = collectDataAnalysisMarketRubDates(market, '2026-07-10');
    expect(dates).toEqual(['2026-07-09', '2026-07-10']);
    const converted = convertDataAnalysisMarketToCny(market, {
      todayKey: '2026-07-10',
      realtime: rate(0.1),
      dailyRates: new Map([['2026-07-09', rate(0.08)]]),
    }, '2026-07-10');
    expect(converted.datasetViews[0].records[0]).toMatchObject({
      orderAmount: 80,
      averagePurchasePrice: 16,
      averageDailyRevenue: 8,
      followMinPrice: 72,
      followMaxPrice: 88,
      currency: 'CNY',
    });
    expect(converted.datasetViews[0].metrics.find((metric) => metric.label === '订购金额')).toMatchObject({ value: 80, currency: 'CNY' });
    expect(converted.currencyConversion).toMatchObject({ targetCurrency: 'CNY', status: 'confirmed' });
  });

  it('preserves source coverage status and full conversion precision before aggregation', () => {
    const converted = convertDataAnalysisMarketToCny({
      datasetViews: [{
        id: 'product-performance',
        dataset: 'product-performance',
        newestCapturedAt: '2026-07-09T09:00:00Z',
        records: [
          { id: 'p-1', currency: 'RUB', orderAmount: 0.333, orderedProducts: 1, averagePurchasePrice: 0.333 },
          { id: 'p-2', currency: 'RUB', orderedProducts: 1, averagePurchasePrice: 1 },
        ],
      }],
      sections: {},
    }, {
      todayKey: '2026-07-10',
      realtime: rate(0.1),
      dailyRates: new Map([['2026-07-09', rate(0.08)]]),
    }, '2026-07-10');

    const dataset = converted.datasetViews[0];
    expect(dataset.records[0].orderAmount).toBeCloseTo(0.02664, 8);
    const amountMetric = dataset.metrics.find((metric) => metric.label === '订购金额');
    expect(amountMetric).toMatchObject({
      status: 'partial',
      currency: 'CNY',
      coverage: { returnedRows: 1, totalRows: 2, missingRows: 1 },
    });
    expect(amountMetric.value).toBeCloseTo(0.02664, 8);
  });
});
