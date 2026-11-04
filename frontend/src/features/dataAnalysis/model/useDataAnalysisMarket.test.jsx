import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readMarket = vi.hoisted(() => vi.fn());
const readCache = vi.hoisted(() => vi.fn());
const refreshHotCache = vi.hoisted(() => vi.fn());

vi.mock('../services/dataAnalysisMarketBrowserService.js', () => ({
  readDataAnalysisMarketBrowserData: readMarket,
}));
vi.mock('../services/dataAnalysisMarketCacheService.js', () => ({
  DATA_ANALYSIS_MARKET_CACHE_EVENT: 'wangzai:ozon-market-cache-updated',
  readDataAnalysisMarketCache: readCache,
  refreshDataAnalysisMarketHotCache: refreshHotCache,
}));

import { useDataAnalysisMarket } from './useDataAnalysisMarket.js';

describe('useDataAnalysisMarket', () => {
  beforeEach(() => {
    readMarket.mockReset().mockResolvedValue({
      status: 'ready',
      statusLabel: '三类市场数据已接入',
      sections: {},
    });
    readCache.mockReset().mockResolvedValue(null);
    refreshHotCache.mockReset().mockResolvedValue({
      status: 'ready',
      statusLabel: '三类市场数据已接入',
      sections: {},
    });
  });

  it('automatically reads captured browser data when the market module becomes active', async () => {
    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: true }));

    await waitFor(() => expect(refreshHotCache).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data?.statusLabel).toBe('三类市场数据已接入');

    await act(async () => {
      await result.current.refresh();
    });
    expect(refreshHotCache).toHaveBeenCalledTimes(2);
  });

  it('keeps the last complete snapshot while background route progress is arriving', async () => {
    const complete = {
      status: 'ready',
      statusLabel: '完整市场缓存',
      sections: {},
      datasetViews: [{ dataset: 'missing-items', recordCount: 2, records: [{ id: 'old-1' }, { id: 'old-2' }] }],
    };
    refreshHotCache.mockResolvedValue(complete);
    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: true }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    const before = result.current.data;
    act(() => {
      window.dispatchEvent(new CustomEvent('wangzai:ozon-market-cache-updated', {
        detail: {
          data: {
            status: 'refreshing',
            statusLabel: '正在获取全部市场分类',
            refreshTrigger: 'background',
            refreshInProgress: true,
            sections: {},
            datasetViews: [{ dataset: 'missing-items', recordCount: 1, records: [{ id: 'partial' }] }],
          },
        },
      }));
    });

    expect(result.current.data).toBe(before);
    expect(result.current.status).toBe('ready');
    expect(result.current.statusLabel).toBe('完整市场缓存');
  });

  it('shows manual refresh progress without replacing the complete table snapshot', async () => {
    let resolveManual;
    const complete = {
      status: 'ready',
      statusLabel: '完整市场缓存',
      sections: {},
      datasetViews: [{ dataset: 'keywords', recordCount: 2, records: [{ id: 'old-1' }, { id: 'old-2' }] }],
    };
    refreshHotCache
      .mockResolvedValueOnce(complete)
      .mockReturnValueOnce(new Promise((resolve) => { resolveManual = resolve; }));
    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: true }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const before = result.current.data;

    let manualPromise;
    act(() => {
      manualPromise = result.current.refresh();
    });
    await waitFor(() => expect(result.current.activeAction).toBe('manual'));

    act(() => {
      window.dispatchEvent(new CustomEvent('wangzai:ozon-market-cache-updated', {
        detail: {
          data: {
            status: 'refreshing',
            statusLabel: '正在获取全部市场分类',
            refreshTrigger: 'manual',
            refreshInProgress: true,
            sections: {},
            datasetViews: [{ dataset: 'keywords', recordCount: 1, records: [{ id: 'partial' }] }],
          },
        },
      }));
    });

    expect(result.current.data).toBe(before);
    expect(result.current.status).toBe('refreshing');

    await act(async () => {
      resolveManual(complete);
      await manualPromise;
    });
  });

  it('does not let a late cache read overwrite a completed live event', async () => {
    let resolveRefresh;
    let resolveCache;
    const complete = {
      status: 'ready',
      statusLabel: '实时刷新完成',
      sections: {},
      datasetViews: [{ dataset: 'keywords', recordCount: 1, records: [{ id: 'live-1' }] }],
    };
    refreshHotCache.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    readCache.mockReturnValue(new Promise((resolve) => { resolveCache = resolve; }));
    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: true }));

    act(() => {
      window.dispatchEvent(new CustomEvent('wangzai:ozon-market-cache-updated', {
        detail: { data: complete },
      }));
    });
    expect(result.current.status).toBe('ready');

    await act(async () => {
      resolveCache({ status: 'partial', statusLabel: '旧缓存', sections: {}, datasetViews: [{ dataset: 'keywords', recordCount: 1, records: [{ id: 'cached-1' }] }] });
      await Promise.resolve();
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.data).toBe(complete);

    await act(async () => {
      resolveRefresh(complete);
      await Promise.resolve();
    });
  });

  it('shows the last trusted cache immediately and keeps it when live refresh fails', async () => {
    let rejectRefresh;
    readCache.mockResolvedValue({
      status: 'partial',
      statusLabel: '已接入 2/3 类',
      isCached: true,
      sections: {},
    });
    refreshHotCache.mockReturnValue(new Promise((_resolve, reject) => {
      rejectRefresh = reject;
    }));

    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: true }));
    await waitFor(() => expect(result.current.status).toBe('cache-ready'));
    expect(result.current.data?.isCached).toBe(true);

    await act(async () => {
      rejectRefresh(new Error('observer not ready'));
    });
    await waitFor(() => expect(result.current.status).toBe('error-with-cache'));
    expect(result.current.data?.statusLabel).toBe('已接入 2/3 类');
  });

  it('keeps cached controls interactive while the view refresh is still running', async () => {
    let resolveRefresh;
    readCache.mockResolvedValue({
      status: 'ready',
      statusLabel: '7 月 29 日缓存',
      isCached: true,
      sections: {},
      datasetViews: [{ dataset: 'keywords', records: [{ id: 'cached' }] }],
    });
    refreshHotCache.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));

    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: true }));
    await waitFor(() => expect(result.current.status).toBe('cache-ready'));
    expect(result.current.activeAction).toBe('');
    expect(readCache).toHaveBeenCalledWith({});
    expect(refreshHotCache).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'view',
      browser: expect.objectContaining({ autoNavigate: true, awaitBackground: true }),
    }));

    act(() => {
      window.dispatchEvent(new CustomEvent('wangzai:ozon-market-cache-updated', {
        detail: {
          data: {
            profileId: 'ozon-a',
            refreshTrigger: 'view',
            refreshInProgress: true,
            sections: {},
            datasetViews: [{ dataset: 'keywords', records: [{ id: 'partial' }] }],
          },
        },
      }));
    });
    expect(result.current.status).toBe('cache-ready');
    expect(result.current.activeAction).toBe('');

    await act(async () => {
      resolveRefresh({ status: 'ready', statusLabel: '最新数据', sections: {}, datasetViews: [] });
    });
  });

  it('clears the interactive action after a timed-out refresh rejects', async () => {
    refreshHotCache.mockRejectedValueOnce(Object.assign(new Error('timeout'), {
      code: 'OZON_DATA_MARKET_REFRESH_TIMEOUT',
    }));
    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: false }));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.activeAction).toBe('');
  });

  it('continues accepting later background completions after a manual refresh', async () => {
    const initial = {
      status: 'ready', statusLabel: '初始市场数据', profileId: 'ozon-a', shopId: 'shop-a', sections: {}, datasetViews: [],
    };
    const manual = {
      status: 'ready', statusLabel: '手动刷新完成', profileId: 'ozon-a', shopId: 'shop-a', sections: {}, datasetViews: [],
    };
    refreshHotCache.mockResolvedValueOnce(initial).mockResolvedValueOnce(manual);
    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: true }));
    await waitFor(() => expect(result.current.statusLabel).toBe('初始市场数据'));

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.statusLabel).toBe('手动刷新完成');

    act(() => {
      window.dispatchEvent(new CustomEvent('wangzai:ozon-market-cache-updated', {
        detail: {
          data: {
            status: 'ready',
            statusLabel: '后台新数据已到达',
            profileId: 'ozon-a',
            shopId: 'shop-a',
            refreshTrigger: 'background',
            refreshInProgress: false,
            sections: {},
            datasetViews: [],
          },
        },
      }));
    });

    expect(result.current.statusLabel).toBe('后台新数据已到达');
    expect(result.current.activeAction).toBe('');
  });

  it('does not let a stale external manual run lock a newly mounted market page', async () => {
    const initial = {
      status: 'ready', statusLabel: '当前页数据', profileId: 'ozon-a', shopId: 'shop-a', sections: {}, datasetViews: [],
    };
    refreshHotCache.mockResolvedValue(initial);
    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: true }));
    await waitFor(() => expect(result.current.statusLabel).toBe('当前页数据'));

    act(() => {
      window.dispatchEvent(new CustomEvent('wangzai:ozon-market-cache-updated', {
        detail: {
          data: {
            status: 'refreshing',
            statusLabel: '旧页面正在刷新',
            profileId: 'ozon-a',
            shopId: 'shop-a',
            refreshTrigger: 'manual',
            refreshInProgress: true,
            sections: {},
            datasetViews: [],
          },
        },
      }));
    });

    expect(result.current.statusLabel).toBe('当前页数据');
    expect(result.current.status).toBe('ready');
    expect(result.current.activeAction).toBe('');
  });

  it('does not let a passive completion clear an active manual refresh', async () => {
    let resolveManual;
    const initial = {
      status: 'ready', statusLabel: '初始数据', profileId: 'ozon-a', shopId: 'shop-a', sections: {}, datasetViews: [],
    };
    refreshHotCache
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(new Promise((resolve) => { resolveManual = resolve; }));
    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: true }));
    await waitFor(() => expect(result.current.statusLabel).toBe('初始数据'));

    let manualPromise;
    act(() => {
      manualPromise = result.current.refresh();
    });
    await waitFor(() => expect(result.current.activeAction).toBe('manual'));

    act(() => {
      window.dispatchEvent(new CustomEvent('wangzai:ozon-market-cache-updated', {
        detail: {
          data: {
            status: 'ready',
            statusLabel: '被动刷新完成',
            profileId: 'ozon-a',
            shopId: 'shop-a',
            refreshTrigger: 'background',
            refreshInProgress: false,
            sections: {},
            datasetViews: [],
          },
        },
      }));
    });
    expect(result.current.activeAction).toBe('manual');
    expect(result.current.statusLabel).not.toBe('被动刷新完成');

    await act(async () => {
      resolveManual({
        status: 'ready', statusLabel: '手动刷新完成', profileId: 'ozon-a', shopId: 'shop-a', sections: {}, datasetViews: [],
      });
      await manualPromise;
    });
    expect(result.current.activeAction).toBe('');
    expect(result.current.statusLabel).toBe('手动刷新完成');
  });

  it('submits a keyword search through the browser hot-cache pipeline', async () => {
    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: false }));
    act(() => result.current.setQuery('遥控汽车'));

    await act(async () => {
      await result.current.search('遥控汽车');
    });

    expect(refreshHotCache).toHaveBeenCalledWith({
      trigger: 'search',
      force: true,
      browser: { query: '遥控汽车', awaitBackground: true, scanRoutes: false },
    });
    expect(result.current.query).toBe('遥控汽车');
    expect(result.current.status).toBe('ready');
  });

  it('keeps the current complete market snapshot when an explicit search cannot obtain a response', async () => {
    const complete = { status: 'ready', statusLabel: '完整市场缓存', sections: {}, datasetViews: [{ dataset: 'products', records: [{ id: 'sku-1' }] }] };
    refreshHotCache
      .mockResolvedValueOnce(complete)
      .mockRejectedValueOnce(new Error('OZON_DATA_SEARCH_RECIPE_UNAVAILABLE'));
    const { result } = renderHook(() => useDataAnalysisMarket({ enabled: false }));

    await act(async () => {
      await result.current.refresh();
    });

    await act(async () => {
      await result.current.search('无结果关键词');
    });

    expect(result.current.data).toBe(complete);
    expect(result.current.status).toBe('error-with-cache');
    expect(result.current.statusLabel).toBe('搜索失败，已保留完整市场数据');
  });
});
