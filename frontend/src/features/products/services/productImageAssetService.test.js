import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestLocalApi: vi.fn() }));

vi.mock('../../../api/localApiClient.js', () => mocks);

import {
  clearProductImageAssetPreviewCache,
  prepareProductImagesForOzon,
  readProductImageAssetPreview,
  readProductImageAssetPreviews,
  waitForProductImagePersistenceTask,
} from './productImageAssetService.js';

describe('product image asset preparation', () => {
  beforeEach(() => {
    mocks.requestLocalApi.mockReset();
    clearProductImageAssetPreviewCache();
  });

  it('keeps remote collected or Ozon images and uploads local images through local-api', async () => {
    mocks.requestLocalApi.mockResolvedValue({ asset: { ozonUrl: 'https://img.example.com/local.png' } });
    const result = await prepareProductImagesForOzon([
      'https://cdn.ozon.ru/original.jpg',
      'data:image/png;base64,cG5n',
    ], { shopId: 'shop-a', productId: '100', offerId: 'offer-100' });
    expect(result).toEqual([
      'https://cdn.ozon.ru/original.jpg',
      'https://img.example.com/local.png',
    ]);
    expect(mocks.requestLocalApi).toHaveBeenCalledWith('/api/product-images/import', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        sourceType: 'product-editor-local', storageScope: 'permanent', shopId: 'shop-a',
        productId: '100', offerId: 'offer-100',
      }),
    }));
  });

  it('promotes several local preview assets and preserves unique Ozon URLs', async () => {
    Array.from({ length: 8 }, (_, index) => index).forEach((index) => {
      mocks.requestLocalApi.mockResolvedValueOnce({ asset: { ozonUrl: `https://img.example.com/pimg_${index}.png` } });
    });
    const previews = Array.from({ length: 8 }, (_, index) => `/api/product-images/preview/pimg_${index}?shopId=shop-a`);
    const result = await prepareProductImagesForOzon(previews, { shopId: 'shop-a', productId: '200' });
    expect(result).toHaveLength(8);
    expect(mocks.requestLocalApi).toHaveBeenCalledTimes(8);
    expect(mocks.requestLocalApi).toHaveBeenNthCalledWith(1, '/api/product-images/promote', expect.objectContaining({
      body: expect.objectContaining({ assetId: 'pimg_0', shopId: 'shop-a', storageScope: 'permanent' }),
    }));
  });

  it('blocks Ozon submission when local storage has no public server URL', async () => {
    mocks.requestLocalApi.mockResolvedValue({ asset: { ozonReady: false, ozonUrl: '' } });
    await expect(prepareProductImagesForOzon(['data:image/jpeg;base64,anBlZw==']))
      .rejects.toThrow('服务器图片存储尚未就绪');
  });

  it('polls the exact shop-scoped persistence task and returns its stored asset', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      task: {
        status: 'completed',
        result: { asset: { id: 'pimg-ready', previewUrl: 'https://oss.example/ready.png' } },
      },
    });

    const result = await waitForProductImagePersistenceTask('task-ready', { shopId: 'shop-a' });

    expect(result.asset.id).toBe('pimg-ready');
    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/product-images/tasks/task-ready?shopId=shop-a',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('reads a fresh private OSS preview URL through the authenticated desktop bridge', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      ok: true,
      asset: { id: 'pimg-ready', previewUrl: 'https://private.example/signed.png' },
    });

    const asset = await readProductImageAssetPreview('pimg-ready', { shopId: 'shop-a' });

    expect(asset.previewUrl).toBe('https://private.example/signed.png');
    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/product-images/assets/pimg-ready/preview?shopId=shop-a',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('reads history previews in one shop-scoped batch and reuses the in-memory hot cache', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      ok: true,
      assets: [
        { id: 'pimg-1', previewUrl: 'https://private.example/1.png', previewUrlExpiresInSeconds: 600 },
        { id: 'pimg-2', previewUrl: 'https://private.example/2.png', previewUrlExpiresInSeconds: 600 },
      ],
      missingAssetIds: [],
    });

    const first = await readProductImageAssetPreviews(['pimg-1', 'pimg-2', 'pimg-1'], { shopId: 'shop-a' });
    const second = await readProductImageAssetPreviews(['pimg-2', 'pimg-1'], { shopId: 'shop-a' });

    expect(first.map((asset) => asset.id)).toEqual(['pimg-1', 'pimg-2']);
    expect(second.map((asset) => asset.id)).toEqual(['pimg-2', 'pimg-1']);
    expect(mocks.requestLocalApi).toHaveBeenCalledTimes(1);
    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/product-images/assets/previews',
      expect.objectContaining({
        method: 'POST',
        body: { shopId: 'shop-a', assetIds: ['pimg-1', 'pimg-2'] },
      }),
    );
  });
});
