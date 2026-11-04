import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const catalogMocks = vi.hoisted(() => ({
  loadCollectionListingWarehouses: vi.fn(),
}));

vi.mock('../services/collectionListingCatalogService.js', () => ({
  loadCollectionListingWarehouses: catalogMocks.loadCollectionListingWarehouses,
}));

import { useCollectionProductBatchStock } from './useCollectionProductBatchStock.js';

describe('useCollectionProductBatchStock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalogMocks.loadCollectionListingWarehouses.mockImplementation(async (shopId) => ([{
      rawId: `${shopId}-warehouse`,
      name: `${shopId} 仓`,
    }]));
  });

  it('loads every selected shop independently and saves each shop warehouse and stock on enabled SKUs', async () => {
    const onChangeSku = vi.fn();
    const { result } = renderHook(() => useCollectionProductBatchStock({
      shopId: 'shop-a',
      shopIds: ['shop-a', 'shop-b'],
      skus: [
        { sourceSkuId: 'enabled', enabled: true },
        { sourceSkuId: 'disabled', enabled: false },
      ],
      onChangeSku,
    }));
    await waitFor(() => expect(result.current.warehouseStatesByShopId).toMatchObject({
      'shop-a': { status: 'ready' },
      'shop-b': { status: 'ready' },
    }));
    expect(catalogMocks.loadCollectionListingWarehouses).toHaveBeenCalledWith(
      'shop-a', expect.objectContaining({ refresh: false, signal: expect.any(AbortSignal) }),
    );
    expect(catalogMocks.loadCollectionListingWarehouses).toHaveBeenCalledWith(
      'shop-b', expect.objectContaining({ refresh: false, signal: expect.any(AbortSignal) }),
    );

    let applied;
    act(() => {
      applied = result.current.applyBatchStock({
        shopInventories: [
          { shopId: 'shop-a', warehouseId: 'shop-a-warehouse', stock: 28 },
          { shopId: 'shop-b', warehouseId: 'shop-b-warehouse', stock: 35 },
        ],
      });
    });
    expect(applied).toEqual({ ok: true, appliedCount: 1, appliedShopCount: 2 });
    expect(onChangeSku).toHaveBeenCalledTimes(1);
    expect(onChangeSku).toHaveBeenCalledWith(0, {
      inventoryByShopId: {
        'shop-a': { warehouseId: 'shop-a-warehouse', stock: '28' },
        'shop-b': { warehouseId: 'shop-b-warehouse', stock: '35' },
      },
    });
  });

  it('refreshes only the requested shop warehouse list', async () => {
    const { result } = renderHook(() => useCollectionProductBatchStock({
      shopId: 'shop-a',
      shopIds: ['shop-a', 'shop-b'],
      skus: [{ sourceSkuId: 'sku-1', enabled: true }],
      onChangeSku: vi.fn(),
    }));
    await waitFor(() => expect(result.current.warehouseStatesByShopId['shop-b']?.status).toBe('ready'));
    await act(async () => {
      await result.current.reloadWarehouses('shop-b');
    });
    expect(catalogMocks.loadCollectionListingWarehouses).toHaveBeenLastCalledWith(
      'shop-b', expect.objectContaining({ refresh: true, signal: expect.any(AbortSignal) }),
    );
  });

  it('drops a removed shop warehouse response without overwriting remaining shop state', async () => {
    let resolveShopA;
    catalogMocks.loadCollectionListingWarehouses.mockImplementation((shopId) => {
      if (shopId === 'shop-a') return new Promise((resolve) => { resolveShopA = resolve; });
      return Promise.resolve([{ rawId: 'shop-b-warehouse', name: 'B 仓' }]);
    });
    const { result, rerender } = renderHook(({ shopIds }) => useCollectionProductBatchStock({
      shopId: 'shop-b',
      shopIds,
      skus: [{ sourceSkuId: 'sku-1', enabled: true }],
      onChangeSku: vi.fn(),
    }), { initialProps: { shopIds: ['shop-a', 'shop-b'] } });
    await waitFor(() => expect(catalogMocks.loadCollectionListingWarehouses).toHaveBeenCalledWith(
      'shop-a', expect.any(Object),
    ));
    rerender({ shopIds: ['shop-b'] });
    await waitFor(() => expect(result.current.warehousesByShopId['shop-b']).toEqual([
      { rawId: 'shop-b-warehouse', name: 'B 仓' },
    ]));
    await act(async () => {
      resolveShopA([{ rawId: 'shop-a-warehouse', name: 'A 仓' }]);
      await Promise.resolve();
    });
    expect(result.current.warehousesByShopId['shop-a']).toBeUndefined();
    expect(result.current.warehouseStatesByShopId['shop-b'].status).toBe('ready');
  });

  it('keeps an explicit empty selection empty and never falls back to the source shop', async () => {
    const { result } = renderHook(() => useCollectionProductBatchStock({
      shopId: 'shop-a',
      shopIds: [],
      skus: [{ sourceSkuId: 'sku-1', enabled: true }],
      onChangeSku: vi.fn(),
    }));

    await act(async () => { await Promise.resolve(); });
    expect(result.current.selectedShopIds).toEqual([]);
    expect(catalogMocks.loadCollectionListingWarehouses).not.toHaveBeenCalled();
    expect(result.current.applyBatchStock({ shopInventories: [] })).toEqual({
      ok: false,
      error: '请先选择要上架的 Ozon 店铺。',
    });
  });
});
