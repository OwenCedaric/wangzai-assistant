import { createSyncJobService, SYNC_JOB_STATUS } from '../../sync/syncJobService.js';
import { createSyncStateService } from '../../sync/syncStateService.js';
import { createStableHash } from '../../utils/stableHash.js';

const LOGISTICS_WRITE_ACTIONS = Object.freeze({
  'warehouse.create.fbs': Object.freeze({
    endpointKeys: Object.freeze(['warehouse.fbsCreate']),
    defaultEndpointKey: 'warehouse.fbsCreate',
    description: '新建 FBS 仓库',
    createsWarehouse: true,
  }),
  'warehouse.create.erfbs-aggregator': Object.freeze({
    endpointKeys: Object.freeze(['warehouse.erfbsAggregatorCreate']),
    defaultEndpointKey: 'warehouse.erfbsAggregatorCreate',
    description: '新建 Ozon 合作伙伴 rFBS 仓库和配送方式',
    createsWarehouse: true,
  }),
  'warehouse.create.erfbs-non-integrated': Object.freeze({
    endpointKeys: Object.freeze(['warehouse.erfbsNonIntegratedCreate']),
    defaultEndpointKey: 'warehouse.erfbsNonIntegratedCreate',
    description: '新建卖家/第三方 rFBS 仓库和配送方式',
    createsWarehouse: true,
  }),
  'delivery-polygon.create': Object.freeze({
    endpointKeys: Object.freeze(['warehouse.polygonCreate']),
    defaultEndpointKey: 'warehouse.polygonCreate',
    description: '新建 rFBS 配送区域',
    createsWarehouse: true,
    referenceWrite: true,
  }),
  'warehouse.update': Object.freeze({
    endpointKeys: Object.freeze(['warehouse.erfbsUpdate', 'warehouse.fbsUpdate']),
    defaultEndpointKey: 'warehouse.erfbsUpdate',
    description: '修改仓库资料',
  }),
  'warehouse.first-mile.update': Object.freeze({
    endpointKeys: Object.freeze(['warehouse.fbsFirstMileUpdate']),
    defaultEndpointKey: 'warehouse.fbsFirstMileUpdate',
    description: '修改首公里设置',
  }),
  'warehouse.archive': Object.freeze({
    endpointKeys: Object.freeze(['warehouse.archive']),
    defaultEndpointKey: 'warehouse.archive',
    description: '归档仓库',
  }),
  'warehouse.unarchive': Object.freeze({
    endpointKeys: Object.freeze(['warehouse.unarchive']),
    defaultEndpointKey: 'warehouse.unarchive',
    description: '恢复仓库',
  }),
  'warehouse.rfbs.pause': Object.freeze({
    endpointKeys: Object.freeze(['warehouse.rfbsPause']),
    defaultEndpointKey: 'warehouse.rfbsPause',
    description: '暂停 rFBS 仓库',
  }),
  'warehouse.rfbs.unpause': Object.freeze({
    endpointKeys: Object.freeze(['warehouse.rfbsUnpause']),
    defaultEndpointKey: 'warehouse.rfbsUnpause',
    description: '恢复 rFBS 仓库',
  }),
  'delivery-method.update': Object.freeze({
    endpointKeys: Object.freeze([
      'warehouse.erfbsAggregatorDeliveryMethodUpdate',
      'warehouse.erfbsNonIntegratedDeliveryMethodUpdate',
    ]),
    defaultEndpointKey: 'warehouse.erfbsAggregatorDeliveryMethodUpdate',
    description: '修改 rFBS 配送方式',
  }),
});

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

function firstText(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return '';
}

function getWarehouseOperationId(value = {}) {
  return firstText(
    value?.operation_id,
    value?.operationId,
    value?.result?.operation_id,
    value?.result?.operationId,
    value?.data?.operation_id,
    value?.data?.operationId,
  );
}

function getWarehouseOperationStatus(value = {}) {
  return firstText(
    value?.status,
    value?.result?.status,
    value?.data?.status,
    value?.data?.result?.status,
  ).toUpperCase();
}

function getWarehouseOperationEntityId(value = {}, fallback = '') {
  return normalizeId(
    value?.result?.warehouse_id
      ?? value?.result?.entity_id
      ?? value?.data?.result?.warehouse_id
      ?? value?.data?.result?.entity_id
      ?? fallback,
  );
}

function writeResultData(result = {}) {
  return result?.data ?? result?.result ?? result;
}

export function listLogisticsWriteActions() {
  return Object.entries(LOGISTICS_WRITE_ACTIONS).map(([action, config]) => ({
    action,
    endpointKeys: [...config.endpointKeys],
    description: config.description,
  }));
}

function resolveEndpointKey(input = {}) {
  const endpointKey = normalizeText(input.endpointKey ?? input.endpoint_key);
  if (endpointKey) return endpointKey;
  const type = normalizeText(input.type ?? input.scope).toLowerCase();
  if (type.includes('delivery')) return 'deliveryMethod.list';
  return 'warehouse.list';
}

export function normalizeLogisticsParams(endpointKey, params = {}) {
  const source = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  if (endpointKey === 'deliveryMethod.list') {
    const limit = Number(source.limit);
    const normalized = {
      ...source,
      limit: Number.isFinite(limit) && limit > 0 && limit <= 100 ? Math.floor(limit) : 100,
    };
    if (
      normalized.filter &&
      typeof normalized.filter === 'object' &&
      !Array.isArray(normalized.filter) &&
      Object.keys(normalized.filter).length === 0
    ) {
      delete normalized.filter;
    }
    return normalized;
  }
  if (endpointKey === 'warehouse.list') {
    const limit = Number(source.limit);
    return {
      ...source,
      limit: Number.isFinite(limit) && limit > 0 && limit <= 100 ? Math.floor(limit) : 100,
      cursor: normalizeText(source.cursor),
    };
  }
  return source;
}

function createLogisticsJobId() {
  return `logistics_sync_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function cacheKeyFor(shopId, endpointKey) {
  return `logistics:${shopId}:${endpointKey}`;
}

export function buildLogisticsRequestFingerprint(input = {}) {
  const endpointKey = resolveEndpointKey(input);
  return createStableHash({
    domain: 'logistics',
    shopId: input.shopId,
    endpointKey,
    params: normalizeLogisticsParams(endpointKey, input.params),
    forceRefresh: input.forceRefresh !== false,
  }, { length: 32 });
}

function isSchedulerOk(result = {}) {
  return Boolean(result.ok || result.status === 'success' || result.status === 'partial' || result.status === 'cache_hit');
}

function schedulerErrorMessage(result, fallback = 'Ozon 物流接口调用失败') {
  const first = result?.errors?.[0];
  return first?.message || result?.job?.lastError || result?.error?.message || fallback;
}

export function createLogisticsService({ ozonScheduler, db, backgroundRunner = (task) => setImmediate(task) } = {}) {
  const jobService = db ? createSyncJobService(db) : null;
  const stateService = db ? createSyncStateService(db) : null;

  function readCache(query = {}) {
    if (!ozonScheduler?.readCache) {
      return { ok: false, error: { code: 'DOMAIN_CACHE_NOT_CONNECTED', message: 'logistics cache reader is not connected.' } };
    }
    return ozonScheduler.readCache('logistics', query);
  }

  async function runLogisticsSyncJob(job, input = {}) {
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    const endpointKey = resolveEndpointKey(input);
    const params = normalizeLogisticsParams(
      endpointKey,
      input.params && typeof input.params === 'object' ? input.params : {},
    );
    const requestedBy = normalizeText(input.requestedBy ?? input.requested_by) || 'logistics-domain-service';
    const syncSource = normalizeText(input.source ?? input.syncSource) || requestedBy;
    const syncMode = normalizeText(input.syncMode ?? input.sync_mode) || null;
    const recoveryRestoreId = normalizeText(input.recoveryRestoreId ?? input.recovery_restore_id) || null;
    const recoveryGenerationId = normalizeText(input.recoveryGenerationId ?? input.recovery_generation_id) || null;
    const recoveryOverlapMinutes = Number.isFinite(Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes))
      ? Number(input.recoveryOverlapMinutes ?? input.recovery_overlap_minutes)
      : null;
    let changedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    let lastError = null;

    jobService.updateJob(job.jobId, { status: SYNC_JOB_STATUS.running, startedAt: nowIso(), progressTotal: 1, progressDone: 0 });
    stateService.upsertState({ domain: 'logistics', shopId, scopeKey: `logistics:${endpointKey}`, status: 'running', lastAttemptAt: nowIso() });

    try {
      const scheduled = await ozonScheduler.executeReadOnly({
        shopId,
        domain: 'logistics',
        endpointKey,
        action: 'sync-logistics-dictionary',
        priority: input.priority || 'P2',
        profile: input.profile ?? input.schedulerProfile,
        source: syncSource,
        syncMode,
        recoveryRestoreId,
        recoveryGenerationId,
        recoveryOverlapMinutes,
        params,
        cacheKey: cacheKeyFor(shopId, endpointKey),
        idempotencyKey: `${job.jobId}:${endpointKey}`,
        requestedBy,
        forceRefresh: input.forceRefresh !== false,
        allowStale: true,
      });
      if (!isSchedulerOk(scheduled)) {
        failedCount = 1;
        lastError = schedulerErrorMessage(scheduled);
      } else if (scheduled.status === 'cache_hit' || scheduled.reused) {
        unchangedCount = 1;
      } else {
        changedCount = 1;
      }
    } catch (error) {
      failedCount = 1;
      lastError = error instanceof Error ? error.message : String(error);
    }

    const finalStatus = failedCount === 0 ? SYNC_JOB_STATUS.success : SYNC_JOB_STATUS.failed;
    const finalJob = jobService.updateJob(job.jobId, {
      status: finalStatus,
      progressDone: 1,
      progressTotal: 1,
      changedCount,
      unchangedCount,
      failedCount,
      lastError,
      finishedAt: nowIso(),
    });
    stateService.upsertState({
      domain: 'logistics',
      shopId,
      scopeKey: `logistics:${endpointKey}`,
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
    if (!ozonScheduler?.executeReadOnly || !jobService) {
      return { ok: false, domain: 'logistics', error: { code: 'LOGISTICS_SYNC_NOT_CONNECTED', message: 'logistics domain service is not connected to scheduler.' } };
    }
    const shopId = normalizeId(input.shopId ?? input.shop_id);
    if (!shopId) {
      return { ok: false, domain: 'logistics', error: { code: 'LOGISTICS_SHOP_ID_REQUIRED', message: 'shopId is required for logistics sync.' } };
    }
    const endpointKey = resolveEndpointKey(input);
    const params = normalizeLogisticsParams(endpointKey, input.params);
    const normalizedInput = { ...input, shopId, endpointKey, params };
    const requestFingerprint = buildLogisticsRequestFingerprint(normalizedInput);
    const reusable = jobService.findReusableJob({ requestFingerprint, idempotencyKey: input.idempotencyKey ?? input.idempotency_key });
    if (reusable?.job) {
      return { ok: true, accepted: true, domain: 'logistics', jobId: reusable.job.jobId, job: reusable.job, status: reusable.job.status, reused: true, reusedFromJobId: reusable.job.jobId, reason: reusable.reason };
    }
    const job = jobService.createJob({
      id: createLogisticsJobId(),
      domain: 'logistics',
      shopId,
      endpointKey,
      action: 'sync-logistics-dictionary',
      priority: input.priority || 'P2',
      profile: input.profile ?? input.schedulerProfile ?? null,
      source: input.source ?? input.syncSource ?? null,
      requestedBy: input.requestedBy || input.requested_by || 'logistics-domain-service',
      cacheKey: cacheKeyFor(shopId, endpointKey),
      idempotencyKey: input.idempotencyKey || input.idempotency_key || null,
      requestFingerprint,
      dedupeUntil: new Date(Date.now() + 60_000).toISOString(),
      progressTotal: 0,
    });
    backgroundRunner(() => {
      runLogisticsSyncJob(job, normalizedInput).catch((error) => {
        jobService.updateJob(job.jobId, {
          status: SYNC_JOB_STATUS.failed,
          lastError: error instanceof Error ? error.message : String(error),
          finishedAt: nowIso(),
        });
      });
    });
    return { ok: true, accepted: true, domain: 'logistics', jobId: job.jobId, job, status: job.status, reused: false, endpointKey };
  }

  async function pollWarehouseOperation({ shopId, operationId, requestedBy }) {
    if (!operationId || !ozonScheduler?.executeReadOnly) return null;
    let latest = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await ozonScheduler.executeReadOnly({
        shopId,
        domain: 'logistics',
        endpointKey: 'warehouse.operationStatus',
        action: 'warehouse-operation-readback',
        priority: 'P1',
        params: { operation_id: operationId },
        cacheKey: `logistics:${shopId}:warehouse-operation:${operationId}`,
        idempotencyKey: `warehouse-operation:${shopId}:${operationId}:${attempt}`,
        requestedBy,
        forceRefresh: true,
        allowStale: false,
      });
      latest = writeResultData(result);
      const status = getWarehouseOperationStatus(latest);
      if (status === 'SUCCESS' || status === 'ERROR') break;
    }
    return latest;
  }

  async function refreshWarehouseReadBack({ shopId, warehouseId, requestedBy }) {
    if (!warehouseId || !ozonScheduler?.executeReadOnly) return { status: 'pending', warehouse: null, deliveryMethods: null };
    const [warehouse, deliveryMethods] = await Promise.all([
      ozonScheduler.executeReadOnly({
        shopId,
        domain: 'logistics',
        endpointKey: 'warehouse.list',
        action: 'warehouse-write-readback',
        priority: 'P1',
        params: { warehouse_ids: [warehouseId] },
        cacheKey: cacheKeyFor(shopId, 'warehouse.list'),
        idempotencyKey: `warehouse-readback:${shopId}:${warehouseId}:${Date.now()}`,
        requestedBy,
        forceRefresh: true,
        allowStale: false,
      }),
      ozonScheduler.executeReadOnly({
        shopId,
        domain: 'logistics',
        endpointKey: 'deliveryMethod.list',
        action: 'delivery-method-write-readback',
        priority: 'P1',
        params: { filter: { warehouse_id: Number(warehouseId) || warehouseId }, limit: 100, offset: 0 },
        cacheKey: cacheKeyFor(shopId, 'deliveryMethod.list'),
        idempotencyKey: `delivery-method-readback:${shopId}:${warehouseId}:${Date.now()}`,
        requestedBy,
        forceRefresh: true,
        allowStale: false,
      }),
    ]);
    const ok = isSchedulerOk(warehouse) && isSchedulerOk(deliveryMethods);
    return { status: ok ? 'merged' : 'partial', warehouse, deliveryMethods };
  }

  async function executeConfirmedWrite({ preview, input = {} } = {}) {
    if (!ozonScheduler?.executeWrite) {
      return {
        ok: false,
        writeConnected: false,
        error: { code: 'LOGISTICS_WRITE_EXECUTOR_NOT_CONNECTED', message: '仓库写入执行器尚未连接。' },
      };
    }
    const action = normalizeText(input.action || preview?.action || preview?.diff?.action);
    const actionConfig = LOGISTICS_WRITE_ACTIONS[action];
    if (!actionConfig) {
      return {
        ok: false,
        writeConnected: false,
        error: { code: 'LOGISTICS_WRITE_ACTION_NOT_REGISTERED', message: `仓库写入动作尚未登记：${action || 'unknown'}` },
      };
    }
    const shopId = normalizeId(input.shopId || input.shop_id || preview?.shopId || preview?.diff?.shopId);
    const payload = input.payload ?? preview?.payload ?? preview?.diff?.after ?? {};
    const warehouseId = normalizeId(payload?.warehouse_id ?? payload?.warehouseId);
    if (!shopId || (!actionConfig.createsWarehouse && !warehouseId)) {
      return {
        ok: false,
        writeConnected: false,
        error: {
          code: 'LOGISTICS_WRITE_SCOPE_REQUIRED',
          message: actionConfig.createsWarehouse ? '新建仓库必须包含店铺。' : '仓库写入必须包含店铺和仓库编号。',
        },
      };
    }
    const endpointKey = normalizeText(input.endpointKey || preview?.endpointKey || preview?.diff?.endpointKey)
      || actionConfig.defaultEndpointKey;
    if (!actionConfig.endpointKeys.includes(endpointKey)) {
      return {
        ok: false,
        writeConnected: false,
        error: { code: 'LOGISTICS_WRITE_ENDPOINT_MISMATCH', message: `动作 ${action} 不能使用接口 ${endpointKey}。` },
      };
    }
    const requestedBy = input.requestedBy || preview?.requestedBy || 'warehouse-logistics-page';
    const realWrite = input.realWrite === true && input.dryRun === false;
    const writeResult = await ozonScheduler.executeWrite({
      shopId,
      domain: 'logistics',
      endpointKey,
      action,
      priority: 'WRITE',
      params: payload,
      idempotencyKey: normalizeText(input.idempotencyKey || preview?.idempotencyKey)
        || `logistics-write:${shopId}:${action}:${warehouseId || 'new'}:${preview?.previewId || Date.now()}`,
      requestedBy,
      previewId: preview?.previewId || input.previewId,
      realWrite,
      dryRun: !realWrite,
      waitForResult: true,
    });
    if (!writeResult?.ok) {
      return {
        ok: false,
        writeConnected: true,
        writeStatus: 'write_failed',
        endpointKey,
        action,
        schedulerResult: writeResult,
        error: writeResult?.error || { code: 'LOGISTICS_WRITE_FAILED', message: '仓库写入失败，原配置已保留。' },
      };
    }
    if (writeResult.dryRun) {
      return {
        ok: true,
        writeConnected: true,
        writeStatus: 'dry_run_recorded',
        endpointKey,
        action,
        schedulerResult: writeResult,
        readBack: { status: 'not_required' },
        message: '仓库操作预览已通过，未写入 Ozon。',
      };
    }
    const data = writeResultData(writeResult);
    if (actionConfig.referenceWrite) {
      return {
        ok: true,
        writeConnected: true,
        writeStatus: 'readback_merged',
        endpointKey,
        action,
        data,
        schedulerResult: writeResult,
        readBack: { status: 'merged', type: 'created-reference' },
        message: 'Ozon 配送区域已创建。',
      };
    }
    const operationId = getWarehouseOperationId(data);
    const operation = await pollWarehouseOperation({ shopId, operationId, requestedBy });
    const operationStatus = getWarehouseOperationStatus(operation);
    if (operationStatus === 'ERROR') {
      return {
        ok: false,
        writeConnected: true,
        writeStatus: 'write_failed',
        endpointKey,
        action,
        schedulerResult: writeResult,
        operation,
        error: operation?.error || { code: 'WAREHOUSE_OPERATION_FAILED', message: 'Ozon 仓库操作返回失败。' },
      };
    }
    const readBackWarehouseId = getWarehouseOperationEntityId(operation, warehouseId);
    const readBack = await refreshWarehouseReadBack({ shopId, warehouseId: readBackWarehouseId, requestedBy });
    return {
      ok: true,
      writeConnected: true,
      writeStatus: readBack.status === 'merged' ? 'readback_merged' : 'submitted_waiting_readback',
      endpointKey,
      action,
      operationId: operationId || null,
      operation,
      schedulerResult: writeResult,
      readBack,
      message: readBack.status === 'merged'
        ? '仓库操作已提交 Ozon，并完成仓库与配送方式回读。'
        : '仓库操作已提交 Ozon，回读尚未完整完成。',
    };
  }

  return {
    domain: 'logistics',
    readCache,
    startSync,
    runLogisticsSyncJob,
    listWriteActions: listLogisticsWriteActions,
    executeConfirmedWrite,
  };
}
