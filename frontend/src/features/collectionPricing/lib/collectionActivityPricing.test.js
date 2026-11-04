import { describe, expect, it } from 'vitest';

import {
  applyCollectionActivityPricingMode,
  applyCollectionActivityPricingToGeneratedRow,
  buildCollectionActivitySalePriceChanges,
} from './collectionActivityPricing.js';

describe('collection activity pricing', () => {
  it('keeps the profit-bearing sale price and doubles only the activity reference price', () => {
    const [sku] = applyCollectionActivityPricingMode([{
      enabled: true,
      priceCny: '100',
      oldPriceCny: '130',
      pricingSnapshot: { expectedProfitCny: '20' },
    }], true);

    expect(sku).toMatchObject({
      priceCny: '100',
      oldPriceCny: '200',
      pricingSnapshot: {
        expectedProfitCny: '20',
        pricingMode: 'ozon-activity-50',
        activityDiscountPercent: 50,
        activityPriceCny: '100',
        activityReferencePriceCny: '200',
        standardOldPriceCny: '130',
      },
    });
  });

  it('restores the normal strike-through price when activity pricing is disabled', () => {
    const enabled = applyCollectionActivityPricingMode([{
      enabled: true, priceCny: '100', oldPriceCny: '135', pricingSnapshot: {},
    }], true);
    const [restored] = applyCollectionActivityPricingMode(enabled, false);

    expect(restored.oldPriceCny).toBe('135');
    expect(restored.pricingSnapshot).not.toHaveProperty('pricingMode');
  });

  it('applies the same fixed 50% relationship to generated and manually edited prices', () => {
    expect(applyCollectionActivityPricingToGeneratedRow({
      priceCny: 88.8,
      oldPriceCny: 115.44,
      pricingSnapshot: { expectedProfitCny: 20 },
    }, true)).toMatchObject({
      priceCny: 88.8,
      oldPriceCny: 177.6,
      pricingSnapshot: { activityPriceCny: '88.8', activityReferencePriceCny: '177.6' },
    });
    expect(buildCollectionActivitySalePriceChanges('99.5', true)).toMatchObject({
      priceCny: '99.5',
      oldPriceCny: '199',
    });
  });
});
