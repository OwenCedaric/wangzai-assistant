import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeCollectionPricingQuote } from '../../../services/protectedComputeClient.js';
import {
  requestCollectionPricingQuote,
  requestCollectionSkuPricingQuotes,
} from './collectionPricingQuoteService.js';

vi.mock('../../../services/protectedComputeClient.js', () => ({
  executeCollectionPricingQuote: vi.fn(),
}));

const DRAFT = Object.freeze({
  purchaseCost: '25',
  firstMileCost: '6',
  extraCost: '1',
  ozonFeePercent: '17',
  expectedProfitCny: '5',
  targetMarginPercent: '20',
  currentPrice: '55.16',
});

beforeEach(() => {
  executeCollectionPricingQuote.mockReset();
});

function mockSignedCollectionPricingCore() {
  executeCollectionPricingQuote.mockImplementation(async ({
    commissionBasisPoints,
    extraCostMinor,
    firstMileCostMinor,
    purchaseCostMinor,
    currentPriceMinor,
    targetMarginBasisPoints,
  }) => {
    const fixedCostMinor = purchaseCostMinor + firstMileCostMinor + extraCostMinor;
    const denominator = 10_000 - commissionBasisPoints;
    const breakEvenPriceMinor = Math.ceil((fixedCostMinor * 10_000) / denominator);
    const suggestedPriceMinor = Math.ceil(
      (fixedCostMinor * (10_000 + targetMarginBasisPoints)) / denominator,
    );
    const currentProfitMinor = currentPriceMinor
      ? currentPriceMinor - Math.ceil((currentPriceMinor * commissionBasisPoints) / 10_000) - fixedCostMinor
      : null;
    return {
      capability: 'collection-pricing.quote', version: 1, source: 'server-signed', signatureVerified: true,
      verification: { responseId: `${purchaseCostMinor}-${currentPriceMinor || 0}-${targetMarginBasisPoints}` },
      result: {
        breakEvenPriceMinor,
        currency: 'CNY',
        currentMarginBasisPoints: currentPriceMinor
          ? Math.trunc((currentProfitMinor * 10_000) / currentPriceMinor)
          : null,
        currentProfitMinor,
        suggestedPriceMinor,
        totalCostMinor: fixedCostMinor,
      },
    };
  });
}

describe('collection pricing quote service', () => {
  it('calls the protected client with only the exact public DTO', async () => {
    executeCollectionPricingQuote.mockResolvedValue({
      capability: 'collection-pricing.quote',
      version: 1,
      source: 'server-signed',
      signatureVerified: true,
      verification: { responseId: 'response-1' },
      result: {
        breakEvenPriceMinor: 3_856,
        currency: 'CNY',
        currentMarginBasisPoints: 2_498,
        currentProfitMinor: 1_378,
        suggestedPriceMinor: 4_627,
        totalCostMinor: 3_200,
      },
    });
    const quote = await requestCollectionPricingQuote(DRAFT);
    expect(executeCollectionPricingQuote).toHaveBeenCalledWith(
      {
        commissionBasisPoints: 1_700,
        currency: 'CNY',
        currentPriceMinor: 5_516,
        extraCostMinor: 100,
        firstMileCostMinor: 600,
        purchaseCostMinor: 2_500,
        targetMarginBasisPoints: 2_000,
      },
      expect.objectContaining({ timeoutMs: 15_000 })
    );
    expect(quote.preview.suggestedPrice).toBe(46.27);
    expect(JSON.stringify(executeCollectionPricingQuote.mock.calls[0])).not.toMatch(
      /apiKey|cookie|password|authorization|clientId/iu
    );
  });

  it('propagates unavailable/auth failures without local fallback', async () => {
    executeCollectionPricingQuote.mockRejectedValue(
      Object.assign(new Error('not configured'), { code: 'PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED' })
    );
    await expect(requestCollectionPricingQuote(DRAFT)).rejects.toMatchObject({
      code: 'PROTECTED_COMPUTE_RUNTIME_NOT_CONFIGURED',
    });
    expect(executeCollectionPricingQuote).toHaveBeenCalledTimes(1);
  });

  it('retries a transient protected-compute failure and keeps the verified server result', async () => {
    executeCollectionPricingQuote
      .mockRejectedValueOnce(Object.assign(new Error('bad gateway'), {
        code: 'PROTECTED_COMPUTE_REMOTE_ERROR',
        status: 502,
      }))
      .mockResolvedValueOnce({
        capability: 'collection-pricing.quote',
        version: 1,
        source: 'server-signed',
        signatureVerified: true,
        verification: { responseId: 'response-after-retry' },
        result: {
          breakEvenPriceMinor: 3_856,
          currency: 'CNY',
          currentMarginBasisPoints: 2_498,
          currentProfitMinor: 1_378,
          suggestedPriceMinor: 4_627,
          totalCostMinor: 3_200,
        },
      });

    const quote = await requestCollectionPricingQuote(DRAFT, { retryDelaysMs: [0, 0] });

    expect(quote.preview.suggestedPrice).toBe(46.27);
    expect(quote.source).toBe('server-signed');
    expect(executeCollectionPricingQuote).toHaveBeenCalledTimes(2);
  });

  it('does not retry result verification failures', async () => {
    executeCollectionPricingQuote.mockRejectedValue(Object.assign(new Error('unverified'), {
      code: 'PROTECTED_COMPUTE_RESULT_UNVERIFIED',
      status: 400,
    }));

    await expect(requestCollectionPricingQuote(DRAFT, { retryDelaysMs: [0, 0] })).rejects.toMatchObject({
      code: 'PROTECTED_COMPUTE_RESULT_UNVERIFIED',
    });
    expect(executeCollectionPricingQuote).toHaveBeenCalledTimes(1);
  });

  it('generates by each unique full-cost input and carries freight plus commission into every signed quote', async () => {
    executeCollectionPricingQuote.mockImplementation(async ({
      commissionBasisPoints,
      extraCostMinor,
      firstMileCostMinor,
      purchaseCostMinor,
      currentPriceMinor,
      targetMarginBasisPoints,
    }) => {
      const fixedCostMinor = purchaseCostMinor + firstMileCostMinor + extraCostMinor;
      const denominator = 10_000 - commissionBasisPoints;
      const breakEvenPriceMinor = Math.ceil((fixedCostMinor * 10_000) / denominator);
      const suggestedPriceMinor = Math.ceil(
        (fixedCostMinor * (10_000 + targetMarginBasisPoints)) / denominator,
      );
      const currentProfitMinor = currentPriceMinor
        ? currentPriceMinor - Math.ceil((currentPriceMinor * commissionBasisPoints) / 10_000) - fixedCostMinor
        : null;
      return {
        capability: 'collection-pricing.quote', version: 1, source: 'server-signed', signatureVerified: true,
        verification: { responseId: `${purchaseCostMinor}-${currentPriceMinor || 0}-${targetMarginBasisPoints}` },
        result: {
          breakEvenPriceMinor,
          currency: 'CNY',
          currentMarginBasisPoints: currentPriceMinor
            ? Math.trunc((currentProfitMinor * 10_000) / currentPriceMinor)
            : null,
          currentProfitMinor,
          suggestedPriceMinor,
          totalCostMinor: fixedCostMinor,
        },
      };
    });

    const result = await requestCollectionSkuPricingQuotes([
      { sourceSkuId: 'a', offerId: 'A', sourcePriceCny: '10', firstMileCostCny: '6', enabled: true },
      { sourceSkuId: 'b', offerId: 'B', sourcePriceCny: '10', firstMileCostCny: '12', enabled: true },
      { sourceSkuId: 'c', offerId: 'C', sourcePriceCny: '10', firstMileCostCny: '6', enabled: true },
    ], DRAFT);

    expect(result.uniquePriceCount).toBe(2);
    expect(result.rows.map((item) => item.priceCny)).toEqual([26.52, 33.75, 26.52]);
    expect(result.rows[0].pricingSnapshot).toMatchObject({
      inputKey: 'collection-sku-pricing-v1:1000:600:100:1700:500',
      purchaseCostCny: 10,
      firstMileCostCny: 6,
      extraCostCny: 1,
      commissionPercent: 17,
      commissionCostCny: 4.51,
      fixedCostCny: 17,
      totalCostCny: 21.51,
      allInCostCny: 21.51,
      expectedProfitCny: 5.01,
    });
    expect(executeCollectionPricingQuote).toHaveBeenCalledTimes(6);
    expect(executeCollectionPricingQuote.mock.calls.every(([input]) => input.commissionBasisPoints === 1_700)).toBe(true);
    expect(new Set(executeCollectionPricingQuote.mock.calls.map(([input]) => input.firstMileCostMinor))).toEqual(new Set([600, 1_200]));
  });

  it.each([
    { purchase: 10, freight: 2.7, extra: 0, commission: 12, target: 20 },
    { purchase: 2.08, freight: 2.7, extra: 0, commission: 12, target: 20 },
    { purchase: 25, freight: 6, extra: 1, commission: 17, target: 20 },
    { purchase: 8.4, freight: 5.33, extra: 0, commission: 13, target: 15 },
    { purchase: 100, freight: 20, extra: 5, commission: 10, target: 25 },
    { purchase: 0.68, freight: 2.7, extra: 0, commission: 12, target: 30 },
    { purchase: 50, freight: 12, extra: 3, commission: 20, target: 10 },
    { purchase: 15.5, freight: 7.8, extra: 1.2, commission: 8, target: 35 },
    { purchase: 200, freight: 40, extra: 10, commission: 15, target: 18 },
    { purchase: 5, freight: 3, extra: 0.5, commission: 5, target: 40 },
  ])('reaches target net margin for %o', async ({ purchase, freight, extra, commission, target }) => {
    mockSignedCollectionPricingCore();
    const result = await requestCollectionSkuPricingQuotes([
      {
        sourceSkuId: 'margin-sku', offerId: 'MARGIN', sourcePriceCny: String(purchase),
        firstMileCostCny: String(freight), enabled: true,
      },
    ], {
      ...DRAFT,
      extraCost: String(extra),
      ozonFeePercent: String(commission),
      expectedProfitCny: '',
      targetMarginPercent: String(target),
    });

    const row = result.rows[0];
    expect(row.priceCny).toBeGreaterThan(row.pricingSnapshot.breakEvenPriceCny);
    expect(row.pricingSnapshot.profitMarginPercent).toBeGreaterThanOrEqual(target);
    expect(row.pricingSnapshot.profitMarginPercent).toBeLessThan(target + 0.2);
    expect(row.pricingSnapshot.inputKey).toMatch(new RegExp(`:margin-${target * 100}$`, 'u'));
  });

  it('rounds the 50% minimum-price boundary upward to a valid currency cent', async () => {
    executeCollectionPricingQuote.mockResolvedValue({
      capability: 'collection-pricing.quote', version: 1, source: 'server-signed', signatureVerified: true,
      verification: { responseId: 'half-cent-boundary' },
      result: {
        breakEvenPriceMinor: 1_579,
        currency: 'CNY',
        currentMarginBasisPoints: 5_158,
        currentProfitMinor: 2_001,
        suggestedPriceMinor: 3_879,
        totalCostMinor: 1_878,
      },
    });

    const result = await requestCollectionSkuPricingQuotes([
      { sourceSkuId: 'a', offerId: 'A', sourcePriceCny: '8.4', firstMileCostCny: '5.33', enabled: true },
    ], { ...DRAFT, expectedProfitCny: '20', targetMarginPercent: '' });

    expect(result.rows[0]).toMatchObject({ priceCny: 38.79, minPriceCny: 19.4 });
    expect(result.rows[0].minPriceCny).toBeGreaterThanOrEqual(result.rows[0].priceCny * 0.5);
  });

  it('refuses to generate SKU prices when logistics or category commission is missing', async () => {
    await expect(requestCollectionSkuPricingQuotes([
      { sourceSkuId: 'a', sourceSkuName: '规格 A', sourcePriceCny: '10', enabled: true },
    ], { ...DRAFT, firstMileCost: '', ozonFeePercent: '' })).rejects.toThrow('物流费');
    await expect(requestCollectionSkuPricingQuotes([
      { sourceSkuId: 'a', sourceSkuName: '规格 A', sourcePriceCny: '10', firstMileCostCny: '6', enabled: true },
    ], { ...DRAFT, ozonFeePercent: '' })).rejects.toThrow('类目扣点');
    expect(executeCollectionPricingQuote).not.toHaveBeenCalled();
  });
});
