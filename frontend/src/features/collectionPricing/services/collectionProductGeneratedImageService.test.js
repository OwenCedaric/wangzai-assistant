import { beforeEach, describe, expect, it, vi } from 'vitest';

const assets = vi.hoisted(() => ({
  importImage: vi.fn(),
  promote: vi.fn(),
  previews: vi.fn(),
  wait: vi.fn(),
}));

vi.mock('../../products/services/productImageAssetService.js', () => ({
  importProductImage: assets.importImage,
  promoteProductImage: assets.promote,
  readProductImageAssetPreviews: assets.previews,
  waitForProductImagePersistenceTask: assets.wait,
}));

import {
  hydrateCollectionProductGeneratedImageSelections,
  persistCollectionProductGeneratedImageSelections,
} from './collectionProductGeneratedImageService.js';

describe('collection product generated image persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assets.wait.mockResolvedValue({ asset: { id: 'temporary-1', storageScope: 'temporary' } });
    assets.promote.mockResolvedValue({
      asset: {
        id: 'permanent-1',
        localUrl: '/api/product-images/preview/permanent-1?shopId=shop-a',
        previewUrl: 'https://oss.example/permanent-1.png',
        storageScope: 'permanent',
      },
    });
  });

  it('waits for pending persistence and promotes the selected slot before saving the draft', async () => {
    const result = await persistCollectionProductGeneratedImageSelections({
      main: {
        historyEntryId: 'batch-1',
        items: [{
          sourceIndex: 4,
          taskId: 'task-1',
          imageUrl: 'https://provider.example/generated.png',
          persistenceStatus: 'pending',
        }],
      },
    }, {
      shopId: 'shop-a',
      productId: '1688:product-a',
    });

    expect(assets.wait).toHaveBeenCalledWith('task-1', expect.objectContaining({ shopId: 'shop-a' }));
    expect(assets.promote).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-a',
      productId: '1688:product-a',
      assetId: 'temporary-1',
      storageScope: 'permanent',
    }), expect.any(Object));
    expect(result.selections.main.items[0]).toMatchObject({
      sourceIndex: 4,
      assetId: 'permanent-1',
      storageScope: 'permanent',
      persistenceStatus: 'completed',
      imageUrl: '/api/product-images/preview/permanent-1?shopId=shop-a',
    });
    expect(result.replacements.get('https://provider.example/generated.png'))
      .toBe('/api/product-images/preview/permanent-1?shopId=shop-a');
  });

  it('refreshes signed previews in one shop-scoped batch when the editor reopens', async () => {
    assets.previews.mockResolvedValue([{
      id: 'permanent-1',
      localUrl: '/api/product-images/preview/permanent-1?shopId=shop-a',
      previewUrl: 'https://oss.example/fresh-signed.png',
      thumbnailUrl: 'https://oss.example/fresh-thumbnail.webp',
      storageScope: 'permanent',
    }]);
    const selections = await hydrateCollectionProductGeneratedImageSelections({
      main: {
        historyEntryId: 'batch-1',
        items: [{ sourceIndex: 0, assetId: 'permanent-1', imageUrl: '/api/product-images/preview/permanent-1' }],
      },
    }, { shopId: 'shop-a' });

    expect(assets.previews).toHaveBeenCalledWith(['permanent-1'], expect.objectContaining({ shopId: 'shop-a' }));
    expect(selections.main.items[0]).toMatchObject({
      imageUrl: '/api/product-images/preview/permanent-1?shopId=shop-a',
      previewUrl: 'https://oss.example/fresh-signed.png',
      thumbnailUrl: 'https://oss.example/fresh-thumbnail.webp',
      storageScope: 'permanent',
    });
  });

  it('refreshes a saved image through its asset owner even when the product catalog shop changed', async () => {
    assets.previews.mockImplementation(async (_assetIds, options) => [{
      id: 'permanent-1',
      localUrl: `/api/product-images/preview/permanent-1?shopId=${options.shopId}`,
      previewUrl: 'https://oss.example/fresh-owner-signed.png',
      storageScope: 'permanent',
    }]);

    const selections = await hydrateCollectionProductGeneratedImageSelections({
      main: {
        historyEntryId: 'batch-owner',
        items: [{
          sourceIndex: 0,
          assetId: 'permanent-1',
          imageUrl: '/api/product-images/preview/permanent-1?shopId=shop-image-owner',
        }],
      },
    }, { shopId: 'shop-current-catalog' });

    expect(assets.previews).toHaveBeenCalledWith(
      ['permanent-1'],
      expect.objectContaining({ shopId: 'shop-image-owner' }),
    );
    expect(selections.main.items[0]).toMatchObject({
      assetShopId: 'shop-image-owner',
      previewUrl: 'https://oss.example/fresh-owner-signed.png',
    });
  });

  it('validates permanent assets through their owner shop when saving after a shop change', async () => {
    assets.previews.mockResolvedValue([{
      id: 'permanent-owner',
      localUrl: '/api/product-images/preview/permanent-owner?shopId=shop-image-owner',
      previewUrl: 'https://oss.example/permanent-owner.png',
      storageScope: 'permanent',
    }]);

    const result = await persistCollectionProductGeneratedImageSelections({
      main: {
        historyEntryId: 'batch-owner',
        items: [{
          sourceIndex: 0,
          assetId: 'permanent-owner',
          imageUrl: '/api/product-images/preview/permanent-owner?shopId=shop-image-owner',
          storageScope: 'permanent',
        }],
      },
    }, {
      shopId: 'shop-current-catalog',
      productId: '1688:product-owner',
    });

    expect(assets.previews).toHaveBeenCalledWith(
      ['permanent-owner'],
      expect.objectContaining({ shopId: 'shop-image-owner' }),
    );
    expect(assets.promote).not.toHaveBeenCalled();
    expect(result.selections.main.items[0]).toMatchObject({
      assetShopId: 'shop-image-owner',
      assetId: 'permanent-owner',
      storageScope: 'permanent',
    });
  });

  it('recovers an older unbacked V2 image id from its provider URL when saving', async () => {
    assets.previews.mockResolvedValue([]);
    assets.importImage.mockResolvedValue({
      asset: {
        id: 'permanent-recovered',
        localUrl: '/api/product-images/preview/permanent-recovered?shopId=shop-a',
        previewUrl: 'https://oss.example/permanent-recovered.png',
        storageScope: 'permanent',
      },
    });

    const result = await persistCollectionProductGeneratedImageSelections({
      main: {
        historyEntryId: 'batch-v2',
        assetShopId: 'shop-a',
        items: [{
          sourceIndex: 3,
          assetId: 'v2-image-unbacked',
          imageUrl: 'https://images.example.invalid/generated.png',
          previewUrl: 'https://images.example.invalid/generated.png',
          storageScope: 'temporary',
          persistenceStatus: 'completed',
        }],
      },
    }, {
      shopId: 'shop-a',
      productId: '1688:product-a',
    });

    expect(assets.importImage).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-a',
      productId: '1688:product-a',
      sourceUrl: 'https://images.example.invalid/generated.png',
      storageScope: 'permanent',
    }), expect.any(Object));
    expect(assets.promote).not.toHaveBeenCalled();
    expect(result.selections.main.items[0]).toMatchObject({
      sourceIndex: 3,
      assetId: 'permanent-recovered',
      storageScope: 'permanent',
    });
  });
});
