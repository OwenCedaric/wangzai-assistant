import { describe, expect, it } from 'vitest';
import {
  filterLocalProductSearchRows,
  normalizeLocalProductSearchRow,
} from './smartToolProductSearchService.js';

describe('smartToolProductSearchService', () => {
  it('normalizes a local product row into searchable product and SKU options', () => {
    const product = normalizeLocalProductSearchRow(
      {
        productId: '10001',
        offerId: 'BX-500',
        title: '保温杯',
        mainImage: 'https://img.example/cup.jpg',
        skus: [{ sku: 'SKU-BLACK-500', color: '黑色', capacity: '500ml' }],
      },
      0,
      { name: '测试店铺' }
    );

    expect(product).toMatchObject({
      id: '10001',
      title: '保温杯',
      offerId: 'BX-500',
      image: 'https://img.example/cup.jpg',
      shopName: '测试店铺',
    });
    expect(product.skuOptions[0]).toMatchObject({
      sku: 'SKU-BLACK-500',
      facts: 'SKU-BLACK-500 · 黑色 · 500ml',
    });
  });

  it('searches by title, article number, product id, or SKU', () => {
    const products = [
      normalizeLocalProductSearchRow({ productId: '10001', offerId: 'BX-500', title: '保温杯', sku: 'SKU-BLACK' }),
      normalizeLocalProductSearchRow({ productId: '10002', offerId: 'BX-900', title: '收纳盒', sku: 'SKU-WHITE' }),
    ];

    expect(filterLocalProductSearchRows(products, 'BX-900')).toHaveLength(1);
    expect(filterLocalProductSearchRows(products, 'SKU-BLACK')[0].title).toBe('保温杯');
    expect(filterLocalProductSearchRows(products, '')).toHaveLength(2);
  });

  it('keeps every legacy gallery image in its original main-image order without a five-image split', () => {
    const images = Array.from({ length: 8 }, (_, index) => `https://img.example/product-${index + 1}.jpg`);
    const product = normalizeLocalProductSearchRow({
      productId: '10003',
      title: '露营灯',
      primaryImageUrl: images[0],
      images,
    });

    expect(product.images).toEqual(images);
    expect(product.mainImages).toEqual(images);
    expect(product.detailImages).toEqual([]);
    expect(product.skuOptions[0].mainImages).toEqual(images);
    expect(product.skuOptions[0].detailImages).toEqual([]);
  });
});
