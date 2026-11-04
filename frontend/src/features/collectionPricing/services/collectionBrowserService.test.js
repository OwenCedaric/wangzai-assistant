import { describe, expect, it, vi } from 'vitest';

import {
  captureCurrentCollectionProduct,
  collectCollectionProductFromLink,
} from './collectionBrowserService.js';

describe('collection browser service', () => {
  it('captures only the active internal-browser tab and normalizes the result', async () => {
    const bridge = vi.fn(async (input) => {
      if (input.command === 'state') return { activeTabId: 'tab-2', tabs: [{ tabId: 'tab-1' }, { tabId: 'tab-2' }] };
      return {
        ok: true,
        capture: {
          platform: '1688',
          pageType: 'product',
          sourceUrl: 'https://detail.1688.com/offer/123.html',
          sourceProductId: '123',
          productTitle: '采集商品',
          purchasePrice: 18.8,
          currency: 'CNY',
          mainImages: ['https://img.example/123-main.jpg'],
          skus: [{ id: '123-default', name: '默认款', price: 18.8 }],
        },
      };
    });
    const result = await captureCurrentCollectionProduct({ bridge });
    expect(bridge).toHaveBeenNthCalledWith(2, { command: 'capture-purchase', tabId: 'tab-2' });
    expect(result.product).toMatchObject({ title: '采集商品', purchasePrice: '18.8' });
  });

  it('opens a pasted link in the isolated parser and retries until product data is ready', async () => {
    let captureAttempts = 0;
    const bridge = vi.fn(async (input) => {
      if (input.command === 'open-external') {
        return {
          tabs: [{
            tabId: 'link-tab',
            browserRole: 'product-link-parser',
            requestedUrl: 'https://detail.1688.com/offer/456.html',
          }],
        };
      }
      captureAttempts += 1;
      if (captureAttempts === 1) {
        return { ok: false, error: { code: 'PURCHASE_BROWSER_CAPTURE_EMPTY' } };
      }
      return {
        ok: true,
        capture: {
          platform: '1688',
          pageType: 'product',
          sourceProductId: '456',
          productTitle: '链接采集商品',
          purchasePrice: 29.9,
          images: ['https://img.example/1.jpg', 'https://img.example/2.jpg'],
          skus: [{ id: '456-default', name: '默认款', price: 29.9 }],
        },
      };
    });
    const sleep = vi.fn(async () => undefined);

    const result = await collectCollectionProductFromLink(
      'https://detail.1688.com/offer/456.html',
      { bridge, attempts: 2, sleep },
    );

    expect(result.product).toMatchObject({ title: '链接采集商品', purchasePrice: '29.9' });
    expect(result.product.images).toHaveLength(2);
    expect(bridge.mock.calls[0][0]).toMatchObject({
      command: 'open-external',
      browserRole: 'product-link-parser',
      background: true,
    });
    expect(bridge.mock.calls[1][0]).toEqual({ command: 'capture-purchase', tabId: 'link-tab' });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('rejects a review heading that was mistakenly returned as a Tmall product', async () => {
    const bridge = vi.fn(async (input) => input.command === 'state'
      ? { activeTabId: 'tmall-tab', tabs: [{ tabId: 'tmall-tab' }] }
      : {
        ok: true,
        capture: {
          platform: '天猫', pageType: 'product',
          sourceUrl: 'https://detail.tmall.com/item.htm?id=676414560867',
          sourceProductId: '676414560867', productTitle: '用户评价·2000+', purchasePrice: 88,
          mainImages: ['https://img.example/review-avatar.jpg'],
          skus: [{ id: '2', name: '评价数', price: 88 }],
        },
      });

    await expect(captureCurrentCollectionProduct({ bridge })).rejects.toMatchObject({
      code: 'COLLECTION_PRODUCT_CAPTURE_INCOMPLETE',
      missing: expect.arrayContaining(['正确标题']),
    });
  });

  it('waits for a reused Pinduoduo parser and rejects a stale previous-product capture', async () => {
    const url = 'https://mobile.yangkeduo.com/goods.html?goods_id=200';
    let stateReads = 0;
    let captures = 0;
    const bridge = vi.fn(async (input) => {
      if (input.command === 'open-external') {
        return { tabs: [{
          tabId: 'pdd-parser', browserRole: 'product-link-parser', requestedUrl: url,
          url: 'https://mobile.yangkeduo.com/goods.html?goods_id=199',
          loading: true, navigationSequence: 2, navigationCompletedSequence: 1,
        }] };
      }
      if (input.command === 'state') {
        stateReads += 1;
        return { tabs: [{
          tabId: 'pdd-parser', browserRole: 'product-link-parser', requestedUrl: url,
          url, loading: false, navigationSequence: 2, navigationCompletedSequence: 2,
        }] };
      }
      captures += 1;
      const sourceProductId = captures === 1 ? '199' : '200';
      return {
        ok: true,
        capture: {
          platform: '拼多多', pageType: 'product', sourceProductId,
          sourceUrl: `https://mobile.yangkeduo.com/goods.html?goods_id=${sourceProductId}`,
          productTitle: `拼多多商品 ${sourceProductId}`, purchasePrice: 33.2,
          mainImages: [`https://img.example/${sourceProductId}.jpg`],
          skus: [{ id: `${sourceProductId}-sku`, name: '标准款', price: 33.2 }],
        },
      };
    });
    const sleep = vi.fn(async () => undefined);

    const result = await collectCollectionProductFromLink(url, { bridge, attempts: 2, sleep });

    expect(stateReads).toBe(1);
    expect(captures).toBe(2);
    expect(result.product.sourceProductId).toBe('200');
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('maps every non-1688 collection URL into the same normalized product contract', async () => {
    const rows = [
      ['https://mobile.yangkeduo.com/goods.html?goods_id=200', '200', 'pdd'],
      ['https://item.taobao.com/item.htm?id=300', '300', 'taobao'],
      ['https://detail.tmall.com/item.htm?id=400', '400', 'tmall'],
      ['https://item.jd.com/50000.html', '50000', 'jd'],
      ['https://www.wildberries.ru/catalog/60000/detail.aspx', '60000', 'wildberries'],
      ['https://www.amazon.com/dp/B0ABC12345', 'B0ABC12345', 'amazon'],
      ['https://www.temu.com/test-g-70000.html?goods_id=70000', '70000', 'temu'],
      ['https://www.aliexpress.com/item/80000.html', '80000', 'aliexpress'],
      ['https://www.ozon.ru/product/test-90000/', '90000', 'ozon-buyer'],
    ];

    for (const [url, sourceProductId, platformCode] of rows) {
      const bridge = vi.fn(async (input) => input.command === 'open-external'
        ? { tabs: [{ tabId: `tab-${platformCode}`, browserRole: 'product-link-parser', requestedUrl: url }] }
        : {
          ok: true,
          capture: {
            pageType: 'product', sourceUrl: url, sourceProductId,
            productTitle: `${platformCode} 测试商品`, purchasePrice: 19.9,
            mainImages: [`https://img.example/${platformCode}-main.jpg`],
            skus: [{ id: `${sourceProductId}-sku`, name: '标准款', price: 19.9 }],
          },
        });
      const result = await collectCollectionProductFromLink(url, { bridge, attempts: 1 });
      expect(result.product).toMatchObject({ platformCode, sourceProductId, purchasePrice: '19.9' });
    }
  });
});
