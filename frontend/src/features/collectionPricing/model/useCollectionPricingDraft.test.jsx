import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  publishCollectionBrowserCapture,
  resetCollectionBrowserCaptureInboxForTests,
} from '../services/collectionBrowserCaptureInbox.js';
import {
  loadCollectionPricingDraft,
  saveCollectionPricingDraft,
} from '../services/collectionPricingDraftStore.js';
import { useCollectionPricingDraft } from './useCollectionPricingDraft.js';

const productCache = vi.hoisted(() => ({
  read: vi.fn(async () => ({ ok: true, rows: [] })),
}));

vi.mock('../../../services/productListSyncClient.js', () => ({
  readProductListCache: productCache.read,
}));

vi.mock('../services/collectionPricingDraftStore.js', () => ({
  COLLECTION_PRICING_DRAFT_LIMIT: 500,
  loadCollectionPricingDraft: vi.fn(async () => []),
  saveCollectionPricingDraft: vi.fn(async () => ({})),
}));

function capture(id, title = `商品 ${id}`) {
  return {
    platform: '1688',
    pageType: 'product',
    sourceUrl: `https://detail.1688.com/offer/${id}.html`,
    sourceProductId: id,
    productTitle: title,
    purchasePrice: 21,
    currency: 'CNY',
    mainImages: ['https://img.example/product/main.jpg'],
    skus: [{ id: `${id}-default`, name: '默认款', price: 21 }],
  };
}

beforeEach(() => {
  loadCollectionPricingDraft.mockReset().mockImplementation(async (scope) => (
    scope === 'user-b' ? [capture('200', '用户 B 商品')] : []
  ));
  saveCollectionPricingDraft.mockReset().mockResolvedValue({});
  productCache.read.mockReset().mockResolvedValue({ ok: true, rows: [] });
  resetCollectionBrowserCaptureInboxForTests();
});

describe('useCollectionPricingDraft collection-only state', () => {
  it('stores a browser capture only in the current user collection list', async () => {
    const { result } = renderHook(() => useCollectionPricingDraft({ ownerScopeKey: 'user-a' }));
    await waitFor(() => expect(loadCollectionPricingDraft).toHaveBeenCalledWith('user-a'));
    act(() => publishCollectionBrowserCapture(capture('321', '只进入列表的商品')));

    await waitFor(() => expect(result.current.collectionItems).toHaveLength(1));
    expect(result.current.collectionItems[0].title).toBe('只进入列表的商品');
    expect(saveCollectionPricingDraft).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: '1688:321' })]),
      'user-a',
    );
    expect(result.current).not.toHaveProperty('pricingDraft');
    expect(result.current).not.toHaveProperty('listingDraft');
  });

  it('clears the visible list and loads the next isolated scope when the user changes', async () => {
    const { result, rerender } = renderHook(
      ({ ownerScopeKey }) => useCollectionPricingDraft({ ownerScopeKey }),
      { initialProps: { ownerScopeKey: 'user-a' } },
    );
    act(() => publishCollectionBrowserCapture(capture('100', '用户 A 商品')));
    await waitFor(() => expect(result.current.collectionItems[0]?.title).toBe('用户 A 商品'));

    rerender({ ownerScopeKey: 'user-b' });
    await waitFor(() => expect(result.current.collectionItems[0]?.title).toBe('用户 B 商品'));
    expect(result.current.collectionItems).toHaveLength(1);
    expect(loadCollectionPricingDraft).toHaveBeenLastCalledWith('user-b');
  });

  it('persists an explicit empty list for the current user when cleared', async () => {
    const { result } = renderHook(() => useCollectionPricingDraft({ ownerScopeKey: 'user-a' }));
    act(() => publishCollectionBrowserCapture(capture('100')));
    await waitFor(() => expect(result.current.collectionItems).toHaveLength(1));
    act(() => result.current.clearDraft());
    expect(result.current.collectionItems).toEqual([]);
    expect(saveCollectionPricingDraft).toHaveBeenLastCalledWith([], 'user-a');
  });

  it('returns the real disk persistence result for the editor save button', async () => {
    const { result } = renderHook(() => useCollectionPricingDraft({ ownerScopeKey: 'user-a' }));
    act(() => publishCollectionBrowserCapture(capture('save-result')));
    await waitFor(() => expect(result.current.collectionItems).toHaveLength(1));

    let saved;
    await act(async () => {
      saved = await result.current.editCollectionItem('1688:save-result', { title: '真实保存结果' });
    });
    expect(saved).toBe(true);
    expect(saveCollectionPricingDraft).toHaveBeenLastCalledWith(
      [expect.objectContaining({ title: '真实保存结果' })],
      'user-a',
    );

    saveCollectionPricingDraft.mockRejectedValueOnce(new Error('disk failed'));
    await act(async () => {
      saved = await result.current.editCollectionItem('1688:save-result', { title: '保存失败结果' });
    });
    expect(saved).toBe(false);
    expect(result.current.collectionPersistenceError).toMatch(/保存失败/u);
  });

  it('backfills a legacy uploaded shop from exact saved offer IDs in the Ozon product cache', async () => {
    loadCollectionPricingDraft.mockResolvedValueOnce([{
      ...capture('old-upload', '历史已上传商品'),
      ozonListingDrafts: {
        'shop-1': {
          shopId: 'shop-1',
          updatedAt: '2026-08-09T12:00:00.000Z',
          skus: [
            { sourceSkuId: 'old-upload-default', offerId: 'WZ-9001', enabled: true },
            { sourceSkuId: 'old-upload-blue', offerId: 'WZ-9002', enabled: true },
          ],
        },
      },
      skus: [
        { id: 'old-upload-default', name: '默认款', price: 21 },
        { id: 'old-upload-blue', name: '蓝色', price: 21 },
      ],
    }]);
    productCache.read.mockResolvedValue({
      ok: true,
      rows: [{ offerId: 'WZ-9001' }, { offerId: 'WZ-9002' }],
    });

    const { result } = renderHook(() => useCollectionPricingDraft({
      ownerScopeKey: 'user-a',
      shops: [{ id: 'shop-1', name: '测试店铺' }],
    }));

    await waitFor(() => expect(result.current.collectionItems[0]?.ozonPublication?.shops?.[0]).toMatchObject({
      shopId: 'shop-1',
      shopLabel: '测试店铺',
      uploaded: true,
      readBackVerified: true,
    }));
    expect(productCache.read).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-1',
      offerIds: expect.stringContaining('WZ-9001'),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(productCache.read.mock.calls[0][0].offerIds).toContain('WZ-9002');
    await waitFor(() => expect(saveCollectionPricingDraft).toHaveBeenLastCalledWith([
      expect.objectContaining({
        ozonPublication: expect.objectContaining({ status: 'completed' }),
      }),
    ], 'user-a'));
  });
});
