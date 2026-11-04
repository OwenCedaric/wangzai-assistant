import {
  containsCyrillicText,
  createReturnRepository,
} from '../../db/repositories/returnRepository.js';
import { createSyncJobService, SYNC_JOB_STATUS } from '../../sync/syncJobService.js';
import { createSyncSnapshotService } from '../../sync/syncSnapshotService.js';
import { createSyncStateService } from '../../sync/syncStateService.js';
import { createStableHash } from '../../utils/stableHash.js';
import { createShopScopedRepositoryRouter } from '../../db/shopScopedRepositoryRouter.js';
import {
  normalizeOrderLikeCacheQueryWithDefaultRange,
  normalizeOrderLikeSyncParamsWithDefaultRange,
} from '../orderTimeRange.js';
import { createReturnsWriteService } from './returnsWriteService.js';

const DEFAULT_RETURNS_PAGE_SIZE = 100;
const DEFAULT_RETURNS_MAX_PAGES = 100;

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

function toPositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function resolveEndpointKey(input = {}) {
  const endpointKey = normalizeText(input.endpointKey ?? input.endpoint_key);
  if (endpointKey) return endpointKey;
  const source = normalizeText(input.source ?? input.scope).toLowerCase();
  if (source.includes('conditional')) return 'returns.conditionalCancellationList';
  if (source.includes('rfbs') && (input.returnId || input.return_id || input.params?.return_id)) return 'returns.rfbsGet';
  if (source.includes('rfbs')) return 'returns.rfbsList';
  return 'returns.list';
}

function endpointSource(endpointKey) {
  if (endpointKey === 'returns.conditionalCancellationList') return 'conditional';
  if (endpointKey === 'returns.rfbsList' || endpointKey === 'returns.rfbsGet') return 'rfbs-return';
  return 'returns';
}

function extractReturns(data = {}) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.returns)) return data.returns;
  if (data.returns && typeof data.returns === 'object') return [data.returns];
  if (data.return && typeof data.return === 'object') return [data.return];
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.conditional_cancellations)) return data.conditional_cancellations;
  if (Array.isArray(data.cancellations)) return data.cancellations;
  if (Array.isArray(data.result?.returns)) return data.result.returns;
  if (data.result?.returns && typeof data.result.returns === 'object') return [data.result.returns];
  if (data.result?.return && typeof data.result.return === 'object') return [data.result.return];
  if (Array.isArray(data.result?.items)) return data.result.items;
  if (Array.isArray(data.result?.conditional_cancellations)) return data.result.conditional_cancellations;
  if (Array.isArray(data.result?.cancellations)) return data.result.cancellations;
  if (Array.isArray(data.result)) return data.result;
  if (data.result && typeof data.result === 'object') return [data.result];
  if (data.return_id || data.id || data.request_id || data.cancellation_id) return [data];
  return [];
}

function getSchedulerData(result = {}) {
  return result.data ?? result.cache?.payload ?? null;
}

function isSchedulerOk(result = {}) {
  return Boolean(result.ok || result.status === 'success' || result.status === 'partial' || result.status === 'cache_hit');
}

function schedulerErrorMessage(result, fallback = 'Ozon 售后接口调用失败') {
  const first = result?.errors?.[0];
  return first?.message || result?.job?.lastError || result?.error?.message || fallback;
}

function hasReturnsTable(db) {
  try {
    return Boolean(db?.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ozon_returns'").get());
  } catch {
    return false;
  }
}

function createReturnsJobId() {
  return `returns_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function publicJobPayload(job, extra = {}) {
  return {
    ok: true,
    accepted: true,
    domain: 'returns',
    jobId: job?.jobId || job?.id,
    job,
    status: job?.status || 'queued',
    ...extra,
  };
}

function shouldRecordReturnNotifications(input = {}) {
  const profile = normalizeText(input.profile ?? input.schedulerProfile);
  const source = normalizeText(input.source ?? input.syncSource).toLowerCase();
  return input.recordNotifications === true || profile === 'background' || source.includes('background');
}

function returnEntityId(row = {}) {
  return (
    normalizeText(row.returnKey) ||
    normalizeText(row.returnId ?? row.return_id) ||
    normalizeText(row.postingNumber ?? row.posting_number) ||
    normalizeText(row.orderId ?? row.order_id) ||
    normalizeText(row.id)
  );
}

function returnPostingNumber(row = {}) {
  return normalizeText(row.postingNumber ?? row.posting_number);
}

function returnDisplayNumber(row = {}) {
  return (
    returnPostingNumber(row) ||
    normalizeText(row.returnId ?? row.return_id) ||
    normalizeText(row.orderId ?? row.order_id) ||
    normalizeText(row.returnKey) ||
    '未知售后单'
  );
}

function firstScalarText(...values) {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = normalizeText(value);
    if (text && text !== '未返回') return text;
  }
  return '';
}

function returnProductSnapshot(row = {}) {
  const source = Array.isArray(row.products)
    ? row.products
    : Array.isArray(row.product)
      ? row.product
      : row.product && typeof row.product === 'object'
        ? [row.product]
        : [];
  const product = source.find((item) => item && typeof item === 'object') || {};
  const imageCandidates = [
    product.image,
    product.imageUrl,
    product.image_url,
    product.skuImage,
    product.sku_image,
    product.primaryImage,
    product.primary_image,
    ...(Array.isArray(product.images) ? product.images : []),
    ...(Array.isArray(product.pictures) ? product.pictures : []),
  ];
  return {
    productName: firstScalarText(
      product.name,
      product.title,
      product.productName,
      product.product_name,
      product.offerName,
      product.offer_name
    ),
    offerId: firstScalarText(product.offerId, product.offer_id),
    productId: firstScalarText(product.productId, product.product_id),
    sku: firstScalarText(product.offerId, product.offer_id, product.sku, product.skuId, product.sku_id),
    imageUrl: imageCandidates.map(firstScalarText).find((value) => /^https?:\/\//iu.test(value)) || '',
    productCount: source.length,
  };
}

function returnValueSnapshot(row = {}) {
  const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
  return {
    status: normalizeText(row.status),
    substatus: normalizeText(row.substatus),
    reason: normalizeText(row.reason ?? row.return_reason),
    refundStatus: normalizeText(row.refundStatus ?? row.refund_status),
    refundTime: normalizeText(row.refundTime ?? row.refund_time),
    refundAmount: firstScalarText(
      row.refundAmount,
      row.refund_amount,
      row.amount,
      row.totalRefundAmount,
      row.total_refund_amount,
      raw.refundAmount,
      raw.refund_amount,
      raw.amount,
      raw.refund?.amount
    ),
    currencyCode: firstScalarText(row.currencyCode, row.currency, raw.currency_code, raw.currency),
    ...returnProductSnapshot(row),
    source: normalizeText(row.source),
  };
}

function compactReturnValue(snapshot = {}) {
  return Object.fromEntries(Object.entries(snapshot).filter(([, value]) => normalizeText(value)));
}

function changedReturnFields(before = {}, after = {}) {
  const fields = [
    ['status', '售后状态'],
    ['substatus', '子状态'],
    ['reason', '售后原因'],
    ['refundStatus', '退款状态'],
    ['refundAmount', '退款金额'],
    ['refundTime', '退款时间'],
    ['source', '来源'],
  ];
  return fields
    .filter(([field]) => normalizeText(before[field]) !== normalizeText(after[field]))
    .map(([, label]) => label);
}

function buildReturnNotificationEvent({
  change,
  shopId,
  shopName,
  snapshotId,
  sourceJobId,
  sourceEndpoint,
  notifyInserted,
} = {}) {
  if (!change?.after) return null;
  const beforeSnapshot = returnValueSnapshot(change.before || {});
  const afterSnapshot = returnValueSnapshot(change.after || {});
  const isInserted = change.changeType === 'inserted';
  if (isInserted && !notifyInserted) return null;
  const fields = isInserted ? ['新增售后'] : changedReturnFields(beforeSnapshot, afterSnapshot);
  if (!fields.length) return null;
  const entityId = returnEntityId(change.after);
  if (!entityId) return null;
  const displayNumber = returnDisplayNumber(change.after);
  return {
    shopId,
    shopName,
    domain: 'returns',
    eventType: isInserted ? 'return_created' : 'return_status_changed',
    severity: 'info',
    title: isInserted ? '新增售后订单' : '售后订单变化',
    summary: isInserted ? `${displayNumber}：新增售后记录` : `${displayNumber}：${fields.join('、')}已变化`,
    oldValue: compactReturnValue(beforeSnapshot),
    newValue: compactReturnValue(afterSnapshot),
    sourceEndpoint,
    sourceJobId,
    snapshotId,
    entityType: 'after_sales_order',
    entityId,
    postingNumber: returnPostingNumber(change.after) || null,
    dedupeWindowMinutes: 60,
  };
}

function buildRequestFingerprint(input = {}) {
  return createStableHash({
    domain: 'returns',
    shopId: input.shopId,
    endpointKey: input.endpointKey,
    params: input.params,
    pageSize: input.pageSize,
    maxPages: input.maxPages,
    forceRefresh: input.forceRefresh === true,
  }, { length: 32 });
}

function withOffsetParams(params = {}, { limit, offset } = {}) {
  return { ...(params || {}), limit, offset };
}

async function runLimitedAsync(items = [], limit = 4, task) {
  const sourceItems = Array.isArray(items) ? items : [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1, sourceItems.length || 1));
  const results = new Array(sourceItems.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < sourceItems.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await task(sourceItems[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: safeLimit }, worker));
  return results;
}

function extractReturnDetailId(row = {}) {
  return normalizeId(row.return_id ?? row.returnId ?? row.id ?? row.request_id ?? row.requestId);
}

function attachReturnDetailRequestIdentity(rows = [], params = {}) {
  const returnId = normalizeId(params.return_id ?? params.returnId ?? params.id);
  if (!returnId || !Array.isArray(rows) || rows.length === 0) return rows;
  return rows.map((row) => ({
    ...row,
    id: normalizeId(row.id) || returnId,
    return_id: normalizeId(row.return_id) || normalizeId(row.returnId) || returnId,
    returnId: normalizeId(row.returnId) || normalizeId(row.return_id) || returnId,
  }));
}

function hasUsefulReturnReason(row = {}) {
  return Boolean(normalizeText(row.reason ?? row.return_reason ?? row.returnReason ?? row.return_reason_name));
}

function mergeReturnListRowWithDetail(row = {}, detail = {}) {
  if (!detail || typeof detail !== 'object') return row;
  return {
    ...row,
    ...detail,
    id: normalizeText(detail.id) || normalizeText(detail.return_id) || normalizeText(detail.returnId) || row.id,
    return_id: normalizeText(detail.return_id) || normalizeText(detail.returnId) || normalizeText(row.return_id) || row.id,
    returnId: normalizeText(detail.returnId) || normalizeText(detail.return_id) || normalizeText(row.returnId),
    posting_number:
      normalizeText(detail.posting_number) || normalizeText(detail.postingNumber) || normalizeText(row.posting_number),
    postingNumber:
      normalizeText(detail.postingNumber) || normalizeText(detail.posting_number) || normalizeText(row.postingNumber),
    order_number: normalizeText(detail.order_number) || normalizeText(detail.orderNumber) || normalizeText(row.order_number),
    product: detail.product ?? row.product,
    products: detail.products ?? row.products,
    listItem: row,
    detail,
  };
}

export function createReturnsService({
  db,
  readDb = db,
  ozonScheduler,
  shopRepository,
  messageTranslationService,
  shopOperationalStorage = null,
  backgroundRunner = (task) => setImmediate(task),
} = {}) {
  const canonicalRepository = db && hasReturnsTable(db) ? createReturnRepository(db) : null;
  const repository = canonicalRepository && shopOperationalStorage?.resolveDirectWriteSession
    ? createShopScopedRepositoryRouter({
        canonicalRepository,
        createRepository: createReturnRepository,
        storage: shopOperationalStorage,
        aggregateRepository: readDb !== db ? createReturnRepository(readDb) : null,
        writeMethods: ['upsertReturns', 'saveReasonTranslation', 'markReasonTranslationFailed'],
        readMethods: ['listReturns'],
      })
    : canonicalRepository;
  const jobService = db ? createSyncJobService(db) : null;
  const snapshotService = db ? createSyncSnapshotService(db) : null;
  const stateService = db ? createSyncStateService(db) : null;
  const writeService = createReturnsWriteService({ repository, ozonScheduler });

  async function translateReasons(input = {}) {
    if (!repository || !messageTranslationService?.translateMessages) {
      return {
        ok: false,
        error: {
          code: 'RETURN_REASON_TRANSLATION_NOT_CONNECTED',
          message: '售后原因翻译服务未连接。',
        },
      };
    }

    const sourceRows = Array.isArray(input.messages) ? input.messages.slice(0, 300) : [];
    const uniqueRows = [];
    const groups = new Map();
    for (const row of sourceRows) {
      const text = normalizeText(row?.text).slice(0, 1000);
      const shopId = normalizeId(row?.shopId ?? row?.shop_id);
      if (!text || !containsCyrillicText(text)) continue;
      let group = groups.get(text);
      if (!group) {
        group = { id: `return-reason-${uniqueRows.length + 1}`, text, shopIds: new Set() };
        groups.set(text, group);
        uniqueRows.push(group);
      }
      if (shopId) group.shopIds.add(shopId);
    }

    const translatedRows = [];
    for (let offset = 0; offset < uniqueRows.length; offset += 100) {
      const chunk = uniqueRows.slice(offset, offset + 100);
      const payload = await messageTranslationService.translateMessages({
        messages: chunk.map(({ id, text }) => ({ id, text })),
        signal: input.signal,
      });
      translatedRows.push(...(Array.isArray(payload?.rows) ? payload.rows : []));
    }

    const translatedByText = new Map(translatedRows.map((row) => [normalizeText(row.text), row]));
    let persistedCount = 0;
    let failedCount = 0;
    const rows = uniqueRows.map((group) => {
      const translated = translatedByText.get(group.text) || {};
      const translatedText = normalizeText(translated.translatedText);
      const valid = Boolean(translated.translated) && translatedText && !containsCyrillicText(translatedText);
      for (const shopId of group.shopIds) {
        const saved = valid
          ? repository.saveReasonTranslation({
              shopId,
              sourceText: group.text,
              translatedText,
              provider: translated.provider || 'automatic',
            })
          : repository.markReasonTranslationFailed({
              shopId,
              sourceText: group.text,
              provider: translated.provider || translated.errorCode || 'unavailable',
            });
        persistedCount += Number(saved?.changed || 0);
      }
      if (!valid) failedCount += 1;
      return {
        text: group.text,
        translatedText: valid ? translatedText : '',
        translated: valid,
        provider: translated.provider || null,
        errorCode: valid ? null : translated.errorCode || 'RETURN_REASON_TRANSLATION_FAILED',
      };
    });

    return {
      ok: true,
      sourceLanguage: 'ru',
      targetLanguage: 'zh-CN',
      rows,
      translatedCount: rows.length - failedCount,
      failedCount,
      persistedCount,
    };
  }

  function readCache(query = {}) {
    if (!repository) {
      return { ok: false, error: { code: 'RETURNS_CACHE_NOT_CONNECTED', message: 'returns SQLite cache is not connected.' } };
    }
    const started = Date.now();
    const payload = repository.listReturns(normalizeOrderLikeCacheQueryWithDefaultRange(query));
    payload.durationMs = Date.now() - started;
    payload.syncState = stateService?.listStates('returns', { shopId: query.shopId || query.shop_id, limit: 5 }) ?? [];
    return payload;
  }

  function getShopName(shopId) {
    return (
      normalizeText(shopRepository?.getShopById?.(shopId)?.name) ||
      normalizeText(shopRepository?.getPublicShopById?.(shopId)?.name) ||
      ''
    );
  }

  function recordReturnNotificationEvents({
    changes = [],
    snapshotId,
    sourceJobId,
    shopId,
    sourceEndpoint,
    notifyInserted,
  } = {}) {
    if (!snapshotService?.isAvailable?.() || !snapshotId || !Array.isArray(changes)) return 0;
    let recordedCount = 0;
    for (const change of changes) {
      const event = buildReturnNotificationEvent({
        change,
        shopId,
        shopName: getShopName(shopId),
        snapshotId,
        sourceJobId,
        sourceEndpoint,
        notifyInserted,
      });
      if (!event) continue;
      const recorded = snapshotService.recordNotification(event);
      if (recorded && !recorded.deduped && !recorded.skipped) recordedCount += 1;
    }
    return recordedCount;
  }

  async function runReturnsSyncJob(job, input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const endpointKey = resolveEndpointKey(input);
    const isDetail = endpointKey === 'returns.rfbsGet';
    const sourceParams = input.params && typeof input.params === 'object' ? input.params : {};
    const baseParams = isDetail ? sourceParams : normalizeOrderLikeSyncParamsWithDefaultRange(sourceParams, input);
    const pageSize = toPositiveInteger(input.pageSize ?? input.limit ?? baseParams.limit, DEFAULT_RETURNS_PAGE_SIZE, 1000);
    const maxPages = isDetail ? 1 : toPositiveInteger(input.maxPages, DEFAULT_RETURNS_MAX_PAGES, 100);
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by) || 'returns-domain-service';
    const syncSource = normalizeText(input.source ?? input.syncSource) || requestedBy;
    const syncMode = normalizeText(input.syncMode ?? input.sync_mode) || null;
    const recoveryRestoreId = normalizeText(
      input.recoveryRestoreId ?? input.recovery_restore_id,
    ) || null;
    const recoveryGenerationId = normalizeText(
      input.recoveryGenerationId ?? input.recovery_generation_id,
    ) || null;
    const recoveryOverlapMinutes = Number.isFinite(
      Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes),
    )
      ? Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes)
      : null;
    const forceRefresh = input.forceRefresh !== false;
    const shouldRecordNotifications = shouldRecordReturnNotifications(input);
    const notifyInserted =
      shouldRecordNotifications && repository.listReturns({ shopId, pageSize: 1, offset: 0 }).total > 0;
    const snapshot = snapshotService?.createSnapshot?.({
      domain: 'returns',
      shopId,
      source: syncSource,
      status: 'running',
      sourceJobId: job.jobId,
    });
    const snapshotId = snapshot?.id || null;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let notificationCount = 0;
    let totalRows = 0;
    let done = 0;
    const errors = [];

    jobService.updateJob(job.jobId, { status: SYNC_JOB_STATUS.running, startedAt: nowIso(), progressTotal: maxPages, snapshotId });
    stateService.upsertState({ domain: 'returns', shopId, scopeKey: `returns:${endpointKey}`, status: 'running', lastAttemptAt: nowIso() });

    async function enrichRfbsRowsWithDetails(rows = []) {
      if (endpointKey !== 'returns.rfbsList' || input.enrichRfbsDetails === false) {
        return { rows, errors: [], attempted: 0 };
      }
      const candidates = rows
        .map((row, index) => ({ row, index, returnId: extractReturnDetailId(row) }))
        .filter(({ returnId }) => returnId);
      if (!candidates.length) return { rows, errors: [], attempted: 0 };

      // Keep only two detail jobs in flight for this shop. The scheduler also
      // serializes the endpoint through the same shop's rate bucket.
      const detailResults = await runLimitedAsync(candidates, 2, async ({ row, returnId }) => {
        const scheduled = await ozonScheduler.executeReadOnly({
          shopId,
          domain: 'returns',
          endpointKey: 'returns.rfbsGet',
          action: 'sync-rfbs-return-detail',
          priority: input.priority || (input.profile === 'background' || input.schedulerProfile === 'background' ? 'P4' : 'P3'),
          profile: input.profile ?? input.schedulerProfile,
          source: syncSource,
          syncMode,
          recoveryRestoreId,
          recoveryGenerationId,
          recoveryOverlapMinutes,
          snapshotId,
          params: { return_id: returnId },
          cacheKey: `returns:${shopId}:returns.rfbsGet:return:${returnId}`,
          idempotencyKey: `${job.jobId}:returns.rfbsGet:${returnId}`,
          requestedBy,
          forceRefresh,
          allowStale: true,
        });
        if (!isSchedulerOk(scheduled)) {
          throw new Error(schedulerErrorMessage(scheduled, `rFBS 售后详情 ${returnId} 读取失败`));
        }
        const detailRows = attachReturnDetailRequestIdentity(extractReturns(getSchedulerData(scheduled)), {
          return_id: returnId,
        });
        return mergeReturnListRowWithDetail(row, detailRows[0]);
      });

      const nextRows = [...rows];
      const detailErrors = [];
      detailResults.forEach((result, resultIndex) => {
        const candidate = candidates[resultIndex];
        if (result?.status === 'fulfilled' && result.value) {
          nextRows[candidate.index] = result.value;
          return;
        }
        detailErrors.push(
          `detail ${candidate.returnId}: ${
            result?.reason instanceof Error ? result.reason.message : String(result?.reason || '详情读取失败')
          }`
        );
      });
      return { rows: nextRows, errors: detailErrors, attempted: candidates.length };
    }

    for (let page = 1; page <= maxPages; page += 1) {
      const offset = (page - 1) * pageSize;
      try {
        const params = isDetail ? baseParams : withOffsetParams(baseParams, { limit: pageSize, offset });
        const detailReturnId = isDetail ? normalizeId(params.return_id ?? params.returnId ?? params.id) : '';
        const cachePart = isDetail
          ? `return:${detailReturnId || createStableHash(params, { length: 16 })}`
          : `offset:${offset}:limit:${pageSize}`;
        const scheduled = await ozonScheduler.executeReadOnly({
          shopId,
          domain: 'returns',
          endpointKey,
          action: isDetail ? 'sync-rfbs-return-detail' : 'sync-returns-list',
          priority: input.priority || (input.profile === 'background' || input.schedulerProfile === 'background' ? 'P4' : 'P2'),
          profile: input.profile ?? input.schedulerProfile,
          source: syncSource,
          syncMode,
          recoveryRestoreId,
          recoveryGenerationId,
          recoveryOverlapMinutes,
          snapshotId,
          params,
          cacheKey: `returns:${shopId}:${endpointKey}:${cachePart}`,
          idempotencyKey: `${job.jobId}:${endpointKey}:${cachePart}`,
          requestedBy,
          forceRefresh,
          allowStale: true,
        });
        if (!isSchedulerOk(scheduled)) {
          failedCount += 1;
          errors.push(`page ${page}: ${schedulerErrorMessage(scheduled)}`);
          break;
        }
        const data = getSchedulerData(scheduled);
        const sourceRows = isDetail ? attachReturnDetailRequestIdentity(extractReturns(data), baseParams) : extractReturns(data);
        const detailMerge = await enrichRfbsRowsWithDetails(sourceRows);
        const rows = detailMerge.rows;
        if (detailMerge.errors.length) {
          failedCount += detailMerge.errors.length;
          errors.push(...detailMerge.errors);
        }
        const merge = repository.upsertReturns({ shopId, rows, source: endpointSource(endpointKey) });
        changedCount += merge.changed || 0;
        unchangedCount += merge.unchanged || 0;
        totalRows += rows.length;
        if (shouldRecordNotifications && snapshotId) {
          notificationCount += recordReturnNotificationEvents({
            changes: merge.changes || [],
            snapshotId,
            sourceJobId: job.jobId,
            shopId,
            sourceEndpoint: endpointKey,
            notifyInserted,
          });
        }
        if (isDetail || rows.length < pageSize) break;
      } catch (error) {
        failedCount += 1;
        errors.push(`page ${page}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      } finally {
        done += 1;
        jobService.updateJob(job.jobId, { progressDone: done, changedCount, unchangedCount, failedCount });
      }
    }

    const finalStatus = failedCount === 0 ? SYNC_JOB_STATUS.success : changedCount + unchangedCount > 0 ? SYNC_JOB_STATUS.partial : SYNC_JOB_STATUS.failed;
    const lastError = errors[0] || null;
    const cacheRowCount = repository.listReturns({ shopId, pageSize: 1, offset: 0 }).total;
    snapshotService?.finishSnapshot?.(snapshotId, {
      status: finalStatus,
      active: finalStatus !== SYNC_JOB_STATUS.failed,
      rowCount: cacheRowCount || totalRows,
      changedCount,
      unchangedCount,
      failedCount,
    });
    const finalJob = jobService.updateJob(job.jobId, {
      status: finalStatus,
      progressDone: done,
      progressTotal: maxPages,
      changedCount,
      unchangedCount,
      failedCount,
      lastError,
      snapshotId,
      message: notificationCount > 0 ? `售后同步完成，已记录 ${notificationCount} 条后台变化提醒。` : undefined,
      finishedAt: nowIso(),
    });
    stateService.upsertState({
      domain: 'returns',
      shopId,
      scopeKey: `returns:${endpointKey}`,
      status: finalStatus,
      lastSuccessAt: finalStatus === SYNC_JOB_STATUS.failed ? null : nowIso(),
      lastAttemptAt: nowIso(),
      lastError,
      changedCount,
      unchangedCount,
    });
    return { job: finalJob, errors };
  }

  function startSync(input = {}) {
    if (!repository || !jobService) {
      return { ok: false, domain: 'returns', error: { code: 'RETURNS_SYNC_NOT_CONNECTED', message: 'returns domain service is not connected to SQLite cache.' } };
    }
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    if (!shopId) {
      return { ok: false, domain: 'returns', error: { code: 'RETURNS_SHOP_ID_REQUIRED', message: 'shopId is required for returns sync.' } };
    }
    const endpointKey = resolveEndpointKey(input);
    const requestFingerprint = buildRequestFingerprint({ ...input, shopId, endpointKey });
    const reusable = jobService.findReusableJob({ requestFingerprint, idempotencyKey: input.idempotencyKey ?? input.idempotency_key });
    if (reusable?.job) {
      return publicJobPayload(reusable.job, { reused: true, reusedFromJobId: reusable.job.jobId, reason: reusable.reason });
    }
    const job = jobService.createJob({
      id: createReturnsJobId(),
      domain: 'returns',
      shopId,
      endpointKey,
      action: endpointKey === 'returns.rfbsGet' ? 'sync-rfbs-return-detail' : 'sync-returns-list',
      priority: input.priority || 'P2',
      profile: input.profile ?? input.schedulerProfile ?? null,
      source: input.source ?? input.syncSource ?? null,
      requestedBy: input.requestedBy || input.requested_by || 'returns-domain-service',
      cacheKey: `returns:${shopId}:${endpointKey}`,
      idempotencyKey: input.idempotencyKey || input.idempotency_key || null,
      requestFingerprint,
      dedupeUntil: new Date(Date.now() + 60_000).toISOString(),
      progressTotal: 0,
    });
    backgroundRunner(() => {
      runReturnsSyncJob(job, { ...input, shopId, endpointKey }).catch((error) => {
        jobService.updateJob(job.jobId, {
          status: SYNC_JOB_STATUS.failed,
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: nowIso(),
        });
      });
    });
    return publicJobPayload(job, { reused: false, endpointKey });
  }

  return {
    domain: 'returns',
    readCache,
    translateReasons,
    startSync,
    runReturnsSyncJob,
    listWriteActions: writeService.listActions,
    executeConfirmedWrite: writeService.executeConfirmedWrite,
  };
}
