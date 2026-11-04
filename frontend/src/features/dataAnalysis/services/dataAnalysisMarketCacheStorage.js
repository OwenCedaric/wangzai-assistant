import {
  deleteDataAnalysisCacheSnapshot,
  readDataAnalysisCache,
  resolveDataAnalysisMarketProfileScope,
  saveDataAnalysisCacheSnapshot,
  saveDataAnalysisCacheSyncState,
} from './dataAnalysisCacheClient.js';
import { compactMarketData } from '../lib/dataAnalysisMarketCacheCodec.js';
import { marketCacheText, marketRowCount } from '../lib/dataAnalysisMarketCacheValue.js';

export const DATA_ANALYSIS_MARKET_CACHE_EVENT = 'wangzai:ozon-market-cache-updated';
export const DATA_ANALYSIS_MARKET_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const ANALYSIS_TYPE = 'ozon-browser-market';
const SOURCE_TYPE = 'ozon-browser-capture';
const DEFAULT_SOURCE_KEY = 'default-profile';
const MARKET_PROFILE_SCOPE_TIMEOUT_MS = 30_000;
const VERIFIED_MARKET_SCOPE = Symbol('verified-data-analysis-market-scope');

function scopeText(value) {
  return marketCacheText(value);
}

function verifyProvidedScope(input = {}, options = {}) {
  const scope = options.verifiedScope;
  if (!scope || scope[VERIFIED_MARKET_SCOPE] !== true) return null;
  const requestedProfileId = scopeText(input.profileId);
  const requestedShopId = scopeText(input.shopId);
  if (requestedProfileId && requestedProfileId !== scope.profileId) {
    throw new Error('DATA_ANALYSIS_MARKET_PROFILE_SCOPE_MISMATCH');
  }
  if (requestedShopId && requestedShopId !== scope.shopId) {
    throw new Error('DATA_ANALYSIS_MARKET_SHOP_SCOPE_MISMATCH');
  }
  return scope;
}

export async function resolveDataAnalysisMarketScope(input = {}, options = {}) {
  const scope = await resolveDataAnalysisMarketProfileScope(input, {
    ...options,
    timeoutMs: options.scopeTimeoutMs ?? options.timeoutMs ?? MARKET_PROFILE_SCOPE_TIMEOUT_MS,
  });
  return Object.freeze({
    profileId: scopeText(scope.profileId),
    shopId: scopeText(scope.shopId),
    [VERIFIED_MARKET_SCOPE]: true,
  });
}

async function resolveMarketScope(input = {}, options = {}) {
  return verifyProvidedScope(input, options)
    || resolveDataAnalysisMarketScope(input, options);
}

export function emitMarketCacheUpdate(data) {
  if (
    typeof globalThis.window?.dispatchEvent !== 'function'
    || typeof globalThis.CustomEvent !== 'function'
  ) return;
  globalThis.window.dispatchEvent(new CustomEvent(DATA_ANALYSIS_MARKET_CACHE_EVENT, {
    detail: { data },
  }));
}

export async function readDataAnalysisMarketCache(options = {}) {
  const scope = await resolveMarketScope({
    profileId: options.profileId,
    shopId: options.shopId,
  }, options);
  const exactPayload = await readDataAnalysisCache({
    shopId: scope.shopId,
    analysisType: ANALYSIS_TYPE,
    sourceType: SOURCE_TYPE,
    sourceKey: scope.profileId,
    limit: options.limit ?? 10,
  }, options);
  const confirmedRows = (payload) => (Array.isArray(payload?.rows) ? payload.rows : [])
    .filter((candidate) => (
      candidate?.payload?.marketData?.sections
      && marketCacheText(candidate?.sourceKey || candidate?.payload?.marketData?.profileId) === scope.profileId
      && candidate?.sourceStatus === 'confirmed_browser_capture'
      && marketCacheText(candidate?.payload?.marketData?.captureMode) !== 'search'
      && candidate?.payload?.marketData?.captureIntegrity?.complete !== false
    ))
    .sort((left, right) => (
      Date.parse(right?.updatedAt || right?.lastSeenAt || 0)
      - Date.parse(left?.updatedAt || left?.lastSeenAt || 0)
    ));
  const exactConfirmedRows = confirmedRows(exactPayload);
  let rows = exactConfirmedRows
    .filter((candidate) => marketCacheText(candidate?.shopId) === scope.shopId);
  let row = rows[0];
  let legacyGlobalFallback = false;
  if (!row) {
    rows = exactConfirmedRows.filter((candidate) => !marketCacheText(candidate?.shopId));
    row = rows[0];
    legacyGlobalFallback = Boolean(row);
  }
  if (!row) {
    const legacyPayload = await readDataAnalysisCache({
      analysisType: ANALYSIS_TYPE,
      sourceType: SOURCE_TYPE,
      sourceKey: scope.profileId,
      legacyGlobalOnly: 1,
      limit: options.limit ?? 10,
    }, options);
    rows = confirmedRows(legacyPayload)
      .filter((candidate) => !marketCacheText(candidate?.shopId));
    row = rows[0];
    legacyGlobalFallback = Boolean(row);
  }
  if (!row) return null;
  const marketData = compactMarketData(row.payload.marketData);
  const cachedAt = marketCacheText(row.updatedAt || row.lastSeenAt || marketData.updatedAt);
  const cachedTime = Date.parse(cachedAt);
  const ageMs = Number.isFinite(cachedTime) ? Math.max(0, Date.now() - cachedTime) : null;
  return {
    ...marketData,
    profileId: scope.profileId,
    shopId: scope.shopId,
    cacheState: 'cached',
    isCached: true,
    cacheUpdatedAt: cachedAt,
    cacheAgeMs: ageMs,
    cacheStale: ageMs === null || ageMs > DATA_ANALYSIS_MARKET_CACHE_TTL_MS,
    legacyGlobalFallback,
    marketRefreshState: exactPayload?.syncState || null,
  };
}

export async function saveDataAnalysisMarketCache(data = {}, options = {}) {
  const compacted = compactMarketData(data);
  const scope = await resolveMarketScope({
    profileId: marketCacheText(compacted.profileId) || options.profileId,
    shopId: marketCacheText(compacted.shopId) || options.shopId,
  }, options);
  const marketData = {
    ...compacted,
    profileId: scope.profileId,
    shopId: scope.shopId,
  };
  const storedAt = new Date().toISOString();
  const sourceKey = marketCacheText(marketData.profileId) || DEFAULT_SOURCE_KEY;
  return saveDataAnalysisCacheSnapshot({
    shopId: scope.shopId,
    analysisType: ANALYSIS_TYPE,
    sourceType: SOURCE_TYPE,
    sourceKey,
    title: 'Ozon 浏览器市场热缓存',
    status: marketData.status,
    rowCount: marketRowCount(marketData),
    summary: {
      observerVersion: marketData.observerVersion,
      endpointCount: marketData.endpointCount,
      datasetCount: marketData.datasetCount,
      confirmedDatasetCount: marketData.confirmedDatasetCount,
    },
    metrics: {
      sections: Object.fromEntries(
        Object.entries(marketData.sections).map(([id, section]) => [id, section.metrics]),
      ),
    },
    payload: { schemaVersion: 1, marketData },
    sourceStatus: 'confirmed_browser_capture',
    sourceSyncedAt: marketData.lastCaptureAt || marketData.updatedAt || storedAt,
    lastSeenAt: storedAt,
    updatedAt: storedAt,
  }, options);
}

export async function deleteDataAnalysisMarketCache(data = {}, options = {}) {
  const scope = await resolveMarketScope({
    profileId: marketCacheText(data.profileId) || options.profileId,
    shopId: marketCacheText(data.shopId) || options.shopId,
  }, options);
  return deleteDataAnalysisCacheSnapshot({
    shopId: scope.shopId,
    analysisType: ANALYSIS_TYPE,
    sourceType: SOURCE_TYPE,
    sourceKey: scope.profileId,
  }, options);
}

export async function saveDataAnalysisMarketRefreshState(state = {}, options = {}) {
  const scope = await resolveMarketScope({
    profileId: marketCacheText(state.profileId) || options.profileId,
    shopId: marketCacheText(state.shopId) || options.shopId,
  }, options);
  const failedRoutes = Array.isArray(state.failedRoutes)
    ? state.failedRoutes.map(marketCacheText).filter(Boolean)
    : [];
  const lastError = state.lastError
    ? {
        ...(typeof state.lastError === 'object'
          ? state.lastError
          : { message: marketCacheText(state.lastError) }),
        failedRoutes,
      }
    : failedRoutes.length
      ? { code: 'OZON_MARKET_REFRESH_PARTIAL', message: '部分市场页面刷新失败。', failedRoutes }
      : null;
  return saveDataAnalysisCacheSyncState({
    shopId: scope.shopId,
    profileId: scope.profileId,
    sourceKey: scope.profileId,
    analysisType: ANALYSIS_TYPE,
    status: marketCacheText(state.status) || 'syncing',
    lastAttemptAt: state.lastAttemptAt || new Date().toISOString(),
    ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
    lastError,
  }, options);
}
