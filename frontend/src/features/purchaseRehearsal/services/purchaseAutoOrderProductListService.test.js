import { describe, expect, it, vi } from 'vitest';
import { loadAutoOrderProductList } from './purchaseAutoOrderProductListService.js';

describe('automatic ordering product list read model', () => {
  it('includes canonical source-linked products before SKU mapping is complete', async () => {
    const readSummary = vi.fn().mockResolvedValue({
      rows: [
        {
          shopId: 'shop-1', productKey: 'product:100', productId: '100', offerId: 'offer-100', sku: '100000', name: '完整绑定商品',
          priceValue: 88.5, currencyCode: 'CNY', primaryImageUrl: 'https://ir.ozone.ru/ozon-product-100.jpg',
          sourceLinks: [{ isPrimary: true, platform: '1688', link: 'https://detail.1688.com/offer/900000.html', title: '完整货源' }],
          updatedAt: '2026-08-25T01:00:00.000Z',
        },
        {
          shopId: 'shop-1', productKey: 'product:200', productId: '200', offerId: 'offer-200', sku: '200000', name: '待完善商品',
          sourceLinks: [{ isPrimary: true, platform: 'PDD', link: 'https://mobile.yangkeduo.com/goods.html?goods_id=800000', title: '已有货源' }],
          updatedAt: '2026-08-25T02:00:00.000Z',
        },
        {
          shopId: 'shop-1', productKey: 'product:300', productId: '300', offerId: 'offer-300', sku: '300000', name: '没有货源',
          sourceLinks: [],
        },
      ],
      total: 3,
    });
    const result = await loadAutoOrderProductList({
      readBindings: vi.fn().mockResolvedValue({
        version: 2,
        bindings: [{
          shopId: 'shop-1',
          ozonProductId: '100',
          ozonOfferId: 'offer-100',
          ozonUrl: 'https://www.ozon.ru/product/example-100000/',
          ozonTitle: '完整绑定商品',
          sourceUrl: 'https://detail.1688.com/offer/900000.html',
          sourceTitle: '完整货源',
          sourcePlatform: '1688',
          pairs: [{
            ozonSkuId: '100000', ozonSkuName: '黑色', ozonPrice: '88.5', ozonCurrency: 'CNY',
            sourceSkuId: '1688-black', sourceSkuName: '雅黑', sourcePrice: '20', sourceCurrency: 'CNY',
            priceDifference: { status: 'ready', ozonPriceCny: 88.5, sourcePriceCny: 20, differenceCny: 68.5 },
          }],
          updatedAt: '2026-08-25T03:00:00.000Z',
        }],
      }),
      readSummary,
      readShops: vi.fn().mockResolvedValue({ shops: [{ id: 'shop-1', alias: 'Ozon测试店' }] }),
      readSourceLinks: vi.fn().mockResolvedValue({
        'shop-1:offer-200': {
          shopId: 'shop-1', productKey: 'offer-200', productId: '200', offerId: 'offer-200', sku: '200000',
          links: [{ platform: 'PDD', link: 'https://mobile.yangkeduo.com/goods.html?goods_id=800000', title: '同一商品旧别名' }],
        },
      }),
    });

    expect(readSummary).toHaveBeenCalledWith(expect.objectContaining({ sourceStatuses: 'saved' }));
    expect(result.items).toHaveLength(2);
    expect(result.items.find((item) => item.sku === '100000')).toMatchObject({
      bindingStatus: 'bound',
      shopName: 'Ozon测试店',
      salePrice: 88.5,
      saleCurrency: 'CNY',
      ozonImageUrl: 'https://ir.ozone.ru/ozon-product-100.jpg',
      bindingPriceMetrics: {
        sourcePrice: { min: 20, max: 20, count: 1 },
        difference: { min: 68.5, max: 68.5, count: 1 },
        grossMargin: { min: 77.40112994350282, max: 77.40112994350282, count: 1 },
      },
      pairs: [{ ozonSkuId: '100000', sourceSkuId: '1688-black' }],
    });
    expect(result.items.find((item) => item.sku === '200000')).toMatchObject({
      bindingStatus: 'sku-pending',
      ozonUrl: 'https://www.ozon.ru/product/200000/',
      sourceTitle: '已有货源',
      pairs: [],
    });
    expect(result.items.some((item) => item.sku === '300000')).toBe(false);
    expect(result).toMatchObject({ total: 2, boundCount: 1, pendingSkuCount: 1 });
  });

  it('keeps a source-link record visible even before its product summary is available', async () => {
    const result = await loadAutoOrderProductList({
      readBindings: vi.fn().mockResolvedValue({ version: 1, bindings: [] }),
      readSummary: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
      readShops: vi.fn().mockResolvedValue({ shops: [{ id: 'shop-2', alias: 'Ozon二店' }] }),
      readSourceLinks: vi.fn().mockResolvedValue({
        'shop-2:product:400': {
          shopId: 'shop-2', productKey: 'product:400', productId: '400', offerId: 'offer-400', sku: '400000',
          links: [{ platform: '淘宝', link: 'https://item.taobao.com/item.htm?id=700000', title: '淘宝货源' }],
          updatedAt: '2026-08-25T04:00:00.000Z',
        },
      }),
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        shopId: 'shop-2', sku: '400000', sourceTitle: '淘宝货源', bindingStatus: 'sku-pending',
      }),
    ]);
  });
});
