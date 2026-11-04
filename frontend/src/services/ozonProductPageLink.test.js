import { describe, expect, it, vi } from 'vitest';
import {
  buildOzonProductPageUrl,
  openOzonProductPage,
  resolveOzonProductPageTarget,
} from './ozonProductPageLink.js';

describe('Ozon product page links', () => {
  it('prefers the public Ozon SKU over the seller offer id', () => {
    expect(buildOzonProductPageUrl({ offerId: 'merchant-offer-1', ozonSku: '123456789' }))
      .toBe('https://www.ozon.ru/product/123456789/');
  });

  it('resolves sales and profit rows through their nested product SKU', () => {
    expect(buildOzonProductPageUrl({ products: [{ skuId: '987654321', name: '测试商品' }] }))
      .toBe('https://www.ozon.ru/product/987654321/');
  });

  it('resolves analysis rows that expose the product id as sku', () => {
    expect(buildOzonProductPageUrl({ sku: '123456789', name: '分析商品' }))
      .toBe('https://www.ozon.ru/product/123456789/');
  });

  it('keeps every titled product clickable by falling back to Ozon search', () => {
    expect(resolveOzonProductPageTarget({ name: '没有 SKU 的商品' })).toMatchObject({
      url: 'https://www.ozon.ru/search/?text=%E6%B2%A1%E6%9C%89%20SKU%20%E7%9A%84%E5%95%86%E5%93%81',
      exact: false,
    });
  });

  it('accepts normalized market-record links when an exact Ozon URL was captured', () => {
    expect(buildOzonProductPageUrl({ title: '市场商品', link: 'https://www.ozon.ru/product/123456789/' }))
      .toBe('https://www.ozon.ru/product/123456789/');
  });

  it('does not mistake a numeric order id for an Ozon product id', () => {
    expect(resolveOzonProductPageTarget({ name: '测试商品' }, { id: '123456789', product: '测试商品' }))
      .toMatchObject({ exact: false });
  });

  it('opens through the supplied internal-browser bridge', async () => {
    const bridge = vi.fn().mockResolvedValue({ ok: true, activeTabId: 'ozon-product-tab' });
    const result = await openOzonProductPage({ productId: '123456789', name: '测试商品' }, { bridge });

    expect(bridge).toHaveBeenCalledWith({
      command: 'open-external',
      url: 'https://www.ozon.ru/product/123456789/',
    });
    expect(result.browserState).toMatchObject({ activeTabId: 'ozon-product-tab' });
  });
});
