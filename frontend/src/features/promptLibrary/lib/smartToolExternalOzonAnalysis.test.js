import { describe, expect, it } from 'vitest';
import {
  buildSmartToolExternalOzonAnalysis,
  normalizeSmartToolExternalProduct,
} from './smartToolExternalOzonAnalysis.js';

describe('smartToolExternalOzonAnalysis', () => {
  it('maps the real SF detail fields into the shared product workbench contract', () => {
    const product = normalizeSmartToolExternalProduct({ sku: 2962820304 }, {
      product: {
        sku: 2962820304,
        title: '测试商品',
        price: 599,
        brandName: '品牌',
        sellerName: '卖家',
        reviewRating: 4.7,
        reviewCount: 88,
        categoryInfo: { cnTitlePath: '服装 > 内衣 > 文胸配件' },
        sessionCount: 1200,
        sessionCountSearch: 800,
        drr: 5.5,
        fulfillment: ['FBO'],
        weight: 80,
        dimension: '10 × 5 × 2 cm',
        upDays: 90,
      },
      totalSales: 300,
      totalRevenue: 179700,
      dailySales: 10,
      stock: 50,
      salesTrendVOList: [{ revenue: 6000, sales: 10 }],
    });

    expect(product).toMatchObject({
      sku: '2962820304',
      brand: '品牌',
      seller: '卖家',
      category: '服装 > 内衣 > 文胸配件',
      sales: 300,
      revenue: 179700,
      stock: 50,
      averageDailyRevenue: 6000,
      averageDailyUnits: 10,
      productCardViews: 1200,
      searchCatalogViews: 800,
      fulfillmentModel: 'FBO',
    });
  });

  it('analyzes keyword-back dimensions and produces deterministic opportunity guidance', () => {
    const analysis = buildSmartToolExternalOzonAnalysis({
      toolId: 'linkfox-seerfar-ozon-keyword-back-search',
      records: [{
        query: 'платье',
        queryCn: '连衣裙',
        searchVolume: 10000,
        count30GrowthRate: 25,
        competingProducts: 100,
        sellers: 20,
        dimension: { naturalRank: 3, exposure: 800, conversion: 5.2 },
      }],
    });

    expect(analysis.records[0]).toMatchObject({ naturalRank: 3, exposure: 800, conversion: 5.2 });
    expect(analysis.records[0].opportunityScore).toBeGreaterThan(0);
    expect(analysis.insights.join('\n')).toContain('综合机会较高');
  });

  it('keeps the SF daily trend and category-rank series in product-detail analysis', () => {
    const analysis = buildSmartToolExternalOzonAnalysis({
      toolId: 'linkfox-seerfar-ozon-product-detail-search',
      data: {
        product: { sku: 2962820304, title: '测试商品', price: 599, returnCancellationRate: 3 },
        totalSales: 30,
        totalRevenue: 17970,
        dailySales: 1,
        stock: 20,
        categoryRanks: [{ date: '2026-07-30', rank: 12, count: 800 }],
      },
      detailRecord: { sku: 2962820304, title: '测试商品', price: 599 },
      trends: [{ date: '2026-07-30', sales: 1, revenue: 599 }],
    });

    expect(analysis.records[0].categoryRanks).toEqual([
      { date: '2026-07-30', rank: 12, count: 800 },
    ]);
    expect(analysis.trends).toEqual([{ date: '2026-07-30', sales: 1, revenue: 599 }]);
    expect(analysis).toMatchObject({
      analysisMode: 'competitor',
      analysisModeLabel: '竞对商品分析',
    });
    expect(analysis.insights.join('\n')).toContain('类目排名');
  });

  it('uses a separate conversion-and-operation plan for an own product', () => {
    const analysis = buildSmartToolExternalOzonAnalysis({
      toolId: 'linkfox-seerfar-ozon-product-detail-search',
      analysisMode: 'own',
      data: {
        product: {
          sku: 2962820304,
          title: '自己的商品',
          sessionCount: 1200,
          convToCartPdp: 12.5,
          sessionCountSearch: 800,
          convToCartSearch: 8.5,
          convViewToOrder: 4.2,
          drr: 9.8,
        },
        dailySales: 10,
        stock: 50,
      },
      detailRecord: { sku: 2962820304, title: '自己的商品' },
      trends: [],
    });

    expect(analysis).toMatchObject({
      analysisMode: 'own',
      analysisModeLabel: '自己商品分析',
    });
    expect(analysis.insights.join('\n')).toContain('商品卡浏览');
    expect(analysis.insights.join('\n')).toContain('广告费用占比');
    expect(analysis.insights.join('\n')).not.toContain('竞对归属');
  });

  it('uses manual costs for both profit judgement and return-risk fallback', () => {
    const analysis = buildSmartToolExternalOzonAnalysis({
      toolId: 'linkfox-seerfar-ozon-product-detail-search',
      analysisMode: 'competitor',
      data: { product: { sku: 1, title: '竞对商品', price: 1000 } },
      detailRecord: { sku: 1, title: '竞对商品', price: 1000 },
      manualData: {
        productCostRub: 400,
        commissionRate: 15,
        fulfillmentFeeRub: 100,
        taxRate: 5,
        returnCancelRate: 11,
      },
    });

    expect(analysis.records[0]).toMatchObject({
      returnCancelRate: 11,
      returnCancelRateSource: '手动补充',
      unitProfit: {
        estimatedUnitProfitRub: 300,
        estimatedUnitProfitRate: 30,
      },
    });
    expect(analysis.overview).toMatchObject({
      estimatedUnitProfitRub: 300,
      estimatedUnitProfitRate: 30,
    });
    expect(analysis.insights.join('\n')).toContain('单件基础利润约 300 ₽');
    expect(analysis.insights.join('\n')).toContain('手动补充的退货取消率 11%');
  });
});
