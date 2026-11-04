import { describe, expect, it, vi } from 'vitest';

import {
  AUTO_ORDER_SKU_BINDING_NAMESPACE,
  AUTO_ORDER_SKU_CATALOG_CACHE_NAMESPACE,
  loadSkuNameBindings,
  readSkuCatalogFromLink,
  resolveSavedSkuBindingForOrder,
  saveSkuNameBinding,
} from './purchaseSkuBindingService.js';

const ozonProduct = {
  sourceUrl: 'https://www.ozon.ru/product/demo-100/', platform: 'Ozon买家', platformCode: 'ozon-buyer',
  title: 'Ozon商品', currency: 'RUB', skus: [{ id: 'ozon-black', attributes: [{ name: '颜色', value: '黑色' }], price: 100 }],
};
const sourceProduct = {
  sourceUrl: 'https://detail.1688.com/offer/200.html', platform: '1688', platformCode: '1688',
  title: '货源商品', currency: 'CNY', skus: [{ id: '1688-black', attributes: [{ name: '颜色', value: '雅黑' }], price: 20 }],
};

describe('purchase exact SKU binding service', () => {
  it('uses the existing structured CEF link collector when no seller scope is available', async () => {
    const collect = vi.fn(async () => ({ product: ozonProduct }));
    const readCache = vi.fn(async () => ({ setting: null }));
    const saveCache = vi.fn(async (_namespace, value) => ({ setting: { value } }));
    const catalog = await readSkuCatalogFromLink(ozonProduct.sourceUrl, 'ozon', { collect, readCache, saveCache });
    expect(collect).toHaveBeenCalledWith(ozonProduct.sourceUrl, undefined);
    expect(catalog.skus[0]).toMatchObject({ id: 'ozon-black', name: '颜色：黑色' });
    expect(saveCache).toHaveBeenCalledWith(
      AUTO_ORDER_SKU_CATALOG_CACHE_NAMESPACE,
      expect.objectContaining({ entries: expect.any(Array) }),
      expect.any(Object),
    );
  });

  it('reads every Ozon seller SKU in the same model family from local SQLite', async () => {
    const readOzonFamily = vi.fn(async () => ({
      ok: true,
      modelIdentity: 'model-a',
      rows: [
        {
          shopId: 'shop-a', productId: 'product-black', offerId: 'offer-black', sku: 'ozon-black',
          name: 'Ozon商品', priceValue: 100, currencyCode: 'RUB', primaryImageUrl: 'https://img.example/black.jpg',
          attributes: [{ id: 10096, name: '颜色', values: [{ value: '黑色' }] }],
        },
        {
          shopId: 'shop-a', productId: 'product-white', offerId: 'offer-white', sku: 'ozon-white',
          name: 'Ozon商品', priceValue: 120, currencyCode: 'RUB', primaryImageUrl: 'https://img.example/white.jpg',
          attributes: [{ id: 10096, name: '颜色', values: [{ value: '白色' }] }],
        },
      ],
    }));
    const catalog = await readSkuCatalogFromLink(ozonProduct.sourceUrl, 'ozon', {
      scope: { shopId: 'shop-a', sku: 'ozon-black' },
      readOzonFamily,
      readCache: async () => ({ setting: null }),
      saveCache: async () => ({ setting: null }),
    });
    expect(readOzonFamily).toHaveBeenCalledWith(expect.objectContaining({ shopId: 'shop-a', sku: 'ozon-black' }), expect.any(Object));
    expect(catalog.localSellerData).toBe(true);
    expect(catalog.skus).toEqual([
      expect.objectContaining({ id: 'ozon-black', name: '颜色：黑色', price: '100' }),
      expect.objectContaining({ id: 'ozon-white', name: '颜色：白色', price: '120' }),
    ]);
  });

  it('ignores a legacy cache that has no SKU IDs and refreshes live data', async () => {
    const collect = vi.fn(async () => ({ product: sourceProduct }));
    const readCache = vi.fn(async () => ({ setting: { value: {
      version: 1,
      entries: [{
        key: `source:${sourceProduct.sourceUrl}`,
        catalog: { role: 'source', url: sourceProduct.sourceUrl, title: '旧缓存', skus: [{ name: '黑色' }] },
        expiresAt: '2099-01-01T00:00:00.000Z',
      }],
    } } }));
    const catalog = await readSkuCatalogFromLink(sourceProduct.sourceUrl, 'source', {
      collect, readCache, saveCache: async () => ({ setting: null }),
    });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(catalog.skus[0].id).toBe('1688-black');
  });

  it('loads legacy rows as pending and saves exact SKU IDs to SQLite profile settings', async () => {
    const read = vi.fn(async () => ({ setting: { value: { version: 1, bindings: [] } } }));
    expect(await loadSkuNameBindings({ read })).toEqual({ version: 2, bindings: [] });
    const save = vi.fn(async (_namespace, value) => ({ setting: { value } }));
    const result = await saveSkuNameBinding({
      ozonCatalog: await readSkuCatalogFromLink('', 'ozon', { collect: async () => ({ product: ozonProduct }) }),
      sourceCatalog: await readSkuCatalogFromLink('', 'source', { collect: async () => ({ product: sourceProduct }) }),
      scope: { shopId: 'shop-a', productId: 'product-a', offerId: 'offer-a' },
      selections: { 'ozon-black': '1688-black' },
      rubToCnyRate: 0.1,
    }, { read, save });
    expect(save).toHaveBeenCalledWith(AUTO_ORDER_SKU_BINDING_NAMESPACE, expect.any(Object), expect.any(Object));
    expect(result.binding.pairs[0]).toMatchObject({ ozonSkuId: 'ozon-black', sourceSkuId: '1688-black' });
    expect(result.document.version).toBe(2);
  });

  it('exposes the exact order-SKU lookup used by automatic ordering', async () => {
    const read = vi.fn(async () => ({ setting: { value: {
      version: 2,
      bindings: [{
        shopId: 'shop-a', ozonProductId: 'product-a', ozonOfferId: 'offer-a',
        ozonUrl: ozonProduct.sourceUrl, ozonTitle: 'Ozon商品',
        sourceUrl: sourceProduct.sourceUrl, sourceTitle: '货源商品', sourcePlatform: '1688',
        pairs: [{ ozonSkuId: 'ozon-black', ozonSkuName: '黑色', sourceSkuId: '1688-black', sourceSkuName: '雅黑' }],
      }],
    } } }));
    const resolved = await resolveSavedSkuBindingForOrder({ shopId: 'shop-a', offerId: 'offer-a', sku: 'ozon-black' }, { read });
    expect(resolved?.pair.sourceSkuId).toBe('1688-black');
  });
});
