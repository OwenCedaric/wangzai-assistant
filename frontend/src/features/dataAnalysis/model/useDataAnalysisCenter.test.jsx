import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readDataAnalysisCache: vi.fn(),
  requestDataAnalysisSync: vi.fn(),
  syncOfficialTrafficData: vi.fn(),
}));

vi.mock('../services/dataAnalysisCacheClient.js', () => ({
  readDataAnalysisCache: mocks.readDataAnalysisCache,
  requestDataAnalysisSync: mocks.requestDataAnalysisSync,
  syncOfficialTrafficData: mocks.syncOfficialTrafficData,
}));

import {
  createDataAnalysisDateRange,
  getOfficialTrafficSyncShopIds,
  useDataAnalysisCenter,
} from './useDataAnalysisCenter.js';

const shops = [
  { id: 'shop-a', clientId: 'client-a', hasApiKey: true },
  { id: 'shop-b', hasClientId: true, hasApiKey: true },
  { id: 'shop-c', clientId: 'client-c', apiKey: 'key-c' },
];

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readDataAnalysisCache.mockResolvedValue({ dashboard: { overview: { metrics: [] } } });
  mocks.requestDataAnalysisSync.mockResolvedValue({ ok: true });
  mocks.syncOfficialTrafficData.mockResolvedValue({ job: { status: 'success' } });
});

describe('useDataAnalysisCenter multi-shop official refresh', () => {
  it('keeps the newest explicit shop result when an older IPC read completes late', async () => {
    const shopA = createDeferred();
    const shopB = createDeferred();
    mocks.readDataAnalysisCache.mockImplementation(({ shopId }) => {
      if (shopId === 'shop-a') return shopA.promise;
      if (shopId === 'shop-b') return shopB.promise;
      return Promise.resolve({ dashboard: { shopId: '', overview: { metrics: [] } } });
    });
    const { result, unmount } = renderHook(() => useDataAnalysisCenter({ shops, isActive: true }));
    await waitFor(() => expect(mocks.readDataAnalysisCache).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: '', shopIds: 'shop-a,shop-b,shop-c' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ));

    act(() => result.current.setShopId('shop-a'));
    await waitFor(() => expect(mocks.readDataAnalysisCache).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-a' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ));
    act(() => result.current.setShopId('shop-b'));
    await waitFor(() => expect(mocks.readDataAnalysisCache).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-b' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ));

    await act(async () => {
      shopB.resolve({ dashboard: { shopId: 'shop-b', overview: { metrics: [] } } });
      await shopB.promise;
    });
    await waitFor(() => expect(result.current.payload.dashboard?.shopId).toBe('shop-b'));

    await act(async () => {
      shopA.resolve({ dashboard: { shopId: 'shop-a', overview: { metrics: [] } } });
      await shopA.promise;
    });
    expect(result.current.payload.dashboard?.shopId).toBe('shop-b');
    unmount();
  });

  it('uses the Moscow date for the default range when China has already crossed midnight', () => {
    expect(createDataAnalysisDateRange('30d', new Date('2026-07-31T20:30:00.000Z'))).toEqual({
      presetId: '30d',
      startDate: '2026-07-02',
      endDate: '2026-07-31',
    });
  });

  it('returns only configured internal shop ids for official traffic sync', () => {
    expect(getOfficialTrafficSyncShopIds([
      ...shops,
      { id: 'shop-without-key', clientId: 'client-empty' },
      { clientId: 'client-without-internal-id', apiKey: 'key' },
    ])).toEqual(['shop-a', 'shop-b', 'shop-c']);
    expect(getOfficialTrafficSyncShopIds(shops, 'shop-b')).toEqual(['shop-b']);
    expect(getOfficialTrafficSyncShopIds(shops, 'client-b')).toEqual([]);
  });

  it('splits all-shops refresh into one non-empty reports sync per configured shop', async () => {
    const { result, unmount } = renderHook(() => useDataAnalysisCenter({
      shops,
      activeShopId: 'shop-a',
      isActive: false,
    }));
    act(() => result.current.setShopId(''));
    await waitFor(() => expect(result.current.filters.shopId).toBe(''));

    await act(async () => {
      await result.current.refreshOfficialData();
    });

    expect(mocks.syncOfficialTrafficData).toHaveBeenCalledTimes(3);
    expect(mocks.syncOfficialTrafficData.mock.calls.map(([payload]) => payload.shopId)).toEqual([
      'shop-a',
      'shop-b',
      'shop-c',
    ]);
    expect(mocks.syncOfficialTrafficData.mock.calls.every(([payload]) => Boolean(payload.shopId))).toBe(true);
    expect(mocks.requestDataAnalysisSync).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: '', shopIds: 'shop-a,shop-b,shop-c', analysisType: 'all' }),
      { timeoutMs: 20000 }
    );
    expect(mocks.readDataAnalysisCache).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('submits only the selected internal shop id', async () => {
    const { result, unmount } = renderHook(() => useDataAnalysisCenter({
      shops,
      activeShopId: 'shop-b',
      isActive: false,
    }));

    act(() => result.current.setShopId('shop-b'));
    await waitFor(() => expect(result.current.filters.shopId).toBe('shop-b'));

    await act(async () => {
      await result.current.refreshOfficialData();
    });

    expect(mocks.syncOfficialTrafficData).toHaveBeenCalledTimes(1);
    expect(mocks.syncOfficialTrafficData).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-b' }),
      { timeoutMs: 90000 }
    );
    unmount();
  });

  it('rebuilds and reads back the aggregate when one shop sync fails', async () => {
    mocks.syncOfficialTrafficData.mockImplementation(async ({ shopId }) => (
      shopId === 'shop-b'
        ? { job: { status: 'failed', lastError: 'shop-b fixture failed' } }
        : { job: { status: 'success' } }
    ));
    const { result, unmount } = renderHook(() => useDataAnalysisCenter({
      shops,
      activeShopId: 'shop-a',
      isActive: false,
    }));
    act(() => result.current.setShopId(''));
    await waitFor(() => expect(result.current.filters.shopId).toBe(''));

    await act(async () => {
      await result.current.refreshOfficialData();
    });

    expect(mocks.requestDataAnalysisSync).toHaveBeenCalledTimes(1);
    expect(mocks.readDataAnalysisCache).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('success');
    expect(result.current.error).toMatchObject({ code: 'OFFICIAL_TRAFFIC_SYNC_PARTIAL' });
    unmount();
  });

  it('reuses the same in-flight refresh promise instead of creating duplicate jobs', async () => {
    const deferred = createDeferred();
    mocks.syncOfficialTrafficData.mockReturnValue(deferred.promise);
    const { result, unmount } = renderHook(() => useDataAnalysisCenter({
      shops: [shops[0]],
      activeShopId: 'shop-a',
      isActive: false,
    }));
    act(() => result.current.setShopId('shop-a'));
    let firstPromise;
    let secondPromise;

    act(() => {
      firstPromise = result.current.refreshOfficialData();
      secondPromise = result.current.refreshOfficialData();
    });

    expect(firstPromise).toBe(secondPromise);
    expect(mocks.syncOfficialTrafficData).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({ job: { status: 'success' } });
      await firstPromise;
    });

    expect(mocks.requestDataAnalysisSync).toHaveBeenCalledTimes(1);
    expect(mocks.readDataAnalysisCache).toHaveBeenCalledTimes(1);
    unmount();
  });
});
