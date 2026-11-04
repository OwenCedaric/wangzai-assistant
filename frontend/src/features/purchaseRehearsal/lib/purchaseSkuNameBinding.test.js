import { describe, expect, it } from 'vitest';

import {
  calculateSkuPriceDifference,
  createSkuNameBinding,
  createSkuNameCatalog,
  mergeSkuNameBinding,
  readableSkuName,
  resolveExactSkuBinding,
} from './purchaseSkuNameBinding.js';

function product(overrides = {}) {
  return {
    sourceUrl: 'https://www.ozon.ru/product/demo-100/',
    sourceProductId: 'ozon-parent-100',
    platform: 'Ozon买家',
    platformCode: 'ozon-buyer',
    title: '测试商品',
    currency: 'RUB',
    skus: [
      { id: 'ozon-black-xl', attributes: [{ name: '颜色', value: '黑色' }, { name: '尺码', value: 'XL' }], price: '100' },
      { id: 'ozon-white-l', attributes: [{ name: '颜色', value: '白色' }, { name: '尺码', value: 'L' }], price: '120' },
    ],
    ...overrides,
  };
}

function sourceCatalog() {
  return createSkuNameCatalog(product({
    sourceUrl: 'https://detail.1688.com/offer/200.html',
    sourceProductId: 'source-200',
    platform: '1688',
    platformCode: '1688',
    currency: 'CNY',
    skus: [
      { id: '1688-black-xl', attributes: [{ name: '颜色', value: '雅黑' }, { name: '尺寸', value: '特大' }], price: '20' },
      { id: '1688-white-l', attributes: [{ name: '颜色', value: '米白' }, { name: '尺寸', value: '大' }], price: '22' },
    ],
  }), { role: 'source' });
}

describe('automatic ordering exact SKU binding', () => {
  it('keeps the real platform SKU ID with every named dimension', () => {
    expect(readableSkuName(product().skus[0])).toBe('颜色：黑色 / 尺码：XL');
    const catalog = createSkuNameCatalog(product(), { role: 'ozon' });
    expect(catalog.skus[0]).toMatchObject({
      id: 'ozon-black-xl', name: '颜色：黑色 / 尺码：XL', price: '100', currency: 'RUB',
    });
  });

  it('fails closed when a product does not return real SKU IDs', () => {
    expect(() => createSkuNameCatalog(product({ skus: [{ name: '黑色', price: 10 }] }), { role: 'ozon' }))
      .toThrow(/真实 SKU ID/u);
  });

  it('requires one source SKU ID for every Ozon SKU ID and stores exact snapshots', () => {
    const ozonCatalog = createSkuNameCatalog(product(), { role: 'ozon' });
    const source = sourceCatalog();
    expect(() => createSkuNameBinding({ ozonCatalog, sourceCatalog: source, selections: {} }))
      .toThrow(/请选择/u);
    const binding = createSkuNameBinding({
      ozonCatalog,
      sourceCatalog: source,
      scope: { shopId: 'shop-a', productId: 'product-a', offerId: 'offer-a', sku: 'ozon-black-xl' },
      selections: {
        'ozon-black-xl': '1688-black-xl',
        'ozon-white-l': '1688-white-l',
      },
      rubToCnyRate: 0.1,
      now: () => new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(binding.bindingStatus).toBe('exact-bound');
    expect(binding.pairs[0]).toMatchObject({
      ozonSkuId: 'ozon-black-xl', sourceSkuId: '1688-black-xl',
      priceDifference: { status: 'ready', ozonPriceCny: 10, sourcePriceCny: 20, differenceCny: -10 },
    });
  });

  it('calculates same-currency and RUB/CNY gross price differences without inventing a rate', () => {
    expect(calculateSkuPriceDifference(
      { price: 100, currency: 'RUB' }, { price: 6, currency: 'CNY' }, 0.1,
    )).toMatchObject({ status: 'ready', differenceCny: 4 });
    expect(calculateSkuPriceDifference(
      { price: 100, currency: 'RUB' }, { price: 6, currency: 'CNY' }, null,
    )).toMatchObject({ status: 'exchange-rate-required' });
  });

  it('resolves an order only by exact shop and Ozon SKU ID', () => {
    const binding = createSkuNameBinding({
      ozonCatalog: createSkuNameCatalog(product(), { role: 'ozon' }),
      sourceCatalog: sourceCatalog(),
      scope: { shopId: 'shop-a', productId: 'product-a', offerId: 'offer-a' },
      selections: { 'ozon-black-xl': '1688-black-xl', 'ozon-white-l': '1688-white-l' },
    });
    const document = mergeSkuNameBinding({ bindings: [] }, binding);
    expect(resolveExactSkuBinding(document, {
      shopId: 'shop-a', offerId: 'offer-a', sku: 'ozon-white-l',
    })?.pair.sourceSkuId).toBe('1688-white-l');
    expect(resolveExactSkuBinding(document, {
      shopId: 'shop-b', offerId: 'offer-a', sku: 'ozon-white-l',
    })).toBeNull();
    expect(resolveExactSkuBinding(document, {
      shopId: 'shop-a', offerId: 'offer-a', sku: 'unknown',
    })).toBeNull();
    expect(resolveExactSkuBinding(document, {
      shopId: 'shop-a', offerId: 'another-variant-offer', sku: 'ozon-white-l',
    })?.pair.sourceSkuId).toBe('1688-white-l');
  });

  it('preserves legacy name-only rows as pending but replaces the same scoped product with exact binding', () => {
    const legacy = {
      ozonUrl: 'https://www.ozon.ru/product/demo-100/', ozonTitle: 'Ozon商品',
      sourceUrl: 'https://detail.1688.com/offer/200.html', sourceTitle: '货源商品', sourcePlatform: '1688',
      pairs: [{ ozonSkuName: '黑色', sourceSkuName: '雅黑' }], updatedAt: '2026-08-25T00:00:00.000Z',
    };
    const exact = createSkuNameBinding({
      ozonCatalog: createSkuNameCatalog(product(), { role: 'ozon' }), sourceCatalog: sourceCatalog(),
      scope: { shopId: 'shop-a', productId: 'product-a' },
      selections: { 'ozon-black-xl': '1688-black-xl', 'ozon-white-l': '1688-white-l' },
    });
    const merged = mergeSkuNameBinding({ bindings: [legacy] }, exact);
    expect(merged.version).toBe(2);
    expect(merged.bindings[0].bindingStatus).toBe('exact-bound');
    expect(merged.bindings[0].pairs[0].sourceSkuId).toBe('1688-black-xl');
  });
});
