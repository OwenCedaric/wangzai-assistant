import { describe, expect, it } from 'vitest';

import {
  calculateCollectionProductFreight,
  calculateCollectionSkuFreights,
  getCollectionPricingQuoteErrorMessage,
  listCollectionLogisticsProviders,
} from './collectionProductPricingService.js';

describe('collection product pricing service', () => {
  it('exposes every preset logistics provider without a hard-coded shop count', () => {
    expect(listCollectionLogisticsProviders().map((item) => item.id)).toEqual(
      expect.arrayContaining(['cel', 'guoo', 'zto', 'ural', 'xingyuan']),
    );
  });

  it('uses exact SKU weight and dimensions when calculating the selected logistics route', () => {
    const common = {
      product: { weightG: '100', packageLengthCm: '10', packageWidthCm: '10', packageHeightCm: '10' },
      listingDraft: {
        weightG: '100', packageLengthCm: '10', packageWidthCm: '10', packageHeightCm: '10',
        skus: [],
      },
      pricingDraft: { purchaseCost: '10' },
      logisticsDraft: { providerId: 'guoo', routeId: 'guoo-standard-extra-small', market: 'RU', serviceLevel: 'standard' },
    };
    const light = calculateCollectionProductFreight({
      ...common,
      sku: { sourcePriceCny: '10', weightG: '100', packageLengthCm: '10', packageWidthCm: '8', packageHeightCm: '4' },
    });
    const heavy = calculateCollectionProductFreight({
      ...common,
      sku: { sourcePriceCny: '10', weightG: '400', packageLengthCm: '20', packageWidthCm: '12', packageHeightCm: '6' },
    });
    expect(light).toMatchObject({ ok: true, amount: 7.3, routeId: 'guoo-standard-extra-small' });
    expect(heavy).toMatchObject({ ok: true, amount: 19.09, routeId: 'guoo-standard-extra-small' });
  });

  it('matches the lowest preset GUOO band without converting the CNY listing price', () => {
    const result = calculateCollectionProductFreight({
      product: { weightG: '50', packageLengthCm: '18', packageWidthCm: '8', packageHeightCm: '2' },
      listingDraft: { weightG: '50', packageLengthCm: '18', packageWidthCm: '8', packageHeightCm: '2', skus: [] },
      pricingDraft: { purchaseCost: '8.4' },
      logisticsDraft: { providerId: 'guoo', routeId: '', market: 'RU', serviceLevel: 'auto' },
      sku: { sourcePriceCny: '8.4', weightG: '50', price: '' },
    });

    expect(result).toMatchObject({
      ok: true,
      routeId: 'guoo-standard-extra-small',
      amount: 5.335,
      matchedBy: 'collection-pre-price-value-band',
      valueBandProvisional: true,
      productValueRubUsed: 1,
    });
  });

  it('does not treat legacy RUB fields as the cross-border listing price', () => {
    const result = calculateCollectionProductFreight({
      product: { weightG: '50', packageLengthCm: '18', packageWidthCm: '8', packageHeightCm: '2' },
      listingDraft: { weightG: '50', packageLengthCm: '18', packageWidthCm: '8', packageHeightCm: '2', skus: [] },
      pricingDraft: { purchaseCost: '8.4' },
      logisticsDraft: { providerId: 'guoo', routeId: '', market: 'RU', serviceLevel: 'auto' },
      sku: { sourcePriceCny: '8.4', weightG: '50', productValueRub: '2000' },
    });

    expect(result).toMatchObject({
      ok: true,
      routeId: 'guoo-standard-extra-small',
      amount: 5.335,
      productValueRubUsed: 1,
    });
  });

  it('calculates an independent freight result for every enabled SKU', () => {
    const rows = calculateCollectionSkuFreights({
      product: {
        skus: [
          { id: 'a', price: '10', weightG: '100' },
          { id: 'b', price: '10', weightG: '400' },
          { id: 'c', price: '10', weightG: '300' },
        ],
      },
      listingDraft: {
        weightG: '100', packageLengthCm: '10', packageWidthCm: '10', packageHeightCm: '10',
        skus: [
          { sourceSkuId: 'a', offerId: 'A', sourcePriceCny: '10', enabled: true },
          { sourceSkuId: 'b', offerId: 'B', sourcePriceCny: '10', enabled: true },
          { sourceSkuId: 'c', offerId: 'C', sourcePriceCny: '10', enabled: false },
        ],
      },
      pricingDraft: {},
      logisticsDraft: { providerId: 'guoo', routeId: 'guoo-standard-extra-small', market: 'RU', serviceLevel: 'standard' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((item) => item.result.amount)).toEqual([7.3, 19.09]);
  });

  it('keeps every SKU on CNY input without accepting a RUB conversion map', () => {
    const rows = calculateCollectionSkuFreights({
      product: { skus: [{ id: 'a', price: '8.4', weightG: '50' }] },
      listingDraft: {
        weightG: '50', packageLengthCm: '18', packageWidthCm: '8', packageHeightCm: '2',
        skus: [{ sourceSkuId: 'a', offerId: 'A', sourcePriceCny: '8.4', enabled: true }],
      },
      pricingDraft: {},
      logisticsDraft: { providerId: 'guoo', routeId: '', market: 'RU', serviceLevel: 'auto' },
    });

    expect(rows[0].result).toMatchObject({
      ok: true,
      routeId: 'guoo-standard-extra-small',
      amount: 5.335,
      productValueRubUsed: 1,
    });
  });

  it('turns protected-compute rejections into stable Chinese messages', () => {
    expect(getCollectionPricingQuoteErrorMessage(Object.assign(new Error('remote'), { status: 401 })))
      .toBe('授权登录已失效，请重新登录后再使用服务器核价。');
    expect(getCollectionPricingQuoteErrorMessage(Object.assign(new Error('remote'), { status: 403 })))
      .toContain('未开通采集核价');
    expect(getCollectionPricingQuoteErrorMessage(Object.assign(new Error('remote'), { status: 429 })))
      .toBe('服务器核价请求过于频繁，请稍后重试。');
    expect(getCollectionPricingQuoteErrorMessage(Object.assign(new Error('Protected-compute server rejected the request.'), {
      code: 'PROTECTED_COMPUTE_REMOTE_ERROR', status: 502,
    }))).toBe('服务器核价暂时失败，请稍后重试。');
  });
});
