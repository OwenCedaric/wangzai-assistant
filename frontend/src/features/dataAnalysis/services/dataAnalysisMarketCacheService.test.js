import { beforeEach, describe, expect, it, vi } from 'vitest';

const readCache = vi.hoisted(() => vi.fn());
const saveSnapshot = vi.hoisted(() => vi.fn());
const deleteSnapshot = vi.hoisted(() => vi.fn());
const resolveMarketScope = vi.hoisted(() => vi.fn());
const saveSyncState = vi.hoisted(() => vi.fn());
const readBrowser = vi.hoisted(() => vi.fn());

vi.mock('./dataAnalysisCacheClient.js', () => ({
  readDataAnalysisCache: readCache,
  saveDataAnalysisCacheSnapshot: saveSnapshot,
  deleteDataAnalysisCacheSnapshot: deleteSnapshot,
  resolveDataAnalysisMarketProfileScope: resolveMarketScope,
  saveDataAnalysisCacheSyncState: saveSyncState,
}));
vi.mock('./dataAnalysisMarketBrowserService.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readDataAnalysisMarketBrowserData: readBrowser,
}));

import {
  createDataAnalysisMarketHotCacheRuntime,
  readDataAnalysisMarketCache,
  refreshDataAnalysisMarketHotCache,
  saveDataAnalysisMarketCache,
  saveDataAnalysisMarketRefreshState,
} from './dataAnalysisMarketCacheService.js';

function createMarketData(overrides = {}) {
  return {
    status: 'ready',
    statusLabel: '三类市场数据已接入',
    updatedAt: '2026-07-22T08:00:00.000Z',
    observerVersion: '2.4.0',
    endpointCount: 12,
    datasetCount: 3,
    confirmedDatasetCount: 3,
    tabId: 'ozon-tab',
    profileId: 'ozon-profile-a',
    sections: {
      competitor: {
        id: 'competitor',
        title: '竞品表现',
        status: 'ready',
        statusLabel: '已接入',
        datasetCount: 1,
        recordCount: 1,
        datasets: ['market-products'],
        newestCapturedAt: '2026-07-22T08:00:00.000Z',
        metrics: [{ label: '记录', value: 1, unit: '条' }],
        records: [{ dataset: 'market-products', sequence: 1, id: 'sku-1', title: '遥控汽车' }],
      },
    },
    ...overrides,
  };
}

describe('dataAnalysisMarketCacheService', () => {
  beforeEach(() => {
    readCache.mockReset().mockResolvedValue({ rows: [] });
    saveSnapshot.mockReset().mockResolvedValue({ ok: true });
    deleteSnapshot.mockReset().mockResolvedValue({ ok: true, deletedCount: 1 });
    resolveMarketScope.mockReset().mockImplementation(async (input = {}) => ({
      profileId: input.profileId || 'ozon-profile-a',
      shopId: input.shopId || 'shop-a',
    }));
    saveSyncState.mockReset().mockResolvedValue({ ok: true });
    readBrowser.mockReset().mockResolvedValue(createMarketData());
  });

  it('reads the newest confirmed browser cache and marks it as cached', async () => {
    readCache.mockResolvedValue({
      rows: [{
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: new Date().toISOString(),
        payload: { marketData: createMarketData() },
      }],
    });

    const result = await readDataAnalysisMarketCache();

    expect(result).toMatchObject({ isCached: true, cacheState: 'cached', profileId: 'ozon-profile-a' });
    expect(result.sections.competitor.records[0].title).toBe('遥控汽车');
    expect(readCache).toHaveBeenCalledWith(expect.objectContaining({
      analysisType: 'ozon-browser-market',
      sourceType: 'ozon-browser-capture',
    }), expect.any(Object));
    expect(resolveMarketScope).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      timeoutMs: 30_000,
    }));
  });

  it('reads private cache data only from the requested Ozon profile', async () => {
    readCache.mockResolvedValue({
      rows: [
        { sourceStatus: 'confirmed_browser_capture', payload: { marketData: createMarketData({ profileId: 'ozon-a' }) } },
        { sourceStatus: 'confirmed_browser_capture', payload: { marketData: createMarketData({ profileId: 'ozon-b' }) } },
      ],
    });
    const result = await readDataAnalysisMarketCache({ profileId: 'ozon-b' });
    expect(result.profileId).toBe('ozon-b');
  });

  it('persists ordinary market result sets without the old 100-row truncation', async () => {
    const records = Array.from({ length: 130 }, (_, index) => ({ id: `sku-${index}`, title: `商品${index}` }));
    const data = createMarketData({
      sections: {
        competitor: {
          ...createMarketData().sections.competitor,
          recordCount: records.length,
          records,
        },
      },
    });

    await saveDataAnalysisMarketCache(data);

    const saved = saveSnapshot.mock.calls[0][0];
    expect(saved.sourceKey).toBe('ozon-profile-a');
    expect(saved.shopId).toBe('shop-a');
    expect(saved.payload.marketData.shopId).toBe('shop-a');
    expect(saved.sourceStatus).toBe('confirmed_browser_capture');
    expect(saved.payload.marketData.sections.competitor.records).toHaveLength(130);
    expect(saved.rowCount).toBe(130);
  });

  it('reads exact shop/profile cache first and only uses the old global row as a fallback', async () => {
    const legacy = {
      shopId: '',
      sourceKey: 'ozon-profile-a',
      sourceStatus: 'confirmed_browser_capture',
      updatedAt: new Date().toISOString(),
      payload: { marketData: createMarketData() },
    };
    readCache
      .mockResolvedValueOnce({ rows: [], syncState: { status: 'failed', lastAttemptAt: '2026-08-06T01:00:00.000Z' } })
      .mockResolvedValueOnce({ rows: [legacy] });

    const result = await readDataAnalysisMarketCache({ profileId: 'ozon-profile-a', shopId: 'shop-a' });

    expect(result).toMatchObject({
      profileId: 'ozon-profile-a',
      shopId: 'shop-a',
      legacyGlobalFallback: true,
      marketRefreshState: { status: 'failed' },
    });
    expect(readCache.mock.calls[0][0]).toMatchObject({
      shopId: 'shop-a',
      sourceKey: 'ozon-profile-a',
    });
    expect(readCache.mock.calls[1][0]).toMatchObject({
      sourceKey: 'ozon-profile-a',
      legacyGlobalOnly: 1,
    });
  });

  it('persists diagnosable market refresh state under the exact shop/profile scope', async () => {
    await saveDataAnalysisMarketRefreshState({
      profileId: 'ozon-profile-a',
      status: 'failed',
      lastAttemptAt: '2026-08-06T01:00:00.000Z',
      lastError: { code: 'ROUTE_TIMEOUT', message: 'route timed out' },
      failedRoutes: ['market-keywords'],
    });

    expect(saveSyncState).toHaveBeenCalledWith(expect.objectContaining({
      shopId: 'shop-a',
      profileId: 'ozon-profile-a',
      sourceKey: 'ozon-profile-a',
      analysisType: 'ozon-browser-market',
      status: 'failed',
      lastError: expect.objectContaining({
        code: 'ROUTE_TIMEOUT',
        failedRoutes: ['market-keywords'],
      }),
    }), expect.any(Object));
  });

  it('reuses a fresh complete hot cache when the market page opens', async () => {
    readCache.mockResolvedValue({
      rows: [{
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: new Date().toISOString(),
        payload: { marketData: createMarketData() },
      }],
    });

    const result = await refreshDataAnalysisMarketHotCache({
      trigger: 'view',
      browser: { autoNavigate: true, awaitBackground: true },
    });

    expect(result).toMatchObject({
      status: 'ready',
      refreshTrigger: 'view-cache',
      refreshInProgress: false,
      refreshOutcome: 'cached',
      isCached: true,
    });
    expect(readBrowser).not.toHaveBeenCalled();
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it('coalesces concurrent live refreshes and publishes a live result', async () => {
    const [first, second] = await Promise.all([
      refreshDataAnalysisMarketHotCache(),
      refreshDataAnalysisMarketHotCache(),
    ]);
    expect(first).toBe(second);
    expect(first).toMatchObject({ isCached: false, cacheState: 'live', cachePersisted: true });
    expect(first.captureIntegrity).toMatchObject({ complete: true, captureMode: 'full-market' });
    expect(readBrowser).toHaveBeenCalledWith(expect.objectContaining({
      awaitBackground: true,
      collectorPriority: 'background',
    }));
    expect(readBrowser).toHaveBeenCalledTimes(1);
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(saveSyncState.mock.calls.map(([state]) => state.status)).toEqual(expect.arrayContaining(['syncing', 'success']));
  });

  it('never replaces a trusted non-empty cache with an empty cold-start capture', async () => {
    const cached = createMarketData();
    readCache.mockResolvedValue({
      rows: [{
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: new Date().toISOString(),
        payload: { marketData: cached },
      }],
    });
    readBrowser.mockResolvedValue(createMarketData({
      status: 'empty',
      statusLabel: '暂无市场数据',
      sections: {
        competitor: {
          ...cached.sections.competitor,
          status: 'empty',
          recordCount: 0,
          records: [],
        },
      },
    }));

    const result = await refreshDataAnalysisMarketHotCache();

    expect(result).toMatchObject({
      isCached: true,
      cacheState: 'cached',
      liveRefreshStatus: 'empty',
      statusLabel: '刷新完成，Ozon 未返回新数据',
      refreshOutcome: 'unchanged',
    });
    expect(result.sections.competitor.records[0].title).toBe('遥控汽车');
    expect(result.lastCaptureAt).toBe(cached.updatedAt);
    expect(result.lastCompletedAt).not.toBe('');
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('retries quickly during the 10-second startup window and then keeps a steady interval', async () => {
    const scheduled = [];
    let now = 0;
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValueOnce(createMarketData());
    const runtime = createDataAnalysisMarketHotCacheRuntime({
      refresh,
      profileIdsLoader: async () => ['ozon-a'],
      now: () => now,
      initialDelayMs: 800,
      retryDelayMs: 1800,
      intervalMs: 45_000,
      startupWindowMs: 10_000,
      setTimeoutImpl: (callback, delay) => {
        const handle = { callback, delay };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutImpl: () => undefined,
    });

    runtime.start();
    const firstAttempt = scheduled.shift();
    expect(firstAttempt.delay).toBe(800);
    now = 800;
    await firstAttempt.callback();
    const retryAttempt = scheduled.shift();
    expect(retryAttempt.delay).toBe(1800);
    now = 2600;
    await retryAttempt.callback();
    expect(scheduled.shift().delay).toBe(45_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    runtime.stop();
  });

  it('does not start a generic CEF command when no Ozon browser profile exists', async () => {
    const scheduled = [];
    const refresh = vi.fn();
    const runtime = createDataAnalysisMarketHotCacheRuntime({
      refresh,
      profileIdsLoader: async () => [],
      intervalMs: 45_000,
      setTimeoutImpl: (callback, delay) => {
        const handle = { callback, delay };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutImpl: () => undefined,
    });

    runtime.start();
    await scheduled.shift().callback();
    expect(refresh).not.toHaveBeenCalled();
    expect(scheduled.shift().delay).toBe(45_000);
    runtime.stop();
  });

  it('polls one designated Ozon profile every thirty minutes', async () => {
    const scheduled = [];
    let active = 0;
    let maximumActive = 0;
    const refresh = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return createMarketData();
    });
    const runtime = createDataAnalysisMarketHotCacheRuntime({
      refresh,
      profileIdsLoader: async () => ['ozon-a', 'ozon-b', 'ozon-a'],
      setTimeoutImpl: (callback, delay) => {
        const handle = { callback, delay };
        scheduled.push(handle);
        return handle;
      },
      clearTimeoutImpl: () => undefined,
    });
    runtime.start();
    await scheduled.shift().callback();
    expect(maximumActive).toBe(1);
    expect(refresh.mock.calls.map(([input]) => input.browser.profileId)).toEqual(['ozon-a']);
    expect(refresh.mock.calls.every(([input]) => input.browser.awaitBackground === true)).toBe(true);
    expect(scheduled.shift().delay).toBe(30 * 60_000);
    runtime.stop();
  });

  it('keeps an empty explicit search ephemeral and never touches the complete profile snapshot', async () => {
    readBrowser.mockResolvedValue(createMarketData({
      status: 'empty',
      statusLabel: '暂无市场数据',
      profileId: 'ozon-profile-a',
      sections: {},
      datasetViews: [],
      datasetCount: 0,
      confirmedDatasetCount: 0,
    }));

    const result = await refreshDataAnalysisMarketHotCache({
      trigger: 'search',
      force: true,
      browser: { query: '不存在的词' },
    });

    expect(result).toMatchObject({ searchEphemeral: true, cachePersisted: false, refreshOutcome: 'empty' });
    expect(deleteSnapshot).not.toHaveBeenCalled();
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it('replaces stale subscription-only data when the default Ozon page returns real market data', async () => {
    const stale = createMarketData({
      datasetViews: [{ id: 'subscription-status', dataset: 'subscription-status', recordCount: 1, records: [{ id: 'old' }] }],
    });
    readCache.mockResolvedValue({
      rows: [{
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: new Date().toISOString(),
        payload: { marketData: stale },
      }],
    });
    readBrowser.mockResolvedValue(createMarketData({
      captureMode: 'default-navigation',
      datasetViews: [{ id: 'market-products', dataset: 'market-products', recordCount: 1, records: [{ id: 'sku-1', title: '运动鞋' }] }],
    }));

    const result = await refreshDataAnalysisMarketHotCache({ force: true, browser: { autoNavigate: true } });

    expect(result.datasetViews.map((dataset) => dataset.dataset)).toEqual(['market-products']);
    expect(saveSnapshot.mock.calls.at(-1)[0].payload.marketData.datasetViews.map((dataset) => dataset.dataset)).toEqual(['market-products']);
  });

  it('keeps the last real dataset when a later background route returns empty', async () => {
    const cached = createMarketData({
      datasetViews: [{
        id: 'trends',
        dataset: 'trends',
        title: '趋势数据',
        recordCount: 1,
        records: [{ id: 'trend-1', title: '遥控汽车趋势' }],
      }],
    });
    readCache.mockResolvedValue({
      rows: [{
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: new Date().toISOString(),
        payload: { marketData: cached },
      }],
    });
    readBrowser.mockImplementation(async (browserOptions) => {
      await browserOptions.onProgress(createMarketData({
        status: 'empty',
        sections: {},
        datasetViews: [],
        datasetCount: 0,
        confirmedDatasetCount: 0,
      }), { id: 'unsupported-route' });
      return cached;
    });

    await refreshDataAnalysisMarketHotCache({ force: true, browser: { autoNavigate: true } });

    expect(deleteSnapshot).not.toHaveBeenCalled();
    expect(saveSnapshot.mock.calls.some(([input]) => (
      input.payload.marketData.datasetViews.some((dataset) => dataset.dataset === 'trends')
    ))).toBe(true);
  });

  it('keeps a rolling union while background routes publish different real datasets', async () => {
    const cached = createMarketData({
      sections: {},
      datasetViews: [{
        id: 'keywords', dataset: 'keywords', title: '关键词数据', recordCount: 1,
        records: [{ id: 'keyword-1', title: '遥控汽车' }],
      }, {
        id: 'products', dataset: 'products', title: '商品明细', recordCount: 1,
        records: [{ id: 'sku-old', title: '旧商品' }],
      }],
    });
    const products = createMarketData({
      sections: {},
      datasetViews: [{
        id: 'products', dataset: 'products', title: '商品明细', recordCount: 1,
        records: [{ id: 'sku-1', title: 'Soft Toy' }],
      }],
    });
    const trends = createMarketData({
      sections: {},
      datasetViews: [{
        id: 'trends', dataset: 'trends', title: '趋势数据', recordCount: 1,
        records: [{ id: '2026-07-22', date: '2026-07-22', revenue: 10 }],
      }],
    });
    readCache
      .mockResolvedValueOnce({
        rows: [{
          sourceStatus: 'confirmed_browser_capture',
          updatedAt: new Date().toISOString(),
          payload: { marketData: cached },
        }],
      })
      .mockResolvedValue({ rows: [] });
    readBrowser.mockImplementation(async (browserOptions) => {
      await browserOptions.onProgress(products, { id: 'products-route' });
      await browserOptions.onProgress(trends, { id: 'trends-route' });
      return trends;
    });

    const result = await refreshDataAnalysisMarketHotCache({ force: true, browser: { autoNavigate: true } });
    const expected = ['keywords', 'products', 'trends'];

    expect(result.datasetViews.map((dataset) => dataset.dataset).sort()).toEqual(expected);
    expect(result.datasetViews.find((dataset) => dataset.dataset === 'products').records
      .map((record) => record.id).sort()).toEqual(['sku-1', 'sku-old']);
    expect(saveSnapshot.mock.calls.at(-1)[0].payload.marketData.datasetViews
      .map((dataset) => dataset.dataset).sort()).toEqual(expected);
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('cancels background work and starts the interactive refresh only after the shared browser is released', async () => {
    let backgroundSignal;
    readBrowser
      .mockImplementationOnce((options) => new Promise((_resolve, reject) => {
        backgroundSignal = options.signal;
        options.signal?.addEventListener?.('abort', () => {
          const error = new Error('background superseded');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }))
      .mockResolvedValueOnce(createMarketData({ updatedAt: '2026-07-22T09:00:00.000Z' }));

    const background = refreshDataAnalysisMarketHotCache({ trigger: 'background' });
    await vi.waitFor(() => expect(readBrowser).toHaveBeenCalledTimes(1));
    const manual = refreshDataAnalysisMarketHotCache({ trigger: 'manual' });
    await vi.waitFor(() => expect(readBrowser).toHaveBeenCalledTimes(2));
    expect(backgroundSignal.aborted).toBe(true);

    await manual;
    await background;
    expect(readBrowser).toHaveBeenCalledTimes(2);
  });

  it('finalizes durable sync state when a search supersedes an active background refresh', async () => {
    readBrowser
      .mockImplementationOnce((options) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener?.('abort', () => {
          const error = new Error('background superseded');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }))
      .mockResolvedValueOnce(createMarketData({
        captureMode: 'search',
        datasetViews: [],
        sections: {},
      }));

    const background = refreshDataAnalysisMarketHotCache({ trigger: 'background' });
    await vi.waitFor(() => expect(saveSyncState.mock.calls.some(([state]) => state.status === 'syncing')).toBe(true));
    const search = refreshDataAnalysisMarketHotCache({
      trigger: 'search',
      browser: { query: '遥控汽车' },
    });

    await expect(search).resolves.toMatchObject({ captureMode: 'search' });
    await expect(background).resolves.toMatchObject({ status: 'superseded' });
    await vi.waitFor(() => expect(saveSyncState.mock.calls.some(([state]) => (
      state.status === 'cancelled'
      && state.lastError?.code === 'OZON_MARKET_REFRESH_SUPERSEDED'
    ))).toBe(true));
  });

  it('serializes all market refreshes because every profile currently shares one native collector window', async () => {
    const resolvers = [];
    readBrowser.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));

    const firstA = refreshDataAnalysisMarketHotCache({ trigger: 'background', shopId: 'shop-a', browser: { profileId: 'ozon-a' } });
    const duplicateA = refreshDataAnalysisMarketHotCache({ trigger: 'background', shopId: 'shop-a', browser: { profileId: 'ozon-a' } });
    const secondShop = refreshDataAnalysisMarketHotCache({ trigger: 'background', shopId: 'shop-b', browser: { profileId: 'ozon-a' } });
    const firstB = refreshDataAnalysisMarketHotCache({ trigger: 'background', shopId: 'shop-c', browser: { profileId: 'ozon-b' } });

    expect(duplicateA).toBe(firstA);
    await vi.waitFor(() => expect(readBrowser).toHaveBeenCalledTimes(1));
    resolvers[0](createMarketData({ profileId: 'ozon-a' }));
    await vi.waitFor(() => expect(readBrowser).toHaveBeenCalledTimes(2));
    resolvers[1](createMarketData({ profileId: 'ozon-a' }));
    await vi.waitFor(() => expect(readBrowser).toHaveBeenCalledTimes(3));
    resolvers[2](createMarketData({ profileId: 'ozon-b' }));
    await Promise.all([firstA, duplicateA, secondShop, firstB]);
  });

  it('resolves the selected second shop to its exact browser profile before capture', async () => {
    resolveMarketScope.mockImplementation(async (input = {}) => ({
      profileId: input.profileId || (input.shopId === 'shop-b' ? 'ozon-profile-b' : 'ozon-profile-a'),
      shopId: input.shopId || (input.profileId === 'ozon-profile-b' ? 'shop-b' : 'shop-a'),
    }));
    readBrowser.mockResolvedValue(createMarketData({
      profileId: '',
      updatedAt: '2026-08-06T11:00:00.000Z',
    }));

    const result = await refreshDataAnalysisMarketHotCache({
      trigger: 'manual',
      shopId: 'shop-b',
      browser: { autoNavigate: true },
    });

    expect(readBrowser).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'ozon-profile-b',
      shopId: 'shop-b',
      collectorPriority: 'interactive',
    }));
    expect(result).toMatchObject({ profileId: 'ozon-profile-b', shopId: 'shop-b' });
    expect(saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      sourceKey: 'ozon-profile-b',
      shopId: 'shop-b',
    }), expect.any(Object));
    expect(resolveMarketScope).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung end-to-end refresh and releases the lane for a later retry', async () => {
    readBrowser
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce(createMarketData());

    await expect(refreshDataAnalysisMarketHotCache({
      trigger: 'manual',
      refreshTimeoutMs: 10,
    })).rejects.toMatchObject({ code: 'OZON_DATA_MARKET_REFRESH_TIMEOUT' });
    await vi.waitFor(() => expect(saveSyncState.mock.calls.some(([state]) => state.status === 'failed')).toBe(true));

    await expect(refreshDataAnalysisMarketHotCache({ trigger: 'manual' }))
      .resolves.toMatchObject({ status: 'ready' });
    expect(readBrowser).toHaveBeenCalledTimes(2);
  });

  it('ignores incomplete and search snapshots during startup cache selection', async () => {
    const complete = createMarketData({
      profileId: 'complete-profile',
      captureMode: 'full-market',
      captureIntegrity: { complete: true },
    });
    readCache.mockResolvedValue({
      rows: [{
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: '2026-07-22T10:00:00.000Z',
        payload: { marketData: createMarketData({ captureIntegrity: { complete: false } }) },
      }, {
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: '2026-07-22T09:30:00.000Z',
        payload: { marketData: createMarketData({ captureMode: 'search' }) },
      }, {
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: '2026-07-22T09:00:00.000Z',
        payload: { marketData: complete },
      }],
    });

    const result = await readDataAnalysisMarketCache({ profileId: 'complete-profile' });
    expect(result.profileId).toBe('complete-profile');
  });

  it('marks a completed pass partial and preserves old categories when one route fails', async () => {
    const cached = createMarketData({
      sections: {},
      datasetViews: [{
        id: 'keywords', dataset: 'keywords', title: '关键词机会', recordCount: 1,
        records: [{ id: 'keyword-old', title: '遥控汽车' }],
      }],
    });
    readCache.mockResolvedValue({
      rows: [{
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: '2026-07-22T08:00:00.000Z',
        payload: { marketData: cached },
      }],
    });
    readBrowser.mockResolvedValue(createMarketData({
      updatedAt: '2026-07-22T09:00:00.000Z',
      sections: {},
      datasetViews: [{
        id: 'products', dataset: 'products', title: '商品明细', recordCount: 1,
        records: [{ id: 'sku-new', title: '新商品' }],
      }],
      routeResults: [{ routeId: 'all-queries', status: 'success' }, {
        routeId: 'categories-comparison',
        status: 'safe-partial',
        complete: false,
        safeToPersist: true,
        incompleteDatasets: ['keywords'],
        safePartialDatasets: ['keywords'],
        paginationWarnings: [{ dataset: 'keywords', limitationCode: 'OZON_DATA_PAGINATION_UNAVAILABLE' }],
      }],
    }));

    const result = await refreshDataAnalysisMarketHotCache({ trigger: 'manual' });
    expect(result.refreshOutcome).toBe('partial');
    expect(result.datasetViews.map((dataset) => dataset.dataset).sort()).toEqual(['keywords', 'products']);
    expect(result.captureIntegrity).toMatchObject({ complete: true, failedRoutes: ['categories-comparison'] });
    expect(result.cachePersisted).toBe(true);
    expect(result.lastCaptureAt).toBe('2026-07-22T09:00:00.000Z');
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(saveSyncState.mock.calls.map(([state]) => state.status)).toEqual(expect.arrayContaining(['syncing', 'partial']));
  });

  it('never lets an interrupted first page shrink a complete 1000-row dataset to 10', async () => {
    const cachedRecords = Array.from({ length: 1000 }, (_, index) => ({
      id: `missing-${index}`,
      title: `完整缺货机会-${index}`,
    }));
    const cached = createMarketData({
      updatedAt: '2026-07-29T08:00:00.000Z',
      sections: {},
      datasetViews: [{
        id: 'missing-items',
        dataset: 'missing-items',
        title: '缺货机会',
        recordCount: cachedRecords.length,
        records: cachedRecords,
      }],
    });
    readCache.mockResolvedValue({
      rows: [{
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: '2026-07-29T08:00:00.000Z',
        payload: { marketData: cached },
      }],
    });
    readBrowser.mockResolvedValue(createMarketData({
      updatedAt: '2026-07-29T09:00:00.000Z',
      sections: {},
      datasetViews: [{
        id: 'missing-items',
        dataset: 'missing-items',
        title: '缺货机会',
        recordCount: 10,
        records: cachedRecords.slice(0, 10),
      }],
      routeResults: [{
        routeId: 'market-bestsellers',
        status: 'safe-partial',
        complete: false,
        safeToPersist: true,
        datasets: ['missing-items'],
        incompleteDatasets: ['missing-items'],
        safePartialDatasets: ['missing-items'],
        paginationWarnings: [{ dataset: 'missing-items', limitationCode: 'OZON_DATA_PAGINATION_UNAVAILABLE' }],
        errorCode: 'OZON_DATA_PAGINATION_UNAVAILABLE',
      }],
    }));

    const result = await refreshDataAnalysisMarketHotCache({ trigger: 'manual' });

    expect(result.datasetViews.find((dataset) => dataset.dataset === 'missing-items'))
      .toMatchObject({ recordCount: 1000 });
    expect(result.refreshOutcome).toBe('partial');
    expect(result.captureIntegrity).toMatchObject({
      complete: true,
      incompleteDatasets: ['missing-items'],
    });
    expect(result.lastCaptureAt).toBe('2026-07-29T09:00:00.000Z');
    expect(result.cachePersisted).toBe(true);
    expect(saveSnapshot).toHaveBeenCalledTimes(1);
  });

  it('migrates a legacy global 10000-row baseline into the exact shop after a safe partial refresh', async () => {
    const cachedRecords = Array.from({ length: 10_000 }, (_, index) => ({
      id: `missing-${index}`,
      title: `完整缺货机会-${index}`,
      sales: index,
      seller: `缓存卖家-${index}`,
    }));
    const legacy = createMarketData({
      updatedAt: '2026-07-29T09:17:27.000Z',
      lastCaptureAt: '2026-07-29T09:17:27.000Z',
      sections: {},
      datasetViews: [{
        id: 'missing-items',
        dataset: 'missing-items',
        title: '缺货机会',
        recordCount: cachedRecords.length,
        records: cachedRecords,
      }],
    });
    readCache
      .mockResolvedValueOnce({ rows: [], syncState: { status: 'syncing' } })
      .mockResolvedValueOnce({
        rows: [{
          shopId: '',
          sourceKey: 'ozon-profile-a',
          sourceStatus: 'confirmed_browser_capture',
          updatedAt: '2026-07-29T09:17:27.000Z',
          payload: { marketData: legacy },
        }],
      });
    readBrowser.mockResolvedValue(createMarketData({
      updatedAt: '2026-08-06T09:30:00.000Z',
      sections: {},
      datasetViews: [{
        id: 'missing-items',
        dataset: 'missing-items',
        title: '缺货机会',
        recordCount: 10,
        records: cachedRecords.slice(0, 10).map((record, index) => ({
          id: record.id,
          title: record.title,
          sales: 9000 + index,
        })),
      }],
      routeResults: [{
        routeId: 'market-bestsellers',
        status: 'safe-partial',
        complete: false,
        safeToPersist: true,
        datasets: ['missing-items'],
        incompleteDatasets: ['missing-items'],
        safePartialDatasets: ['missing-items'],
        paginationWarnings: [{ dataset: 'missing-items', limitationCode: 'OZON_DATA_PAGINATION_UNAVAILABLE' }],
      }],
    }));

    const result = await refreshDataAnalysisMarketHotCache({
      trigger: 'manual',
      shopId: 'shop-a',
      browser: { profileId: 'ozon-profile-a' },
    });

    const resultDataset = result.datasetViews.find((dataset) => dataset.dataset === 'missing-items');
    const saved = saveSnapshot.mock.calls[0][0];
    const savedDataset = saved.payload.marketData.datasetViews
      .find((dataset) => dataset.dataset === 'missing-items');
    expect(readCache.mock.calls[0][0]).toMatchObject({
      shopId: 'shop-a',
      sourceKey: 'ozon-profile-a',
    });
    expect(readCache.mock.calls[1][0]).toMatchObject({
      sourceKey: 'ozon-profile-a',
      legacyGlobalOnly: 1,
    });
    expect(resultDataset).toMatchObject({ recordCount: 10_000 });
    expect(resultDataset.records[0]).toMatchObject({ sales: 9000, seller: '缓存卖家-0' });
    expect(result.lastCaptureAt).toBe('2026-08-06T09:30:00.000Z');
    expect(result.cachePersisted).toBe(true);
    expect(saved).toMatchObject({ shopId: 'shop-a', sourceKey: 'ozon-profile-a', rowCount: 10_000 });
    expect(saved.payload.marketData).toMatchObject({
      shopId: 'shop-a',
      profileId: 'ozon-profile-a',
      lastCaptureAt: '2026-08-06T09:30:00.000Z',
      legacyGlobalMigration: {
        sourceKey: 'ozon-profile-a',
        sourceRowCount: 10_000,
        sourceUpdatedAt: '2026-07-29T09:17:27.000Z',
      },
    });
    expect(savedDataset).toMatchObject({ recordCount: 10_000 });
    expect(savedDataset.records[0]).toMatchObject({ sales: 9000, seller: '缓存卖家-0' });
  });

  it('does not overwrite or advance a legacy baseline after an unsafe partial refresh', async () => {
    const cached = createMarketData({
      updatedAt: '2026-07-29T09:17:27.000Z',
      lastCaptureAt: '2026-07-29T09:17:27.000Z',
      sections: {},
      datasetViews: [{
        id: 'keywords', dataset: 'keywords', title: '关键词机会', recordCount: 2,
        records: [{ title: '旧词一', searches: 10 }, { title: '旧词二', searches: 20 }],
      }],
    });
    readCache
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          shopId: '',
          sourceKey: 'ozon-profile-a',
          sourceStatus: 'confirmed_browser_capture',
          updatedAt: '2026-07-29T09:17:27.000Z',
          payload: { marketData: cached },
        }],
      });
    readBrowser.mockResolvedValue(createMarketData({
      updatedAt: '2026-08-06T10:00:00.000Z',
      sections: {},
      datasetViews: [{
        id: 'keywords', dataset: 'keywords', title: '关键词机会', recordCount: 1,
        records: [{ title: '旧词一', searches: 999 }],
      }],
      routeResults: [{
        routeId: 'market-keywords',
        status: 'failed',
        complete: false,
        safeToPersist: false,
        datasets: ['keywords'],
        incompleteDatasets: ['keywords'],
      }],
    }));

    const result = await refreshDataAnalysisMarketHotCache({
      trigger: 'manual',
      shopId: 'shop-a',
      browser: { profileId: 'ozon-profile-a' },
    });

    expect(result.cachePersisted).toBe(false);
    expect(result.lastCaptureAt).toBe('2026-07-29T09:17:27.000Z');
    expect(result.captureIntegrity).toMatchObject({ complete: false, safeToPersist: false });
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  it('replaces a freshly captured dataset instead of retaining stale or misclassified cache rows', async () => {
    const cached = createMarketData({
      sections: {},
      datasetViews: [{
        id: 'market-products', dataset: 'market-products', title: '市场商品', recordCount: 2,
        records: [{ id: 'stale-1', title: '旧错误数据一' }, { id: 'stale-2', title: '旧错误数据二' }],
      }],
    });
    readCache.mockResolvedValue({
      rows: [{
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: '2026-07-22T08:00:00.000Z',
        payload: { marketData: cached },
      }],
    });
    readBrowser.mockResolvedValue(createMarketData({
      updatedAt: '2026-07-22T09:00:00.000Z',
      sections: {},
      datasetViews: [{
        id: 'market-products', dataset: 'market-products', title: '市场商品', recordCount: 1,
        records: [{ id: 'fresh-1', title: '本轮真实数据' }],
      }],
      routeResults: [{ routeId: 'all-bestsellers', status: 'success' }],
    }));

    const result = await refreshDataAnalysisMarketHotCache({ trigger: 'manual' });

    expect(result.datasetViews.find((dataset) => dataset.dataset === 'market-products')?.records)
      .toEqual([expect.objectContaining({ id: 'fresh-1', title: '本轮真实数据' })]);
  });

  it('keeps confirmed hot-cache data when a periodic default navigation is temporarily empty', async () => {
    const cached = createMarketData({
      datasetViews: [{
        id: 'keywords',
        dataset: 'keywords',
        title: '关键词数据',
        recordCount: 1,
        records: [{ id: 'keyword-1', title: '遥控汽车' }],
      }],
    });
    readCache.mockResolvedValue({
      rows: [{
        sourceStatus: 'confirmed_browser_capture',
        updatedAt: new Date().toISOString(),
        payload: { marketData: cached },
      }],
    });
    readBrowser.mockResolvedValue(createMarketData({
      captureMode: 'default-navigation',
      status: 'empty',
      sections: {},
      datasetViews: [],
      datasetCount: 0,
      confirmedDatasetCount: 0,
    }));

    const result = await refreshDataAnalysisMarketHotCache({ force: true, browser: { autoNavigate: true } });

    expect(result.datasetViews.map((dataset) => dataset.dataset)).toEqual(['keywords']);
    expect(result.liveRefreshStatus).toBe('empty');
    expect(deleteSnapshot).not.toHaveBeenCalled();
  });

  it('retries the final compact market-cache write before reporting completion', async () => {
    saveSnapshot
      .mockRejectedValueOnce(new Error('本地 API 请求超时'))
      .mockResolvedValueOnce({ ok: true });
    readBrowser.mockResolvedValue(createMarketData({
      updatedAt: '2026-08-27T12:00:00.000Z',
      routeResults: [{ routeId: 'market-bestsellers', status: 'success', complete: true }],
    }));

    const result = await refreshDataAnalysisMarketHotCache({
      trigger: 'manual',
      persistenceRetryDelayMs: 0,
    });

    expect(saveSnapshot).toHaveBeenCalledTimes(2);
    expect(saveSnapshot.mock.calls[0][1]).toMatchObject({ timeoutMs: 120_000 });
    expect(result.cachePersisted).toBe(true);
  });
});
