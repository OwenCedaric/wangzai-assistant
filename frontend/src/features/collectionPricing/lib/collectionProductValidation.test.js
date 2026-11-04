import { describe, expect, it } from 'vitest';

import { validateCollectedProduct } from './collectionProductValidation.js';

function validProduct(overrides = {}) {
  return {
    platformCode: 'tmall', pageType: 'product',
    sourceUrl: 'https://detail.tmall.com/item.htm?id=676414560867',
    sourceProductId: '676414560867', title: '儿童遥控越野汽车', purchasePrice: '88',
    mainImages: ['https://img.example/main.jpg'], skuImages: [], detailImages: [],
    skus: [{ id: 'black', name: '黑色', price: '88' }],
    description: '', attributes: [],
    ...overrides,
  };
}

describe('collected product validation', () => {
  it('rejects review counters and other false product headings', () => {
    expect(validateCollectedProduct(validProduct({ title: '用户评价·2000+' }))).toMatchObject({
      accepted: false, status: 'rejected', coreMissing: ['正确标题'],
    });
  });

  it('rejects missing price and SKU instead of displaying a false success', () => {
    const result = validateCollectedProduct(validProduct({ purchasePrice: '', skus: [] }));
    expect(result.accepted).toBe(false);
    expect(result.coreMissing).toEqual(expect.arrayContaining(['有效价格', 'SKU 明细']));
  });

  it('marks a core product as usable and a full benchmark record as complete', () => {
    expect(validateCollectedProduct(validProduct())).toMatchObject({ accepted: true, status: 'usable' });
    expect(validateCollectedProduct(validProduct({
      description: '完整详情', detailImages: ['https://img.example/detail.jpg'],
      attributes: [{ name: '颜色', value: '黑色' }],
    }))).toMatchObject({ accepted: true, status: 'complete' });
  });

  it('rejects a product ID that does not match the link', () => {
    expect(validateCollectedProduct(validProduct({ sourceProductId: '111' })).coreMissing)
      .toContain('商品 ID 匹配');
  });
});
