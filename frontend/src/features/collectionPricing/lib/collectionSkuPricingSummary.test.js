import { describe, expect, it } from 'vitest';

import { buildCollectionSkuPricingSummary } from './collectionSkuPricingSummary.js';

describe('collection SKU pricing summary', () => {
  it('shows all-in cost including the signed commission result after SKU pricing', () => {
    const summary = buildCollectionSkuPricingSummary({
      listingDraft: {
        skus: [
          {
            enabled: true,
            pricingSnapshot: {
              // Simulates a persisted/reloaded snapshot: only the normalized total survives.
              totalCostCny: 21.51,
              expectedProfitCny: 5,
              profitMarginPercent: 18.86,
              breakEvenPriceCny: 20.49,
            },
          },
          {
            enabled: true,
            pricingSnapshot: {
              totalCostCny: 28.74,
              commissionCostCny: 5.74,
              allInCostCny: 28.74,
              expectedProfitCny: 5,
              profitMarginPercent: 14.82,
              breakEvenPriceCny: 27.72,
            },
          },
        ],
      },
      pricingDraft: { ozonFeePercent: '17', expectedProfitCny: '5' },
    });

    expect(summary.totalCostRange).toEqual({ minimum: 21.51, maximum: 28.74 });
    expect(summary.profitRange).toEqual({ minimum: 5, maximum: 5 });
    expect(summary.commissionPercent).toBe(17);
    expect(summary.generatedSkuCount).toBe(2);
  });
});
