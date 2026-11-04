import { describe, expect, it } from 'vitest';

import {
  COLLECTION_PRODUCT_IMAGE_HISTORY_RETENTION_MS,
  countCollectionProductImageHistoryImages,
  isCollectionProductGeneratedImageSelected,
  mergeCollectionProductGeneratedImageSelection,
  normalizeCollectionProductImageHistory,
  normalizeCollectionProductGeneratedImageSelections,
  removeCollectionProductGeneratedImageSelection,
  resolveCollectionProductImageHistoryUrl,
  upsertCollectionProductImageHistory,
  withCollectionProductGeneratedImageItemSelection,
} from './collectionProductImageHistory.js';

const NOW_MS = Date.parse('2026-08-07T12:00:00.000Z');

function entry(overrides = {}) {
  return {
    id: 'batch-1',
    shopId: 'shop-a',
    productKey: '1688:907805856885',
    sourceUrl: 'https://detail.1688.com/offer/907805856885.html',
    createdAt: new Date(NOW_MS - 60_000).toISOString(),
    items: [{ sourceIndex: 0, imageUrl: 'https://provider.example/one.png', persistenceStatus: 'pending' }],
    ...overrides,
  };
}

describe('collection product image history', () => {
  it('keeps only the current three-day image history and counts images instead of batches', () => {
    const normalized = normalizeCollectionProductImageHistory([
      entry(),
      entry({
        id: 'batch-2',
        createdAt: new Date(NOW_MS - COLLECTION_PRODUCT_IMAGE_HISTORY_RETENTION_MS - 1).toISOString(),
        items: [{ sourceIndex: 0, imageUrl: 'https://provider.example/expired.png' }],
      }),
      entry({
        id: 'batch-3',
        items: [
          { sourceIndex: 0, assetId: 'asset-a', persistenceStatus: 'completed' },
          { sourceIndex: 1, assetId: 'asset-b', persistenceStatus: 'completed' },
        ],
      }),
    ], { nowMs: NOW_MS });

    expect(normalized.map((item) => item.id)).toEqual(['batch-1', 'batch-3']);
    expect(countCollectionProductImageHistoryImages(normalized, { nowMs: NOW_MS })).toBe(3);
  });

  it('upgrades the same generated slot from provider preview to the persisted shop asset', () => {
    const pending = upsertCollectionProductImageHistory([], entry(), { nowMs: NOW_MS });
    const stored = upsertCollectionProductImageHistory(pending, entry({
      items: [{
        sourceIndex: 0,
        assetId: 'asset-stored',
        imageUrl: 'https://oss.example/stored.png',
        persistenceStatus: 'completed',
      }],
    }), { nowMs: NOW_MS });

    expect(stored).toHaveLength(1);
    expect(stored[0].items).toEqual([expect.objectContaining({
      assetId: 'asset-stored',
      persistenceStatus: 'completed',
    })]);
    expect(resolveCollectionProductImageHistoryUrl(stored[0].items[0], 'shop-a'))
      .toBe('/api/product-images/preview/asset-stored?shopId=shop-a');
  });

  it('removes one generated slot while leaving the remaining slots and history data intact', () => {
    const selections = normalizeCollectionProductGeneratedImageSelections({
      main: {
        historyEntryId: 'batch-1',
        items: [
          { sourceIndex: 0, assetId: 'asset-a', imageUrl: 'https://oss.example/a.png' },
          { sourceIndex: 1, assetId: 'asset-b', imageUrl: 'https://oss.example/b.png' },
        ],
      },
    });
    const next = removeCollectionProductGeneratedImageSelection(selections, {
      group: 'main', sourceIndex: 0, assetId: 'asset-a',
    });
    expect(next.main.items).toHaveLength(1);
    expect(next.main.items[0]).toMatchObject({ sourceIndex: 1, assetId: 'asset-b' });
    expect(removeCollectionProductGeneratedImageSelection(next, { group: 'main' })).toEqual(next);
  });

  it('retains source SKU identity when normalizing generated history', () => {
    const normalized = normalizeCollectionProductGeneratedImageSelections({
      sku: { items: [{ sourceIndex: 2, sourceSkuId: 'sku-blue', imageUrl: 'https://oss.example/blue.png' }] },
    });
    expect(normalized.sku.items[0]).toMatchObject({ sourceIndex: 2, sourceSkuId: 'sku-blue' });
  });

  it('keeps the private image owner shop separate from the current upload shop', () => {
    const normalized = normalizeCollectionProductGeneratedImageSelections({
      main: {
        items: [{
          sourceIndex: 0,
          assetId: 'asset-private',
          imageUrl: '/api/product-images/preview/asset-private?shopId=shop-image-owner',
        }],
      },
    });

    expect(normalized.main).toMatchObject({
      assetShopId: 'shop-image-owner',
      items: [expect.objectContaining({ assetShopId: 'shop-image-owner' })],
    });
  });

  it('toggles one generated image in the upload list without deleting the generated result', () => {
    const generated = { sourceIndex: 0, assetId: 'asset-a', imageUrl: 'https://oss.example/a.png' };
    const selected = withCollectionProductGeneratedImageItemSelection({}, {
      group: 'main', ...generated, selected: true,
    });
    expect(isCollectionProductGeneratedImageSelected(selected, { group: 'main', sourceIndex: 0 })).toBe(true);

    const unselected = withCollectionProductGeneratedImageItemSelection(selected, {
      group: 'main', ...generated, selected: false,
    });
    expect(isCollectionProductGeneratedImageSelected(unselected, { group: 'main', sourceIndex: 0 })).toBe(false);
  });

  it('replaces only regenerated source positions and preserves other confirmed upload images', () => {
    const current = {
      main: {
        historyEntryId: 'old-batch',
        items: [
          { sourceIndex: 0, assetId: 'asset-old-a', imageUrl: 'https://oss.example/old-a.png' },
          { sourceIndex: 1, assetId: 'asset-old-b', imageUrl: 'https://oss.example/old-b.png' },
        ],
      },
    };
    const next = mergeCollectionProductGeneratedImageSelection(current, entry({
      id: 'regenerated-batch',
      items: [{ sourceIndex: 1, assetId: 'asset-new-b', imageUrl: 'https://oss.example/new-b.png' }],
    }));

    expect(next.main.items).toEqual([
      expect.objectContaining({ sourceIndex: 0, assetId: 'asset-old-a' }),
      expect.objectContaining({ sourceIndex: 1, assetId: 'asset-new-b' }),
    ]);
  });

  it('removes stale images from every requested position when a new batch only partly succeeds', () => {
    const current = {
      main: {
        historyEntryId: 'old-batch',
        items: [
          { sourceIndex: 0, assetId: 'asset-old-a', imageUrl: 'https://oss.example/old-a.png' },
          { sourceIndex: 1, assetId: 'asset-old-b', imageUrl: 'https://oss.example/old-b.png' },
          { sourceIndex: 2, assetId: 'asset-old-c', imageUrl: 'https://oss.example/old-c.png' },
        ],
      },
    };
    const next = mergeCollectionProductGeneratedImageSelection(current, entry({
      id: 'new-batch',
      replaceSourceIndexes: [0, 1],
      items: [{ sourceIndex: 0, assetId: 'asset-new-a', imageUrl: 'https://oss.example/new-a.png' }],
    }));

    expect(next.main.items).toEqual([
      expect.objectContaining({ sourceIndex: 0, assetId: 'asset-new-a' }),
      expect.objectContaining({ sourceIndex: 2, assetId: 'asset-old-c' }),
    ]);
  });

  it('clears the requested stale slot when the replacement batch has no successful image', () => {
    const current = {
      main: {
        historyEntryId: 'old-batch',
        items: [{ sourceIndex: 1, assetId: 'asset-old-b', imageUrl: 'https://oss.example/old-b.png' }],
      },
    };
    const next = mergeCollectionProductGeneratedImageSelection(current, entry({
      id: 'failed-batch',
      replaceSourceIndexes: [1],
      items: [{ sourceIndex: 1, status: 'error', message: '生成失败' }],
    }));

    expect(next.main).toBeUndefined();
  });
});
