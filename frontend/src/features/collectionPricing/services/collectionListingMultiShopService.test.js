import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  importProductImage,
  promoteProductImage,
  readProductImageAssetPreviews,
} from '../../products/services/productImageAssetService.js';
import { loadCollectionListingWarehouses } from './collectionListingCatalogService.js';
import {
  canResumeCollectionListingReadBack,
  confirmCollectionListing,
  continueCollectionListingReadBack,
  previewCollectionListing,
} from './collectionListingService.js';
import {
  canResumeCollectionListingsReadBack,
  confirmCollectionListingsForShops,
  continueCollectionListingsReadBackForShops,
  normalizeCollectionListingTargetShopIds,
  prepareCollectionListingTargetDraft,
  previewCollectionListingsForShops,
} from './collectionListingMultiShopService.js';

vi.mock('../../products/services/productImageAssetService.js', () => ({
  getLocalProductImageAssetId: vi.fn((value) => String(value || '').match(/\/preview\/([^?]+)/u)?.[1] || ''),
  importProductImage: vi.fn(),
  isLocalProductImage: vi.fn((value) => String(value || '').startsWith('data:image/')),
  promoteProductImage: vi.fn(),
  readProductImageAssetPreviews: vi.fn(),
}));

vi.mock('./collectionListingCatalogService.js', () => ({
  loadCollectionListingWarehouses: vi.fn(),
}));

vi.mock('./collectionListingService.js', () => ({
  canResumeCollectionListingReadBack: vi.fn(),
  confirmCollectionListing: vi.fn(),
  continueCollectionListingReadBack: vi.fn(),
  previewCollectionListing: vi.fn(),
  releaseCollectionListingPreview: vi.fn().mockResolvedValue({ ok: true, released: 1 }),
}));

const shops = [
  { id: 'shop-a', name: '店铺 A' },
  { id: 'shop-b', name: '店铺 B' },
];

const baseDraft = {
  shopId: 'shop-a',
  title: '商品标题',
  images: ['https://img.example/main.jpg'],
  imagesText: 'https://img.example/main.jpg',
  skus: [{
    sourceSkuId: 'sku-1', offerId: 'offer-1', stock: '100', warehouseId: 'warehouse-a',
    inventoryByShopId: {
      'shop-a': { stock: '100', warehouseId: 'warehouse-a' },
      'shop-b': { stock: '35', warehouseId: 'warehouse-b' },
    },
    imageUrl: 'https://img.example/sku.jpg', priceCny: '100', oldPriceCny: '130',
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  loadCollectionListingWarehouses.mockImplementation(async (shopId) => ([{
    rawId: shopId === 'shop-a' ? 'warehouse-a' : 'warehouse-b',
    name: shopId === 'shop-a' ? 'A 仓' : 'B 仓',
    isDefault: true,
  }]));
  readProductImageAssetPreviews.mockResolvedValue([]);
  promoteProductImage.mockResolvedValue({
    provenanceProtected: true,
    asset: { id: 'permanent-watermarked', ozonUrl: 'https://oss.example/target.jpg' },
  });
  importProductImage.mockImplementation(async () => ({
    asset: { id: `temporary-source-${importProductImage.mock.calls.length}`, storageScope: 'temporary' },
  }));
  canResumeCollectionListingReadBack.mockImplementation((result) => Boolean(result?.resumable));
});

describe('collection listing multi-shop service', () => {
  it('keeps only available unique target shops', () => {
    expect(normalizeCollectionListingTargetShopIds(['shop-b', 'missing', 'shop-b', 'shop-a'], shops))
      .toEqual(['shop-b', 'shop-a']);
  });

  it('maps stock to the target shop warehouse and copies a private source asset into that shop', async () => {
    readProductImageAssetPreviews.mockResolvedValue([{
      id: 'asset-one',
      previewUrl: 'https://source-shop.example/signed.jpg',
    }]);
    const target = await prepareCollectionListingTargetDraft({
      baseDraft: {
        ...baseDraft,
        images: ['/api/product-images/preview/asset-one?shopId=shop-a'],
        imagesText: '/api/product-images/preview/asset-one?shopId=shop-a',
      },
      sourceShopId: 'shop-a',
      targetShopId: 'shop-b',
      productId: 'product-1',
    });

    expect(target.shopId).toBe('shop-b');
    expect(target.skus[0]).toMatchObject({ stock: '35', warehouseId: 'warehouse-b' });
    expect(target.images).toEqual(['https://oss.example/target.jpg']);
    expect(target.imagesText).toBe('https://oss.example/target.jpg');
    expect(importProductImage).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-b',
      sourceUrl: 'https://source-shop.example/signed.jpg',
      storageScope: 'temporary',
    }), expect.any(Object));
    expect(promoteProductImage).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-b',
      assetId: expect.stringMatching(/^temporary-source-/u),
      storageScope: 'permanent',
    }), expect.any(Object));
  });

  it('never copies the source shop stock or warehouse into another shop without that shop configuration', async () => {
    const target = await prepareCollectionListingTargetDraft({
      baseDraft: {
        ...baseDraft,
        skus: [{
          ...baseDraft.skus[0],
          inventoryByShopId: {
            'shop-a': { stock: '100', warehouseId: 'warehouse-a' },
          },
        }],
      },
      sourceShopId: 'shop-a',
      targetShopId: 'shop-b',
      productId: 'product-1',
    });

    expect(target.skus[0]).toMatchObject({ stock: '', warehouseId: '' });
    expect(target.targetWarehouseId).toBe('');
  });

  it('previews and submits each shop independently so one failure does not block the other', async () => {
    previewCollectionListing.mockImplementation(async (draft) => ({
      ok: true,
      operationId: `preview-${draft.shopId}`,
      draftSnapshot: draft,
      products: [{ offer_id: 'offer-1' }],
      prices: [{ offer_id: 'offer-1', price: '100' }],
      stocks: [{ offer_id: 'offer-1', stock: 100 }],
      transport: { chunkCount: 2, totalBytes: 500 },
    }));
    confirmCollectionListing.mockImplementation(async (preview) => (
      preview.draftSnapshot.shopId === 'shop-a'
        ? { completed: true, status: 'completed', message: '完成', results: [{ kind: 'info', label: '商品卡', readBackStatus: 'merged' }] }
        : { completed: false, status: 'failed', message: '今日额度已用完', results: [{ kind: 'info', label: '商品卡', readBackStatus: 'failed' }] }
    ));

    const preview = await previewCollectionListingsForShops({
      baseDraft,
      sourceShopId: 'shop-a',
      targetShopIds: ['shop-a', 'shop-b'],
      shops,
      savedDraftsByShop: {},
      productId: 'product-1',
    });
    expect(preview.readyCount).toBe(2);
    expect(preview.shopPreviews.map((item) => item.warehouseId)).toEqual(['warehouse-a', 'warehouse-b']);
    expect(previewCollectionListing.mock.calls.map(([draft]) => draft.skus[0].stock)).toEqual(['100', '35']);

    const result = await confirmCollectionListingsForShops(preview);
    expect(confirmCollectionListing).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'partial', completedCount: 1, failedCount: 1 });
    expect(result.shopResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ shopId: 'shop-a', completed: true }),
      expect.objectContaining({ shopId: 'shop-b', completed: false, error: '今日额度已用完' }),
    ]));
  });

  it('keeps a valid shop preview when another selected shop has no usable warehouse', async () => {
    loadCollectionListingWarehouses.mockImplementation(async (shopId) => (
      shopId === 'shop-a' ? [{ rawId: 'warehouse-a', name: 'A 仓', isDefault: true }] : []
    ));
    previewCollectionListing.mockImplementation(async (draft) => ({
      ok: true,
      operationId: `preview-${draft.shopId}`,
      draftSnapshot: draft,
      products: [{ offer_id: 'offer-1' }],
      prices: [],
      stocks: [],
      transport: { chunkCount: 1, totalBytes: 100 },
    }));

    const preview = await previewCollectionListingsForShops({
      baseDraft,
      sourceShopId: 'shop-a',
      targetShopIds: ['shop-a', 'shop-b'],
      shops,
      productId: 'product-1',
    });

    expect(preview).toMatchObject({ readyCount: 1, failedCount: 1 });
    expect(preview.shopPreviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ shopId: 'shop-a', status: 'ready' }),
      expect.objectContaining({ shopId: 'shop-b', status: 'failed', error: expect.stringContaining('仓库已经失效') }),
    ]));
    expect(previewCollectionListing).toHaveBeenCalledTimes(1);
  });

  it('continues only the pending shop readback and preserves already completed shops', async () => {
    const preview = {
      multiShop: true,
      operationId: 'multi-resume',
      selectedShopIds: ['shop-a', 'shop-b'],
      shopPreviews: [
        { shopId: 'shop-a', shopLabel: '店铺 A', status: 'ready', preview: { operationId: 'preview-a' } },
        { shopId: 'shop-b', shopLabel: '店铺 B', status: 'ready', preview: { operationId: 'preview-b' } },
      ],
    };
    const priorResult = {
      shopResults: [
        { shopId: 'shop-a', shopLabel: '店铺 A', completed: true, status: 'completed', result: { completed: true } },
        { shopId: 'shop-b', shopLabel: '店铺 B', completed: false, status: 'pending_readback', result: { resumable: true } },
      ],
    };
    continueCollectionListingReadBack.mockResolvedValue({
      completed: true,
      status: 'completed',
      message: '完成',
      results: [{ kind: 'info', label: '商品卡', readBackStatus: 'merged' }],
    });

    expect(canResumeCollectionListingsReadBack(priorResult)).toBe(true);
    const result = await continueCollectionListingsReadBackForShops(preview, priorResult);

    expect(continueCollectionListingReadBack).toHaveBeenCalledTimes(1);
    expect(continueCollectionListingReadBack).toHaveBeenCalledWith(
      preview.shopPreviews[1].preview,
      priorResult.shopResults[1].result,
      expect.any(Object),
    );
    expect(result).toMatchObject({ completed: true, completedCount: 2, failedCount: 0 });
  });
});
