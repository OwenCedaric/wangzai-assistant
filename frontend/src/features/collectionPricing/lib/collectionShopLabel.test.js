import { describe, expect, it } from 'vitest';

import { formatCollectionShopLabel } from './collectionShopLabel.js';

describe('collection shop label', () => {
  it('uses the real seller alias fields before falling back to the shop id', () => {
    expect(formatCollectionShopLabel({ id: 'shop-1', shopAlias: '一店' })).toBe('一店 · shop-1');
    expect(formatCollectionShopLabel({ shopId: 'shop-2', sellerName: '二店' })).toBe('二店 · shop-2');
    expect(formatCollectionShopLabel({}, 'shop-3')).toBe('Ozon 店铺 · shop-3');
  });
});
