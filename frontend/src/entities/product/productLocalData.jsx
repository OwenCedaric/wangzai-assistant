import { getPurchaseOrderRecordKey } from '../order/purchaseOrderRecordRules.jsx';
import {
  getOzonRowShopScopeValues,
  getOzonShopClientId,
  getOzonShopForOrder,
  getOzonShopLabel,
  getOzonStableShopSourceKey,
} from '../order/orderIdentityRules.jsx';
import { getSalesOrderRecordKey } from '../order/orderRecordRules.jsx';
import { getProfitOrderRecordKey } from '../profit/profitOrderRecordRules.jsx';
import { rowMatchesShopScope } from '../../services/localMirrorDataset';
import {
  mergeDomainSnapshotIntoLocalStore,
  mergeOzonProductSnapshotIntoLocalStore,
  mergeOzonSnapshotIntoLocalStore,
  readDomainSnapshotFromLocalStore,
  readOzonProductSnapshotFromLocalStore,
  readOzonSnapshotFromLocalStore,
} from '../../services/ozonLocalDataLayer';
import {
  isBlockedLegacyLocalDataFileKey,
  readLocalDataFile,
  requestLocalDataFile,
  writeLocalDataFile,
} from '../../services/localDataFileClient.js';
import { LOCAL_OZON_DATA_LAYER_FILE_KEY } from '../../shared/config/appConfigCore.jsx';
import {
  deserializeOzonShopGenerationScope,
  hasCompleteOzonShopGeneration,
  isOzonCacheKeyBlockedByGenerationFence,
  normalizeOzonShopGenerationScope,
  ozonCacheKeyBelongsToOwner,
  serializeOzonShopGenerationScope,
} from '../../shared/ozon/ozonShopGeneration.js';
import {
  normalizeProductStatusLabel,
  ozonProductVisibilityStatusMap,
  productStatusTabs,
} from './productStatusRules.jsx';
import { normalizeImageList, safeImageUrl } from './productImageRules.jsx';

export function getProductStatusLabelByVisibility(visibility) {
  const key = String(visibility || '')
    .trim()
    .toUpperCase();
  return ozonProductVisibilityStatusMap[key] || '';
}

export const productListMemoryCache = new Map();

export const productListPageMetaMemoryCache = new Map();

export const productListCursorMemoryCache = new Map();

// Permanent account removal keeps an exact, process-lifetime binding-generation
// fence. Late callbacks from the removed incarnation stay rejected, while a
// verified rebind using the same local shop id receives a new generation key.
const PRODUCT_LIST_OWNER_FENCE_PREFIX = '__account-removal-owner-fence__:';

function normalizeProductListOwnerScope(value = []) {
  return normalizeOzonShopGenerationScope(value);
}

function productListCacheKeyBelongsToOwner(cacheKey, ownerScope = []) {
  const text = String(cacheKey ?? '');
  const scope = normalizeProductListOwnerScope(ownerScope);
  return ozonCacheKeyBelongsToOwner(text, scope) || scope.identifiers.some((identifier) => (
    text.startsWith(`${PRODUCT_LIST_CACHE_VERSION}:${identifier}:`)
    || text.includes(`${PRODUCT_LIST_CACHE_VERSION}:${identifier}|`)
    || text.includes(`|${identifier}:`)
  ));
}

function getProductListOwnerFences() {
  return [...productListCursorMemoryCache.keys()]
    .filter((key) => String(key).startsWith(PRODUCT_LIST_OWNER_FENCE_PREFIX))
    .map((key) => deserializeOzonShopGenerationScope(String(key).slice(PRODUCT_LIST_OWNER_FENCE_PREFIX.length)));
}

export function fenceProductListCachesForOwnerIdentifiers(ownerScope = []) {
  const scope = normalizeProductListOwnerScope(ownerScope);
  productListCursorMemoryCache.set(
    `${PRODUCT_LIST_OWNER_FENCE_PREFIX}${serializeOzonShopGenerationScope(scope)}`,
    { value: true, savedAt: Number.MAX_SAFE_INTEGER },
  );
  invalidateProductListCachesForOwnerIdentifiers(scope);
  return { fenced: true, remaining: countProductListCachesForOwnerIdentifiers(scope) };
}

export function releaseProductListOwnerFence(ownerScope) {
  return productListCursorMemoryCache.delete(`${PRODUCT_LIST_OWNER_FENCE_PREFIX}${serializeOzonShopGenerationScope(normalizeProductListOwnerScope(ownerScope))}`);
}

export function invalidateProductListCachesForOwnerIdentifiers(ownerScope = []) {
  for (const cache of [productListMemoryCache, productListPageMetaMemoryCache, productListCursorMemoryCache]) {
    for (const key of cache.keys()) {
      if (!String(key).startsWith(PRODUCT_LIST_OWNER_FENCE_PREFIX) && productListCacheKeyBelongsToOwner(key, ownerScope)) cache.delete(key);
    }
  }
}

export function countProductListCachesForOwnerIdentifiers(ownerScope = []) {
  let count = 0;
  for (const cache of [productListMemoryCache, productListPageMetaMemoryCache, productListCursorMemoryCache]) {
    for (const key of cache.keys()) {
      if (!String(key).startsWith(PRODUCT_LIST_OWNER_FENCE_PREFIX) && productListCacheKeyBelongsToOwner(key, ownerScope)) count += 1;
    }
  }
  return count;
}

export const PRODUCT_LIST_CACHE_VERSION = 'ozon-platform-status-v5';

export const WAREHOUSE_SNAPSHOT_CACHE_VERSION = 'ozon-warehouse-v1';

export const PRODUCT_LIST_CACHE_TTL_MS = 5 * 60 * 1000;

export const PRODUCT_PAGE_SIZE_OPTIONS = [20, 30, 50, 100];

export const PRODUCT_MANUAL_REFRESH_PAGE_SIZE = 1000;

export const PRODUCT_MANUAL_REFRESH_MAX_PAGES = 20;

export const PRODUCT_MANUAL_REFRESH_SYNC_MAX_PAGES = 'all';

export function getProductListServerSort(productSort = {}) {
  const key = String(productSort?.key || '')
    .trim()
    .toLowerCase();
  const direction =
    String(productSort?.direction || 'desc')
      .trim()
      .toLowerCase() === 'asc'
      ? 'asc'
      : 'desc';
  if (!key) return 'stable';
  if (['stock', 'price', 'fee', 'profit', 'weight', 'status'].includes(key)) return `${key}_${direction}`;
  if (key === 'updated') return 'updated_desc';
  if (key === 'identity' || key === 'product_id') return 'identity';
  return 'stable';
}

export function createEmptyProductStatusCounts() {
  return Object.fromEntries(productStatusTabs.map((tab) => [tab.label, 0]));
}

export function getProductRowSnapshotVisibilities(product = {}) {
  return getOzonLocalUniqueValues([
    product.productSnapshotVisibility,
    ...(Array.isArray(product.productSnapshotVisibilities) ? product.productSnapshotVisibilities : []),
  ]).map((value) =>
    String(value || '')
      .trim()
      .toUpperCase()
  );
}

export function productMatchesStatusTabForCounts(product = {}, tab = {}) {
  const visibility = String(tab.visibility || '')
    .trim()
    .toUpperCase();
  const visibilities = getProductRowSnapshotVisibilities(product);
  if (visibility === 'ALL') {
    // 软件内“全部商品”是当前店铺所有有效商品，不等同于 Ozon ALL 快照。
    // 下架、待销售、错误、待修改、违规都必须计入全部。
    return true;
  }
  if (visibilities.includes(visibility)) return true;
  return normalizeProductStatusLabel(product?.status || '') === tab.label;
}

export function buildProductStatusCountsFromRows(rows = []) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  return productStatusTabs.reduce((counts, tab) => {
    counts[tab.label] = sourceRows.filter((product) => productMatchesStatusTabForCounts(product, tab)).length;
    return counts;
  }, createEmptyProductStatusCounts());
}

export function mapProductCacheCountsToStatusLabels(cacheCounts = {}) {
  const sourceCounts = cacheCounts && typeof cacheCounts === 'object' && !Array.isArray(cacheCounts) ? cacheCounts : {};
  return productStatusTabs.reduce((counts, tab) => {
    const rawValue = sourceCounts[tab.visibility] ?? sourceCounts[tab.label];
    counts[tab.label] = Number(rawValue) || 0;
    return counts;
  }, createEmptyProductStatusCounts());
}

export function hasProductStatusCountValues(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return false;
  return productStatusTabs.some((tab) => Number(counts[tab.label]) > 0);
}

export function productMatchesShopScope(product = {}, shopScope = 'all') {
  return rowMatchesShopScope(product, shopScope, {
    getRowShop: (row) => [
      ...getOzonRowShopScopeValues(row),
      row.shop,
      row.shopName,
      row.localShopKey,
      row.shopClientId,
      row.shopId,
      row.raw?.entity?.localShopKey,
    ],
  });
}

export function getOzonShopCacheKey(shop) {
  return getOzonStableShopSourceKey(shop);
}

export function getOzonLegacyShopCacheKey(shop) {
  return `${shop?.id || 'shop'}:${shop?.clientId || ''}`;
}

export function getOzonShopCacheKeyCandidates(shop) {
  return getOzonLocalUniqueValues([
    getOzonShopCacheKey(shop),
    ...(hasCompleteOzonShopGeneration(shop) ? [] : [getOzonLegacyShopCacheKey(shop)]),
  ]);
}

export function getProductListCacheKeyForShopKey(shopKey, status) {
  return `${PRODUCT_LIST_CACHE_VERSION}:${shopKey}:${status}`;
}

export function getProductListCacheKey(shop, status) {
  return getProductListCacheKeyForShopKey(getOzonShopCacheKey(shop), status);
}

export function getProductListCacheKeyCandidates(shop, status) {
  return getOzonShopCacheKeyCandidates(shop).map((shopKey) => getProductListCacheKeyForShopKey(shopKey, status));
}

function getProductListPageCacheSuffix(pageSize, page, keyword = '', sort = 'stable', filterSignature = '') {
  const keywordPart = String(keyword || '').trim();
  const keywordKey = keywordPart ? `:kw:${encodeURIComponent(keywordPart).slice(0, 200)}` : '';
  const sortKey = String(sort || 'stable').trim() || 'stable';
  const normalizedFilterSignature = String(filterSignature || '').trim();
  const filterKey = normalizedFilterSignature
    ? `:filters:${encodeURIComponent(normalizedFilterSignature).slice(0, 1200)}`
    : '';
  return `:${pageSize || PRODUCT_PAGE_SIZE_OPTIONS[0]}:${page || 1}:sort:${sortKey}${keywordKey}${filterKey}`;
}

export function getProductListPageCacheKey(
  shop,
  status,
  pageSize,
  page,
  keyword = '',
  sort = 'stable',
  filterSignature = ''
) {
  return `${getProductListCacheKey(shop, status)}${getProductListPageCacheSuffix(
    pageSize,
    page,
    keyword,
    sort,
    filterSignature
  )}`;
}

export function getProductListPageCacheKeyForScopeKey(
  scopeKey,
  status,
  pageSize,
  page,
  keyword = '',
  sort = 'stable',
  filterSignature = ''
) {
  const normalizedScopeKey = String(scopeKey || '').trim();
  return `${getProductListCacheKeyForShopKey(normalizedScopeKey || 'empty-scope', status)}${getProductListPageCacheSuffix(
    pageSize,
    page,
    keyword,
    sort,
    filterSignature
  )}`;
}

export function getProductListPageCacheKeyCandidates(
  shop,
  status,
  pageSize,
  page,
  keyword = '',
  sort = 'stable',
  filterSignature = ''
) {
  return getProductListCacheKeyCandidates(shop, status).map((cacheKey) => {
    return `${cacheKey}${getProductListPageCacheSuffix(pageSize, page, keyword, sort, filterSignature)}`;
  });
}

export function getProductListFullCacheKey(shop, status) {
  return `${getProductListCacheKey(shop, status)}:full`;
}

export function getProductListCursorCacheKey(shop, status, pageSize) {
  return `${getProductListCacheKey(shop, status)}:${pageSize || PRODUCT_PAGE_SIZE_OPTIONS[0]}:cursors`;
}

export function getOzonWarehouseConfigSnapshotKeyForShopKey(shopKey) {
  return `${WAREHOUSE_SNAPSHOT_CACHE_VERSION}:ozon-warehouse-config:${shopKey}`;
}

export function getOzonWarehouseProductsSnapshotKeyForShopKey(shopKey) {
  return `${WAREHOUSE_SNAPSHOT_CACHE_VERSION}:ozon-warehouse-products:${shopKey}:all`;
}

export function getOzonWarehouseConfigSnapshotKey(shop) {
  return getOzonWarehouseConfigSnapshotKeyForShopKey(getOzonShopCacheKey(shop));
}

export function getOzonWarehouseConfigSnapshotKeyCandidates(shop) {
  return getOzonShopCacheKeyCandidates(shop).map(getOzonWarehouseConfigSnapshotKeyForShopKey);
}

export function getOzonWarehouseProductsSnapshotKey(shop) {
  return getOzonWarehouseProductsSnapshotKeyForShopKey(getOzonShopCacheKey(shop));
}

export function getOzonWarehouseProductsSnapshotKeyCandidates(shop) {
  return getOzonShopCacheKeyCandidates(shop).map(getOzonWarehouseProductsSnapshotKeyForShopKey);
}

export function readTimedCache(cache, key, ttl) {
  const item = cache.get(key);
  if (!item || Date.now() - item.savedAt > ttl) return null;
  return item.value;
}

export function readTimedCacheCandidates(cache, keys, ttl) {
  for (const key of getOzonLocalSnapshotKeyCandidates(keys)) {
    const value = readTimedCache(cache, key, ttl);
    if (value !== null) return value;
  }
  return null;
}

export function writeTimedCache(cache, key, value) {
  cache.set(key, { value, savedAt: Date.now() });
}

export function writeProductListPageMemoryCache(cacheKey, rows = [], meta = {}) {
  if (getProductListOwnerFences().some((scope) => isOzonCacheKeyBlockedByGenerationFence(cacheKey, scope))) return false;
  writeTimedCache(productListMemoryCache, cacheKey, rows);
  writeTimedCache(productListPageMetaMemoryCache, cacheKey, {
    ...meta,
    rowsLength: Array.isArray(rows) ? rows.length : 0,
  });
  return true;
}

export function clearProductListCacheForShop(shop) {
  const shopKeys = getOzonShopCacheKeyCandidates(shop);
  const belongsToShop = (cacheKey) =>
    shopKeys.some((shopKey) => {
      const prefix = `${PRODUCT_LIST_CACHE_VERSION}:${shopKey}:`;
      return (
        cacheKey.startsWith(prefix) ||
        cacheKey.includes(`${PRODUCT_LIST_CACHE_VERSION}:${shopKey}|`) ||
        cacheKey.includes(`|${shopKey}:`)
      );
    });
  for (const key of productListMemoryCache.keys()) {
    if (belongsToShop(key)) productListMemoryCache.delete(key);
  }
  for (const key of productListPageMetaMemoryCache.keys()) {
    if (belongsToShop(key)) productListPageMetaMemoryCache.delete(key);
  }
  for (const key of productListCursorMemoryCache.keys()) {
    if (belongsToShop(key)) productListCursorMemoryCache.delete(key);
  }
}

export {
  isBlockedLegacyLocalDataFileKey,
  readLocalDataFile,
  requestLocalDataFile,
  writeLocalDataFile,
};

// 非执行审计墓碑：export let localMirrorReadLogWriteQueue
// localMirrorReadLogWriteQueue/localMirrorRetryQueueWriteQueue 已由 SQLite 可观测性取代。
export const LOCAL_MIRROR_JSON_DIAGNOSTICS_RETIRED = true;

export function recordLocalMirrorReadLog(_entry = {}) {
  return Promise.resolve({ retired: true, sink: 'sqlite-scheduler-observability' });
}

export function recordLocalMirrorRetryTask(_entry = {}) {
  return Promise.resolve({ retired: true, sink: 'sqlite-request-jobs' });
}

export const ozonLocalDataWriteQueues = new Map();

export function enqueueOzonLocalDataWrite(fileKey, writer) {
  const key = String(fileKey || '').trim();
  if (!key) return writer();
  const previous = ozonLocalDataWriteQueues.get(key) || Promise.resolve();
  const writePromise = previous.catch(() => undefined).then(writer);
  const queuedPromise = writePromise
    .catch(() => undefined)
    .then(() => {
      if (ozonLocalDataWriteQueues.get(key) === queuedPromise) {
        ozonLocalDataWriteQueues.delete(key);
      }
    });
  ozonLocalDataWriteQueues.set(key, queuedPromise);
  return writePromise;
}

export function waitForOzonLocalDataRetry(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function writeOzonLocalDataFileWithRetry(fileKey, store, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await writeLocalDataFile(fileKey, store);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      await waitForOzonLocalDataRetry(250 * attempt);
    }
  }
  throw lastError;
}

export function getOzonLocalSnapshotKeyCandidates(keys) {
  return getOzonLocalUniqueValues(Array.isArray(keys) ? keys : [keys]);
}

export function getLocalMirrorReadDomainFromSnapshotKey(snapshotKey = '') {
  const key = getOzonLocalSnapshotKeyCandidates(snapshotKey)[0] || '';
  if (key.startsWith('ozon-after-sales:')) return '09_after_sales';
  if (key.startsWith('ozon-sales-orders:')) return '05_sales_orders';
  if (key.startsWith('ozon-purchase-orders:')) return '07_purchase_orders';
  if (key.startsWith('ozon-finance:')) return '11_finance_operations';
  if (key.startsWith('ozon-profit') || key.startsWith('profit-ledger')) return '10_profit_ledgers';
  if (key.startsWith('ozon-products') || key.startsWith('product-list')) return '03_products';
  if (key.startsWith('ozon-warehouse')) return '12_warehouse_logistics';
  return key.split(':')[0] || 'unknown';
}

export async function readOzonLocalDataSnapshot(fileKey, snapshotKey) {
  if (!fileKey || !snapshotKey) return null;
  const snapshotKeys = getOzonLocalSnapshotKeyCandidates(snapshotKey);
  try {
    const store = await readLocalDataFile(fileKey);
    const snapshot = readOzonSnapshotFromLocalStore(store, snapshotKeys);
    if (snapshot) {
      recordLocalMirrorReadLog({
        domain: getLocalMirrorReadDomainFromSnapshotKey(snapshot.localSnapshotKey || snapshotKeys),
        source: snapshot.source || 'local-cache',
        status: 'hit',
        rows: snapshot.rows?.length ?? 0,
        failures: snapshot.failureKeys?.length ?? snapshot.errors?.length ?? 0,
        partial: Boolean(snapshot.errors?.length),
        refreshedAt: snapshot.localUpdatedAt || snapshot.fetchedAt || new Date().toISOString(),
        changeSummary: snapshot.changeSummary,
        details: {
          fileKey,
          snapshotKey: snapshotKeys[0] || '',
          localSnapshotKey: snapshot.localSnapshotKey || snapshotKeys[0] || '',
          legacyCompatibleRead: Boolean(snapshot.legacyCompatibleRead),
          candidateCount: snapshotKeys.length,
        },
      }).catch(() => undefined);
      return snapshot;
    }
    recordLocalMirrorReadLog({
      domain: getLocalMirrorReadDomainFromSnapshotKey(snapshotKeys),
      source: 'local-cache',
      status: 'miss',
      rows: 0,
      details: { fileKey, snapshotKeys },
    }).catch(() => undefined);
    return null;
  } catch (error) {
    recordLocalMirrorReadLog({
      domain: getLocalMirrorReadDomainFromSnapshotKey(snapshotKeys),
      source: 'local-cache',
      status: 'failed',
      rows: 0,
      failures: 1,
      partial: true,
      details: { fileKey, snapshotKeys, error: error instanceof Error ? error.message : String(error) },
    }).catch(() => undefined);
    recordLocalMirrorRetryTask({
      domain: getLocalMirrorReadDomainFromSnapshotKey(snapshotKeys),
      source: 'local-cache',
      entityType: 'snapshot',
      entityKey: snapshotKeys.join('|') || fileKey,
      fileKey,
      snapshotKey: snapshotKeys[0] || '',
      reason: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}

export async function writeOzonLocalDataSnapshot(fileKey, snapshotKey, snapshot) {
  if (!fileKey || !snapshotKey || !snapshot) return null;
  const snapshotKeys = getOzonLocalSnapshotKeyCandidates(snapshotKey);
  const primarySnapshotKey = snapshotKeys[0];
  if (!primarySnapshotKey) return null;
  return enqueueOzonLocalDataWrite(fileKey, async () => {
    const currentStore = await readLocalDataFile(fileKey).catch(() => ({}));
    const existingPrimarySnapshot = readOzonSnapshotFromLocalStore(currentStore, primarySnapshotKey);
    const legacySnapshot = existingPrimarySnapshot
      ? null
      : readOzonSnapshotFromLocalStore(currentStore, snapshotKeys.slice(1));
    const baseStore = legacySnapshot
      ? mergeOzonSnapshotIntoLocalStore(currentStore, primarySnapshotKey, legacySnapshot, {
          source: 'legacy-cache-migration',
          afterSalesCompatibleSnapshotKeys: snapshotKeys,
        }).store
      : currentStore;
    const { store, stats } = mergeOzonSnapshotIntoLocalStore(baseStore, primarySnapshotKey, snapshot, {
      afterSalesCompatibleSnapshotKeys: snapshotKeys,
    });
    await writeOzonLocalDataFileWithRetry(fileKey, store);
    return stats;
  });
}

export async function readOzonLocalDomainSnapshot(fileKey, snapshotKey) {
  if (!fileKey || !snapshotKey) return null;
  const snapshotKeys = getOzonLocalSnapshotKeyCandidates(snapshotKey);
  try {
    const store = await readLocalDataFile(fileKey);
    for (const key of snapshotKeys) {
      const snapshot = readDomainSnapshotFromLocalStore(store, key);
      if (snapshot) {
        const rowCount = snapshot.rows?.length ?? snapshot.warehouses?.length ?? snapshot.items?.length ?? 0;
        recordLocalMirrorReadLog({
          domain: getLocalMirrorReadDomainFromSnapshotKey(key),
          source: snapshot.source || 'local-cache',
          status: 'hit',
          rows: rowCount,
          failures: snapshot.failureKeys?.length ?? snapshot.errors?.length ?? 0,
          partial: Boolean(snapshot.errors?.length),
          refreshedAt: snapshot.localUpdatedAt || snapshot.fetchedAt || new Date().toISOString(),
          changeSummary: snapshot.changeSummary,
          details: {
            fileKey,
            snapshotKey: key,
            localSnapshotKey: snapshot.localSnapshotKey || key,
            legacyCompatibleRead: Boolean(snapshot.legacyCompatibleRead),
            candidateCount: snapshotKeys.length,
          },
        }).catch(() => undefined);
        return snapshot;
      }
    }
    recordLocalMirrorReadLog({
      domain: getLocalMirrorReadDomainFromSnapshotKey(snapshotKeys),
      source: 'local-cache',
      status: 'miss',
      rows: 0,
      details: { fileKey, snapshotKeys },
    }).catch(() => undefined);
    return null;
  } catch (error) {
    recordLocalMirrorReadLog({
      domain: getLocalMirrorReadDomainFromSnapshotKey(snapshotKeys),
      source: 'local-cache',
      status: 'failed',
      rows: 0,
      failures: 1,
      partial: true,
      details: { fileKey, snapshotKeys, error: error instanceof Error ? error.message : String(error) },
    }).catch(() => undefined);
    recordLocalMirrorRetryTask({
      domain: getLocalMirrorReadDomainFromSnapshotKey(snapshotKeys),
      source: 'local-cache',
      entityType: 'domainSnapshot',
      entityKey: snapshotKeys.join('|') || fileKey,
      fileKey,
      snapshotKey: snapshotKeys[0] || '',
      reason: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}

export async function writeOzonLocalDomainSnapshot(fileKey, snapshotKey, snapshot, options = {}) {
  if (!fileKey || !snapshotKey || !snapshot) return null;
  const snapshotKeys = getOzonLocalSnapshotKeyCandidates(snapshotKey);
  const primarySnapshotKey = snapshotKeys[0];
  if (!primarySnapshotKey) return null;
  return enqueueOzonLocalDataWrite(fileKey, async () => {
    const currentStore = await readLocalDataFile(fileKey).catch(() => ({}));
    const existingPrimarySnapshot = readDomainSnapshotFromLocalStore(currentStore, primarySnapshotKey);
    const legacySnapshot = existingPrimarySnapshot
      ? null
      : readDomainSnapshotFromLocalStore(currentStore, snapshotKeys.slice(1));
    const baseStore = legacySnapshot
      ? mergeDomainSnapshotIntoLocalStore(currentStore, primarySnapshotKey, legacySnapshot, {
          ...options,
          source: 'legacy-cache-migration',
        }).store
      : currentStore;
    const { store, stats } = mergeDomainSnapshotIntoLocalStore(baseStore, primarySnapshotKey, snapshot, options);
    await writeOzonLocalDataFileWithRetry(fileKey, store);
    return stats;
  });
}

export async function readOzonLocalProductSnapshot(fileKey, snapshotKey) {
  if (!fileKey || !snapshotKey) return null;
  const snapshotKeys = getOzonLocalSnapshotKeyCandidates(snapshotKey);
  try {
    const store = await readLocalDataFile(fileKey);
    for (const key of snapshotKeys) {
      const snapshot = readOzonProductSnapshotFromLocalStore(store, key);
      if (snapshot) {
        recordLocalMirrorReadLog({
          domain: '03_products',
          source: snapshot.source || 'local-cache',
          status: 'hit',
          rows: snapshot.rows?.length ?? 0,
          failures: snapshot.failureKeys?.length ?? snapshot.errors?.length ?? 0,
          partial: Boolean(snapshot.errors?.length),
          refreshedAt: snapshot.localUpdatedAt || snapshot.fetchedAt || new Date().toISOString(),
          changeSummary: snapshot.changeSummary,
          details: {
            fileKey,
            snapshotKey: key,
            localSnapshotKey: snapshot.localSnapshotKey || key,
            legacyCompatibleRead: Boolean(snapshot.legacyCompatibleRead),
            candidateCount: snapshotKeys.length,
          },
        }).catch(() => undefined);
        return snapshot;
      }
    }
    recordLocalMirrorReadLog({
      domain: '03_products',
      source: 'local-cache',
      status: 'miss',
      rows: 0,
      details: { fileKey, snapshotKeys },
    }).catch(() => undefined);
    return null;
  } catch (error) {
    recordLocalMirrorReadLog({
      domain: '03_products',
      source: 'local-cache',
      status: 'failed',
      rows: 0,
      failures: 1,
      partial: true,
      details: { fileKey, snapshotKeys, error: error instanceof Error ? error.message : String(error) },
    }).catch(() => undefined);
    recordLocalMirrorRetryTask({
      domain: '03_products',
      source: 'local-cache',
      entityType: 'productSnapshot',
      entityKey: snapshotKeys.join('|') || fileKey,
      fileKey,
      snapshotKey: snapshotKeys[0] || '',
      reason: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}

export async function writeOzonLocalProductSnapshot(fileKey, snapshotKey, snapshot, options = {}) {
  if (!fileKey || !snapshotKey || !snapshot) return null;
  const snapshotKeys = getOzonLocalSnapshotKeyCandidates(snapshotKey);
  const primarySnapshotKey = snapshotKeys[0];
  if (!primarySnapshotKey) return null;
  return enqueueOzonLocalDataWrite(fileKey, async () => {
    const currentStore = await readLocalDataFile(fileKey).catch(() => ({}));
    const existingPrimarySnapshot = readOzonProductSnapshotFromLocalStore(currentStore, primarySnapshotKey);
    const legacySnapshot = existingPrimarySnapshot
      ? null
      : readOzonProductSnapshotFromLocalStore(currentStore, snapshotKeys.slice(1));
    const baseStore = legacySnapshot
      ? mergeOzonProductSnapshotIntoLocalStore(currentStore, primarySnapshotKey, legacySnapshot, {
          ...options,
          source: 'legacy-cache-migration',
        }).store
      : currentStore;
    const { store, stats } = mergeOzonProductSnapshotIntoLocalStore(baseStore, primarySnapshotKey, snapshot, options);
    await writeOzonLocalDataFileWithRetry(fileKey, store);
    return stats;
  });
}

export function getOzonLocalUniqueValues(values = []) {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
}

export function getOzonLocalProductPrimaryShopKey(shop) {
  return (
    getOzonLocalUniqueValues([
      getOzonShopClientId(shop),
      shop?.id,
      getOzonShopCacheKey(shop),
      getOzonShopLabel(shop),
    ])[0] || 'unknown-shop'
  );
}

export function getOzonLocalProductShopKeys(shop) {
  return getOzonLocalUniqueValues([
    getOzonShopClientId(shop),
    shop?.id,
    getOzonShopCacheKey(shop),
    getOzonLegacyShopCacheKey(shop),
    getOzonShopLabel(shop),
  ]);
}

export function getOzonLocalProductShopKeysForOrder(order = {}, shops = []) {
  const orderShop = getOzonShopForOrder(order, shops, null);
  return getOzonLocalUniqueValues([
    ...(orderShop ? getOzonLocalProductShopKeys(orderShop) : []),
    order.shopClientId,
    order.shopId,
    order.sellerId,
    order.shop,
    order.shopName,
  ]);
}

export function getOzonLocalOrderRecordKey(order = {}, getRecordKey = getSalesOrderRecordKey) {
  return (
    getRecordKey(order) ||
    getSalesOrderRecordKey(order) ||
    getPurchaseOrderRecordKey(order) ||
    getProfitOrderRecordKey(order) ||
    ''
  );
}

export function getOzonLocalOrderProductLookupKey(order = {}, productIndex = 0, getRecordKey = getSalesOrderRecordKey) {
  const orderKey = getOzonLocalOrderRecordKey(order, getRecordKey);
  return orderKey ? `${orderKey}:${productIndex}` : '';
}

export function getOzonLocalImageUrls(values = []) {
  return [...new Set(normalizeImageList(values).map(safeImageUrl).filter(Boolean))];
}
