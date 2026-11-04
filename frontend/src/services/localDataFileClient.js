import { safeWarn } from './safeLog';
import {
  LOCAL_AFTER_SALES_DISPLAY_SNAPSHOT_FILE_KEY,
  LOCAL_DATA_API_BASE,
  LOCAL_DATA_FILE_READ_CACHE_TTL_MS,
  LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY,
  LOCAL_MIRROR_READ_LOG_FILE_KEY,
  LOCAL_MIRROR_RETRY_QUEUE_FILE_KEY,
  LOCAL_OZON_SHOP_SETTINGS_FILE_KEY,
  LOCAL_OZON_DATA_LAYER_FILE_KEY,
  LOCAL_PROFIT_DATA_FILE_KEY,
  LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY,
  localDataFileReadCache,
} from '../shared/config/appConfigCore.jsx';

const RETIRED_PURCHASE_PLUGIN_CONTEXT_ROUTE = '/legacy-migration-api/purchase-source-plugin-context';
const RETIRED_PURCHASE_PLUGIN_CONTEXT_MARKER_NAMESPACE = 'purchase-plugin-context';
const RETIRED_MARKETING_ACTIVITY_CACHE_ROUTE = '/legacy-migration-api/marketing-activity-cache';

// Closed boundary for every former generic JSON business store.  The mapping
// still exists in the desktop/Vite hosts as an audit tombstone, but runtime
// reads and writes must use local-api + SQLite only.
const FROZEN_LEGACY_LOCAL_DATA_FILE_KEYS = new Set([
  LOCAL_OZON_DATA_LAYER_FILE_KEY,
  LOCAL_PROFIT_DATA_FILE_KEY,
  LOCAL_AFTER_SALES_DISPLAY_SNAPSHOT_FILE_KEY,
  LOCAL_MIRROR_READ_LOG_FILE_KEY,
  LOCAL_MIRROR_RETRY_QUEUE_FILE_KEY,
  LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY,
  LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY,
  LOCAL_OZON_SHOP_SETTINGS_FILE_KEY,
  'sales-source-links',
  'product-material-profiles',
  'product-source-links',
  'purchase-source-links',
  'purchase-order-local-overrides',
  'cross-border-bus-order-records',
  'browser-local-storage',
]);

export function isBlockedLegacyLocalDataFileKey(key) {
  const normalizedKey = String(key || '').trim();
  return FROZEN_LEGACY_LOCAL_DATA_FILE_KEYS.has(normalizedKey);
}

export async function requestLocalDataFile(key, options = {}) {
  if (typeof window === 'undefined') return {};
  const method = options.method || 'GET';
  const cacheKey = String(key || '').trim();
  if (isBlockedLegacyLocalDataFileKey(cacheKey)) {
    localDataFileReadCache.delete(cacheKey);
    if (method !== 'GET') {
      safeWarn('[local-data] 已阻断退役 JSON 缓存写入', { key: cacheKey, method });
    }
    return {};
  }
  if (method === 'GET' && cacheKey) {
    const cached = localDataFileReadCache.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < LOCAL_DATA_FILE_READ_CACHE_TTL_MS) return cached.promise;
  } else if (cacheKey) {
    localDataFileReadCache.delete(cacheKey);
  }

  const requestPromise = (async () => {
    const response = await fetch(`${LOCAL_DATA_API_BASE}/${encodeURIComponent(key)}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: options.data ? JSON.stringify(options.data) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) throw new Error(payload?.message || 'Local data request failed');
    return payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};
  })();

  if (method === 'GET' && cacheKey) {
    localDataFileReadCache.set(cacheKey, { savedAt: Date.now(), promise: requestPromise });
    requestPromise.catch(() => {
      if (localDataFileReadCache.get(cacheKey)?.promise === requestPromise) localDataFileReadCache.delete(cacheKey);
    });
  }
  return requestPromise;
}

export function readLocalDataFile(key) {
  return requestLocalDataFile(key);
}

export function writeLocalDataFile(key, data) {
  return requestLocalDataFile(key, { method: 'PUT', data });
}

/**
 * The retired purchase-plugin JSON is intentionally outside the generic
 * local-data API. Only its migration owner may read the old payload and replace
 * it with this fixed marker after a profile SQLite readback succeeds.
 */
async function requestRetiredPurchasePluginContext(method, data) {
  if (typeof window === 'undefined') return {};
  const response = await fetch(RETIRED_PURCHASE_PLUGIN_CONTEXT_ROUTE, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || 'Retired purchase plugin context migration request failed');
  }
  return payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};
}

export function readRetiredPurchasePluginContextFile(key = LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY) {
  if (String(key || '').trim() !== LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY) {
    return Promise.reject(new Error('Retired purchase plugin context key is fixed.'));
  }
  return requestRetiredPurchasePluginContext('GET');
}

export async function writeRetiredPurchasePluginContextMarker(
  key = LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY,
  marker = {}
) {
  if (String(key || '').trim() !== LOCAL_PURCHASE_PLUGIN_SOURCE_CONTEXT_FILE_KEY) {
    throw new Error('Retired purchase plugin context key is fixed.');
  }
  const validMarker =
    marker &&
    typeof marker === 'object' &&
    !Array.isArray(marker) &&
    Object.keys(marker).length === 3 &&
    marker.migration === 'profile-settings' &&
    marker.namespace === RETIRED_PURCHASE_PLUGIN_CONTEXT_MARKER_NAMESPACE &&
    typeof marker.migratedAt === 'string' &&
    marker.migratedAt.length <= 80;
  if (!validMarker) throw new Error('Retired purchase plugin context marker is invalid.');
  await requestRetiredPurchasePluginContext('PUT', marker);
  return true;
}

/**
 * The retired marketing aggregate is intentionally not exposed through the
 * generic local-data API.  Its migration owner receives the exact opaque file
 * revision and can only issue a conditional whole-file removal after a SQLite
 * POST -> independent GET proof.  It can never write a replacement aggregate.
 */
async function requestRetiredMarketingActivityCache(method, data) {
  if (typeof window === 'undefined') return { data: {}, revision: '', exists: false };
  const response = await fetch(RETIRED_MARKETING_ACTIVITY_CACHE_ROUTE, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.message || 'Retired marketing activity cache migration request failed');
    error.code = payload?.code || payload?.error?.code || '';
    error.payload = payload;
    throw error;
  }
  return {
    data: payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {},
    revision: typeof payload?.revision === 'string' ? payload.revision : '',
    exists: payload?.exists === true,
  };
}

export async function readRetiredMarketingActivityCacheFile(key = LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY) {
  if (String(key || '').trim() !== LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY) {
    throw new Error('Retired marketing activity cache key is fixed.');
  }
  const result = await requestRetiredMarketingActivityCache('GET');
  if (!/^[a-f0-9]{64}$/u.test(result.revision)) {
    throw new Error('Retired marketing activity cache revision is invalid.');
  }
  return result;
}

/**
 * Deletes the entire old aggregate only if it is exactly the file that was
 * independently validated.  A 409 is surfaced to the caller so it can retain
 * the old source and report the cleanup conflict rather than retrying blindly.
 */
export async function clearRetiredMarketingActivityCacheFile(
  key = LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY,
  expectedRevision = ''
) {
  if (String(key || '').trim() !== LOCAL_MARKETING_ACTIVITY_CACHE_FILE_KEY) {
    throw new Error('Retired marketing activity cache key is fixed.');
  }
  if (!/^[a-f0-9]{64}$/u.test(String(expectedRevision))) {
    throw new Error('Retired marketing activity cache expected revision is invalid.');
  }
  const result = await requestRetiredMarketingActivityCache('PUT', { expectedRevision: String(expectedRevision) });
  if (result.exists || Object.keys(result.data).length) {
    throw new Error('Retired marketing activity cache conditional removal did not clear the source.');
  }
  return true;
}
