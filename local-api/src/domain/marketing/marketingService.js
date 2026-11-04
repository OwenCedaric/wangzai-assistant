import { createMarketingRepository } from '../../db/repositories/marketingRepository.js';
import { createProductRepository } from '../../db/repositories/productRepository.js';
import { createSyncJobService, SYNC_JOB_STATUS } from '../../sync/syncJobService.js';
import { createSyncStateService } from '../../sync/syncStateService.js';
import { createStableHash } from '../../utils/stableHash.js';
import { createMarketingWriteService } from './marketingWriteService.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== '0' && text !== '未返回' ? text : '';
}

function createMarketingJobId() {
  return `marketing_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function extractItems(data) {
  if (Array.isArray(data?.result?.items)) return data.result.items;
  if (Array.isArray(data?.result?.actions)) return data.result.actions;
  if (Array.isArray(data?.result?.products)) return data.result.products;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.actions)) return data.actions;
  if (Array.isArray(data?.products)) return data.products;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data)) return data;
  return [];
}

function extractTotal(data) {
  const value = data?.result?.total ?? data?.total ?? data?.result?.total_count ?? data?.total_count;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.floor(numberValue) : null;
}

function getSchedulerData(result = {}) {
  return result.data ?? result.cache?.payload ?? null;
}

function isSchedulerOk(result = {}) {
  return Boolean(result.ok || result.status === 'success' || result.status === 'partial' || result.status === 'cache_hit');
}

function schedulerErrorMessage(result, fallback = 'Ozon 营销活动接口调用失败') {
  const first = result?.errors?.[0];
  return first?.message || result?.job?.lastError || result?.error?.message || fallback;
}

function buildMarketingRequestFingerprint(input = {}) {
  return createStableHash({
    domain: 'marketing',
    shopId: input.shopId,
    action: input.action || 'sync-marketing-activities',
    scope: input.scope || 'activities',
    activityId: input.activityId || input.activity_id || '',
    sourceType: input.sourceType || input.source_type || '',
    productScope: input.productScope || input.product_scope || input.range || '',
    forceRefresh: input.forceRefresh !== false,
    syncMode: normalizeText(input.syncMode ?? input.sync_mode),
    recoveryRestoreId: normalizeText(input.recoveryRestoreId ?? input.recovery_restore_id),
  }, { length: 32 });
}

function hasTableColumns(db, tableName, requiredColumns = []) {
  try {
    const found = db?.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)?.present;
    if (!found) return false;
    const columns = new Set(
      db.prepare(`PRAGMA table_info("${String(tableName).replaceAll('"', '""')}")`).all().map((row) => row.name),
    );
    return requiredColumns.every((column) => columns.has(column));
  } catch {
    return false;
  }
}

function hasMarketingCacheTables(db) {
  return [
    ['ozon_marketing_activities', ['source_type', 'source_tone', 'date_start', 'date_end']],
    ['ozon_marketing_activity_products', ['source_type', 'ozon_sku']],
    ['ozon_products', ['shop_id', 'product_id', 'is_stale']],
    [
      'marketing_view_state',
      [
        'selected_activity_id',
        'selected_source_type',
        'product_scope',
        'selected_product_ids_json',
        'activity_total',
        'joined_activity_total',
        'joined_product_total',
        'issue_product_total',
        'summary_initialized',
        'cached_at',
      ],
    ],
  ].every(([tableName, columns]) => hasTableColumns(db, tableName, columns));
}

function hasProductsCacheTable(db) {
  try {
    return Boolean(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ozon_products'").get());
  } catch {
    return false;
  }
}

async function readMarketingEndpoint({
  ozonScheduler,
  shopId,
  endpointKey,
  params,
  cacheKey,
  idempotencyKey,
  requestedBy,
  forceRefresh,
  profile,
  source,
  syncMode,
  recoveryRestoreId,
  recoveryGenerationId,
  recoveryOverlapMinutes,
  action = 'sync-marketing-activities',
}) {
  return ozonScheduler.executeReadOnly({
    shopId,
    domain: 'marketing',
    endpointKey,
    action,
    priority: 'P2',
    profile,
    source,
    syncMode,
    recoveryRestoreId,
    recoveryGenerationId,
    recoveryOverlapMinutes,
    params,
    cacheKey,
    idempotencyKey,
    requestedBy,
    forceRefresh,
    allowStale: true,
    // Domain sync jobs consume the endpoint payload immediately. When a
    // product and summary job coalesce on the same request fingerprint, a
    // non-waiting follower only receives the active job shell (without
    // `data`). Treating that shell as an empty Ozon page would stale every
    // previously confirmed product, so every internal reader must wait for
    // the shared physical request result.
    waitForResult: true,
  });
}

async function readMarketingPagedItems({
  ozonScheduler,
  shopId,
  endpointKey,
  params = {},
  cacheKey,
  idempotencyKey,
  requestedBy,
  forceRefresh,
  limit = 1000,
  maxPages = 20,
  action = 'sync-marketing-products',
} = {}) {
  const rows = [];
  let offset = Math.max(Number(params.offset) || 0, 0);
  let total = null;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 1000));
  const safeMaxPages = Math.max(1, Math.min(Number(maxPages) || 20, 50));

  for (let page = 1; page <= safeMaxPages; page += 1) {
    const result = await readMarketingEndpoint({
      ozonScheduler,
      shopId,
      endpointKey,
      params: { ...params, limit: safeLimit, offset, maxPages: 1 },
      cacheKey: `${cacheKey}:offset:${offset}:limit:${safeLimit}`,
      idempotencyKey: `${idempotencyKey}:page:${page}`,
      requestedBy,
      forceRefresh,
      action,
    });
    if (!isSchedulerOk(result)) {
      throw new Error(schedulerErrorMessage(result));
    }
    const data = getSchedulerData(result);
    const pageRows = extractItems(data);
    const pageTotal = extractTotal(data);
    if (pageTotal !== null) total = pageTotal;
    rows.push(...pageRows);
    offset += pageRows.length;
    if (pageRows.length === 0) break;
    if (total !== null && rows.length >= total) break;
    if (pageRows.length < safeLimit) break;
  }

  return { rows, total: total ?? rows.length };
}

async function readMarketingProductHydrationEndpoint({
  ozonScheduler,
  shopId,
  endpointKey,
  params,
  cacheKey,
  idempotencyKey,
  requestedBy,
  forceRefresh,
} = {}) {
  return ozonScheduler.executeReadOnly({
    shopId,
    domain: 'products',
    endpointKey,
    action: 'sync-marketing-products-hydrate',
    priority: 'P2',
    params,
    cacheKey,
    idempotencyKey,
    requestedBy,
    forceRefresh,
    allowStale: true,
    // Hydration batches share exact-payload cache keys. Followers need the
    // settled payload rather than an active-job acknowledgement.
    waitForResult: true,
  });
}

function normalizeProductScope(value) {
  const text = normalizeText(value).toLowerCase();
  if (text === 'joined' || text === 'available' || text === 'all') return text;
  return 'joined';
}

function normalizeMarketingSyncScope(value, input = {}) {
  const text = normalizeText(value || (getActivityId(input) ? 'products' : 'activities')).toLowerCase();
  if (text === 'products' || text === 'product_pool' || text === 'product-pool') return 'products';
  if (text === 'summary' || text === 'stats' || text === 'statistics') return 'summary';
  return 'activities';
}

function getActivitySourceType(input = {}) {
  const sourceType = normalizeText(input.sourceType ?? input.source_type ?? input.activity?.sourceType);
  return sourceType === 'seller' ? 'seller' : 'official';
}

function getActivityId(input = {}) {
  return normalizeId(input.activityId ?? input.activity_id ?? input.actionId ?? input.action_id ?? input.activity?.id);
}

function getProductId(row = {}) {
  return normalizeId(row.product_id ?? row.productId ?? row.id ?? row.sku ?? row.offer_id ?? row.offerId);
}

function getHydrationProductId(row = {}) {
  return normalizeId(row.product_id ?? row.productId ?? row.id);
}

function uniqueIds(values = []) {
  return [...new Set(values.map(normalizeId).filter(Boolean))];
}

/**
 * Product hydration cache identities must describe the actual Ozon payload.
 * Using only the batch number ("product:1", "product:2", ...) made unrelated
 * activity/summary jobs fight for the same scheduler lock and could also reuse
 * a response that belonged to a different product set.
 */
export function buildMarketingHydrationBatchIdentity({ shopId, endpointKey, productIds = [] } = {}) {
  const normalizedShopId = normalizeId(shopId);
  const normalizedEndpointKey = normalizeText(endpointKey);
  const normalizedProductIds = uniqueIds(productIds).sort((left, right) => left.localeCompare(right));
  if (!normalizedShopId) throw new Error('marketing hydration cache identity requires shopId.');
  if (!normalizedEndpointKey) throw new Error('marketing hydration cache identity requires endpointKey.');
  if (!normalizedProductIds.length) throw new Error('marketing hydration cache identity requires productIds.');
  const payloadHash = createStableHash({ endpointKey: normalizedEndpointKey, productIds: normalizedProductIds }, { length: 24 });
  return {
    productIds: normalizedProductIds,
    payloadHash,
    cacheKey: `marketing:${normalizedShopId}:hydrate:${normalizedEndpointKey}:products:${payloadHash}`,
    idempotencyKey: `marketing:${normalizedShopId}:hydrate:${normalizedEndpointKey}:${payloadHash}`,
  };
}

export function buildMarketingActivityProductCacheKey({ shopId, sourceType, activityId, rowStatus } = {}) {
  const normalizedShopId = normalizeId(shopId);
  const normalizedActivityId = normalizeId(activityId);
  const normalizedSourceType = getActivitySourceType({ sourceType });
  const normalizedRowStatus = rowStatus === '可添加' ? 'available' : 'joined';
  if (!normalizedShopId) throw new Error('marketing activity product cache key requires shopId.');
  if (!normalizedActivityId) throw new Error('marketing activity product cache key requires activityId.');
  return `marketing:${normalizedShopId}:activity-products:${normalizedSourceType}:${normalizedActivityId}:${normalizedRowStatus}`;
}

function chunkArray(values = [], chunkSize = 100) {
  const size = Math.min(Math.max(Number(chunkSize) || 100, 1), 100);
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function normalizeMaxHydrateProducts(value, fallback = 1000) {
  const text = normalizeText(value).toLowerCase();
  if (text === 'all' || text === 'full' || text === 'unlimited') return Number.POSITIVE_INFINITY;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return fallback;
  return Math.floor(numberValue);
}

function limitIds(values = [], maxCount = Number.POSITIVE_INFINITY) {
  const ids = uniqueIds(values);
  return Number.isFinite(maxCount) ? ids.slice(0, maxCount) : ids;
}

function shouldReturnFastCacheSnapshot(input = {}) {
  return input.includeCacheSnapshot === true || input.includeCache === true || input.returnCache === true;
}

function readFastMarketingCacheSnapshot(repository, input = {}, context = {}) {
  if (!repository || !shouldReturnFastCacheSnapshot(input)) return null;
  const shopId = context.shopId || normalizeId(input.shopId ?? input.shop_id);
  if (!shopId) return null;
  const productSync = context.productSync === true;
  const summarySync = context.summarySync === true;
  try {
    if (summarySync) {
      return repository.readSummary({
        shopId,
        sourceType: input.sourceType ?? input.source_type,
      });
    }
    if (productSync) {
      return repository.listActivityProducts({
        scope: 'products',
        shopId,
        activityId: context.activityId || getActivityId(input),
        sourceType: context.sourceType || getActivitySourceType(input),
        productScope: context.productScope || normalizeProductScope(input.productScope ?? input.product_scope ?? input.range),
        pageSize: input.pageSize || input.limit || 1000,
      });
    }
    return repository.listActivities({
      scope: 'activities',
      shopId,
      sourceType: input.sourceType ?? input.source_type,
      pageSize: input.pageSize || input.limit || 1000,
    });
  } catch (error) {
    return {
      ok: false,
      domain: 'marketing',
      scope: summarySync ? 'summary' : productSync ? 'products' : 'activities',
      error: {
        code: 'MARKETING_FAST_CACHE_SNAPSHOT_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function attachFastMarketingCacheSnapshot(payload = {}, repository, input = {}, context = {}) {
  const cacheSnapshot = readFastMarketingCacheSnapshot(repository, input, context);
  if (!cacheSnapshot) return payload;
  return {
    ...payload,
    fastAck: true,
    cacheSnapshot,
    cacheReturnedAt: nowIso(),
  };
}

export function createMarketingService({ db, ozonScheduler, productRepository: providedProductRepository, backgroundRunner = (task) => setImmediate(task) } = {}) {
  const repository = db && hasMarketingCacheTables(db) ? createMarketingRepository(db) : null;
  const productRepository = providedProductRepository
    || (db && hasProductsCacheTable(db) ? createProductRepository(db) : null);
  const jobService = db ? createSyncJobService(db) : null;
  const stateService = db ? createSyncStateService(db) : null;
  const marketingWriteService = createMarketingWriteService({ ozonScheduler });

  function readCache(query = {}) {
    if (!repository) {
      return { ok: false, error: { code: 'MARKETING_CACHE_NOT_CONNECTED', message: '营销活动缓存表尚未连接。' } };
    }
    const scope = normalizeText(query.scope || 'activities');
    if (scope === 'activities') {
      return repository.listActivities(query);
    }
    if (scope === 'products') {
      return repository.listActivityProducts(query);
    }
    if (scope === 'summary') {
      return repository.readSummary(query);
    }
    if (scope === 'snapshot') {
      return repository.readSnapshot(query);
    }
    if (scope !== 'activities') {
      return { ok: false, error: { code: 'MARKETING_CACHE_SCOPE_NOT_CONNECTED', message: `营销活动缓存范围尚未接入：${scope}` } };
    }
    return repository.listActivities(query);
  }

  function importLegacySnapshots(input = {}) {
    if (!repository) {
      return { ok: false, error: { code: 'MARKETING_CACHE_NOT_CONNECTED', message: '营销活动缓存表尚未连接。' } };
    }
    return repository.importLegacySnapshots(input);
  }

  function saveViewState(input = {}) {
    if (!repository) {
      return { ok: false, error: { code: 'MARKETING_CACHE_NOT_CONNECTED', message: '营销活动缓存表尚未连接。' } };
    }
    return repository.saveViewState(input);
  }

  async function runMarketingSyncJob(job, input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by) || 'marketing-domain-service';
    const syncSource = normalizeText(input.source ?? input.syncSource) || requestedBy;
    const syncMode = normalizeText(input.syncMode ?? input.sync_mode) || null;
    const recoveryRestoreId = normalizeText(input.recoveryRestoreId ?? input.recovery_restore_id) || null;
    const recoveryGenerationId = normalizeText(input.recoveryGenerationId ?? input.recovery_generation_id) || null;
    const recoveryOverlapMinutes = Number.isFinite(Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes))
      ? Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes)
      : null;
    const forceRefresh = input.forceRefresh !== false;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let lastError = null;

    jobService.updateJob(job.jobId, { status: SYNC_JOB_STATUS.running, startedAt: nowIso(), progressTotal: 2, progressDone: 0 });
    stateService.upsertState({ domain: 'marketing', shopId, scopeKey: 'marketing:activities', status: 'running', lastAttemptAt: nowIso() });

    const endpoints = [
      {
        endpointKey: 'actions.list',
        sourceType: 'official',
        sourceLabel: '平台活动',
        params: {},
        cacheKey: `marketing:${shopId}:actions.list`,
      },
      {
        endpointKey: 'sellerActions.list',
        sourceType: 'seller',
        sourceLabel: '商家自主',
        params: { limit: Number(input.limit) || 100, offset: 0 },
        cacheKey: `marketing:${shopId}:sellerActions.list`,
      },
    ];

    let completedCount = 0;
    await Promise.all(endpoints.map(async (endpoint) => {
      try {
        const result = await readMarketingEndpoint({
          ozonScheduler,
          shopId,
          endpointKey: endpoint.endpointKey,
          params: endpoint.params,
          cacheKey: endpoint.cacheKey,
          idempotencyKey: `${job.jobId}:${endpoint.endpointKey}`,
          requestedBy,
          forceRefresh,
          profile: input.profile ?? input.schedulerProfile,
          source: syncSource,
          syncMode,
          recoveryRestoreId,
          recoveryGenerationId,
          recoveryOverlapMinutes,
        });
        if (!isSchedulerOk(result)) {
          failedCount += 1;
          lastError = schedulerErrorMessage(result);
        } else {
          const data = getSchedulerData(result);
          const rows = extractItems(data);
          const merge = repository.upsertActivities({
            shopId,
            sourceType: endpoint.sourceType,
            sourceLabel: endpoint.sourceLabel,
            rows,
          });
          changedCount += Number(merge.changed) || 0;
          unchangedCount += Number(merge.unchanged) || 0;
        }
      } catch (error) {
        failedCount += 1;
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        completedCount += 1;
        jobService.updateJob(job.jobId, {
          progressDone: completedCount,
          changedCount,
          unchangedCount,
          failedCount,
          lastError,
        });
      }
    }));

    const finalStatus = failedCount === 0 ? SYNC_JOB_STATUS.success : changedCount + unchangedCount > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
    const finalJob = jobService.updateJob(job.jobId, {
      status: finalStatus,
      progressDone: 2,
      progressTotal: 2,
      changedCount,
      unchangedCount,
      failedCount,
      lastError,
      finishedAt: nowIso(),
    });
    stateService.upsertState({
      domain: 'marketing',
      shopId,
      scopeKey: 'marketing:activities',
      status: finalStatus,
      lastSuccessAt: finalStatus === SYNC_JOB_STATUS.failed ? null : nowIso(),
      lastAttemptAt: nowIso(),
      lastError,
      changedCount,
      unchangedCount,
    });
    return { job: finalJob };
  }

  async function hydrateMarketingProducts({ job, shopId, rows = [], requestedBy, forceRefresh, maxHydrateProducts } = {}) {
    if (!productRepository || !ozonScheduler?.executeReadOnly) {
      return { changedCount: 0, unchangedCount: 0, failedCount: 0, errors: [], skipped: true };
    }
    const maxHydrateCount = normalizeMaxHydrateProducts(maxHydrateProducts, 1000);
    const productIds = limitIds(rows.map(getHydrationProductId), maxHydrateCount)
      .sort((left, right) => left.localeCompare(right));
    if (!productIds.length) {
      return { changedCount: 0, unchangedCount: 0, failedCount: 0, errors: [], productCount: 0 };
    }

    const productChunks = chunkArray(productIds, 100);
    const totalBatches = productChunks.length * 3;
    const currentJob = jobService.getJob(job.jobId);
    let done = Number(currentJob?.progress?.done) || Number(job.progressDone) || 0;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    const errors = [];

    jobService.updateJob(job.jobId, {
      progressTotal: (Number(currentJob?.progress?.total) || 0) + totalBatches,
    });

    const runHydrator = async ({ endpointKey, label, paramBuilder, merge }) => {
      for (let index = 0; index < productChunks.length; index += 1) {
        const chunk = productChunks[index];
        const batchIdentity = buildMarketingHydrationBatchIdentity({
          shopId,
          endpointKey,
          productIds: chunk,
        });
        try {
          const result = await readMarketingProductHydrationEndpoint({
            ozonScheduler,
            shopId,
            endpointKey,
            params: paramBuilder(batchIdentity.productIds),
            cacheKey: batchIdentity.cacheKey,
            idempotencyKey: batchIdentity.idempotencyKey,
            requestedBy,
            forceRefresh,
          });
          if (!isSchedulerOk(result)) {
            throw new Error(schedulerErrorMessage(result, `${label}补水失败`));
          }
          const mergeResult = merge({ shopId, rows: extractItems(getSchedulerData(result)) });
          changedCount += Number(mergeResult.changed ?? mergeResult.updated) || 0;
          unchangedCount += Number(mergeResult.unchanged) || 0;
        } catch (error) {
          failedCount += 1;
          errors.push(`${label}补水：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          done += 1;
          jobService.updateJob(job.jobId, {
            progressDone: done,
            changedCount,
            unchangedCount,
            failedCount,
            lastError: errors.length ? errors.slice(0, 3).join('；') : null,
          });
        }
      }
    };

    await runHydrator({
      endpointKey: 'products.infoList',
      label: '商品详情',
      paramBuilder: (chunk) => ({ product_id: chunk }),
      merge: (input) => productRepository.mergeProductInfoRows(input),
    });
    await runHydrator({
      endpointKey: 'products.prices',
      label: '价格',
      paramBuilder: (chunk) => ({ filter: { product_id: chunk }, limit: 1000 }),
      merge: (input) => productRepository.mergeProductPriceRows(input),
    });
    await runHydrator({
      endpointKey: 'products.stocks',
      label: '库存',
      paramBuilder: (chunk) => ({ filter: { product_id: chunk }, limit: 1000 }),
      merge: (input) => productRepository.mergeProductStockRows(input),
    });

    return {
      changedCount,
      unchangedCount,
      failedCount,
      errors,
      productCount: productIds.length,
    };
  }

  function listAllMarketingActivitiesForSummary({ shopId, sourceType = '' } = {}) {
    const activities = [];
    let page = 1;
    const pageSize = 1000;
    while (true) {
      const result = repository.listActivities({ shopId, sourceType, page, pageSize });
      const rows = Array.isArray(result.activityRows) ? result.activityRows : [];
      activities.push(...rows);
      if (!rows.length || activities.length >= (Number(result.total) || 0)) break;
      page += 1;
      if (page > 100) break;
    }
    return activities;
  }

  async function syncOneMarketingActivityProductsForSummary({ job, shopId, activity, requestedBy, forceRefresh, maxHydrateProducts } = {}) {
    const sourceType = getActivitySourceType({ sourceType: activity.sourceType });
    const activityId = getActivityId({ activityId: activity.id ?? activity.activityId });
    if (!activityId) return { changedCount: 0, unchangedCount: 0, failedCount: 1, error: '活动 ID 为空。' };
    const actionId = Number.isFinite(Number(activityId)) ? Number(activityId) : activityId;
    const declaredAvailable = Number(activity.available ?? activity.availableCount ?? activity.available_count);
    const hasDeclaredAvailable = activity.hasAvailableCount === true || activity.has_available_count === true;
    const shouldReadCandidates = !(hasDeclaredAvailable && Number.isFinite(declaredAvailable) && declaredAvailable <= 0);
    const endpoints = [
      {
        endpointKey: sourceType === 'seller' ? 'sellerActions.productsList' : 'actions.products',
        rowStatus: '已添加',
        cacheKey: buildMarketingActivityProductCacheKey({ shopId, sourceType, activityId, rowStatus: '已添加' }),
      },
      shouldReadCandidates
        ? {
            endpointKey: sourceType === 'seller' ? 'sellerActions.productsCandidates' : 'actions.candidates',
            rowStatus: '可添加',
            cacheKey: buildMarketingActivityProductCacheKey({ shopId, sourceType, activityId, rowStatus: '可添加' }),
          }
        : null,
    ].filter(Boolean);
    const endpointResults = [];
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let lastError = null;
    const joinedIds = new Set();
    const hydrationRows = [];

    for (const endpoint of endpoints) {
      try {
        const page = await readMarketingPagedItems({
          ozonScheduler,
          shopId,
          endpointKey: endpoint.endpointKey,
          params: { action_id: actionId },
          cacheKey: endpoint.cacheKey,
          idempotencyKey: `${job.jobId}:summary:${sourceType}:${activityId}:${endpoint.endpointKey}`,
          requestedBy,
          forceRefresh,
          limit: 1000,
          maxPages: 50,
          action: 'sync-marketing-product-facts',
        });
        endpointResults.push({ endpoint, rows: page.rows });
      } catch (error) {
        failedCount += 1;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    const joinedResult = endpointResults.find((item) => item.endpoint.rowStatus === '已添加');
    if (joinedResult) {
      joinedResult.rows.forEach((row) => {
        const productId = getProductId(row);
        if (productId) joinedIds.add(productId);
      });
    }

    for (const item of endpointResults) {
      const rows = item.endpoint.rowStatus === '可添加'
        ? item.rows.filter((row) => !joinedIds.has(getProductId(row)))
        : item.rows;
      hydrationRows.push(...rows);
      const merge = repository.upsertActivityProducts({
        shopId,
        activityId,
        sourceType,
        rowStatus: item.endpoint.rowStatus,
        rows,
      });
      changedCount += Number(merge.changed) || 0;
      unchangedCount += Number(merge.unchanged) || 0;
    }

    if (hydrationRows.length) {
      const hydration = await hydrateMarketingProducts({
        job,
        shopId,
        rows: hydrationRows,
        requestedBy,
        forceRefresh,
        maxHydrateProducts,
      });
      changedCount += Number(hydration.changedCount) || 0;
      unchangedCount += Number(hydration.unchangedCount) || 0;
      failedCount += Number(hydration.failedCount) || 0;
      if (hydration.errors?.length) lastError = hydration.errors.slice(0, 3).join('；');
    }

    return { changedCount, unchangedCount, failedCount, error: lastError, activityId };
  }

  async function runMarketingSummarySyncJob(job, input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by) || 'marketing-domain-service';
    const sourceType = normalizeText(input.sourceType ?? input.source_type);
    const forceRefresh = input.forceRefresh === true;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let lastError = null;

    jobService.updateJob(job.jobId, { status: SYNC_JOB_STATUS.running, startedAt: nowIso(), progressTotal: 1, progressDone: 0 });
    stateService.upsertState({ domain: 'marketing', shopId, scopeKey: 'marketing:summary', status: 'running', lastAttemptAt: nowIso() });

    const activities = listAllMarketingActivitiesForSummary({ shopId, sourceType });
    jobService.updateJob(job.jobId, { progressTotal: Math.max(activities.length, 1) });

    for (const activity of activities) {
      const result = await syncOneMarketingActivityProductsForSummary({
        job,
        shopId,
        activity,
        requestedBy,
        forceRefresh,
        maxHydrateProducts: input.maxHydrateProducts ?? input.max_hydrate_products,
      });
      changedCount += Number(result.changedCount) || 0;
      unchangedCount += Number(result.unchangedCount) || 0;
      failedCount += Number(result.failedCount) || 0;
      if (result.error) lastError = result.error;
      const latest = jobService.getJob(job.jobId);
      jobService.updateJob(job.jobId, {
        progressDone: (Number(latest?.progress?.done) || 0) + 1,
        changedCount,
        unchangedCount,
        failedCount,
        lastError,
      });
    }

    const summary = repository.readSummary({ shopId, sourceType });
    const finalStatus = failedCount === 0 ? SYNC_JOB_STATUS.success : changedCount + unchangedCount > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
    const latestProgressJob = jobService.getJob(job.jobId);
    const finalJob = jobService.updateJob(job.jobId, {
      status: finalStatus,
      progressDone: Number(latestProgressJob?.progress?.done) || Math.max(activities.length, 1),
      progressTotal: Number(latestProgressJob?.progress?.total) || Math.max(activities.length, 1),
      changedCount,
      unchangedCount,
      failedCount,
      lastError,
      finishedAt: nowIso(),
    });
    stateService.upsertState({
      domain: 'marketing',
      shopId,
      scopeKey: 'marketing:summary',
      status: finalStatus,
      lastSuccessAt: finalStatus === SYNC_JOB_STATUS.failed ? null : nowIso(),
      lastAttemptAt: nowIso(),
      lastError,
      changedCount,
      unchangedCount,
    });
    return { job: finalJob, summary };
  }

  async function runMarketingProductsSyncJob(job, input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by) || 'marketing-domain-service';
    const sourceType = getActivitySourceType(input);
    const activityId = getActivityId(input);
    const productScope = normalizeProductScope(input.productScope ?? input.product_scope ?? input.range ?? input.scope);
    const actionId = Number.isFinite(Number(activityId)) ? Number(activityId) : activityId;
    const declaredAvailable = Number(input.available ?? input.availableCount ?? input.available_count);
    const hasDeclaredAvailable = input.hasAvailableCount === true || input.has_available_count === true;
    const shouldReadJoined = productScope !== 'available';
    const shouldReadCandidates = productScope !== 'joined' && !(hasDeclaredAvailable && Number.isFinite(declaredAvailable) && declaredAvailable <= 0);
    const endpoints = [
      shouldReadJoined
        ? {
            endpointKey: sourceType === 'seller' ? 'sellerActions.productsList' : 'actions.products',
            rowStatus: '已添加',
            cacheKey: buildMarketingActivityProductCacheKey({ shopId, sourceType, activityId, rowStatus: '已添加' }),
          }
        : null,
      shouldReadCandidates
        ? {
            endpointKey: sourceType === 'seller' ? 'sellerActions.productsCandidates' : 'actions.candidates',
            rowStatus: '可添加',
            cacheKey: buildMarketingActivityProductCacheKey({ shopId, sourceType, activityId, rowStatus: '可添加' }),
          }
        : null,
    ].filter(Boolean);

    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let lastError = null;
    const joinedIds = new Set();
    const hydrationRows = [];

    jobService.updateJob(job.jobId, {
      status: SYNC_JOB_STATUS.running,
      startedAt: nowIso(),
      progressTotal: endpoints.length,
      progressDone: 0,
    });
    stateService.upsertState({
      domain: 'marketing',
      shopId,
      scopeKey: `marketing:products:${sourceType}:${activityId}:${productScope}`,
      status: 'running',
      lastAttemptAt: nowIso(),
    });

    let completedCount = 0;
    const endpointResults = await Promise.all(endpoints.map(async (endpoint) => {
      try {
        const page = await readMarketingPagedItems({
          ozonScheduler,
          shopId,
          endpointKey: endpoint.endpointKey,
          params: { action_id: actionId },
          cacheKey: endpoint.cacheKey,
          idempotencyKey: `${job.jobId}:${endpoint.endpointKey}`,
          requestedBy,
          forceRefresh: input.forceRefresh === true,
          limit: Number(input.limit) || 1000,
          maxPages: Number(input.maxPages) || 20,
          action: 'sync-marketing-product-facts',
        });
        return { endpoint, rows: page.rows };
      } catch (error) {
        failedCount += 1;
        lastError = error instanceof Error ? error.message : String(error);
        return { endpoint, rows: [], error };
      } finally {
        completedCount += 1;
        jobService.updateJob(job.jobId, {
          progressDone: completedCount,
          changedCount,
          unchangedCount,
          failedCount,
          lastError,
        });
      }
    }));

    const joinedResult = endpointResults.find((item) => item.endpoint.rowStatus === '已添加');
    if (joinedResult) {
      joinedResult.rows.forEach((row) => {
        const productId = getProductId(row);
        if (productId) joinedIds.add(productId);
      });
    }

    for (const item of endpointResults) {
      if (item.error) continue;
      const rows = item.endpoint.rowStatus === '可添加'
        ? item.rows.filter((row) => !joinedIds.has(getProductId(row)))
        : item.rows;
      hydrationRows.push(...rows);
      const merge = repository.upsertActivityProducts({
        shopId,
        activityId,
        sourceType,
        rowStatus: item.endpoint.rowStatus,
        rows,
      });
      changedCount += Number(merge.changed) || 0;
      unchangedCount += Number(merge.unchanged) || 0;
      jobService.updateJob(job.jobId, {
        changedCount,
        unchangedCount,
        failedCount,
        lastError,
      });
    }

    const shouldHydrateProducts = input.hydrateProducts !== false && input.hydrate_products !== false;
    if (shouldHydrateProducts && hydrationRows.length) {
      const hydration = await hydrateMarketingProducts({
        job,
        shopId,
        rows: hydrationRows,
        requestedBy,
        forceRefresh: input.forceRefresh === true,
        maxHydrateProducts: input.maxHydrateProducts ?? input.max_hydrate_products,
      });
      changedCount += Number(hydration.changedCount) || 0;
      unchangedCount += Number(hydration.unchangedCount) || 0;
      failedCount += Number(hydration.failedCount) || 0;
      if (hydration.errors?.length) lastError = hydration.errors.slice(0, 3).join('；');
    }

    const finalStatus = failedCount === 0 ? SYNC_JOB_STATUS.success : changedCount + unchangedCount > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
    const latestProgressJob = jobService.getJob(job.jobId);
    const finalJob = jobService.updateJob(job.jobId, {
      status: finalStatus,
      progressDone: Number(latestProgressJob?.progress?.done) || endpoints.length,
      progressTotal: Number(latestProgressJob?.progress?.total) || endpoints.length,
      changedCount,
      unchangedCount,
      failedCount,
      lastError,
      finishedAt: nowIso(),
    });
    stateService.upsertState({
      domain: 'marketing',
      shopId,
      scopeKey: `marketing:products:${sourceType}:${activityId}:${productScope}`,
      status: finalStatus,
      lastSuccessAt: finalStatus === SYNC_JOB_STATUS.failed ? null : nowIso(),
      lastAttemptAt: nowIso(),
      lastError,
      changedCount,
      unchangedCount,
    });
    return { job: finalJob };
  }

  function startSync(input = {}) {
    if (!repository || !ozonScheduler?.executeReadOnly || !jobService) {
      return { ok: false, domain: 'marketing', error: { code: 'MARKETING_SYNC_NOT_CONNECTED', message: 'marketing domain service is not connected.' } };
    }
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    if (!shopId) {
      return { ok: false, domain: 'marketing', error: { code: 'MARKETING_SHOP_ID_REQUIRED', message: 'shopId is required for marketing sync.' } };
    }
    const syncScope = normalizeMarketingSyncScope(input.scope, input);
    const productSync = syncScope === 'products';
    const summarySync = syncScope === 'summary';
    const activityId = getActivityId(input);
    const sourceType = summarySync ? normalizeText(input.sourceType ?? input.source_type) : getActivitySourceType(input);
    const productScope = normalizeProductScope(input.productScope ?? input.product_scope ?? input.range ?? input.scope);
    if (productSync && !activityId) {
      return { ok: false, domain: 'marketing', error: { code: 'MARKETING_ACTIVITY_ID_REQUIRED', message: 'activityId is required for marketing product pool sync.' } };
    }
    const action = summarySync ? 'sync-marketing-summary' : productSync ? 'sync-marketing-products' : 'sync-marketing-activities';
    const requestFingerprint = buildMarketingRequestFingerprint({
      ...input,
      shopId,
      action,
      scope: syncScope,
      activityId,
      sourceType,
      productScope,
    });
    const reusable = jobService.findReusableJob({ requestFingerprint, idempotencyKey: input.idempotencyKey ?? input.idempotency_key });
    if (reusable?.job) {
      return attachFastMarketingCacheSnapshot(
        { ok: true, accepted: true, domain: 'marketing', jobId: reusable.job.jobId, job: reusable.job, status: reusable.job.status, reused: true, reusedFromJobId: reusable.job.jobId, reason: reusable.reason },
        repository,
        input,
        { shopId, productSync, summarySync, activityId, sourceType, productScope },
      );
    }
    const job = jobService.createJob({
      id: createMarketingJobId(),
      domain: 'marketing',
      shopId,
      endpointKey: summarySync ? 'marketing.summary' : productSync ? 'marketing.products' : 'marketing.activities',
      action,
      priority: input.priority || 'P2',
      profile: input.profile ?? input.schedulerProfile ?? null,
      source: input.source ?? input.syncSource ?? null,
      requestedBy: input.requestedBy || input.requested_by || 'marketing-domain-service',
      cacheKey: summarySync
        ? `marketing:${shopId}:summary`
        : productSync
          ? `marketing:${shopId}:${sourceType}:${activityId}:${productScope}`
          : `marketing:${shopId}:activities`,
      idempotencyKey: input.idempotencyKey || input.idempotency_key || null,
      requestFingerprint,
      dedupeUntil: new Date(Date.now() + 60_000).toISOString(),
      progressTotal: 0,
    });
    backgroundRunner(() => {
      const runner = summarySync ? runMarketingSummarySyncJob : productSync ? runMarketingProductsSyncJob : runMarketingSyncJob;
      return runner(job, { ...input, shopId, activityId, sourceType, productScope }).catch((error) => {
        jobService.updateJob(job.jobId, {
          status: SYNC_JOB_STATUS.failed,
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: nowIso(),
        });
      });
    });
    return attachFastMarketingCacheSnapshot(
      { ok: true, accepted: true, domain: 'marketing', jobId: job.jobId, job, status: job.status, reused: false },
      repository,
      input,
      { shopId, productSync, summarySync, activityId, sourceType, productScope },
    );
  }

  return {
    domain: 'marketing',
    readCache,
    importLegacySnapshots,
    saveViewState,
    startSync,
    runMarketingSyncJob,
    runMarketingSummarySyncJob,
    executeConfirmedWrite(context = {}) {
      return marketingWriteService.executeConfirmedWrite(context);
    },
  };
}
