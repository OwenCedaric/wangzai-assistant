import { describe, expect, it } from 'vitest';
import { buildOzonProductWorkbenchOpenPayload } from './ozonProductWorkbenchPresentation.js';

describe('Ozon product workbench presentation reuse', () => {
  it('reuses the purchase workbench contract for an Ozon sales-order product', () => {
    const result = buildOzonProductWorkbenchOpenPayload({
      order: {
        id: 'ORDER-1',
        shop: 'Ozon 1店',
        product: '测试商品',
        amount: '¥99.00',
        status: '已发货',
        paymentTime: '2026/07/24 10:30:00',
      },
      product: {
        name: '测试商品',
        skuId: '123456789',
        offerId: 'OFFER-1',
        qty: 2,
      },
    });

    expect(result.target.url).toBe('https://www.ozon.ru/product/123456789/');
    expect(result.presentation).toMatchObject({
      kind: 'purchase-order',
      title: '商品订单操作台',
      browserLabel: 'Ozon 商品页面',
      order: { orderNo: 'ORDER-1', shop: 'Ozon 1店' },
      product: { title: '测试商品', sku: 'OFFER-1' },
    });
  });

  it('maps existing purchase, source and cross-border data into the same workbench', () => {
    const result = buildOzonProductWorkbenchOpenPayload({
      order: {
        id: 'ORDER-2',
        shop: 'Ozon 2店',
        product: 'Ozon 商品标题',
        salesAmount: '¥120.00',
        status: '完结单',
      },
      product: {
        name: 'Ozon 商品标题',
        skuId: '987654321',
        offerId: 'OFFER-2',
        imageUrl: 'https://cdn.example.test/ozon.jpg',
      },
      sourceEntry: {
        platform: '1688',
        link: 'https://detail.1688.com/offer/1.html',
        title: '供应商标题',
        price: '¥22.50',
      },
      purchaseInfo: {
        platform: '1688',
        orderNumber: 'PO-1688-1',
        cost: '¥22.50',
      },
      crossBorderInfo: {
        orderId: 'CB-1',
        packageWeight: '0.8 kg',
        packageSize: '30 x 20 x 10 cm',
        logistics: '空运专线',
        readStatus: '跨境巴士已读取',
      },
    });

    expect(result.presentation).toMatchObject({
      order: {
        orderNo: 'ORDER-2',
        purchasePlatform: '1688',
        purchaseOrderNo: 'PO-1688-1',
        salesAmount: '¥120.00',
      },
      product: {
        title: 'Ozon 商品标题',
        sku: 'OFFER-2',
        imageUrl: 'https://cdn.example.test/ozon.jpg',
      },
      source: {
        platform: '1688',
        amount: '¥22.50',
        url: 'https://detail.1688.com/offer/1.html',
      },
      logistics: {
        orderId: 'CB-1',
        weight: '0.8 kg',
        size: '30 x 20 x 10 cm',
        route: '空运专线',
        readStatus: '跨境巴士已读取',
      },
    });
  });

  it('recovers the first saved source record when the caller only has the enriched order row', () => {
    const result = buildOzonProductWorkbenchOpenPayload({
      order: {
        id: 'ORDER-3',
        product: '商品三',
        manualSourceRecord: {
          primaryIndex: 0,
          links: [{ platform: 'PDD', link: 'https://mobile.yangkeduo.com/goods.html', price: '¥9.90' }],
        },
      },
      product: { name: '商品三', skuId: '11223344' },
    });

    expect(result.presentation.source).toEqual({
      platform: 'PDD',
      amount: '¥9.90',
      url: 'https://mobile.yangkeduo.com/goods.html',
    });
  });

  it('keeps the product-analysis sidebar payload while reusing the existing Ozon workbench', () => {
    const result = buildOzonProductWorkbenchOpenPayload({
      product: {
        title: '搜索结果商品',
        sku: '3568698657',
        productUrl: 'https://www.ozon.ru/product/test-3568698657/',
      },
      sidebarKind: 'product-analysis',
      productAnalysis: {
        price: '1 999 ₽',
        sales: '120 件',
        revenue: '239 880 ₽',
        stock: '44 件',
      },
      title: 'Ozon 商品分析操作台',
      subtitle: '左侧固定当前商品数据，右侧查看对应 Ozon 商品页面',
    });

    expect(result.target).toMatchObject({
      url: 'https://www.ozon.ru/product/test-3568698657/',
      exact: true,
    });
    expect(result.presentation).toMatchObject({
      sidebarKind: 'product-analysis',
      title: 'Ozon 商品分析操作台',
      product: { title: '搜索结果商品', sku: '3568698657' },
      productAnalysis: {
        price: '1 999 ₽',
        sales: '120 件',
        revenue: '239 880 ₽',
        stock: '44 件',
      },
    });
  });
});
