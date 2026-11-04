import { afterEach, describe, expect, it } from 'vitest';

import {
  getCollectionProductThumbnailSource,
  getCollectionProductThumbnailUrls,
} from './collectionProductImageUrl.js';

afterEach(() => {
  delete globalThis.wangzaiDesktop;
});

describe('collection product thumbnail URL', () => {
  it('falls back from a missing main image to the first SKU image', () => {
    expect(getCollectionProductThumbnailSource({
      mainImages: [],
      skuImages: [{ imageUrl: 'https://cbu01.alicdn.com/img/ibank/sku.jpg' }],
    })).toBe('https://cbu01.alicdn.com/img/ibank/sku.jpg');
  });

  it('uses the desktop image proxy first and retains the direct no-referrer fallback', () => {
    globalThis.wangzaiDesktop = { purchaseBridgeRequest() {} };
    const urls = getCollectionProductThumbnailUrls({
      mainImages: ['https://cbu01.alicdn.com/img/ibank/main.jpg'],
    });
    expect(urls[0]).toBe('app://wangzai/purchase-image?url=https%3A%2F%2Fcbu01.alicdn.com%2Fimg%2Fibank%2Fmain.jpg');
    expect(urls[1]).toBe('https://cbu01.alicdn.com/img/ibank/main.jpg');
  });
});
