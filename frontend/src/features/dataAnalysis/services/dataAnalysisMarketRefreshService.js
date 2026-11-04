import { readDataAnalysisMarketBrowserData } from './dataAnalysisMarketBrowserService.js';
import {
  emitMarketCacheUpdate,
  readDataAnalysisMarketCache,
  resolveDataAnalysisMarketScope,
  saveDataAnalysisMarketCache,
  saveDataAnalysisMarketRefreshState,
} from './dataAnalysisMarketCacheStorage.js';
import { mergeLiveMarketDataWithCache } from '../lib/dataAnalysisMarketCacheMerge.js';
import {
  marketCacheCount,
  marketCacheText,
  marketRowCount,
} from '../lib/dataAnalysisMarketCacheValue.js';
let refreshRunSequence = 0;
const VIEW_CACHE_MAX_AGE_MS = 60_000;
// The browser workflow owns a 20-minute accuracy-first full-capture budget.
// Callers must outlive that budget plus navigation, bounded retries and final
// SQLite persistence; otherwise a correct pass is aborted just before commit.
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 25 * 60_000;
const DEFAULT_PASSIVE_TIMEOUT_MS = 30 * 60_000;
const MARKET_CACHE_WRITE_TIMEOUT_MS = 2 * 60_000;
const MARKET_CACHE_WRITE_ATTEMPTS = 3;
const MARKET_CACHE_WRITE_RETRY_DELAY_MS = 1_000;
const refreshLanes = new Map();
const browserRefreshTails = new Map();

function browserRefreshLaneKey(options = {}) {
  // Every market route currently uses the one native CEF collector window.
  // Serialize globally even when the cache scope names different shops or
  // profiles; those scopes do not create independent browser windows.
  void options;
  return 'ozon-market-browser-global';
}

function enqueueBrowserRefresh(options, worker) {
  const key = browserRefreshLaneKey(options);
  const previous = browserRefreshTails.get(key) || Promise.resolve();
  const execution = previous.catch(() => undefined).then(worker);
  let tail;
  tail = execution.catch(() => undefined).finally(() => {
    if (browserRefreshTails.get(key) === tail) browserRefreshTails.delete(key);
  });
  browserRefreshTails.set(key, tail);
  return execution;
}

function cancelPassiveBrowserRefreshes(profileKey) {
  for (const [laneKey, lane] of refreshLanes.entries()) {
    if (lane.profileKey !== profileKey) continue;
    for (const [taskKey, task] of lane.tasks.entries()) {
      if (task.interactive) continue;
      task.cancel?.();
      if (lane.tasks.get(taskKey) === task) lane.tasks.delete(taskKey);
    }
    if (!lane.tasks.size) refreshLanes.delete(laneKey);
  }
}

function refreshLaneKey(options = {}) {
  const profileId = marketCacheText(options.browser?.profileId || options.cacheRead?.profileId);
  const shopId = marketCacheText(options.shopId || options.browser?.shopId || options.cacheRead?.shopId);
  return `profile:${profileId || 'default'}|shop:${shopId || 'unbound'}`;
}

function refreshTaskKey(trigger, options = {}) {
  if (trigger === 'search') return `search:${marketCacheText(options.browser?.query)}`;
  if (trigger === 'manual') return 'manual';
  return 'passive';
}

function refreshTimeoutMs(trigger, options = {}) {
  const explicitTimeout = Number(options.refreshTimeoutMs);
  if (Number.isFinite(explicitTimeout) && explicitTimeout > 0) return explicitTimeout;
  return trigger === 'background'
    ? DEFAULT_PASSIVE_TIMEOUT_MS
    : DEFAULT_INTERACTIVE_TIMEOUT_MS;
}

function refreshStateScope(options = {}, signal) {
  const profileId = marketCacheText(options.browser?.profileId || options.cacheRead?.profileId);
  const shopId = marketCacheText(options.shopId || options.browser?.shopId || options.cacheRead?.shopId);
  return {
    state: {
      ...(profileId ? { profileId } : {}),
      ...(shopId ? { shopId } : {}),
    },
    options: {
      ...(profileId ? { profileId } : {}),
      ...(shopId ? { shopId } : {}),
      ...(signal ? { signal } : {}),
      ...(options.verifiedScope ? { verifiedScope: options.verifiedScope } : {}),
    },
  };
}

async function persistRefreshState(options, state, signal) {
  const scope = refreshStateScope(options, signal);
  try {
    await saveDataAnalysisMarketRefreshState(
      { ...scope.state, ...state },
      { ...scope.options, timeoutMs: 30_000 },
    );
  } catch {
    // Refresh-state persistence must never prevent the real browser capture.
  }
}

function persistenceDelay(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function retryMarketCacheWrite(operation, options = {}) {
  const attempts = Math.max(1, Math.min(
    5,
    Number(options.attempts) || MARKET_CACHE_WRITE_ATTEMPTS,
  ));
  const retryDelayMs = options.retryDelayMs === 0
    ? 0
    : Math.max(100, Number(options.retryDelayMs) || MARKET_CACHE_WRITE_RETRY_DELAY_MS);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted === true || attempt >= attempts) throw error;
      await persistenceDelay(retryDelayMs * (attempt === 1 ? 1 : 3));
    }
  }
  throw lastError;
}

async function persistSupersededRefreshState(options, trigger, runContext) {
  if (
    trigger === 'search'
    || runContext.remoteStarted !== true
    || runContext.terminationReason !== 'superseded'
    || runContext.supersededStatePersisted === true
  ) return;
  runContext.supersededStatePersisted = true;
  await persistRefreshState(options, {
    status: 'cancelled',
    lastAttemptAt: runContext.attemptAt,
    lastError: {
      code: 'OZON_MARKET_REFRESH_SUPERSEDED',
      message: '后台市场刷新已让位给当前手动操作。',
      failedRoutes: [],
    },
    failedRoutes: [],
  });
}

function refreshErrorState(error, failedRoutes = []) {
  return {
    code: marketCacheText(error?.code) || 'OZON_MARKET_REFRESH_FAILED',
    message: marketCacheText(error?.message) || 'Ozon 市场数据刷新失败。',
    failedRoutes,
  };
}

function createRefreshTimeoutError(timeoutMs) {
  const error = new Error(`Ozon 市场数据刷新超过 ${Math.ceil(timeoutMs / 1000)} 秒，已结束本次等待。`);
  error.code = 'OZON_DATA_MARKET_REFRESH_TIMEOUT';
  return error;
}

function runWithTimeout(execution, timeoutMs, onTimeout) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = globalThis.setTimeout?.(() => {
      reject(createRefreshTimeoutError(timeoutMs));
      onTimeout?.();
    }, timeoutMs);
  });
  return Promise.race([execution, timeout]).finally(() => {
    if (timer !== null) globalThis.clearTimeout?.(timer);
  });
}

function parsedTime(value) {
  const result = Date.parse(marketCacheText(value));
  return Number.isFinite(result) ? result : 0;
}

function newestTime(...values) {
  return values.map(marketCacheText).filter(Boolean).sort((left, right) => parsedTime(left) - parsedTime(right)).at(-1) || '';
}

function marketFingerprint(data = {}) {
  return (data.datasetViews || [])
    .map((dataset) => `${marketCacheText(dataset?.dataset || dataset?.id)}:${marketCacheCount(dataset?.recordCount)}:${marketCacheText(dataset?.newestCapturedAt)}`)
    .filter((value) => !value.startsWith(':'))
    .sort()
    .join('|');
}

function datasetCoverage(data = {}) {
  return Object.fromEntries((data.datasetViews || [])
    .map((dataset) => [marketCacheText(dataset?.dataset || dataset?.id), marketCacheCount(dataset?.recordCount)])
    .filter(([id, count]) => Boolean(id) && count > 0));
}

function refreshOutcomeLabel(outcome) {
  if (outcome === 'updated') return '已获取新数据';
  if (outcome === 'partial') return '部分分类未更新，已保留原数据';
  if (outcome === 'unchanged') return '刷新完成，Ozon 未返回新数据';
  if (outcome === 'empty') return '刷新完成，暂未返回可用数据';
  return '刷新完成';
}

async function executeMarketRefresh(options = {}, runContext = {}) {
  const trigger = marketCacheText(options.trigger) || (marketCacheText(options.browser?.query) ? 'search' : 'automatic');
  const attemptAt = new Date().toISOString();
  const refreshRunId = marketCacheText(runContext.refreshRunId)
    || `${Date.now().toString(36)}-standalone`;
  runContext.attemptAt = attemptAt;
  const isSearch = Boolean(marketCacheText(options.browser?.query));
  let refreshAccumulator = null;
  const browserOptions = {
    autoNavigate: options.browser?.autoNavigate ?? true,
    awaitBackground: options.browser?.awaitBackground ?? true,
    ...(options.browser || {}),
    collectorPriority: options.browser?.collectorPriority
      || (['manual', 'search'].includes(trigger) ? 'interactive' : 'background'),
  };
  if (isSearch && options.browser?.scanRoutes === undefined) browserOptions.scanRoutes = false;
  const requestedScope = await resolveDataAnalysisMarketScope({
    profileId: marketCacheText(browserOptions.profileId || options.cacheRead?.profileId),
    shopId: marketCacheText(options.shopId || browserOptions.shopId || options.cacheRead?.shopId),
  }, {
    ...(options.cacheRead || {}),
    ...(browserOptions.signal ? { signal: browserOptions.signal } : {}),
  });
  // The cache scope and the browser session must be the same pair.  In
  // particular, selecting shop B must never leave profileId empty and let the
  // browser workflow fall back to shop A's default Cookie/session.
  browserOptions.profileId = requestedScope.profileId;
  browserOptions.shopId = requestedScope.shopId;
  const scopedOptions = { ...options, verifiedScope: requestedScope };
  const cacheReadOptions = {
    ...(options.cacheRead || {}),
    ...(browserOptions.signal ? { signal: browserOptions.signal } : {}),
    profileId: requestedScope.profileId,
    shopId: requestedScope.shopId,
    verifiedScope: requestedScope,
  };
  const baselineCache = isSearch
    ? null
    : await readDataAnalysisMarketCache(cacheReadOptions).catch(() => null);
  if (runContext.isActive?.() === false || runContext.isSuperseded?.() === true) {
    await persistSupersededRefreshState(scopedOptions, trigger, runContext);
    return {
      ...(baselineCache || {}),
      refreshTrigger: trigger,
      refreshInProgress: false,
      refreshSuperseded: true,
    };
  }
  refreshAccumulator = baselineCache;
  const cacheAgeMs = Number(baselineCache?.cacheAgeMs);
  const canReuseFreshViewCache = trigger === 'view'
    && options.force !== true
    && marketRowCount(baselineCache || {}) > 0
    && baselineCache?.cacheStale !== true
    && Number.isFinite(cacheAgeMs)
    && cacheAgeMs <= VIEW_CACHE_MAX_AGE_MS;
  if (canReuseFreshViewCache) {
    return {
      ...baselineCache,
      status: baselineCache.status === 'partial' ? 'partial' : 'ready',
      statusLabel: baselineCache.statusLabel || '已显示最新市场热缓存',
      refreshTrigger: 'view-cache',
      refreshInProgress: false,
      refreshOutcome: 'cached',
      refreshOutcomeLabel: '已显示最新热缓存',
      cacheState: 'cached',
      isCached: true,
    };
  }
  if (!isSearch) {
    runContext.remoteStarted = true;
    await persistRefreshState(scopedOptions, {
      status: 'syncing',
      lastAttemptAt: attemptAt,
      lastError: null,
      failedRoutes: [],
    }, browserOptions.signal);
    if (runContext.isActive?.() === false || runContext.isSuperseded?.() === true) {
      await persistSupersededRefreshState(scopedOptions, trigger, runContext);
      return {
        ...(baselineCache || {}),
        refreshTrigger: trigger,
        refreshInProgress: false,
        refreshSuperseded: true,
      };
    }
  }
  const callerProgress = browserOptions.onProgress;
  if (isSearch || browserOptions.autoNavigate === true) {
    browserOptions.onProgress = async (progressData, route) => {
      if (runContext.isActive?.() === false || runContext.isSuperseded?.() === true) return;
      const rawProgress = {
        ...progressData,
        cacheState: 'live',
        isCached: false,
        cacheUpdatedAt: attemptAt,
        cacheAgeMs: 0,
        cacheStale: false,
      };
      const merged = isSearch
        ? { data: rawProgress, fallbackSections: [] }
        : mergeLiveMarketDataWithCache(rawProgress, refreshAccumulator || baselineCache);
      const liveProgress = {
        ...merged.data,
        ...(marketCacheText(browserOptions.profileId || merged.data.profileId || baselineCache?.profileId)
          ? { profileId: marketCacheText(browserOptions.profileId || merged.data.profileId || baselineCache?.profileId) }
          : {}),
        ...(marketCacheText(options.shopId || browserOptions.shopId || baselineCache?.shopId)
          ? { shopId: marketCacheText(options.shopId || browserOptions.shopId || baselineCache?.shopId) }
          : {}),
        status: isSearch ? 'searching' : 'refreshing',
        statusLabel: isSearch ? '正在获取搜索结果' : '正在获取全部市场分类',
        lastAttemptAt: attemptAt,
        lastCaptureAt: newestTime(merged.data.updatedAt, baselineCache?.lastCaptureAt, baselineCache?.updatedAt),
        refreshTrigger: trigger,
        refreshInProgress: true,
        cacheState: merged.data.cacheState || (merged.fallbackSections.length ? 'mixed' : 'live'),
        isCached: merged.data.isCached === true,
        cacheUpdatedAt: attemptAt,
        cacheAgeMs: 0,
        cacheStale: false,
      };
      refreshAccumulator = liveProgress;
      // Progress is intentionally not persisted.  A crash or restart must
      // always fall back to the previous complete snapshot, never a half route.
      emitMarketCacheUpdate(liveProgress);
      await callerProgress?.(liveProgress, route);
    };
  }

  const data = await readDataAnalysisMarketBrowserData(browserOptions);
  if (runContext.isActive?.() === false || runContext.isSuperseded?.() === true) {
    await persistSupersededRefreshState(scopedOptions, trigger, runContext);
    return {
      ...(baselineCache || data),
      refreshTrigger: trigger,
      refreshInProgress: false,
      refreshSuperseded: true,
    };
  }
  const completedAt = new Date().toISOString();
  if (isSearch || marketCacheText(data.captureMode) === 'search') {
    const searchRows = marketRowCount(data);
    const searchData = {
      ...data,
      ...(marketCacheText(browserOptions.profileId || data.profileId)
        ? { profileId: marketCacheText(browserOptions.profileId || data.profileId) }
        : {}),
      ...(marketCacheText(options.shopId || browserOptions.shopId)
        ? { shopId: marketCacheText(options.shopId || browserOptions.shopId) }
        : {}),
      status: searchRows ? 'ready' : 'empty',
      statusLabel: searchRows ? '搜索结果已更新' : 'Ozon 未返回匹配数据',
      lastAttemptAt: attemptAt,
      lastCaptureAt: marketCacheText(data.updatedAt),
      lastCompletedAt: completedAt,
      refreshOutcome: searchRows ? 'updated' : 'empty',
      refreshOutcomeLabel: searchRows ? '搜索完成' : '搜索完成，未返回匹配数据',
      refreshTrigger: trigger,
      refreshInProgress: false,
      searchEphemeral: true,
      cachePersisted: false,
      cacheState: 'live',
      isCached: false,
      cacheUpdatedAt: completedAt,
      cacheAgeMs: 0,
      cacheStale: false,
    };
    emitMarketCacheUpdate(searchData);
    return searchData;
  }

  const routeResults = Array.isArray(data.routeResults) ? data.routeResults : [];
  const incompleteRouteResults = routeResults.filter((route) => {
    const status = marketCacheText(route?.status);
    return status === 'failed' || status === 'partial' || route?.complete === false;
  });
  const failedRoutes = incompleteRouteResults
    .map((route) => marketCacheText(route?.routeId))
    .filter(Boolean);
  const incompleteDatasets = [...new Set(incompleteRouteResults.flatMap((route) => {
    const explicit = Array.isArray(route?.incompleteDatasets) ? route.incompleteDatasets : [];
    const affected = explicit.length ? explicit : Array.isArray(route?.datasets) ? route.datasets : [];
    return affected.map(marketCacheText).filter(Boolean);
  }))];
  const captureComplete = failedRoutes.length === 0 && data.captureIntegrity?.complete !== false;
  const safePartialCapture = incompleteRouteResults.length > 0
    && incompleteRouteResults.every((route) => route?.safeToPersist === true);
  const safePartialDatasets = [...new Set(incompleteRouteResults.flatMap((route) => (
    Array.isArray(route?.safePartialDatasets) ? route.safePartialDatasets : []
  )).map(marketCacheText).filter(Boolean))];
  const paginationWarnings = incompleteRouteResults.flatMap((route) => (
    Array.isArray(route?.paginationWarnings) ? route.paginationWarnings : []
  ));

  // Only a completed route pass is authoritative for replacement.  A route
  // whose pagination was interrupted may still contain its first 10/50 rows;
  // those rows are useful for the current view but must be unioned with the
  // trusted cache instead of shrinking it.
  const merged = mergeLiveMarketDataWithCache(
    data,
    refreshAccumulator || baselineCache,
    {
      replaceLiveDatasets: true,
      preserveLiveDatasetIds: incompleteDatasets,
    },
  );
  const liveCaptureAt = marketCacheText(data.updatedAt);
  const previousCaptureAt = marketCacheText(baselineCache?.lastCaptureAt || baselineCache?.updatedAt);
  const liveRows = marketRowCount(data);
  const lastCaptureAt = captureComplete || safePartialCapture
    ? newestTime(liveCaptureAt, previousCaptureAt)
    : previousCaptureAt || liveCaptureAt;
  const hasRows = marketRowCount(merged.data) > 0;
  // A failed pagination pass is not authoritative by itself.  Once it has
  // been unioned with the last confirmed snapshot, however, the merged
  // snapshot is still complete and safe to reuse: refreshed first-page rows
  // advance while the old long dataset is retained instead of shrinking.
  const mergedSnapshotComplete = captureComplete || (safePartialCapture && hasRows);
  const captureAdvanced = parsedTime(liveCaptureAt) > parsedTime(previousCaptureAt);
  const dataChanged = marketFingerprint(data) !== marketFingerprint(baselineCache || {});
  const outcome = failedRoutes.length
    ? 'partial'
    : captureAdvanced || dataChanged && marketRowCount(data) > 0
      ? 'updated'
      : hasRows
        ? 'unchanged'
        : 'empty';
  const liveData = {
    ...merged.data,
    profileId: requestedScope.profileId,
    ...(baselineCache?.legacyGlobalFallback === true
      ? {
          legacyGlobalMigration: {
            sourceKey: requestedScope.profileId,
            sourceRowCount: marketRowCount(baselineCache),
            sourceUpdatedAt: marketCacheText(baselineCache.cacheUpdatedAt || baselineCache.updatedAt),
          },
        }
      : {}),
    ...(marketCacheText(options.shopId || browserOptions.shopId || baselineCache?.shopId)
      ? { shopId: marketCacheText(options.shopId || browserOptions.shopId || baselineCache?.shopId) }
      : {}),
    status: failedRoutes.length && hasRows ? 'partial' : hasRows ? 'ready' : 'empty',
    statusLabel: refreshOutcomeLabel(outcome),
    updatedAt: lastCaptureAt,
    lastAttemptAt: attemptAt,
    lastCaptureAt,
    lastCompletedAt: completedAt,
    refreshOutcome: outcome,
    refreshOutcomeLabel: refreshOutcomeLabel(outcome),
    refreshTrigger: trigger,
    refreshInProgress: false,
    captureMode: 'full-market',
    captureIntegrity: {
      schemaVersion: 1,
      refreshRunId,
      captureMode: 'full-market',
      complete: mergedSnapshotComplete,
      routePassComplete: captureComplete,
      safeToPersist: mergedSnapshotComplete,
      safePartial: safePartialCapture,
      completedAt,
      datasets: datasetCoverage(merged.data),
      failedRoutes,
      incompleteDatasets,
      safePartialDatasets,
      paginationWarnings,
    },
    cacheState: !captureComplete && baselineCache ? 'mixed' : merged.data.cacheState || (baselineCache ? 'mixed' : 'live'),
    isCached: !captureComplete && Boolean(baselineCache) || outcome !== 'updated' && Boolean(baselineCache),
    cacheUpdatedAt: !captureComplete && baselineCache
      ? marketCacheText(baselineCache.cacheUpdatedAt || baselineCache.updatedAt)
      : completedAt,
    cacheAgeMs: 0,
    cacheStale: false,
  };
  refreshAccumulator = liveData;
  if (!hasRows || !mergedSnapshotComplete) {
    liveData.cachePersisted = false;
    emitMarketCacheUpdate(liveData);
    await persistRefreshState(scopedOptions, {
      status: failedRoutes.length ? 'partial' : 'failed',
      lastAttemptAt: attemptAt,
      lastError: refreshErrorState(null, failedRoutes),
      failedRoutes,
    });
    return liveData;
  }
  try {
    await retryMarketCacheWrite(() => saveDataAnalysisMarketCache(liveData, {
        ...(options.cache || {}),
        timeoutMs: options.cache?.timeoutMs ?? MARKET_CACHE_WRITE_TIMEOUT_MS,
        verifiedScope: requestedScope,
        ...(browserOptions.signal ? { signal: browserOptions.signal } : {}),
        ...(marketCacheText(browserOptions.profileId || liveData.profileId)
          ? { profileId: marketCacheText(browserOptions.profileId || liveData.profileId) }
          : {}),
        ...(marketCacheText(options.shopId || browserOptions.shopId || liveData.shopId)
          ? { shopId: marketCacheText(options.shopId || browserOptions.shopId || liveData.shopId) }
          : {}),
      }), {
      signal: browserOptions.signal,
      retryDelayMs: options.persistenceRetryDelayMs,
    });
    liveData.cachePersisted = true;
    liveData.cacheUpdatedAt = completedAt;
    liveData.cacheAgeMs = 0;
  } catch (error) {
    liveData.cachePersisted = false;
    liveData.cacheWriteError = error;
  }
  if (runContext.isActive?.() !== false && runContext.isSuperseded?.() !== true) {
    emitMarketCacheUpdate(liveData);
  }
  if (runContext.isActive?.() !== false && runContext.isSuperseded?.() !== true) {
    await persistRefreshState(scopedOptions, liveData.cachePersisted === false
      ? {
        status: failedRoutes.length ? 'partial' : 'failed',
        lastAttemptAt: attemptAt,
        lastError: refreshErrorState(liveData.cacheWriteError, failedRoutes),
        failedRoutes,
      }
      : failedRoutes.length
        ? {
          status: 'partial',
          lastAttemptAt: attemptAt,
          lastError: refreshErrorState(null, failedRoutes),
          failedRoutes,
        }
        : {
          status: 'success',
          lastAttemptAt: attemptAt,
          lastSuccessAt: completedAt,
          lastError: null,
          failedRoutes: [],
        });
  }
  return liveData;
}

export function refreshDataAnalysisMarketHotCache(options = {}) {
  const trigger = marketCacheText(options.trigger) || (marketCacheText(options.browser?.query) ? 'search' : 'automatic');
  const normalizedOptions = { ...options, trigger };
  const laneKey = refreshLaneKey(normalizedOptions);
  const taskKey = refreshTaskKey(trigger, normalizedOptions);
  const interactive = ['manual', 'search'].includes(trigger);
  const profileKey = browserRefreshLaneKey(normalizedOptions);
  const lane = refreshLanes.get(laneKey) || {
    tasks: new Map(),
    latestInteractiveSequence: 0,
    profileKey,
  };
  refreshLanes.set(laneKey, lane);
  const existing = lane.tasks.get(taskKey);
  if (existing) return existing.promise;

  const sequence = ++refreshRunSequence;
  if (interactive) {
    lane.latestInteractiveSequence = sequence;
    cancelPassiveBrowserRefreshes(profileKey);
    refreshLanes.set(laneKey, lane);
  }
  const abortController = typeof AbortController === 'function' ? new AbortController() : null;
  let active = true;
  const runContext = {
    isActive: () => active,
    isSuperseded: () => !interactive && lane.latestInteractiveSequence > sequence,
    remoteStarted: false,
    terminationReason: '',
    supersededStatePersisted: false,
    refreshRunId: `${Date.now().toString(36)}-${sequence.toString(36)}`,
  };
  const browser = {
    ...(normalizedOptions.browser || {}),
    ...(abortController && !normalizedOptions.browser?.signal ? { signal: abortController.signal } : {}),
  };
  const scopedOptions = { ...normalizedOptions, browser };
  const promise = enqueueBrowserRefresh(scopedOptions, () => {
    const execution = executeMarketRefresh(scopedOptions, runContext).catch(async (error) => {
      if (runContext.isActive() === false || runContext.isSuperseded() === true) {
        await persistSupersededRefreshState(scopedOptions, trigger, runContext);
        return {
          status: 'superseded',
          statusLabel: '已让位给当前手动操作',
          refreshTrigger: trigger,
          refreshInProgress: false,
          refreshSuperseded: true,
        };
      }
      if (runContext.remoteStarted && trigger !== 'search') {
        await persistRefreshState(scopedOptions, {
          status: 'failed',
          lastAttemptAt: runContext.attemptAt,
          lastError: refreshErrorState(error),
          failedRoutes: [],
        });
      }
      throw error;
    });
    return runWithTimeout(execution, refreshTimeoutMs(trigger, normalizedOptions), () => {
      runContext.terminationReason = 'timeout';
      active = false;
      if (runContext.remoteStarted && trigger !== 'search') {
        void persistRefreshState(scopedOptions, {
          status: 'failed',
          lastAttemptAt: runContext.attemptAt,
          lastError: refreshErrorState(createRefreshTimeoutError(refreshTimeoutMs(trigger, normalizedOptions))),
          failedRoutes: [],
        });
      }
      abortController?.abort();
    });
  });
  lane.tasks.set(taskKey, {
    promise,
    sequence,
    interactive,
    cancel() {
      runContext.terminationReason = 'superseded';
      active = false;
      abortController?.abort();
    },
  });
  void promise.finally(() => {
    active = false;
    const current = lane.tasks.get(taskKey);
    if (current?.promise === promise) lane.tasks.delete(taskKey);
    if (!lane.tasks.size) refreshLanes.delete(laneKey);
  }).catch(() => undefined);
  return promise;
}
