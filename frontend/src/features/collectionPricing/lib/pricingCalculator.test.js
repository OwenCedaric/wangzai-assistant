import { describe, expect, it } from 'vitest';

import {
  buildCollectionPricingQuoteInput,
  createEmptyPricingPreview,
  mapVerifiedCollectionPricingQuote,
} from './pricingCalculator.js';

const DRAFT = Object.freeze({
  purchaseCost: '25.00',
  firstMileCost: '6',
  extraCost: '1',
  ozonFeePercent: '17',
  targetMarginPercent: '20',
  currentPrice: '55.16',
});

describe('collection pricing public contract adapter', () => {
  it('only normalizes public units into the exact minimal server DTO', () => {
    expect(buildCollectionPricingQuoteInput(DRAFT)).toEqual({
      commissionBasisPoints: 1_700,
      currency: 'CNY',
      currentPriceMinor: 5_516,
      extraCostMinor: 100,
      firstMileCostMinor: 600,
      purchaseCostMinor: 2_500,
      targetMarginBasisPoints: 2_000,
    });
    expect(buildCollectionPricingQuoteInput({ ...DRAFT, currentPrice: '' }).currentPriceMinor).toBeNull();
  });

  it('rejects missing or negative public inputs without computing a fallback', () => {
    expect(() => buildCollectionPricingQuoteInput({ ...DRAFT, purchaseCost: '' })).toThrow(
      expect.objectContaining({ code: 'COLLECTION_PRICING_REQUIRED' })
    );
    expect(() => buildCollectionPricingQuoteInput({ ...DRAFT, extraCost: '-1' })).toThrow(
      expect.objectContaining({ code: 'COLLECTION_PRICING_NEGATIVE' })
    );
    expect(createEmptyPricingPreview()).toEqual({
      hasCost: false,
      totalCost: null,
      allInCost: null,
      commissionCost: null,
      feePercent: null,
      targetMarginPercent: null,
      breakEvenPrice: null,
      suggestedPrice: null,
      currentProfit: null,
      currentMargin: null,
    });
  });

  it('maps only a verified signed result into display units', () => {
    const input = buildCollectionPricingQuoteInput(DRAFT);
    expect(
      mapVerifiedCollectionPricingQuote(
        {
          capability: 'collection-pricing.quote',
          version: 1,
          source: 'server-signed',
          signatureVerified: true,
          result: {
            breakEvenPriceMinor: 3_856,
            currency: 'CNY',
            currentMarginBasisPoints: 2_498,
            currentProfitMinor: 1_378,
            suggestedPriceMinor: 4_627,
            totalCostMinor: 3_200,
          },
        },
        input
      )
    ).toEqual({
      hasCost: true,
      totalCost: 32,
      allInCost: 41.38,
      commissionCost: 9.38,
      feePercent: 17,
      targetMarginPercent: 20,
      breakEvenPrice: 38.56,
      suggestedPrice: 46.27,
      currentProfit: 13.78,
      currentMargin: 24.98,
    });
    expect(() =>
      mapVerifiedCollectionPricingQuote(
        {
          capability: 'collection-pricing.quote',
          version: 1,
          source: 'server-signed',
          signatureVerified: false,
          result: {},
        },
        input
      )
    ).toThrow(expect.objectContaining({ code: 'COLLECTION_PRICING_RESULT_UNVERIFIED' }));
  });
});
