import { describe, expect, it } from 'vitest';

import {
  buildCollectionSkuPricingInputKey,
  clearAllCollectionSignedSkuPricing,
  clearStaleCollectionSignedSkuPricing,
  isCollectionSkuPricingSnapshotCurrent,
} from './collectionSkuPricingIntegrity.js';

const pricingDraft = Object.freeze({
  firstMileCost: '5.33',
  extraCost: '',
  ozonFeePercent: '13',
  expectedProfitCny: '20',
});

describe('collection SKU pricing integrity', () => {
  it('binds every signed SKU price to the exact public pricing inputs', () => {
    const sku = { sourcePriceCny: '8.4' };
    const inputKey = buildCollectionSkuPricingInputKey(sku, pricingDraft);
    expect(inputKey).toBe('collection-sku-pricing-v1:840:533:0:1300:2000');
    expect(isCollectionSkuPricingSnapshotCurrent({
      ...sku,
      pricingSnapshot: { quoteSource: 'server-signed', inputKey },
    }, pricingDraft)).toBe(true);
    expect(isCollectionSkuPricingSnapshotCurrent({
      ...sku,
      pricingSnapshot: { quoteSource: 'server-signed', inputKey },
    }, { ...pricingDraft, firstMileCost: '23.02' })).toBe(false);
  });

  it('binds target-margin pricing independently from fixed-profit pricing', () => {
    const sku = { sourcePriceCny: '8.4' };
    expect(buildCollectionSkuPricingInputKey(sku, {
      ...pricingDraft,
      expectedProfitCny: '',
      targetMarginPercent: '20',
    })).toBe('collection-sku-pricing-v1:840:533:0:1300:margin-2000');
  });

  it('fails legacy unbound signed prices closed and clears generated amounts only', () => {
    const signed = {
      sourcePriceCny: '8.4',
      priceCny: '38.79',
      oldPriceCny: '50.43',
      minPriceCny: '19.4',
      pricingSnapshot: { quoteSource: 'server-signed' },
    };
    const manual = { sourcePriceCny: '8.4', priceCny: '40', pricingSnapshot: {} };
    const stale = clearStaleCollectionSignedSkuPricing([signed, manual], pricingDraft);
    expect(stale.changed).toBe(true);
    expect(stale.skus[0]).toMatchObject({
      priceCny: '', oldPriceCny: '', minPriceCny: '', pricingSnapshot: {},
    });
    expect(stale.skus[1]).toBe(manual);

    const cleared = clearAllCollectionSignedSkuPricing([signed, manual]);
    expect(cleared.changed).toBe(true);
    expect(cleared.skus[0].priceCny).toBe('');
    expect(cleared.skus[1]).toBe(manual);
  });
});
