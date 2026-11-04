import { getOzonSnapshotSourceKey } from '../../../entities/order/orderShopScope.jsx';
import {
  getProductListPageCacheKeyForScopeKey,
  PRODUCT_PAGE_SIZE_OPTIONS,
  writeProductListPageMemoryCache,
} from '../../../entities/product/productLocalData.jsx';
import { readLocalApiProductPage } from '../../../entities/product/productLocalMirror.jsx';
import { productStatusTabs } from '../../../shared/ozon/ozonRuntime.jsx';

export const PRODUCT_LIST_RENDERER_HOT_CACHE_INTERVAL_MS = 4 * 60 * 1000;
export const PRODUCT_LIST_RENDERER_INITIAL_DELAY_MS = 12_000;
const PRODUCT_LIST_RENDERER_WARM_CONCURRENCY = 1;
const PRODUCT_LIST_SQLITE_READ_TIMEOUT_MS = 15_000;

function normalizeProductHotCacheShops(shops = []) {
  const byId = new Map();
  (Array.isArray(shops) ? shops : []).forEach((shop) => {
    const shopId = String(shop?.id || '').trim();
    if (shopId && !byId.has(shopId)) byId.set(shopId, shop);
  });
  return [...byId.values()];
}

export function buildProductHotCacheScopes(shops = []) {
  const normalized = normalizeProductHotCacheShops(shops);
  if (normalized.length <= 1) return normalized.map((shop) => [shop]);
  return [...normalized.map((shop) => [shop]), normalized];
}

async function runWithProductWarmConcurrency(tasks = [], concurrency = PRODUCT_LIST_RENDERER_WARM_CONCURRENCY) {
  let cursor = 0;
  const results = new Array(tasks.length);
  const worker = async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), tasks.length) }, () => worker())
  );
  return results;
}

/**
 * Reads only the durable SQLite product cache and keeps the first product-list
 * page warm in renderer memory. Remote Ozon traffic remains owned by the
 * local-api continuous-sync scheduler.
 */
export async function warmProductListHotCacheFromSqlite(shops = [], options = {}) {
  const scopes = buildProductHotCacheScopes(shops);
  if (!scopes.length) return { ok: true, warmed: 0, empty: 0, failed: 0, scopes: [] };

  const selectedTab = productStatusTabs[0];
  const pageSize = PRODUCT_PAGE_SIZE_OPTIONS[0];
  const readPage = options.readPage || readLocalApiProductPage;
  const writePage = options.writePage || writeProductListPageMemoryCache;
  const tasks = scopes.map((scopeShops) => async () => {
    const scopeKey = getOzonSnapshotSourceKey(scopeShops);
    try {
      const page = await readPage(scopeShops, selectedTab, {
        page: 1,
        pageSize,
        keyword: '',
        sort: 'stable',
        filters: {},
        timeoutMs: options.timeoutMs || PRODUCT_LIST_SQLITE_READ_TIMEOUT_MS,
      });
      const rows = Array.isArray(page?.rows) ? page.rows : [];
      const cacheKey = getProductListPageCacheKeyForScopeKey(
        scopeKey,
        selectedTab.visibility,
        pageSize,
        1,
        '',
        'stable',
        ''
      );
      writePage(cacheKey, rows, {
        scopeKey,
        status: selectedTab.label,
        keyword: '',
        page: 1,
        pageSize,
        sort: 'stable',
        filterSignature: '',
        statusCounts: page?.counts || null,
        total: Number(page?.total) || rows.length,
        source: 'sqlite-startup-hot-cache',
      });
      return { ok: true, scopeKey, rows: rows.length };
    } catch (error) {
      return {
        ok: false,
        scopeKey,
        rows: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const results = await runWithProductWarmConcurrency(
    tasks,
    options.concurrency || PRODUCT_LIST_RENDERER_WARM_CONCURRENCY
  );
  return {
    ok: results.every((result) => result.ok),
    warmed: results.filter((result) => result.ok && result.rows > 0).length,
    empty: results.filter((result) => result.ok && result.rows === 0).length,
    failed: results.filter((result) => !result.ok).length,
    scopes: results,
  };
}

export function startProductListHotCacheRuntime(options = {}) {
  const getShops = typeof options.getShops === 'function' ? options.getShops : () => options.shops || [];
  const warm = options.warm || warmProductListHotCacheFromSqlite;
  const setIntervalImpl = options.setIntervalImpl || globalThis.setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || globalThis.clearInterval;
  const setTimeoutImpl = options.setTimeoutImpl || globalThis.setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || globalThis.clearTimeout;
  const initialDelayMs = Number.isFinite(Number(options.initialDelayMs))
    ? Math.max(Number(options.initialDelayMs), 0)
    : PRODUCT_LIST_RENDERER_INITIAL_DELAY_MS;
  const intervalMs = Math.max(
    Number(options.intervalMs) || PRODUCT_LIST_RENDERER_HOT_CACHE_INTERVAL_MS,
    30_000
  );
  let stopped = false;
  let inFlight = null;

  const run = () => {
    if (stopped) return Promise.resolve({ ok: false, stopped: true });
    if (inFlight) return inFlight;
    inFlight = Promise.resolve(warm(getShops(), options))
      .then((result) => {
        if (result?.failed && typeof options.onError === 'function') {
          const details = (result.scopes || [])
            .filter((scope) => !scope.ok)
            .map((scope) => `${scope.scopeKey}: ${scope.error}`)
            .join('；');
          options.onError(new Error(`商品列表本地热缓存有 ${result.failed} 个店铺范围读取失败。${details}`));
        }
        return result;
      })
      .catch((error) => {
        options.onError?.(error);
        return { ok: false, failed: 1, error };
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const startupTimer = initialDelayMs === 0
    ? (void run(), null)
    : setTimeoutImpl?.(() => void run(), initialDelayMs);
  startupTimer?.unref?.();
  const timer = setIntervalImpl?.(() => {
    void run();
  }, intervalMs);
  timer?.unref?.();

  return () => {
    stopped = true;
    if (startupTimer != null) clearTimeoutImpl?.(startupTimer);
    if (timer != null) clearIntervalImpl?.(timer);
  };
}
