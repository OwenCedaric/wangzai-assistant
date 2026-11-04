import { describe, expect, it } from 'vitest';
import { evaluateOzonProductDecision } from './smartToolOzonProductDecisionRules.js';

const PRICE_BANDS = [
  { key: 'under-1000', label: '1,000 ₽以下', min: 0, max: 1000 },
  { key: '1000-2999', label: '1,000–2,999 ₽', min: 1000, max: 3000 },
  { key: '3000-4999', label: '3,000–4,999 ₽', min: 3000, max: 5000 },
  { key: '5000-9999', label: '5,000–9,999 ₽', min: 5000, max: 10000 },
  { key: '10000-plus', label: '10,000 ₽以上', min: 10000, max: Number.POSITIVE_INFINITY },
];

function healthyRecord(index) {
  const price = 1400 + index * 80;
  const dailyUnits = 3 + index % 5;
  return {
    id: `healthy-${index}`,
    brand: `品牌-${index % 10}`,
    seller: `卖家-${index % 15}`,
    price,
    sales: dailyUnits * 30,
    revenue: price * dailyUnits * 30,
    growth: 12 + index % 18,
    stock: dailyUnits * 28,
    averageDailyUnits: dailyUnits,
    adSpendShare: 3 + index % 4,
    promoRevenueShare: 12 + index % 8,
    paidPromotionDays: index % 3,
    clickThroughRate: 8 + index % 3,
    productCardToCartRate: 11 + index % 3,
    searchCatalogToCartRate: 7 + index % 2,
    impressionToOrderRate: 3.2 + (index % 3) * 0.2,
    redemptionRate: 96,
    returnCancelRate: 3.5,
    listingDays: 30 + index * 4,
    followSellerCount: index % 2,
    followMinPrice: price + 50,
  };
}

function riskyRecord(index) {
  const price = 1800 + index * 100;
  return {
    id: `risk-${index}`,
    brand: '单一品牌',
    seller: '单一卖家',
    price,
    sales: Math.max(1, 60 - index * 4),
    revenue: index === 0 ? 2_000_000 : 20_000,
    growth: -30,
    stock: 2,
    averageDailyUnits: 8,
    adSpendShare: 28,
    promoRevenueShare: 82,
    paidPromotionDays: 30,
    clickThroughRate: 1,
    productCardToCartRate: 1.5,
    searchCatalogToCartRate: 1,
    impressionToOrderRate: 0.4,
    redemptionRate: 62,
    returnCancelRate: 32,
    listingDays: 240,
    followSellerCount: 8,
    followMinPrice: price - 300,
  };
}

describe('smartToolOzonProductDecisionRules', () => {
  it('builds a high-confidence multi-dimensional decision from complete returned fields', () => {
    const result = evaluateOzonProductDecision(
      Array.from({ length: 30 }, (_, index) => healthyRecord(index)),
      { priceBands: PRICE_BANDS, periodComparison: { revenueGrowthPercent: 18 } },
    );

    expect(result.rulesVersion).toBe('ozon-product-decision-v1');
    expect(result.opportunity).toMatchObject({
      confidence: 'high',
      availableDimensionCount: 7,
      totalDimensionCount: 7,
    });
    expect(result.opportunity.score).toBeGreaterThanOrEqual(60);
    expect(result.opportunity.reasons.length).toBeGreaterThan(0);
    expect(result.opportunity.actions.length).toBeGreaterThan(0);
    expect(result.pricePerformance.bestRevenueBand).toBeTruthy();
    expect(result.trafficConversion.bottleneck).toBeTruthy();
    expect(result.inventoryHealth).toMatchObject({ status: 'healthy', lowCoverCount: 0, overstockCount: 0 });
    expect(result.fulfillmentHealth.status).toBe('healthy');
    expect(result.profitability).toMatchObject({ ready: false });
  });

  it('returns explicit risks and actions instead of hiding a weak market behind totals', () => {
    const result = evaluateOzonProductDecision(
      Array.from({ length: 24 }, (_, index) => riskyRecord(index)),
      { priceBands: PRICE_BANDS, periodComparison: { revenueGrowthPercent: -35 } },
    );

    expect(result.opportunity.score).toBeLessThan(45);
    expect(result.opportunity.label).toBe('暂缓跟进');
    expect(result.opportunity.risks.map((item) => item.key)).toEqual(expect.arrayContaining([
      'momentum',
      'conversion',
      'inventory',
    ]));
    expect(result.opportunity.actions.join('\n')).toMatch(/下单|补货|销量/u);
    expect(result.marketStructure.level).toBe('high');
    expect(result.promotionDependency.dependency).toBe('high');
    expect(result.followSellerPressure.pressure).toBe('high');
    expect(result.followSellerPressure.followedProductCount).toBe(24);
    expect(result.inventoryHealth.status).toBe('risk');
    expect(result.fulfillmentHealth.status).toBe('risk');
  });

  it('describes the price-sales relationship only when enough comparable rows exist', () => {
    const result = evaluateOzonProductDecision([
      { price: 1000, sales: 100 },
      { price: 2000, sales: 60 },
      { price: 3000, sales: 30 },
      { price: 4000, sales: 10 },
    ], { priceBands: PRICE_BANDS });

    expect(result.pricePerformance).toMatchObject({
      pairCount: 4,
      relation: 'lower-price-faster',
    });
    expect(result.pricePerformance.priceSalesCorrelation).toBeLessThan(-0.9);
  });

  it('does not generate an opportunity score when the evidence dimensions are missing', () => {
    const result = evaluateOzonProductDecision([
      { id: '1', title: 'Only identity' },
      { id: '2', title: 'Still identity' },
    ], { priceBands: PRICE_BANDS });

    expect(result.opportunity).toMatchObject({
      score: null,
      label: '暂时看不准',
      confidence: 'low',
      availableDimensionCount: 0,
    });
    expect(result.opportunity.missingDimensions).toHaveLength(7);
    expect(result.insights).toEqual([]);
  });
});
