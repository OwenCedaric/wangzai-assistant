import {
  getMarketingActivityDescription,
  getMarketingAddModeLabel,
  getMarketingAddModeTone,
  isMarketingSellerAddedAction,
  normalizeMarketingAddMode,
  translateMarketingActivityTitle,
} from '../../../../entities/marketing/marketingActionDisplay.jsx';
import {
  buildFastMarketingSummary,
  buildMarketingProductPoolCacheResult,
  filterOnlineMarketingActivities,
  firstFilled,
  firstUsableOzonId,
  formatMarketingEstimate,
  getMarketingActivityIdentityKey,
  getMarketingActivityDateRange,
  normalizeMarketingCacheSnapshot,
  normalizeOzonId,
  parseMarketingNumber,
  resolveMarketingActivitySelection,
} from '../../../../entities/order/orderShopScope.jsx';
import {
  AFTER_SALES_REFUSED_REFUND_STATUS,
  AFTER_SALES_SIGNED_REFUND_STATUS,
} from '../../../../entities/order/afterSalesStatusRules.jsx';
import {
  confirmMarketingWrite,
  pollMarketingActivitySyncJob,
  previewMarketingWrite,
  readMarketingActivitySnapshotCache,
  readMarketingProductPoolCache,
  readMarketingSummaryCache,
  startMarketingActivitySync,
  startMarketingProductPoolSync,
  startMarketingSummarySync,
} from '../../../../services/marketingActivityClient';
import { safeWarn } from '../../../../services/safeLog';

const MARKETING_LOCAL_CACHE_TIMEOUT_MS = 15_000;
const MARKETING_SUMMARY_CACHE_TIMEOUT_MS = 8_000;
export {
  formatPurchaseOrderPaymentTime,
  getPurchaseOrderKeys,
  getPurchaseOrderPaymentDateKey,
  getPurchaseOrderPaymentTimeMs,
  getPurchaseOrderPaymentTimeRaw,
  isPurchaseOrderBeforeShopBinding,
  parsePurchaseOrderDateMs,
  purchaseOrderStatusTones,
} from '../../../../services/purchaseOrderRuntime.js';

export function mapOzonMarketingActivity(item, index, source = '平台活动') {
  const id = normalizeOzonId(item?.id ?? item?.action_id ?? item?.seller_action_id ?? item?.actionId);
  const originalTitle = item?.title || item?.name || item?.action_name || `活动 ${index + 1}`;
  const rawAction = { ...item, title: originalTitle, raw: item };
  const addMode = isMarketingSellerAddedAction(rawAction)
    ? 'seller'
    : normalizeMarketingAddMode(item?.addition_mode ?? item?.add_mode ?? item?.source ?? source);
  const joinedCount =
    item?.participating_products_count ??
    item?.products_count ??
    item?.product_count ??
    item?.current_products_count ??
    0;
  const availableCount =
    item?.potential_products_count ?? item?.candidates_count ?? item?.available_products_count ?? item?.candidate_count;
  const hasAvailableCount = availableCount !== undefined && availableCount !== null && availableCount !== '';
  const isSellerAction = addMode === 'seller';

  return {
    id: id || `${isSellerAction ? 'seller' : 'action'}-${index + 1}`,
    title: translateMarketingActivityTitle(rawAction),
    originalTitle,
    source: getMarketingAddModeLabel(addMode),
    sourceTone: getMarketingAddModeTone(addMode),
    count: Number(joinedCount) || 0,
    description: getMarketingActivityDescription(rawAction),
    available: Number(availableCount) || 0,
    hasAvailableCount,
    estimate: formatMarketingEstimate(item),
    raw: item,
    sourceType: addMode === 'seller' ? 'seller' : 'official',
  };
}

export function normalizeLocalApiMarketingActivity(row = {}, index = 0) {
  const sourceType = row.sourceType === 'seller' ? 'seller' : 'official';
  const sourceLabel = row.source || (sourceType === 'seller' ? '商家自主' : '平台活动');
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : row;
  const mapped = mapOzonMarketingActivity(raw, index, sourceLabel);
  const id = normalizeOzonId(row.id ?? row.activityId ?? mapped.id);
  const dateRange = getMarketingActivityDateRange({ ...mapped, ...row, raw });
  return {
    ...mapped,
    id: id || mapped.id,
    title: mapped.title || row.title || row.originalTitle || `活动 ${index + 1}`,
    originalTitle: row.originalTitle || mapped.originalTitle || row.title || '',
    source: mapped.source || sourceLabel,
    sourceTone: mapped.sourceTone || getMarketingAddModeTone(sourceType === 'seller' ? 'seller' : 'platform'),
    count: Number(row.count ?? mapped.count) || 0,
    description: mapped.description || row.description || '',
    available: Number(row.available ?? mapped.available) || 0,
    hasAvailableCount: Boolean(row.hasAvailableCount ?? mapped.hasAvailableCount),
    estimate: mapped.estimate || row.estimate || '-',
    dateStart: row.dateStart || dateRange.dateStart || '',
    dateEnd: row.dateEnd || dateRange.dateEnd || '',
    isOnline: row.isOnline ?? true,
    raw,
    sourceType,
  };
}

export function getMarketingLocalApiShopId(shop = {}) {
  return String(shop?.id || '').trim();
}

export function buildMarketingActivitySnapshotFromRows(rows = []) {
  const activityRows = filterOnlineMarketingActivities(
    rows.map(normalizeLocalApiMarketingActivity).filter((activity) => activity.id)
  );
  if (!activityRows.length) return null;
  return {
    activityRows,
    productPool: [],
    marketingSummary: buildFastMarketingSummary(activityRows),
    // Fact-only sync results intentionally do not choose array[0]. The page
    // must prefer a SQLite view-state `(selectedActivityId, selectedSourceType)`
    // pair before it reads a product pool.
    selectedActivityId: '',
    selectedSourceType: '',
    productScope: 'joined',
    selectedProductIds: [],
    cachedAt: new Date().toISOString(),
  };
}

export async function readMarketingActivityLocalApiSnapshot(shop, options = {}) {
  const shopId = getMarketingLocalApiShopId(shop);
  if (!shopId) return null;
  const cache = await readMarketingActivitySnapshotCache(
    { shopId, includeProductPool: options.includeProductPool !== false },
    { timeoutMs: options.timeoutMs || 3500, signal: options.signal }
  );
  if (cache?.found !== true) return null;
  return buildMarketingActivitySnapshotFromLocalApiCache(cache);
}

export function buildMarketingActivitySnapshotFromLocalApiCache(cache = {}) {
  if (cache?.ok === false || cache?.found === false) return null;
  const snapshot = cache?.snapshot && typeof cache.snapshot === 'object' ? cache.snapshot : cache;
  const normalized = normalizeMarketingCacheSnapshot({
    ...snapshot,
    activityRows: Array.isArray(snapshot?.activityRows)
      ? snapshot.activityRows
      : Array.isArray(snapshot?.rows)
        ? snapshot.rows
        : [],
  });
  if (!normalized) return null;

  const activityRows = filterOnlineMarketingActivities(
    normalized.activityRows.map(normalizeLocalApiMarketingActivity).filter((activity) => activity.id)
  );
  if (!activityRows.length) return null;
  const hasPersistedSummary = Boolean(snapshot?.marketingSummary && typeof snapshot.marketingSummary === 'object');
  const selectedActivity = resolveMarketingActivitySelection(activityRows, {
    selectedActivityId: normalized.selectedActivityId,
    selectedSourceType: normalized.selectedSourceType,
  });
  return {
    ...normalized,
    activityRows,
    marketingSummary: hasPersistedSummary ? normalized.marketingSummary : buildFastMarketingSummary(activityRows),
    selectedActivityId: selectedActivity?.id || '',
    selectedSourceType: selectedActivity?.sourceType || '',
  };
}

export function buildMarketingActivitySnapshotFromSyncResult(syncResult = {}) {
  return buildMarketingActivitySnapshotFromLocalApiCache(syncResult?.cacheSnapshot || syncResult);
}

export function buildMarketingProductPoolResultFromLocalApiCache(cache = {}, activity = {}) {
  const products = Array.isArray(cache?.productPool)
    ? cache.productPool
    : Array.isArray(cache?.products)
      ? cache.products
      : Array.isArray(cache?.rows)
        ? cache.rows
        : [];
  const readTotal = (value, fallback) => {
    if (value === null || value === undefined || value === '') return fallback;
    const total = Number(value);
    return Number.isFinite(total) ? total : fallback;
  };
  const joinedRowsTotal = products.filter((product) => product.status === '已添加').length;
  const availableRowsTotal = products.filter((product) => product.status === '可添加').length;
  return {
    products,
    joinedTotal: readTotal(cache?.joinedTotal, joinedRowsTotal),
    availableTotal: readTotal(cache?.availableTotal, availableRowsTotal),
    cacheSnapshot: cache,
  };
}

export async function readMarketingProductPoolLocalApiResult(shop, activity, scope = 'all', options = {}) {
  const shopId = getMarketingLocalApiShopId(shop);
  if (!shopId) throw new Error('营销活动商品池读取需要 shopId。');
  if (!activity?.id) throw new Error('营销活动商品池读取需要 activityId。');
  const productScopeValue = ['joined', 'available', 'all'].includes(scope) ? scope : 'joined';
  const pageSize = Math.min(Math.max(Number(options.pageSize) || 1000, 1), 1000);
  const maxPages = Math.min(Math.max(Number(options.maxCachePages) || 50, 1), 100);
  const readPage = (page) => readMarketingProductPoolCache(
    {
      shopId,
      activityId: activity.id,
      sourceType: activity.sourceType || 'official',
      productScope: productScopeValue,
      page,
      pageSize,
    },
    { timeoutMs: options.cacheTimeoutMs || options.timeoutMs || 2500, signal: options.signal }
  );
  const firstPage = await readPage(1);
  const products = [
    ...(Array.isArray(firstPage?.productPool)
      ? firstPage.productPool
      : Array.isArray(firstPage?.rows)
        ? firstPage.rows
        : []),
  ];
  const total = Math.max(Number(firstPage?.total) || products.length, products.length);
  let page = 1;
  while (products.length < total && page < maxPages) {
    page += 1;
    const nextPage = await readPage(page);
    const nextProducts = Array.isArray(nextPage?.productPool)
      ? nextPage.productPool
      : Array.isArray(nextPage?.rows)
        ? nextPage.rows
        : [];
    if (!nextProducts.length) break;
    products.push(...nextProducts);
    if (nextProducts.length < pageSize) break;
  }
  return buildMarketingProductPoolResultFromLocalApiCache({
    ...firstPage,
    productPool: products,
    rows: products,
    loadedTotal: products.length,
  }, activity);
}

export { filterMarketingProductsByScope } from '../../../../entities/marketing/marketingCacheRules.jsx';

export function getMarketingActionId(activity = {}) {
  const id = Number(activity.id);
  return Number.isFinite(id) ? id : activity.id;
}

export function getMarketingProductNumericId(product = {}) {
  const id = Number(product.id);
  return Number.isFinite(id) ? id : null;
}

export function buildMarketingWriteProducts(products = [], percent = 50) {
  return products
    .map((product) => {
      const productId = getMarketingProductNumericId(product);
      const basePrice = parseMarketingNumber(product.price);
      if (!productId || basePrice === null) return null;
      const actionPrice = Number((basePrice * (percent / 100)).toFixed(2));
      const stock = parseMarketingNumber(product.stock);
      return {
        product_id: productId,
        action_price: actionPrice,
        ...(stock !== null && stock > 0 ? { stock } : {}),
      };
    })
    .filter(Boolean);
}

export async function requestMarketingGuardedWrite({
  shop,
  activity,
  endpointKey,
  action,
  payload,
  products = [],
  percent = null,
} = {}) {
  const shopId = getMarketingLocalApiShopId(shop);
  if (!shopId) throw new Error('营销写入需要 shopId。');
  const before = {
    activityId: activity?.id || '',
    title: activity?.title || '',
    sourceType: activity?.sourceType || 'official',
    selectedCount: products.length,
  };
  const after = {
    ...before,
    percent,
    payload,
  };
  const preview = await previewMarketingWrite(
    {
      shopId,
      endpointKey,
      action,
      before,
      after,
      payload,
      requestedBy: 'marketing-activity-page',
    },
    { timeoutMs: 5000 }
  );
  const confirmed = await confirmMarketingWrite(
    {
      shopId,
      previewId: preview.previewId,
      confirm: true,
      endpointKey,
      action,
      payload,
      realWrite: true,
      dryRun: false,
      fastAck: false,
      asyncWrite: false,
      waitForResult: true,
      requestedBy: 'marketing-activity-page',
    },
    { timeoutMs: 60_000 }
  );
  if (!confirmed?.ok) {
    const error = new Error(confirmed?.error?.message || '营销写入安全门尚未接通，未写入 Ozon。');
    error.payload = confirmed;
    throw error;
  }
  return confirmed;
}

export async function requestOzonMarketingActivateProducts(shop, activity, products, percent, options = {}) {
  const writeProducts = buildMarketingWriteProducts(products, percent);
  if (writeProducts.length === 0) {
    throw new Error('没有可写入的商品活动价');
  }
  const endpointKey = activity.sourceType === 'seller' ? 'sellerActions.productsAdd' : 'actions.productsActivate';
  return requestMarketingGuardedWrite({
    shop,
    activity,
    endpointKey,
    action: 'marketing.products.add',
    products,
    percent,
    payload: {
      action_id: getMarketingActionId(activity),
      products: writeProducts,
    },
    confirmed: options.confirmed === true,
  });
}

export async function requestOzonMarketingDeactivateProducts(shop, activity, products, options = {}) {
  const productIds = products
    .map((product) => getMarketingProductNumericId(product))
    .filter((productId) => productId !== null);
  if (productIds.length === 0) {
    throw new Error('没有可取消的商品');
  }
  const endpointKey = activity.sourceType === 'seller' ? 'sellerActions.productsDelete' : 'actions.productsDeactivate';
  return requestMarketingGuardedWrite({
    shop,
    activity,
    endpointKey,
    action: 'marketing.products.remove',
    products,
    payload: {
      action_id: getMarketingActionId(activity),
      product_ids: productIds,
    },
    confirmed: options.confirmed === true,
  });
}

export async function requestOzonMarketingProductPool(shop, activity, scope = 'all', options = {}) {
  const shopId = getMarketingLocalApiShopId(shop);
  if (!shopId) throw new Error('营销活动商品池读取需要 shopId。');
  if (!activity?.id) throw new Error('营销活动商品池读取需要 activityId。');
  const productScopeValue = ['joined', 'available', 'all'].includes(scope) ? scope : 'joined';
  let cacheResult = options.cacheResult
    ? buildMarketingProductPoolResultFromLocalApiCache(options.cacheResult, activity)
    : null;
  let cacheReadError = null;
  if (options.skipCache !== true) {
    try {
      cacheResult = await readMarketingProductPoolLocalApiResult(shop, activity, productScopeValue, {
        pageSize: options.pageSize || 1000,
        cacheTimeoutMs: options.cacheTimeoutMs || MARKETING_LOCAL_CACHE_TIMEOUT_MS,
        signal: options.signal,
      });
    } catch (error) {
      cacheReadError = error;
      if (options.cacheOnly) throw error;
      safeWarn('营销活动商品池本地缓存读取失败', error);
    }
  }

  let syncResult = null;
  let syncStartError = null;
  const shouldStartRemote = options.cacheOnly !== true && options.allowRemote !== false;
  if (shouldStartRemote) {
    try {
      syncResult = await startMarketingProductPoolSync(
        {
          shopId,
          activityId: activity.id,
          sourceType: activity.sourceType || 'official',
          productScope: productScopeValue,
          limit: options.limit || 1000,
          maxPages: options.maxPages || 20,
          forceRefresh: options.forceRefresh !== false,
          fastAck: true,
          includeCacheSnapshot: false,
          waitForResult: false,
          available: activity.available,
          hasAvailableCount: activity.hasAvailableCount,
          // The product catalogue already owns title/price/stock hydration.
          // Re-hydrating up to 1,000 products on every scope click starts 30
          // extra Ozon batches and can block every shop's local cache reads.
          hydrateProducts: options.hydrateProducts === true,
          requestedBy: 'marketing-activity-page',
        },
        { timeoutMs: options.syncTimeoutMs || 2500 }
      );
      if (!cacheResult && syncResult?.cacheSnapshot) {
        cacheResult = buildMarketingProductPoolResultFromLocalApiCache(syncResult.cacheSnapshot, activity);
      }
    } catch (error) {
      syncStartError = error;
      if (!cacheResult) throw error;
      safeWarn('营销活动商品池后台同步启动失败，继续使用 SQLite 快照', error);
    }
  }

  if ((options.waitForSync || options.strict) && syncResult?.jobId) {
    const finalResult = await pollMarketingActivitySyncJob(syncResult.jobId, {
      intervalMs: options.pollIntervalMs || 800,
      timeoutMs: options.pollTimeoutMs || (options.strict ? 90_000 : 15_000),
    });
    const finalStatus = finalResult?.job?.status || finalResult?.status || '';
    if (['failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open', 'timeout'].includes(finalStatus)) {
      const message = finalResult?.job?.lastError || finalResult?.error?.message || '营销活动商品池同步失败。';
      if (options.strict) throw new Error(message);
      safeWarn('营销活动商品池同步未完成', finalResult);
    } else {
      cacheResult = await readMarketingProductPoolLocalApiResult(shop, activity, productScopeValue, {
        pageSize: options.pageSize || 1000,
        cacheTimeoutMs: options.cacheTimeoutMs || 2500,
      });
    }
  }

  const emptyFallback = buildMarketingProductPoolCacheResult([], activity);
  const fallbackJoinedTotal = Number(activity?.count) || 0;
  const fallbackAvailableTotal = Number(activity?.available) || 0;
  return {
    ...(cacheResult || {
      ...emptyFallback,
      joinedTotal: fallbackJoinedTotal,
      availableTotal: fallbackAvailableTotal,
    }),
    syncJobId: syncResult?.jobId || '',
    syncStatus: syncResult?.status || syncResult?.job?.status || '',
    pending: Boolean(syncResult?.jobId),
    reused: Boolean(syncResult?.reused),
    syncStartFailed: Boolean(syncStartError),
    cacheReadFailed: Boolean(cacheReadError),
  };
}

export function normalizeMarketingSummaryResult(cache = {}, activities = []) {
  const source = cache?.summary && typeof cache.summary === 'object' ? cache.summary : cache;
  const fastSummary = buildFastMarketingSummary(activities);
  const pickNumber = (value, fallback = null) => {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const rawPoolsByActivity = source.poolsByActivity ?? cache.poolsByActivity;
  const poolEntries = rawPoolsByActivity instanceof Map
    ? [...rawPoolsByActivity.entries()]
    : Array.isArray(rawPoolsByActivity)
      ? rawPoolsByActivity
      : [];
  const poolsByActivity = new Map();
  poolEntries.forEach(([, pool]) => {
    if (!pool?.activity?.id) return;
    poolsByActivity.set(getMarketingActivityIdentityKey(pool.activity), pool);
  });
  return {
    activityTotal: pickNumber(source.activityTotal ?? source.activity_total, fastSummary.activityTotal) ?? 0,
    joinedActivityTotal:
      pickNumber(source.joinedActivityTotal ?? source.joined_activity_total, fastSummary.joinedActivityTotal) ?? 0,
    joinedProductTotal: pickNumber(source.joinedProductTotal ?? source.joined_product_total, null),
    issueProductTotal: pickNumber(source.issueProductTotal ?? source.issue_product_total, null),
    cachedProductRows: pickNumber(source.cachedProductRows ?? source.cached_product_rows, 0) ?? 0,
    cachedActivityProductTotal:
      pickNumber(source.cachedActivityProductTotal ?? source.cached_activity_product_total, 0) ?? 0,
    updatedAt: source.updatedAt ?? source.updated_at ?? cache.updatedAt ?? '',
    source: source.source || cache.source || 'sqlite',
    poolsByActivity,
  };
}

export async function readMarketingSummaryLocalApiResult(shop, activities = [], options = {}) {
  const shopId = getMarketingLocalApiShopId(shop);
  if (!shopId) throw new Error('营销活动统计读取需要 shopId。');
  const cache = await readMarketingSummaryCache(
    { shopId },
    { timeoutMs: options.cacheTimeoutMs || options.timeoutMs || MARKETING_SUMMARY_CACHE_TIMEOUT_MS, signal: options.signal }
  );
  return normalizeMarketingSummaryResult(cache, activities);
}

export async function requestOzonMarketingSummary(shop, activities, options = {}) {
  const shopId = getMarketingLocalApiShopId(shop);
  if (!shopId) throw new Error('营销活动统计读取需要 shopId。');
  let summary = options.cacheResult
    ? normalizeMarketingSummaryResult(options.cacheResult, activities)
    : null;
  if (options.skipCache !== true) {
    try {
      summary = await readMarketingSummaryLocalApiResult(shop, activities, {
        cacheTimeoutMs: options.cacheTimeoutMs || MARKETING_SUMMARY_CACHE_TIMEOUT_MS,
        signal: options.signal,
      });
    } catch (error) {
      if (options.cacheOnly) throw error;
      safeWarn('营销活动全局统计缓存读取失败', error);
    }
  }

  let syncResult = null;
  let syncStartError = null;
  const shouldStartRemote = options.cacheOnly !== true && options.allowRemote !== false;
  if (shouldStartRemote) {
    try {
      syncResult = await startMarketingSummarySync(
        {
          shopId,
          forceRefresh: options.forceRefresh !== false,
          fastAck: true,
          includeCacheSnapshot: false,
          waitForResult: false,
          requestedBy: 'marketing-activity-page',
        },
        { timeoutMs: options.syncTimeoutMs || 2500 }
      );
      if ((!summary || summary.activityTotal === 0) && syncResult?.cacheSnapshot) {
        summary = normalizeMarketingSummaryResult(syncResult.cacheSnapshot, activities);
      }
    } catch (error) {
      syncStartError = error;
      if (!summary && !activities.length) throw error;
      safeWarn('营销活动全局统计后台同步启动失败，继续使用 SQLite 统计', error);
    }
  }

  return {
    ...(summary || buildFastMarketingSummary(activities)),
    poolsByActivity: summary?.poolsByActivity || new Map(),
    syncJobId: syncResult?.jobId || '',
    syncStatus: syncResult?.status || syncResult?.job?.status || '',
    pending: Boolean(syncResult?.jobId),
    reused: Boolean(syncResult?.reused),
    syncStartFailed: Boolean(syncStartError),
  };
}

export async function requestOzonMarketingActivities(shop, options = {}) {
  const shopId = getMarketingLocalApiShopId(shop);
  if (!shopId) throw new Error('营销活动读取需要 shopId。');
  let snapshot = options.cacheSnapshot
    ? buildMarketingActivitySnapshotFromLocalApiCache(options.cacheSnapshot)
    : null;
  if (options.skipCache !== true) {
    try {
      snapshot = await readMarketingActivityLocalApiSnapshot(shop, {
        timeoutMs: options.cacheTimeoutMs || MARKETING_SUMMARY_CACHE_TIMEOUT_MS,
        includeProductPool: false,
      });
    } catch (error) {
      if (options.cacheOnly) throw error;
      safeWarn('营销活动本地缓存读取失败', error);
    }
  }

  let syncResult = null;
  let syncStartError = null;
  const shouldStartRemote = options.cacheOnly !== true && options.allowRemote !== false;
  if (shouldStartRemote) {
    try {
      syncResult = await startMarketingActivitySync(
        {
          shopId,
          forceRefresh: options.forceRefresh !== false,
          fastAck: true,
          includeCacheSnapshot: false,
          waitForResult: false,
          requestedBy: 'marketing-activity-page',
        },
        { timeoutMs: options.syncTimeoutMs || 2500 }
      );
      if (!snapshot && syncResult?.cacheSnapshot) {
        snapshot = buildMarketingActivitySnapshotFromSyncResult(syncResult);
      }
    } catch (error) {
      syncStartError = error;
      if (!snapshot) throw error;
      safeWarn('营销活动后台同步启动失败，继续使用 SQLite 快照', error);
    }
  }

  if ((options.waitForSync || options.strict) && syncResult?.jobId) {
    const finalResult = await pollMarketingActivitySyncJob(syncResult.jobId, {
      intervalMs: options.pollIntervalMs || 800,
      timeoutMs: options.pollTimeoutMs || (options.strict ? 90_000 : 15_000),
    });
    const finalStatus = finalResult?.job?.status || finalResult?.status || '';
    if (['failed', 'canceled', 'blocked', 'rate_limited', 'circuit_open', 'timeout'].includes(finalStatus)) {
      safeWarn('营销活动同步未完成，尝试读取本地缓存', finalResult);
    } else {
      snapshot = await readMarketingActivityLocalApiSnapshot(shop, {
        timeoutMs: options.cacheTimeoutMs || 2500,
        includeProductPool: false,
      });
    }
  }

  return {
    activityRows: snapshot?.activityRows || [],
    snapshot,
    syncJobId: syncResult?.jobId || '',
    syncStatus: syncResult?.status || syncResult?.job?.status || '',
    pending: Boolean(syncResult?.jobId),
    reused: Boolean(syncResult?.reused),
    syncStartFailed: Boolean(syncStartError),
  };
}

export function getFriendlyOzonReadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  safeWarn('Ozon 营销活动读取失败', error);
  if (/local-api 请求超时|本地 API 请求超时|无法连接本地 API/iu.test(message)) {
    return '本地营销数据处理繁忙，已保留当前快照，后台会继续更新。';
  }
  if (
    message.includes('WRITE_EXECUTION_NOT_CONNECTED') ||
    message.includes('real Ozon write execution is not connected')
  ) {
    return '营销写入安全门已记录确认，但真实写入通道尚未接通，未写入 Ozon。';
  }
  if (message.includes('REAL_OZON_WRITE_DISABLED')) {
    return '营销写入未执行：本机 local-api 真实写入总开关未开启。';
  }
  if (message.includes('营销写入安全门尚未接通')) return message;
  if (message.includes('products/activate') || message.includes('products/add') || message.includes('没有可写入')) {
    return '写入失败：Ozon 暂未接受活动商品修改，请检查活动价、库存和商品状态。';
  }
  if (
    message.includes('products/deactivate') ||
    message.includes('products/delete') ||
    message.includes('没有可取消')
  ) {
    return '取消失败：Ozon 暂未移出商品，请稍后重试。';
  }
  if (message.includes('401') || message.includes('403')) return '读取失败：店铺接口权限不足或密钥无效。';
  if (message.includes('404') || message.includes('405')) return '读取失败：当前店铺暂不支持这个活动读取入口。';
  if (message.includes('可添加商品读取失败')) return '读取失败：可添加商品暂未返回，请稍后重试。';
  if (message.includes('已添加商品读取失败')) return '读取失败：已添加商品暂未返回，请稍后重试。';
  if (message.includes('HTTP 500')) return '读取失败：Ozon 当前返回异常，请稍后重试。';
  if (message.includes('Failed to fetch') || message.includes('NetworkError'))
    return '读取失败：请检查本地服务代理或网络。';
  return '读取失败：Ozon 暂未返回可用活动数据，请稍后重试。';
}

export const afterSalesOrderStatusTabs = [
  { label: '全部订单', value: 'all', tone: 'primary' },
  { label: '发货前取消', value: '发货前取消', tone: 'warning' },
  { label: '发货后取消', value: '发货后取消', tone: 'error' },
  { label: '拒收后退款', value: AFTER_SALES_REFUSED_REFUND_STATUS, tone: 'success' },
  { label: '签收后退款', value: AFTER_SALES_SIGNED_REFUND_STATUS, tone: 'error' },
];

export const salesOrderStatusTabs = [
  { label: '全部订单', value: 'all', tone: 'primary' },
  { label: '等待备货', value: '等待备货', tone: 'warning' },
  { label: '等待发货', value: '等待发货', tone: 'warning' },
  { label: '即将超时', value: '即将超时', tone: 'warning' },
  { label: '发货超时', value: '发货超时', tone: 'error' },
  { label: '已经发货', value: '已经发货', tone: 'primary' },
  { label: '售后订单', value: '售后订单', tone: 'error' },
  { label: '成功订单', value: '成功订单', tone: 'success' },
  { label: '关闭订单', value: '关闭订单', tone: 'default' },
  { label: '未知状态', value: '未知状态', tone: 'default' },
];

export const purchaseOrderStageTabs = [
  { label: '全部订单', value: 'all', tone: 'primary' },
  { label: '待拍单', value: '待拍单', tone: 'warning' },
  { label: '已拍单-待预报', value: '已拍单-待预报', tone: 'warning' },
  { label: '已拍单-待发货', value: '已拍单-待发货', tone: 'warning' },
  { label: '已拍单-已发货', value: '已拍单-已发货', tone: 'primary' },
  { label: '已拍单-未操作', value: '已拍单-未操作', tone: 'default' },
  { label: '已拍单-售后单', value: '已拍单-售后单', tone: 'error' },
  { label: '完结单', value: '完结单', tone: 'success' },
  { label: '关闭单', value: '关闭单', tone: 'default' },
];

export const purchaseOrderManualClassifyOptions = [
  { label: '转待拍单', value: '待拍单', risky: false },
  { label: '转待预报', value: '已拍单-待预报', risky: false },
  { label: '转待发货', value: '已拍单-待发货', risky: false },
  { label: '转已发货', value: '已拍单-已发货', risky: true },
  { label: '转售后单', value: '已拍单-售后单', risky: true },
  { label: '转完结单', value: '完结单', risky: true },
  { label: '转关闭单', value: '关闭单', risky: true },
];

export { getPurchaseOrderRecordKey } from '../../../../entities/order/purchaseOrderRecordRules.jsx';
