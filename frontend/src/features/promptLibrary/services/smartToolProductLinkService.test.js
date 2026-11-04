import { describe, expect, it, vi } from 'vitest';
import {
  SMART_TOOL_PRODUCT_LINK_INPUT,
  buildSmartToolProductLinkSearchValues,
  buildSmartToolTargetProductComparison,
  detectSmartToolProductLinkPlatform,
  ensureSmartToolProductLinkUsageInputs,
  parseSmartToolProductLink,
} from './smartToolProductLinkService.js';

describe('smartToolProductLinkService', () => {
  it('accepts only the five supported product platforms', () => {
    expect(detectSmartToolProductLinkPlatform('https://detail.1688.com/offer/123.html')?.key).toBe('1688');
    expect(detectSmartToolProductLinkPlatform('https://item.taobao.com/item.htm?id=123')?.key).toBe('taobao');
    expect(detectSmartToolProductLinkPlatform('https://detail.tmall.com/item.htm?id=123')?.key).toBe('tmall');
    expect(detectSmartToolProductLinkPlatform('https://mobile.yangkeduo.com/goods.html?goods_id=123')?.key).toBe('pinduoduo');
    expect(detectSmartToolProductLinkPlatform('https://www.ozon.ru/product/test-123')?.key).toBe('ozon-buyer');
    expect(detectSmartToolProductLinkPlatform('https://seller.ozon.ru/app/dashboard/main')).toBeNull();
    expect(detectSmartToolProductLinkPlatform('https://example.com/product/123')).toBeNull();
  });

  it('keeps the Ozon search rail to two ordinary inputs', () => {
    expect(ensureSmartToolProductLinkUsageInputs(
      { id: 'ozon-product-search' },
      ['关键词或 SKU'],
    )).toEqual(['关键词或 SKU', SMART_TOOL_PRODUCT_LINK_INPUT]);
  });

  it('opens and inspects the dedicated parser role without touching the collector tab', async () => {
    const bridge = vi.fn(async (input) => {
      if (input.command === 'open-external') {
        return {
          activeTabId: 'collector-tab',
          tabs: [
            { tabId: 'collector-tab', browserRole: 'market-collector', background: true },
            {
              tabId: 'parser-tab',
              browserRole: 'product-link-parser',
              background: true,
              requestedUrl: 'https://detail.1688.com/offer/123.html',
              sessionId: 'parser-session',
              generation: 2,
            },
          ],
        };
      }
      return {
        inspection: {
          platform: '1688',
          pageType: 'product',
          productTitle: '测试连衣裙',
          purchasePrice: 26.8,
          currency: 'CNY',
          lengthCm: 30,
          widthCm: 20,
          heightCm: 8,
          weightKg: 0.45,
        },
      };
    });
    const capture = await parseSmartToolProductLink('https://detail.1688.com/offer/123.html', {
      bridge,
      attempts: 1,
    });
    expect(capture).toMatchObject({
      platform: '1688',
      productTitle: '测试连衣裙',
      price: 26.8,
      lengthCm: 30,
      weightKg: 0.45,
    });
    expect(bridge.mock.calls[0][0]).toMatchObject({
      command: 'open-external',
      browserRole: 'product-link-parser',
      background: true,
      restoreVisible: false,
    });
    expect(bridge.mock.calls[1][0]).toMatchObject({
      command: 'inspect',
      tabId: 'parser-tab',
      sessionId: 'parser-session',
      generation: 2,
    });
  });

  it('retries while the isolated CEF page is still creating its JavaScript context', async () => {
    let inspections = 0;
    const bridge = vi.fn(async (input) => {
      if (input.command === 'open-external') {
        return {
          tabs: [{
            tabId: 'parser-tab',
            browserRole: 'product-link-parser',
            background: true,
            requestedUrl: 'https://www.ozon.ru/product/test-3876911440/',
            sessionId: 'parser-session',
            generation: 1,
          }],
        };
      }
      inspections += 1;
      if (inspections === 1) {
        throw new Error("Error invoking remote method 'desktop:purchase-browser-command': Error: PURCHASE_BROWSER_CEF_FAILED");
      }
      return {
        inspection: {
          platform: 'Ozon',
          pageType: 'product',
          sourceProductId: '3876911440',
          productTitle: '测试商品',
          purchasePrice: 1999,
          currency: 'RUB',
        },
      };
    });
    const sleep = vi.fn(async () => undefined);

    const capture = await parseSmartToolProductLink(
      'https://www.ozon.ru/product/test-3876911440/',
      { bridge, attempts: 2, sleep },
    );

    expect(capture).toMatchObject({
      sourceProductId: '3876911440',
      productTitle: '测试商品',
      price: 1999,
    });
    expect(inspections).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('uses an explicit keyword when present and derives one from the parsed link otherwise', () => {
    expect(buildSmartToolProductLinkSearchValues({
      '关键词或 SKU': '连衣裙',
      [SMART_TOOL_PRODUCT_LINK_INPUT]: 'https://detail.1688.com/offer/123.html',
    }, { productTitle: '测试裙子' })).toEqual({ '关键词或 SKU': '连衣裙' });
    expect(buildSmartToolProductLinkSearchValues({
      '关键词或 SKU': '',
      [SMART_TOOL_PRODUCT_LINK_INPUT]: 'https://detail.1688.com/offer/123.html',
    }, { category: '女装 > 连衣裙', productTitle: '测试裙子' })).toEqual({
      '关键词或 SKU': '女装 > 连衣裙',
    });
  });

  it('builds the target-product price and fee comparison only from returned values', () => {
    const comparison = buildSmartToolTargetProductComparison({
      platform: '1688',
      platformKey: '1688',
      productTitle: '测试连衣裙',
      price: 26.8,
      currency: 'CNY',
      lengthCm: 30,
      widthCm: 20,
      heightCm: 8,
      weightKg: 0.45,
    }, {
      priceStats: { median: 2400 },
      records: [
        { price: 2000, categoryCommission: 15 },
        { price: 2400, categoryCommission: 0.16 },
        { price: 3000, categoryCommission: 17 },
      ],
    });
    expect(comparison).toMatchObject({
      priceKind: '采购参考价',
      sourceCostCny: 26.8,
      suggestedSalePriceRub: 2400,
      commissionPercent: 16,
      estimatedCommissionRub: 384,
      estimatedAcquiringRub: 48,
      estimatedDeliveryRub: 15,
      estimatedPlatformFeesRub: 447,
      dimensions: '30 × 20 × 8 cm',
    });
  });

  it('keeps parsed link data visible when the market comparison has no matching rows', () => {
    const comparison = buildSmartToolTargetProductComparison({
      platform: 'Ozon',
      platformKey: 'ozon-buyer',
      sourceProductId: '3876911440',
      productTitle: '测试商品',
      price: 1999,
      currency: 'RUB',
      lengthCm: 25,
      widthCm: 15,
      heightCm: 8,
      weightKg: 0.6,
    });

    expect(comparison).toMatchObject({
      sourceProductId: '3876911440',
      priceKind: '销售价',
      capturedPrice: 1999,
      suggestedSalePriceRub: 1999,
      dimensions: '25 × 15 × 8 cm',
      estimatedAcquiringRub: 39.98,
      estimatedDeliveryRub: 15,
    });
    expect(comparison.estimatedCommissionRub).toBeNull();
    expect(comparison.estimatedPlatformFeesRub).toBeNull();
  });

  it('fills an Ozon target card from the matching real market row when the page exposes only its product id', () => {
    const comparison = buildSmartToolTargetProductComparison({
      platform: 'Ozon买家',
      platformKey: 'ozon-buyer',
      sourceProductId: '175924376',
      sourceUrl: 'https://www.ozon.ru/product/175924376',
      currency: 'RUB',
    }, {
      priceStats: { median: 2679.325 },
      records: [{
        id: '175924376',
        title: 'Яндекс Music Subscription',
        imageUrl: 'https://ir.ozone.ru/item.jpg',
        brand: 'Яндекс',
        category: '音乐订阅',
        price: 2679.325,
        packageDimensions: '20 × 12 × 3 cm',
        packageWeight: '250 g',
      }],
    });

    expect(comparison).toMatchObject({
      productTitle: 'Яндекс Music Subscription',
      imageUrl: 'https://ir.ozone.ru/item.jpg',
      brand: 'Яндекс',
      category: '音乐订阅',
      capturedPrice: 2679.325,
      suggestedSalePriceRub: 2679.325,
      dimensions: '20 × 12 × 3 cm',
      weightKg: 0.25,
    });
  });
});
