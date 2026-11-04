import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  calculateCollectionSkuFreights,
} from './collectionProductPricingService.js';
import { requestCollectionSkuPricingQuotes } from './collectionPricingQuoteService.js';
import { generateCollectionSkuPricesWithResolvedFreight } from './collectionSkuPricingWorkflowService.js';

vi.mock('./collectionProductPricingService.js', () => ({
  calculateCollectionSkuFreights: vi.fn(),
}));

vi.mock('./collectionPricingQuoteService.js', () => ({
  requestCollectionSkuPricingQuotes: vi.fn(),
}));

const LISTING = Object.freeze({
  skus: [
    { sourceSkuId: 'a', offerId: 'A', sourceSkuName: '规格 A', sourcePriceCny: '8.4', enabled: true },
  ],
});

function freight(routeId, amount, provisional = false) {
  return [{
    sourceSkuId: 'a',
    offerId: 'A',
    result: {
      ok: true,
      providerId: 'guoo',
      routeId,
      amount,
      pricingVersion: 'v1',
      valueBandProvisional: provisional,
      route: { minValueRub: routeId.includes('extra-small') ? 1 : 1500, maxValueRub: 7000 },
    },
  }];
}

function generated(priceCny) {
  return {
    uniquePricingInputCount: 1,
    rows: [{ sourceSkuId: 'a', offerId: 'A', priceCny, oldPriceCny: priceCny * 1.3, minPriceCny: 10 }],
  };
}

beforeEach(() => {
  calculateCollectionSkuFreights.mockReset();
  requestCollectionSkuPricingQuotes.mockReset();
});

describe('collection SKU pricing workflow', () => {
  it('quotes each SKU once in CNY without reading an exchange rate or repricing in RUB', async () => {
    calculateCollectionSkuFreights.mockReturnValue(freight('guoo-standard-extra-small', 5.335, true));
    requestCollectionSkuPricingQuotes.mockResolvedValue(generated(28.6));

    const result = await generateCollectionSkuPricesWithResolvedFreight({
      listingDraft: LISTING,
      pricingDraft: { expectedProfitCny: '10', ozonFeePercent: '13' },
      logisticsDraft: { providerId: 'guoo', routeId: '', market: 'RU', serviceLevel: 'auto' },
    });

    expect(result).toMatchObject({ pricingCurrency: 'CNY', currencyConversionApplied: false });
    expect(calculateCollectionSkuFreights).toHaveBeenCalledTimes(1);
    expect(requestCollectionSkuPricingQuotes).toHaveBeenCalledTimes(1);
    expect(requestCollectionSkuPricingQuotes.mock.calls[0][0][0]).toMatchObject({
      firstMileCostCny: '5.33', logisticsRouteId: 'guoo-standard-extra-small',
    });
  });

  it('does not run a second logistics calculation when the generated CNY price is high', async () => {
    calculateCollectionSkuFreights.mockReturnValue(freight('guoo-standard-extra-small', 5.335, true));
    requestCollectionSkuPricingQuotes.mockResolvedValue(generated(160));

    const result = await generateCollectionSkuPricesWithResolvedFreight({
      listingDraft: LISTING,
      pricingDraft: { expectedProfitCny: '10', ozonFeePercent: '13' },
      logisticsDraft: { providerId: 'guoo', routeId: '', market: 'RU', serviceLevel: 'auto' },
    });

    expect(result.generated.rows[0].priceCny).toBe(160);
    expect(calculateCollectionSkuFreights).toHaveBeenCalledTimes(1);
    expect(requestCollectionSkuPricingQuotes).toHaveBeenCalledTimes(1);
  });

  it('stops before protected pricing when freight cannot be matched', async () => {
    calculateCollectionSkuFreights.mockReturnValue([{
      sourceSkuId: 'a', offerId: 'A', result: { ok: false, reason: '没有匹配到计费线路' },
    }]);

    await expect(generateCollectionSkuPricesWithResolvedFreight({
      listingDraft: LISTING,
      pricingDraft: { expectedProfitCny: '10', ozonFeePercent: '13' },
      logisticsDraft: { providerId: 'guoo', routeId: '', market: 'RU', serviceLevel: 'auto' },
    })).rejects.toThrow('规格 A物流费测算失败');
    expect(requestCollectionSkuPricingQuotes).not.toHaveBeenCalled();
  });
});
