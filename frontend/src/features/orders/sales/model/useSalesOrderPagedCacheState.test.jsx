import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  clearSalesOrderPagedMemoryCache: vi.fn(),
  invalidateSalesOrderPagedMemoryCache: vi.fn(),
  readSalesOrderPagedCache: vi.fn(),
  resolveSalesOrderShopId: vi.fn((_shops, shop) => shop === 'all' ? '' : shop),
}));

const syncMocks = vi.hoisted(() => ({
  getJobStatus: vi.fn(),
  startDomainRefresh: vi.fn(),
}));

vi.mock('../../../../services/salesOrderPagedCacheClient.js', () => cacheMocks);
vi.mock('../../../../services/ozonSyncClient.js', () => syncMocks);

import { useSalesOrderPagedCacheState } from './useSalesOrderPagedCacheState.jsx';

const shops = [{ id: 'shop-1', clientId: 'client-1', apiKey: 'secret', shopAlias: '一店' }];
const timeScope = { cachePart: 'range', since: '', to: '' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSalesOrderPagedCacheState', () => {
  it('keeps the last successful page stale when a single-shop read fails', async () => {
    cacheMocks.readSalesOrderPagedCache
      .mockResolvedValueOnce({
        rows: [{ shopId: 'shop-1', posting: 'ORDER-1' }],
        total: 1,
        source: 'sqlite',
        summary: { total: 1, salesStatusCounts: { all: 1 } },
      })
      .mockRejectedValueOnce(Object.assign(new Error('单店读取失败'), { code: 'LOCAL_API_READ_FAILED' }));

    const { result, rerender } = renderHook(
      ({ shop }) => useSalesOrderPagedCacheState({ shops, timeScope, shop, isActive: true }),
      { initialProps: { shop: 'all' } },
    );
    await waitFor(() => expect(result.current.data?.fetchedAt).toBeTruthy());
    expect(result.current.data.rows).toHaveLength(1);

    act(() => rerender({ shop: 'shop-1' }));
    await waitFor(() => expect(result.current.error?.message).toBe('单店读取失败'));
    expect(result.current.stale).toBe(true);
    expect(result.current.data.rows).toEqual([{ shopId: 'shop-1', posting: 'ORDER-1' }]);
  });

  it('ignores an older response after the user switches stores quickly', async () => {
    let resolveOld;
    cacheMocks.readSalesOrderPagedCache.mockImplementation(({ shop }) => {
      if (shop === 'shop-1') return new Promise((resolve) => { resolveOld = resolve; });
      return Promise.resolve({
        rows: [{ shopId: 'shop-2', posting: 'ORDER-2' }],
        total: 1,
        source: 'sqlite',
        summary: { total: 1, salesStatusCounts: { all: 1 } },
      });
    });
    const allResult = {
      rows: [], total: 0, source: 'sqlite', summary: { total: 0, salesStatusCounts: { all: 0 } },
    };
    cacheMocks.readSalesOrderPagedCache.mockResolvedValueOnce(allResult);

    const { result, rerender } = renderHook(
      ({ shop }) => useSalesOrderPagedCacheState({ shops, timeScope, shop, isActive: true }),
      { initialProps: { shop: 'all' } },
    );
    await waitFor(() => expect(result.current.data?.fetchedAt).toBeTruthy());
    act(() => rerender({ shop: 'shop-1' }));
    await waitFor(() => expect(cacheMocks.readSalesOrderPagedCache).toHaveBeenCalledTimes(2));
    act(() => rerender({ shop: 'shop-2' }));
    await waitFor(() => expect(result.current.data.rows[0]?.shopId).toBe('shop-2'));
    await act(async () => {
      resolveOld({
        rows: [{ shopId: 'shop-1', posting: 'ORDER-1' }],
        total: 1,
        source: 'sqlite',
        summary: { total: 1, salesStatusCounts: { all: 1 } },
      });
      await Promise.resolve();
    });
    expect(result.current.data.rows[0]?.shopId).toBe('shop-2');
  });

  it('refreshes through the current time and then bypasses the local-api hot cache', async () => {
    const staleTo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const staleSince = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const staleScope = {
      page: 'sales-orders',
      filterScope: 'all',
      version: 'time-v1',
      defaultDays: 90,
      hasExplicitStartDate: false,
      hasExplicitEndDate: false,
      cachePart: 'sales-orders:range:stale',
      since: staleSince,
      to: staleTo,
    };
    cacheMocks.readSalesOrderPagedCache.mockResolvedValue({
      rows: [], total: 0, source: 'sqlite', summary: { total: 0, salesStatusCounts: { all: 0 } },
    });
    syncMocks.startDomainRefresh.mockImplementation((_domain, input) =>
      Promise.resolve({ jobId: `job-${input.endpointKey}` })
    );
    syncMocks.getJobStatus.mockResolvedValue({ job: { status: 'success' } });

    const { result } = renderHook(() =>
      useSalesOrderPagedCacheState({ shops, timeScope: staleScope, shop: 'shop-1', isActive: true })
    );
    await waitFor(() => expect(cacheMocks.readSalesOrderPagedCache).toHaveBeenCalled());

    await act(async () => {
      await result.current.refresh();
    });

    expect(syncMocks.startDomainRefresh).toHaveBeenCalledTimes(3);
    const submittedRange = syncMocks.startDomainRefresh.mock.calls[0][1].params.filter;
    expect(new Date(submittedRange.to).getTime()).toBeGreaterThan(new Date(staleTo).getTime());
    expect(cacheMocks.readSalesOrderPagedCache.mock.calls.some(([, options]) =>
      options?.bypassMemory === true && options?.bypassHotCache === true
    )).toBe(true);
  });
});
