import { describe, expect, it } from 'vitest';

import { applyCollectionProductGeneratedImagesToListingDraft } from './collectionProductGeneratedImageApplication.js';

describe('collection generated image application', () => {
  it('uploads only the five generated images and never falls back to raw 1688 images', () => {
    const sourceMain = Array.from({ length: 24 }, (_item, index) => `https://1688.example/main-${index}.jpg`);
    const sourceSku = Array.from({ length: 6 }, (_item, index) => ({
      skuId: `sku-${index}`,
      imageUrl: `https://1688.example/sku-${index}.jpg`,
    }));
    const generated = Array.from({ length: 5 }, (_item, index) => ({
      sourceIndex: index,
      assetId: `asset-${index}`,
      imageUrl: `/api/product-images/preview/asset-${index}?shopId=shop-a`,
      storageScope: 'permanent',
    }));
    const result = applyCollectionProductGeneratedImagesToListingDraft({
      images: [...sourceMain, ...sourceSku.map((item) => item.imageUrl)],
      skus: sourceSku.map((item) => ({ sourceSkuId: item.skuId, imageUrl: item.imageUrl })),
    }, {
      main: { historyEntryId: 'history-main', items: generated },
    }, { mainImages: sourceMain, skuImages: sourceSku });

    expect(result.images).toHaveLength(5);
    expect(result.images.slice(0, 5)).toEqual(generated.map((item) => item.imageUrl));
    expect(result.images).not.toContain(sourceMain[0]);
    expect(result.skus.every((item) => item.imageUrl === '')).toBe(true);
  });

  it('adds only explicitly checked source images alongside generated images', () => {
    const result = applyCollectionProductGeneratedImagesToListingDraft({
      originalImageSelections: {
        main: { items: [{ sourceIndex: 1, sourceImageUrl: 'https://1688.example/source-2.jpg' }] },
      },
      skus: [],
    }, {
      main: { items: [{ sourceIndex: 0, imageUrl: 'https://oss.example/generated.png' }] },
    }, {
      mainImages: ['https://1688.example/source-1.jpg', 'https://1688.example/source-2.jpg', 'https://1688.example/source-3.jpg'],
    });

    expect(result.images).toEqual([
      'https://oss.example/generated.png',
      'https://1688.example/source-2.jpg',
    ]);
    expect(result.images).not.toContain('https://1688.example/source-1.jpg');
    expect(result.images).not.toContain('https://1688.example/source-3.jpg');
  });

  it('keeps SKU images tied to the exact generated or explicitly selected source SKU', () => {
    const result = applyCollectionProductGeneratedImagesToListingDraft({
      originalImageSelections: { sku: { items: [{ sourceIndex: 0, sourceSkuId: 'red', sourceImageUrl: 'https://1688.example/red.jpg' }] } },
      skus: [{ sourceSkuId: 'red' }, { sourceSkuId: 'blue' }],
    }, {
      sku: { items: [{ sourceIndex: 1, sourceSkuId: 'blue', imageUrl: 'https://oss.example/blue.png' }] },
    }, {
      skuImages: [
        { skuId: 'red', imageUrl: 'https://1688.example/red.jpg' },
        { skuId: 'blue', imageUrl: 'https://1688.example/blue.jpg' },
      ],
    });

    expect(result.images).toEqual(['https://oss.example/blue.png', 'https://1688.example/red.jpg']);
    expect(result.skus.map((item) => item.imageUrl)).toEqual([
      'https://1688.example/red.jpg',
      'https://oss.example/blue.png',
    ]);
  });

  it('uses a generated SKU image when one exists and shared generated main for other variants', () => {
    const result = applyCollectionProductGeneratedImagesToListingDraft({
      images: ['https://1688.example/main.jpg', 'https://1688.example/red.jpg', 'https://1688.example/blue.jpg'],
      skus: [
        { sourceSkuId: 'red', imageUrl: 'https://1688.example/red.jpg' },
        { sourceSkuId: 'blue', imageUrl: 'https://1688.example/blue.jpg' },
      ],
    }, {
      main: { historyEntryId: 'main', items: [{ sourceIndex: 0, imageUrl: 'https://oss.example/main.png' }] },
      sku: { historyEntryId: 'sku', items: [{ sourceIndex: 1, imageUrl: 'https://oss.example/blue.png' }] },
    }, {
      mainImages: ['https://1688.example/main.jpg'],
      skuImages: [
        { skuId: 'red', imageUrl: 'https://1688.example/red.jpg' },
        { skuId: 'blue', imageUrl: 'https://1688.example/blue.jpg' },
      ],
    });

    expect(result.images[0]).toBe('https://oss.example/main.png');
    expect(result.skus).toEqual([
      { sourceSkuId: 'red', imageUrl: '' },
      { sourceSkuId: 'blue', imageUrl: 'https://oss.example/blue.png' },
    ]);
  });
});
