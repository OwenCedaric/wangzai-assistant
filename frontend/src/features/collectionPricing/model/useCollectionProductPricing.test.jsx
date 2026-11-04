import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  requestCollectionPricingQuote,
  requestCollectionSkuPricingQuotes,
} from '../services/collectionPricingQuoteService.js';
import {
  calculateCollectionProductFreight,
  calculateCollectionSkuFreights,
} from '../services/collectionProductPricingService.js';
import { readCollectionCategoryCommission } from '../services/collectionCategoryCommissionService.js';
import { useCollectionProductPricing } from './useCollectionProductPricing.js';
import { buildCollectionSkuPricingInputKey } from '../lib/collectionSkuPricingIntegrity.js';

vi.mock('../services/collectionPricingQuoteService.js', () => ({
  requestCollectionPricingQuote: vi.fn(),
  requestCollectionSkuPricingQuotes: vi.fn(),
}));
vi.mock('../services/collectionProductPricingService.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    calculateCollectionProductFreight: vi.fn(),
    calculateCollectionSkuFreights: vi.fn(),
    listCollectionLogisticsProviders: vi.fn(() => [{ id: 'guoo', label: 'GUOO', markets: ['RU'] }]),
    listCollectionLogisticsRoutes: vi.fn(() => [{ id: 'guoo-route', providerId: 'guoo', label: 'GUOO 线路', market: 'RU' }]),
  };
});
vi.mock('../services/collectionCategoryCommissionService.js', () => ({
  readCollectionCategoryCommission: vi.fn(),
}));

const product = {
  id: '1688:1', currency: 'CNY', purchasePrice: '25', weightG: '500',
  packageLengthCm: '20', packageWidthCm: '10', packageHeightCm: '8',
};

function listingDraft(overrides = {}) {
  return {
    shopId: 'shop-a', weightG: '500', packageLengthCm: '20', packageWidthCm: '10', packageHeightCm: '8',
    pricingDraft: { purchaseCost: '25', firstMileCost: '6', extraCost: '1', ozonFeePercent: '17', expectedProfitCny: '10', targetMarginPercent: '20', currentPrice: '55.16' },
    logisticsDraft: { providerId: 'guoo', routeId: 'guoo-route', market: 'RU', routeText: '' },
    skus: [{ sourceSkuId: 'a', sourceSkuName: '规格 A', offerId: 'A', sourcePriceCny: '25', price: '1000', enabled: true }],
    ...overrides,
  };
}

beforeEach(() => {
  requestCollectionPricingQuote.mockReset();
  requestCollectionSkuPricingQuotes.mockReset();
  calculateCollectionProductFreight.mockReset();
  calculateCollectionSkuFreights.mockReset();
  calculateCollectionSkuFreights.mockImplementation(({ listingDraft: source }) => (
    (source?.skus || []).filter((item) => item?.enabled !== false).map((item) => ({
      sourceSkuId: String(item.sourceSkuId || ''),
      offerId: String(item.offerId || ''),
      result: {
        ok: true,
        amount: 6,
        providerId: 'guoo',
        routeId: 'guoo-route',
        pricingVersion: 'test-v1',
      },
    }))
  ));
  readCollectionCategoryCommission.mockReset();
});

describe('useCollectionProductPricing', () => {
  it('never requests protected pricing until the user explicitly clicks', async () => {
    requestCollectionPricingQuote.mockResolvedValue({
      preview: { hasCost: true, suggestedPrice: 46.27, breakEvenPrice: 38.56, totalCost: 32, currentProfit: 13.78, currentMargin: 24.98, targetMarginPercent: 20 },
      source: 'server-signed', verification: { responseId: 'q-1' },
    });
    const onChangeListingDraft = vi.fn();
    const { result } = renderHook(() => useCollectionProductPricing({ product, listingDraft: listingDraft(), onChangeListingDraft }));
    expect(requestCollectionPricingQuote).not.toHaveBeenCalled();
    act(() => result.current.changePricingField('extraCost')({ target: { value: '2' } }));
    expect(requestCollectionPricingQuote).not.toHaveBeenCalled();
    await act(async () => result.current.requestQuote());
    expect(requestCollectionPricingQuote).toHaveBeenCalledTimes(1);
    expect(result.current.pricingPreview.suggestedPrice).toBe(46.27);
  });

  it('fills the verified freight amount into the current shop pricing draft', () => {
    calculateCollectionProductFreight.mockReturnValue({ ok: true, amount: 12.34, display: '¥12.34', providerLabel: 'GUOO', routeLabel: '线路 A' });
    const onChangeListingDraft = vi.fn();
    const { result } = renderHook(() => useCollectionProductPricing({ product, listingDraft: listingDraft(), onChangeListingDraft }));
    act(() => result.current.calculateFreight());
    expect(onChangeListingDraft).toHaveBeenCalledWith({ pricingDraft: expect.objectContaining({ firstMileCost: '12.34' }) });
    expect(result.current.freightState.status).toBe('success');
  });

  it('automatically measures freight after a provider is selected without exposing a route control', async () => {
    calculateCollectionProductFreight.mockReturnValue({
      ok: true, amount: 5.335, display: '¥5.33', providerLabel: 'GUOO', routeLabel: 'GUOO 标准线路',
    });
    const onChangeListingDraft = vi.fn();
    const { result } = renderHook(() => useCollectionProductPricing({
      product,
      listingDraft: listingDraft({ logisticsDraft: { providerId: 'guoo', routeId: '', market: 'RU', serviceLevel: 'auto' } }),
      onChangeListingDraft,
    }));
    await waitFor(() => expect(onChangeListingDraft).toHaveBeenCalledWith({
      pricingDraft: expect.objectContaining({ firstMileCost: '5.33' }),
    }));
    expect(result.current.freightState.status).toBe('success');
    expect(result.current.freightState.message).toBe('');
  });

  it('applies a separately signed CNY result to every enabled SKU', async () => {
    requestCollectionSkuPricingQuotes.mockResolvedValue({
      uniquePriceCount: 1,
      rows: [{
        sourceSkuId: 'a', offerId: 'A', priceCny: 50, oldPriceCny: 65, minPriceCny: 40,
        pricingSnapshot: { totalCostCny: 32, expectedProfitCny: 10, profitMarginPercent: 20, breakEvenPriceCny: 40 },
      }],
    });
    const onChangeListingDraft = vi.fn();
    const { result } = renderHook(() => useCollectionProductPricing({ product, listingDraft: listingDraft(), onChangeListingDraft }));
    await act(async () => result.current.applySuggestedPrice());
    expect(calculateCollectionSkuFreights).toHaveBeenCalledWith(expect.objectContaining({
      listingDraft: expect.objectContaining({ shopId: 'shop-a' }),
      logisticsDraft: expect.objectContaining({ providerId: 'guoo', routeId: 'guoo-route' }),
      pricingDraft: expect.objectContaining({ ozonFeePercent: '17', expectedProfitCny: '10' }),
    }));
    expect(requestCollectionSkuPricingQuotes).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({
        sourcePriceCny: '25',
        firstMileCostCny: '6',
        logisticsProviderId: 'guoo',
        logisticsRouteId: 'guoo-route',
      })]),
      expect.objectContaining({ ozonFeePercent: '17', expectedProfitCny: '10' }),
      expect.objectContaining({ concurrency: 4, signal: expect.any(AbortSignal) }),
    );
    expect(onChangeListingDraft).toHaveBeenCalledWith({
      skus: [expect.objectContaining({ priceCny: '50', oldPriceCny: '65', minPriceCny: '40', price: '' })],
      pricingDraft: expect.objectContaining({ firstMileCost: '6', ozonFeePercent: '17' }),
    });
    expect(result.current.applyState.message).toBe('');
    expect(result.current.freightState.message).toBe('');
  });

  it('generates a 2x activity reference price without changing the signed target-profit price', async () => {
    requestCollectionSkuPricingQuotes.mockResolvedValue({
      uniquePriceCount: 1,
      rows: [{
        sourceSkuId: 'a', offerId: 'A', priceCny: 100, oldPriceCny: 130, minPriceCny: 70,
        pricingSnapshot: { totalCostCny: 80, expectedProfitCny: 20 },
      }],
    });
    const onChangeListingDraft = vi.fn();
    const { result } = renderHook(() => useCollectionProductPricing({
      product,
      listingDraft: listingDraft({ activityPriceUpload: true }),
      onChangeListingDraft,
    }));

    await act(async () => result.current.applySuggestedPrice());

    expect(onChangeListingDraft).toHaveBeenCalledWith(expect.objectContaining({
      skus: [expect.objectContaining({
        priceCny: '100',
        oldPriceCny: '200',
        pricingSnapshot: expect.objectContaining({
          expectedProfitCny: 20,
          activityPriceCny: '100',
          activityReferencePriceCny: '200',
        }),
      })],
    }));
  });

  it('switches existing SKU prices into and out of activity-price mode', () => {
    const onChangeListingDraft = vi.fn();
    const { result } = renderHook(() => useCollectionProductPricing({
      product,
      listingDraft: listingDraft({
        activityPriceUpload: false,
        skus: [{ sourceSkuId: 'a', offerId: 'A', priceCny: '100', oldPriceCny: '130', enabled: true }],
      }),
      onChangeListingDraft,
    }));

    act(() => result.current.toggleActivityPriceUpload());

    expect(onChangeListingDraft).toHaveBeenCalledWith({
      activityPriceUpload: true,
      skus: [expect.objectContaining({ priceCny: '100', oldPriceCny: '200' })],
    });
  });

  it('does not change SKUs when signed per-SKU pricing fails', async () => {
    requestCollectionSkuPricingQuotes.mockRejectedValue(new Error('核价服务暂不可用。'));
    const onChangeListingDraft = vi.fn();
    const { result } = renderHook(() => useCollectionProductPricing({ product, listingDraft: listingDraft(), onChangeListingDraft }));
    await act(async () => result.current.applySuggestedPrice());
    await waitFor(() => expect(result.current.applyState.status).toBe('error'));
    expect(onChangeListingDraft).not.toHaveBeenCalled();
  });

  it('blocks SKU pricing when the selected logistics route cannot price one specification', async () => {
    calculateCollectionSkuFreights.mockReturnValue([{
      sourceSkuId: 'a', offerId: 'A', sourcePriceCny: '25',
      result: { ok: false, reason: '重量超出线路范围' },
    }]);
    const onChangeListingDraft = vi.fn();
    const { result } = renderHook(() => useCollectionProductPricing({
      product,
      listingDraft: listingDraft(),
      onChangeListingDraft,
    }));
    await act(async () => result.current.applySuggestedPrice());
    expect(requestCollectionSkuPricingQuotes).not.toHaveBeenCalled();
    expect(result.current.applyState.error).toContain('规格 A物流费测算失败');
    expect(onChangeListingDraft).not.toHaveBeenCalled();
  });

  it('reads one consistent real Ozon commission for the selected category', async () => {
    readCollectionCategoryCommission.mockResolvedValue({
      status: 'ready', percent: 17, evidenceCount: 3,
      source: 'ozon-product-commission-snapshot', message: '已读取。',
    });
    const onChangeListingDraft = vi.fn();
    renderHook(() => useCollectionProductPricing({
      product,
      listingDraft: listingDraft({
        descriptionCategoryId: '10', typeId: '20', categoryCommissionSource: '',
        pricingDraft: { ...listingDraft().pricingDraft, ozonFeePercent: '' },
      }),
      onChangeListingDraft,
    }));
    await waitFor(() => expect(onChangeListingDraft).toHaveBeenCalledWith(expect.objectContaining({
      categoryCommissionPercent: '17',
      categoryCommissionSource: 'ozon-product-commission-snapshot',
      categoryCommissionEvidenceCount: 3,
      pricingDraft: expect.objectContaining({ ozonFeePercent: '17' }),
    })));
  });

  it('keeps a manually edited category commission and skips automatic replacement', () => {
    const onChangeListingDraft = vi.fn();
    const { result } = renderHook(() => useCollectionProductPricing({
      product,
      listingDraft: listingDraft({
        descriptionCategoryId: '10', typeId: '20', categoryCommissionPercent: '19', categoryCommissionSource: 'manual',
        pricingDraft: { ...listingDraft().pricingDraft, ozonFeePercent: '19' },
      }),
      onChangeListingDraft,
    }));
    expect(readCollectionCategoryCommission).not.toHaveBeenCalled();
    act(() => result.current.changePricingField('ozonFeePercent')({ target: { value: '18' } }));
    expect(onChangeListingDraft).toHaveBeenCalledWith(expect.objectContaining({
      categoryCommissionPercent: '18', categoryCommissionSource: 'manual',
    }));
  });

  it('clears a signed SKU price as soon as any bound pricing input changes', () => {
    const current = listingDraft();
    const sku = {
      ...current.skus[0],
      priceCny: '50', oldPriceCny: '65', minPriceCny: '40',
    };
    sku.pricingSnapshot = {
      quoteSource: 'server-signed',
      inputKey: buildCollectionSkuPricingInputKey(sku, current.pricingDraft),
    };
    const onChangeListingDraft = vi.fn();
    const { result } = renderHook(() => useCollectionProductPricing({
      product,
      listingDraft: { ...current, skus: [sku] },
      onChangeListingDraft,
    }));

    act(() => result.current.changePricingField('extraCost')({ target: { value: '2' } }));

    expect(onChangeListingDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      pricingDraft: expect.objectContaining({ extraCost: '2' }),
      skus: [expect.objectContaining({
        priceCny: '', oldPriceCny: '', minPriceCny: '', pricingSnapshot: {},
      })],
    }));
  });

  it('fails old signed SKU prices closed when they have no input binding', async () => {
    const onChangeListingDraft = vi.fn();
    renderHook(() => useCollectionProductPricing({
      product,
      listingDraft: listingDraft({
        skus: [{
          sourceSkuId: 'a', sourcePriceCny: '25', priceCny: '50', oldPriceCny: '65', minPriceCny: '40',
          enabled: true, pricingSnapshot: { quoteSource: 'server-signed' },
        }],
      }),
      onChangeListingDraft,
    }));

    await waitFor(() => expect(onChangeListingDraft).toHaveBeenCalledWith({
      skus: [expect.objectContaining({
        priceCny: '', oldPriceCny: '', minPriceCny: '', pricingSnapshot: {},
      })],
    }));
  });
});
