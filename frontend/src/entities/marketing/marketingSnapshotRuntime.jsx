import { getFriendlyOzonOrderError as getFriendlyOzonOrderErrorSafe } from '../../services/ozonOrderSafety';
import { safeWarn } from '../../services/safeLog';
import { simulateOrderTestSplit } from '../../api/localApiClient.js';
import {
  OZON_LABEL_CREATE_MAX_ATTEMPTS,
  OZON_LABEL_MAX_POLLS,
  OZON_LABEL_POLL_DELAY_MS,
} from '../../shared/config/appConfigCore.jsx';
import {
  getOzonApiRequestCount,
  getPerformanceNow,
  isOzonSnapshotOwnerFenced,
  ozonSnapshotInFlight,
  ozonSnapshotManualRefreshAt,
  ozonSnapshotMemoryCache,
} from '../../shared/config/appConfigRuntime.jsx';
import { countRowsImages } from '../../shared/ozon/ozonRuntime.jsx';
import {
  canUseOzonSnapshotSource,
  getOzonSnapshotSourceKey,
  getOzonSnapshotSourceKeyCandidates,
} from '../order/orderShopScope.jsx';
import { isOzonAwaitingDeliveryRawStatus as isOzonAwaitingDeliveryRawStatusRule } from '../order/orderStatusRules.jsx';
import {
  getOzonLocalSnapshotKeyCandidates,
  readOzonLocalDataSnapshot,
  readTimedCache,
  writeOzonLocalDataSnapshot,
  writeTimedCache,
} from '../product/productLocalData.jsx';
import {
  assertFbsSalesOrder,
  buildOzonShipProducts,
  buildSimulatedSalesOrderSplitResult,
  getSalesOrderRawStatus,
  isSalesOrderSplitUiTestOrder,
  parseSplitQuantityPlan,
  requestOzonSalesOrderDetail,
  requestProtectedOzonOrderOperation,
} from './marketingOrderFields.jsx';
import { firstMarketingValue as pickFirstMarketingValue } from './marketingValueRules.jsx';
import React from 'react';

const passthroughLocalSnapshot = (snapshot) => snapshot;

// FROZEN: a successful loader result is authoritative. The former read-after-write
// branch is retained below only as an explicit deletion marker for the legacy pipeline.
export const OZON_POST_LOAD_LOCAL_REREAD_FROZEN = true;

export async function submitSalesOrderCancel(shop, order, options = {}) {
  const postingNumber = assertFbsSalesOrder(order, '取消订单');
  const cancelReasonId = Number(options.cancelReasonId);
  const cancelReasonMessage = String(options.cancelReasonMessage || '').trim();

  if (!Number.isSafeInteger(cancelReasonId) || cancelReasonId <= 0) {
    throw new Error('请先选择 Ozon 返回的取消原因。');
  }

  return requestProtectedOzonOrderOperation(
    'cancelFbsPosting',
    shop,
    {
      posting_number: postingNumber,
      cancel_reason_id: cancelReasonId,
      cancel_reason_message: cancelReasonMessage,
    },
    { confirmed: true }
  );
}

export async function submitSalesOrderShip(shop, order, actionName = '确认发货') {
  const postingNumber = assertFbsSalesOrder(order, actionName);
  const detailOrder = await requestOzonSalesOrderDetail(shop, { ...order, posting: postingNumber });
  const rawStatus = getSalesOrderRawStatus(detailOrder);
  if (rawStatus && rawStatus !== 'awaiting_packaging') {
    throw new Error(`Ozon 当前状态是 ${rawStatus}，不是等待备货，已停止${actionName}。`);
  }

  return requestProtectedOzonOrderOperation(
    'shipFbsPosting',
    shop,
    {
      posting_number: postingNumber,
      packages: [{ products: buildOzonShipProducts(detailOrder, actionName) }],
      with: { additional_data: false },
    },
    { confirmed: true }
  );
}

export function isOzonAwaitingDeliveryRawStatus(rawStatus = '') {
  return isOzonAwaitingDeliveryRawStatusRule(rawStatus);
}

export function createOzonAwaitingDeliveryPendingError(rawStatus = '') {
  const error = new Error('Ozon 正在等待配送，面单暂未生成，请稍后再预报。');
  error.code = 'OZON_AWAITING_DELIVERY_PENDING_LABEL';
  error.rawStatus = rawStatus;
  return error;
}

export function isOzonAwaitingDeliveryPendingError(error) {
  return (
    error?.code === 'OZON_AWAITING_DELIVERY_PENDING_LABEL' ||
    /Ozon 正在等待配送|awaiting_deliver|awaiting_delivery/i.test(
      error instanceof Error ? error.message : String(error || '')
    )
  );
}

export async function readOzonPurchaseForecastState(shop, order, options = {}) {
  const postingNumber = assertFbsSalesOrder(order, '读取 Ozon 预报状态');
  const detailOrder = await requestOzonSalesOrderDetail(
    shop,
    { ...order, posting: postingNumber },
    {
      forceRefresh: options.forceRefresh !== false,
      syncSource: options.syncSource || 'purchase-forecast-state',
      requestedBy: options.requestedBy || 'purchase-forecast-flow',
      priority: options.priority || 'P0',
      profile: options.profile || 'readback',
      schedulerProfile: options.schedulerProfile || options.profile || 'readback',
      timeoutMs: options.timeoutMs || 15_000,
      orderSyncTimeoutMs: options.orderSyncTimeoutMs || 10_000,
      orderSyncPollIntervalMs: options.orderSyncPollIntervalMs || 500,
      signal: options.signal,
    }
  );
  return {
    postingNumber,
    detailOrder,
    rawStatus: getSalesOrderRawStatus(detailOrder),
  };
}

export async function prepareOzonForPurchaseForecast(shop, order, options = {}) {
  let initial = await readOzonPurchaseForecastState(shop, order, {
    syncSource: 'purchase-forecast-before-prepare',
    forceRefresh: false,
  });
  if (isOzonAwaitingDeliveryRawStatus(initial.rawStatus) || (initial.rawStatus && initial.rawStatus !== 'awaiting_packaging')) {
    initial = await readOzonPurchaseForecastState(shop, order, {
      syncSource: 'purchase-forecast-before-prepare-verify',
      requestedBy: 'purchase-forecast-prepare-verify',
      priority: 'P0',
      profile: 'readback',
      timeoutMs: 12_000,
      orderSyncTimeoutMs: 10_000,
      orderSyncPollIntervalMs: 400,
    });
  }
  const { postingNumber, detailOrder, rawStatus } = initial;

  if (isOzonAwaitingDeliveryRawStatus(rawStatus)) {
    return {
      skipped: true,
      postingNumber,
      rawStatus,
      detailOrder,
    };
  }

  if (rawStatus && rawStatus !== 'awaiting_packaging') {
    throw new Error(`Ozon 当前状态是 ${rawStatus}，不是等待备货或等待发货，已停止预报。`);
  }

  await requestProtectedOzonOrderOperation(
    'shipFbsPosting',
    shop,
    {
      posting_number: postingNumber,
      packages: [{ products: buildOzonShipProducts(detailOrder, 'Ozon 备货') }],
      with: { additional_data: false },
    },
    { confirmed: true }
  );

  const readbackAttempts = Math.max(1, Number(options.readbackAttempts) || 3);
  const configuredReadbackDelayMs = Number(options.readbackDelayMs);
  const readbackDelayMs = Number.isFinite(configuredReadbackDelayMs)
    ? Math.max(0, configuredReadbackDelayMs)
    : 1_000;
  let lastReadback = null;
  for (let attempt = 0; attempt < readbackAttempts; attempt += 1) {
    if (attempt === 0 && readbackDelayMs > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, Math.min(readbackDelayMs, 800)));
    }
    lastReadback = await readOzonPurchaseForecastState(shop, order, {
      syncSource: 'purchase-forecast-after-prepare',
      requestedBy: 'purchase-forecast-prepare-readback',
      priority: 'P0',
      profile: 'readback',
      timeoutMs: 12_000,
      orderSyncTimeoutMs: 10_000,
      orderSyncPollIntervalMs: 400,
    });
    if (isOzonAwaitingDeliveryRawStatus(lastReadback.rawStatus)) {
      return {
        skipped: false,
        ...lastReadback,
      };
    }
    if (attempt + 1 < readbackAttempts && readbackDelayMs > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, readbackDelayMs));
    }
  }
  const confirmedStatus = String(lastReadback?.rawStatus || rawStatus || '未返回').trim();
  throw new Error(`Ozon 备货提交后回读仍为 ${confirmedStatus}，尚未确认备货成功。`);
}

export function waitForOzonLabelPoll(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function findDeepTextValue(source, keys = [], seen = new Set()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return '';
  seen.add(source);

  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }

  const values = Array.isArray(source) ? source : Object.values(source);
  for (const value of values) {
    const found = findDeepTextValue(value, keys, seen);
    if (found) return found;
  }
  return '';
}

export function getOzonPackageLabelTaskId(data = {}) {
  return findDeepTextValue(data, ['task_id', 'taskId', 'id']);
}

export function getOzonPackageLabelUrl(data = {}) {
  const url = findDeepTextValue(data, [
    'file_url',
    'fileUrl',
    'download_url',
    'downloadUrl',
    'label_url',
    'labelUrl',
    'pdf_url',
    'pdfUrl',
    'sheet',
    'sheet_url',
    'sheetUrl',
  ]);
  return /^https?:\/\//i.test(url) ? url : '';
}

export function getOzonPackageLabelNumber(data = {}, postingNumber = '') {
  return (
    findDeepTextValue(data, [
      'sheet_order_sn',
      'sheetOrderSn',
      'label_number',
      'labelNumber',
      'barcode',
      'bar_code',
      'barCode',
      'tracking_number',
      'trackingNumber',
      'posting_number',
      'postingNumber',
    ]) || postingNumber
  );
}

export function isOzonPackageLabelNotReadyError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return (
    error?.code === 'OZON_PACKAGE_LABEL_TASK_PENDING' ||
    /NO_POSTINGS_FOR_BATCH_DOWNLOAD|no postings for batch download|面单暂未返回可回传 PDF/i.test(message)
  );
}

export async function createOzonPackageLabelTask(shop, postingNumber, options = {}) {
  let lastError = null;
  const maxAttempts = Math.max(1, Number(options.maxCreateAttempts) || OZON_LABEL_CREATE_MAX_ATTEMPTS);
  const retryDelayMs = Math.max(0, Number(options.createRetryDelayMs) || OZON_LABEL_POLL_DELAY_MS);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await requestProtectedOzonOrderOperation(
        'createFbsPackageLabel',
        shop,
        { posting_number: [postingNumber] },
        { confirmed: true }
      );
    } catch (error) {
      lastError = error;
      if (!isOzonPackageLabelNotReadyError(error)) throw error;
      if (attempt + 1 < maxAttempts && typeof options.refreshOrderDetail === 'function') {
        await options.refreshOrderDetail();
      }
      if (attempt + 1 < maxAttempts && retryDelayMs > 0) {
        await waitForOzonLabelPoll(retryDelayMs);
      }
    }
  }
  throw lastError;
}

export async function createOzonPackageLabelForPurchase(shop, order, options = {}) {
  const postingNumber = assertFbsSalesOrder(order, '生成面单');
  let latestRawStatus = '';
  const refreshOrderDetail = async () => {
    const { detailOrder: latestOrder, rawStatus } = await readOzonPurchaseForecastState(
      shop,
      { ...order, posting: postingNumber },
      {
        syncSource: 'purchase-forecast-label-check',
        requestedBy: 'purchase-forecast-label-check',
        priority: options.priority || 'P0',
        profile: options.profile || 'readback',
        timeoutMs: options.timeoutMs || 12_000,
        orderSyncTimeoutMs: options.orderSyncTimeoutMs,
        orderSyncPollIntervalMs: options.orderSyncPollIntervalMs,
        signal: options.signal,
      }
    );
    latestRawStatus = rawStatus;
    return latestOrder;
  };

  if (options.initialDetailOrder && typeof options.initialDetailOrder === 'object') {
    latestRawStatus = getSalesOrderRawStatus(options.initialDetailOrder);
  } else {
    await refreshOrderDetail();
  }
  let taskId = String(options.existingTaskId || '').trim();
  if (!taskId) {
    let createPayload = null;
    try {
      createPayload = await createOzonPackageLabelTask(shop, postingNumber, {
        refreshOrderDetail,
        maxCreateAttempts: options.maxCreateAttempts,
        createRetryDelayMs: options.createRetryDelayMs,
      });
    } catch (error) {
      if (isOzonPackageLabelNotReadyError(error) && isOzonAwaitingDeliveryRawStatus(latestRawStatus)) {
        throw createOzonAwaitingDeliveryPendingError(latestRawStatus);
      }
      throw error;
    }
    taskId = getOzonPackageLabelTaskId(createPayload);
  }
  if (!taskId) throw new Error('Ozon 已返回面单创建响应，但没有返回可查询的任务 ID。');

  const taskValue = /^\d+$/.test(String(taskId)) ? Number(taskId) : String(taskId);
  let lastStatus = '';
  for (let attempt = 0; attempt < OZON_LABEL_MAX_POLLS; attempt += 1) {
    if (attempt > 0) await waitForOzonLabelPoll(OZON_LABEL_POLL_DELAY_MS);
    const labelPayload = await requestProtectedOzonOrderOperation(
      'getFbsPackageLabel',
      shop,
      { task_id: taskValue },
      { confirmed: true }
    );
    const sheetUrl = getOzonPackageLabelUrl(labelPayload);
    if (sheetUrl) {
      return {
        postingNumber,
        taskId: String(taskId),
        sheetOrderSn: getOzonPackageLabelNumber(labelPayload, postingNumber),
        sheetUrl,
        raw: labelPayload,
      };
    }
    lastStatus = findDeepTextValue(labelPayload, ['status', 'state', 'result_status', 'resultStatus']);
    const errorMessage = findDeepTextValue(labelPayload, ['error_message', 'errorMessage', 'error', 'message']);
    if (
      /fail|failed|error|cancel/i.test(lastStatus) ||
      (/error/i.test(errorMessage) && !/ready|process/i.test(errorMessage))
    ) {
      throw new Error(`Ozon 面单生成失败：${errorMessage || lastStatus || '未返回可用面单'}`);
    }
  }

  const pendingError = new Error(`Ozon 面单暂未返回可回传 PDF${lastStatus ? `，当前状态：${lastStatus}` : ''}。`);
  pendingError.code = 'OZON_PACKAGE_LABEL_TASK_PENDING';
  pendingError.taskId = String(taskId);
  pendingError.rawStatus = latestRawStatus;
  throw pendingError;
}

export async function submitSalesOrderSplit(shop, order, splitPlan) {
  const postingNumber = assertFbsSalesOrder(order, '拆解订单');
  if (isSalesOrderSplitUiTestOrder(order)) {
    const products = buildOzonShipProducts(order, '拆解订单测试');
    if (products.length !== 1) {
      throw new Error('当前拆解流程只支持单商品订单，多商品订单请到 Ozon 后台处理。');
    }
    const quantities = Array.isArray(splitPlan) ? splitPlan : parseSplitQuantityPlan(splitPlan);
    if (quantities.length < 2) throw new Error('拆解计划至少需要填写两组数量，例如：1,2。');
    const total = quantities.reduce((sum, item) => sum + item, 0);
    if (total !== products[0].quantity) {
      throw new Error(`拆解数量合计是 ${total}，和订单数量 ${products[0].quantity} 不一致。`);
    }
    let localSimulation = null;
    try {
      localSimulation = await simulateOrderTestSplit(
        {
          shopId: shop?.id || shop?.shopId || order.shopId || order.shop_id,
          postingNumber,
          splitQuantities: quantities,
        },
        { timeoutMs: 10_000 }
      );
    } catch (error) {
      const message = error?.payload?.error?.message || error?.message || '测试拆单模拟写入 SQLite 失败。';
      throw new Error(message);
    }
    return {
      ...buildSimulatedSalesOrderSplitResult(order, quantities),
      ...localSimulation,
      message: localSimulation?.message || `测试单已模拟拆解：${postingNumber} -> ${quantities.join('+')}。`,
    };
  }

  const detailOrder = await requestOzonSalesOrderDetail(shop, { ...order, posting: postingNumber });
  const rawStatus = getSalesOrderRawStatus(detailOrder);
  if (rawStatus && rawStatus !== 'awaiting_packaging') {
    throw new Error(`Ozon 当前状态是 ${rawStatus}，不是等待备货，已停止拆解订单。`);
  }

  const products = buildOzonShipProducts(detailOrder);
  if (products.length !== 1) {
    throw new Error('当前拆解流程只支持单商品订单，多商品订单请到 Ozon 后台处理。');
  }

  const quantities = Array.isArray(splitPlan) ? splitPlan : parseSplitQuantityPlan(splitPlan);
  if (quantities.length < 2) throw new Error('拆解计划至少需要填写两组数量，例如：1,2。');
  const total = quantities.reduce((sum, item) => sum + item, 0);
  if (total !== products[0].quantity) {
    throw new Error(`拆解数量合计是 ${total}，和订单数量 ${products[0].quantity} 不一致。`);
  }

  return requestProtectedOzonOrderOperation(
    'splitFbsPosting',
    shop,
    {
      posting_number: postingNumber,
      postings: quantities.map((quantity) => ({
        products: [{ product_id: products[0].product_id, quantity }],
      })),
    },
    { confirmed: true }
  );
}

export function getFriendlyOzonOrderError(error) {
  return getFriendlyOzonOrderErrorSafe(error);
}

export function getOzonRealtimeSnapshotSourceHint(snapshotState = {}, options = {}) {
  const performanceEventId = String(snapshotState.performance?.eventId || '');
  const rowCount = Number(snapshotState.performance?.rows ?? snapshotState.data?.rows?.length ?? 0) || 0;
  if (snapshotState.refreshing || (snapshotState.loading && rowCount > 0)) {
    return options.refreshingText || '正在同步';
  }
  if (snapshotState.loading) return options.loadingText || '正在读取';
  if (snapshotState.error && rowCount > 0) return options.failedKeepText || '接口失败，保留缓存';
  if (performanceEventId.endsWith(':local-file')) return options.localText || '本地缓存';
  if (performanceEventId.endsWith(':cache')) return options.memoryText || options.localText || '本地缓存';
  if (performanceEventId.endsWith(':api')) return options.apiText || 'Ozon 实时读取';
  if (snapshotState.hasLoaded || rowCount > 0) return options.loadedText || '已读取';
  return options.emptyText || '待读取';
}

export function getOzonRealtimeSnapshotLogSource(snapshotState = {}) {
  const performanceEventId = String(snapshotState.performance?.eventId || '');
  const rowCount = Number(snapshotState.performance?.rows ?? snapshotState.data?.rows?.length ?? 0) || 0;
  if (snapshotState.refreshing || (snapshotState.loading && rowCount > 0)) return 'background-refresh';
  if (performanceEventId.endsWith(':local-file')) return 'local-cache';
  if (performanceEventId.endsWith(':cache')) return 'memory-cache';
  if (performanceEventId.endsWith(':api')) return 'remote';
  if (snapshotState.error && rowCount > 0) return 'partial';
  if (snapshotState.error) return 'error';
  if (snapshotState.hasLoaded || rowCount > 0) return 'loaded';
  return 'idle';
}

export async function preloadOzonRealtimeSnapshot(source, loader, options = {}) {
  const sources = (Array.isArray(source) ? source : [source]).filter(Boolean);
  const aggregateSource = sources.length > 1;
  const cacheTtlMs = Number(options.cacheTtlMs) || 0;
  const allowAggregateLocalData = options.allowAggregateLocalData === true;
  if (
    options.enabled === false ||
    typeof loader !== 'function' ||
    !cacheTtlMs ||
    (aggregateSource && !allowAggregateLocalData) ||
    !canUseOzonSnapshotSource(source)
  ) {
    return null;
  }

  const snapshotGroup = options.cacheGroup || loader.name || 'ozon-snapshot';
  const sourceKey = getOzonSnapshotSourceKey(source);
  const cacheKey = `${snapshotGroup}:${sourceKey}`;
  const cachedData = readTimedCache(ozonSnapshotMemoryCache, cacheKey, cacheTtlMs);
  if (cachedData) return cachedData;

  const existingRequest = ozonSnapshotInFlight.get(cacheKey);
  if (existingRequest) return existingRequest;

  const requestPromise = Promise.resolve()
    .then(() => loader(source, {
      ...(options.loaderOptions || {}),
      forceRefresh: false,
    }))
    .then((data) => {
      if (!isOzonSnapshotOwnerFenced(cacheKey)) {
        writeTimedCache(ozonSnapshotMemoryCache, cacheKey, data);
      }
      return data;
    })
    .finally(() => {
      if (ozonSnapshotInFlight.get(cacheKey) === requestPromise) {
        ozonSnapshotInFlight.delete(cacheKey);
      }
    });
  if (!isOzonSnapshotOwnerFenced(cacheKey)) {
    ozonSnapshotInFlight.set(cacheKey, requestPromise);
  }
  return requestPromise;
}

export function useOzonRealtimeSnapshot(source, loader, options = {}) {
  const snapshotGroup = options.cacheGroup || loader?.name || 'ozon-snapshot';
  const sourceCount = (Array.isArray(source) ? source : [source]).filter(Boolean).length;
  const aggregateSource = sourceCount > 1;
  const sourceKey = getOzonSnapshotSourceKey(source);
  const sourceKeyCandidates = getOzonSnapshotSourceKeyCandidates(source);
  const manualRefreshCooldownMs = Math.max(0, Number(options.manualRefreshCooldownMs) || 0);
  const enabled = options.enabled !== false;
  const refreshOnMount = options.refreshOnMount === true;
  const abortOnUnmount = options.abortOnUnmount === true;
  const cacheTtlMs = Number(options.cacheTtlMs) || 0;
  const allowAggregateLocalData = options.allowAggregateLocalData === true;
  const cacheKey = cacheTtlMs && (!aggregateSource || allowAggregateLocalData)
    ? `${snapshotGroup}:${sourceKey}`
    : '';
  const inFlightKey = cacheKey || `${snapshotGroup}:${sourceKey}`;
  const manualRefreshCooldownKey = `${options.manualRefreshCooldownKey || snapshotGroup}:${sourceKey}`;
  const localDataFileKey = aggregateSource && !allowAggregateLocalData ? '' : options.localDataFileKey || '';
  const localDataSnapshotKey = options.localDataSnapshotKey || cacheKey || inFlightKey;
  const loadLocalOnMount = options.loadLocalOnMount !== false && Boolean(localDataFileKey && localDataSnapshotKey);
  const preferLocalDataOnCacheHit = options.preferLocalDataOnCacheHit === true;
  const keepCurrentDataOnForceRefresh = options.keepCurrentDataOnForceRefresh === true;
  const invalidateOnSnapshotKeyChange = options.invalidateOnSnapshotKeyChange === true;
  const prepareLocalSnapshot =
    typeof options.prepareLocalSnapshot === 'function' ? options.prepareLocalSnapshot : passthroughLocalSnapshot;
  const snapshotIdentityKey = options.snapshotIdentityKey || localDataSnapshotKey || cacheKey || inFlightKey;
  const defaultLegacyLocalDataSnapshotKeys = sourceKeyCandidates
    .slice(1)
    .map((legacySourceKey) => `${snapshotGroup}:${legacySourceKey}`);
  const localDataSnapshotKeys = getOzonLocalSnapshotKeyCandidates(
    options.localDataSnapshotKeys || [
      localDataSnapshotKey,
      ...(options.localDataSnapshotKey ? [] : defaultLegacyLocalDataSnapshotKeys),
    ]
  );
  const localDataSnapshotKeysKey = localDataSnapshotKeys.join('|');
  const optionsRef = React.useRef(options);
  const localDataSnapshotKeysRef = React.useRef(localDataSnapshotKeys);
  optionsRef.current = options;
  localDataSnapshotKeysRef.current = localDataSnapshotKeys;
  const initialCachedData = cacheKey ? readTimedCache(ozonSnapshotMemoryCache, cacheKey, cacheTtlMs) : null;
  const [snapshot, setSnapshot] = React.useState({
    data: initialCachedData,
    loading: false,
    refreshing: false,
    error: '',
    hasLoaded: Boolean(initialCachedData),
    performance: null,
  });
  const snapshotDataRef = React.useRef(initialCachedData);
  const snapshotIdentityRef = React.useRef(snapshotIdentityKey);
  const requestGenerationRef = React.useRef(0);
  const requestAbortRef = React.useRef(null);
  const requestInFlightRef = React.useRef(null);

  React.useEffect(() => {
    snapshotDataRef.current = snapshot.data;
  }, [snapshot.data]);

  React.useEffect(
    () => () => {
      if (abortOnUnmount) requestAbortRef.current?.abort();
    },
    [abortOnUnmount]
  );

  React.useEffect(() => {
    if (!enabled) {
      requestGenerationRef.current += 1;
      setSnapshot((current) =>
        current.loading || current.refreshing ? { ...current, loading: false, refreshing: false } : current
      );
    }
  }, [enabled]);

  const refresh = React.useCallback(
    async ({
      silent = false,
      force = false,
      localOnly = false,
      loaderForceRefresh,
      loaderOptions: requestLoaderOptions,
    } = {}) => {
      if (!enabled) return;
      const currentOptions = optionsRef.current || {};
      const requestGeneration = requestGenerationRef.current + 1;
      requestGenerationRef.current = requestGeneration;
      const existingSharedRequest = !force && !localOnly ? ozonSnapshotInFlight.get(inFlightKey) : null;
      if (force) {
        const previousRequest = requestInFlightRef.current;
        requestAbortRef.current?.abort();
        if (previousRequest && ozonSnapshotInFlight.get(inFlightKey) === previousRequest) {
          ozonSnapshotInFlight.delete(inFlightKey);
        }
        requestInFlightRef.current = null;
      }
      const requestController =
        !existingSharedRequest && typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (!existingSharedRequest) requestAbortRef.current = requestController;
      const startedAt = getPerformanceNow();
      const apiCountStart = getOzonApiRequestCount();
      const localStart = getPerformanceNow();
      const cachedData = cacheKey && !force ? readTimedCache(ozonSnapshotMemoryCache, cacheKey, cacheTtlMs) : null;
      const localMs = getPerformanceNow() - localStart;
      const eventIdBase = `${sourceKey}:${Date.now()}`;
      const isCurrentRequest = () => requestGenerationRef.current === requestGeneration;
      let servedSnapshotData = Boolean(
        cachedData || (force && keepCurrentDataOnForceRefresh && snapshotDataRef.current)
      );

      if (cachedData) {
        const imageStart = getPerformanceNow();
        const imageCount = countRowsImages(cachedData.rows ?? []);
        if (isCurrentRequest())
          setSnapshot({
            data: cachedData,
            loading: false,
            refreshing: false,
            error: '',
            hasLoaded: true,
            performance: {
              eventId: `${eventIdBase}:cache`,
              startedAt,
              localMs,
              ozonMs: 0,
              processingMs: 0,
              imageMs: getPerformanceNow() - imageStart,
              rows: cachedData.rows?.length ?? 0,
              imageCount,
              apiCount: 0,
            },
          });
        if (
          currentOptions.refreshOnCacheHit !== true &&
          !(preferLocalDataOnCacheHit && localDataFileKey && localDataSnapshotKey)
        ) {
          return cachedData;
        }
      }

      if (localDataFileKey && localDataSnapshotKey && !force && (!cachedData || preferLocalDataOnCacheHit)) {
        const localReadStart = getPerformanceNow();
        const localSnapshot = await readOzonLocalDataSnapshot(localDataFileKey, localDataSnapshotKeysRef.current).catch(
          () => null
        );
        if (localSnapshot) {
          if (cacheKey && !isOzonSnapshotOwnerFenced(cacheKey)) writeTimedCache(ozonSnapshotMemoryCache, cacheKey, localSnapshot);
          const matchedLocalSnapshotKey = String(localSnapshot.localSnapshotKey || '');
          if (
            matchedLocalSnapshotKey
            && matchedLocalSnapshotKey !== localDataSnapshotKey
            && !isOzonSnapshotOwnerFenced(inFlightKey)
          ) {
            writeOzonLocalDataSnapshot(localDataFileKey, localDataSnapshotKey, localSnapshot).catch(() => undefined);
          }
          servedSnapshotData = true;
          const imageStart = getPerformanceNow();
          const imageCount = countRowsImages(localSnapshot.rows ?? []);
          if (isCurrentRequest())
            setSnapshot({
              data: localSnapshot,
              loading: false,
              refreshing: false,
              error: '',
              hasLoaded: true,
              performance: {
                eventId: `${eventIdBase}:local-file`,
                startedAt,
                localMs: getPerformanceNow() - localReadStart,
                ozonMs: 0,
                processingMs: 0,
                imageMs: getPerformanceNow() - imageStart,
                rows: localSnapshot.rows?.length ?? 0,
                imageCount,
                apiCount: 0,
              },
            });
          if (currentOptions.refreshOnLocalHit !== true) return localSnapshot;
        }
      }

      if (localOnly) {
        if (isCurrentRequest()) {
          setSnapshot((current) => ({
            ...current,
            loading: false,
            refreshing: false,
            error: '',
            hasLoaded: Boolean(current.hasLoaded || current.data),
            performance: {
              eventId: `${eventIdBase}:local-miss`,
              startedAt,
              localMs: getPerformanceNow() - startedAt,
              ozonMs: 0,
              processingMs: 0,
              imageMs: 0,
              rows: current.data?.rows?.length ?? 0,
              imageCount: countRowsImages(current.data?.rows ?? []),
              apiCount: 0,
            },
          }));
        }
        return snapshotDataRef.current ?? null;
      }

      if (!canUseOzonSnapshotSource(source)) {
        if (isCurrentRequest())
          setSnapshot({
            data: null,
            loading: false,
            refreshing: false,
            error: '请先在设置里配置 Ozon 店铺 Client ID 和 API Key。',
            hasLoaded: false,
            performance: {
              eventId: `${eventIdBase}:empty`,
              startedAt,
              localMs,
              ozonMs: 0,
              processingMs: 0,
              imageMs: 0,
              rows: 0,
              imageCount: 0,
              apiCount: 0,
            },
          });
        return;
      }

      if (isCurrentRequest()) {
        setSnapshot((current) => ({
          ...current,
          loading: !servedSnapshotData && (!silent || !current.hasLoaded),
          refreshing: servedSnapshotData || (silent && current.hasLoaded),
          error: '',
        }));
      }

      try {
        const ozonStart = getPerformanceNow();
        const existingRequest = existingSharedRequest || (force ? null : ozonSnapshotInFlight.get(inFlightKey));
        const requestPromise =
          existingRequest ||
          loader(source, {
            ...(currentOptions.loaderOptions || {}),
            ...(requestLoaderOptions && typeof requestLoaderOptions === 'object' ? requestLoaderOptions : {}),
            forceRefresh: typeof loaderForceRefresh === 'boolean' ? loaderForceRefresh : force,
            signal: requestController?.signal,
            onInitialSnapshot: currentOptions.allowInitialPartialSnapshot === true ? (partial) => {
              if (!isCurrentRequest() || requestController?.signal.aborted || isOzonSnapshotOwnerFenced(inFlightKey)
                // Keep a useful complete list stable during refresh. An old
                // empty list must not hide the newly arrived first batch.
                || (snapshotDataRef.current?.rows?.length > 0 && snapshotDataRef.current.complete !== false)
                || !Array.isArray(partial?.rows) || !partial.rows.length || partial.complete !== false) return;
              // First paint only: never publish a partial range to the shared
              // memory/local cache or claim totals/select-all are complete.
              const firstPaint = { ...partial, complete: false, partial: true };
              snapshotDataRef.current = firstPaint;
              setSnapshot(current => ({ ...current, data: firstPaint, loading: true, refreshing: false, hasLoaded: false }));
            } : undefined,
          });
        if (!existingRequest) {
          requestInFlightRef.current = requestPromise;
          if (!isOzonSnapshotOwnerFenced(inFlightKey)) ozonSnapshotInFlight.set(inFlightKey, requestPromise);
          requestPromise
            .finally(() => {
              if (ozonSnapshotInFlight.get(inFlightKey) === requestPromise) {
                ozonSnapshotInFlight.delete(inFlightKey);
              }
              if (requestInFlightRef.current === requestPromise) {
                requestInFlightRef.current = null;
              }
            })
            .catch(() => undefined);
        }
        const data = await requestPromise;
        const ozonMs = getPerformanceNow() - ozonStart;
        if (!isCurrentRequest()) return;
        if (isOzonSnapshotOwnerFenced(inFlightKey)) return null;
        let displayData = data;
        if (localDataFileKey && localDataSnapshotKey) {
          let localSnapshotWriteError = null;
          await writeOzonLocalDataSnapshot(
            localDataFileKey,
            localDataSnapshotKey,
            prepareLocalSnapshot(data, { snapshotKey: localDataSnapshotKey, reason: 'remote-success' })
          ).catch((error) => {
            localSnapshotWriteError = error;
            return null;
          });
          if (localSnapshotWriteError) {
            safeWarn('本地快照写入失败，已继续使用本次读取到的新数据', localSnapshotWriteError);
          }
          if (!OZON_POST_LOAD_LOCAL_REREAD_FROZEN) {
            const mergedLocalSnapshot = await readOzonLocalDataSnapshot(localDataFileKey, localDataSnapshotKey).catch(
              () => null
            );
            if (mergedLocalSnapshot) {
              displayData = {
                ...mergedLocalSnapshot,
                fetchedAt: data?.fetchedAt || mergedLocalSnapshot.fetchedAt,
              };
            }
          }
        }
        if (!isCurrentRequest()) return;
        if (cacheKey && !isOzonSnapshotOwnerFenced(cacheKey)) writeTimedCache(ozonSnapshotMemoryCache, cacheKey, displayData);
        const imageStart = getPerformanceNow();
        const imageCount = countRowsImages(displayData?.rows ?? []);
        setSnapshot({
          data: displayData,
          loading: false,
          refreshing: false,
          error: '',
          hasLoaded: true,
          performance: {
            eventId: `${eventIdBase}:api`,
            startedAt,
            localMs,
            ozonMs,
            processingMs: 0,
            imageMs: getPerformanceNow() - imageStart,
            rows: displayData?.rows?.length ?? 0,
            imageCount,
            apiCount: getOzonApiRequestCount() - apiCountStart,
          },
        });
        return displayData;
      } catch (error) {
        if (!isCurrentRequest()) return;
        if (globalThis.__wangzaiRendererTreeTelemetryEnabled) {
          performance.mark('wangzai-snapshot-read-error', { detail: {
            name: error?.name, code: error?.code || error?.codeName, message: error?.message || String(error),
          } });
        }
        const existingRows = snapshotDataRef.current?.rows ?? [];
        if (
          localDataFileKey
          && localDataSnapshotKey
          && existingRows.length
          && !isOzonSnapshotOwnerFenced(inFlightKey)
        ) {
          writeOzonLocalDataSnapshot(
            localDataFileKey,
            localDataSnapshotKey,
            prepareLocalSnapshot(
              {
                ...(snapshotDataRef.current ?? {}),
                rows: existingRows,
                errors: [{ label: currentOptions.cacheGroup || 'Ozon', error }],
                fetchedAt: snapshotDataRef.current?.fetchedAt || new Date().toISOString(),
                lastFailedAt: new Date().toISOString(),
              },
              { snapshotKey: localDataSnapshotKey, reason: 'remote-error' }
            )
          ).catch(() => undefined);
        }
        setSnapshot((current) => ({
          ...current,
          loading: false,
          refreshing: false,
          error: getFriendlyOzonOrderError(error),
          performance: {
            eventId: `${eventIdBase}:error`,
            startedAt,
            localMs,
            ozonMs: getPerformanceNow() - startedAt - localMs,
            processingMs: 0,
            imageMs: 0,
            rows: current.data?.rows?.length ?? 0,
            imageCount: countRowsImages(current.data?.rows ?? []),
            apiCount: getOzonApiRequestCount() - apiCountStart,
          },
        }));
      }
    },
    [
      cacheKey,
      cacheTtlMs,
      enabled,
      inFlightKey,
      localDataFileKey,
      localDataSnapshotKey,
      keepCurrentDataOnForceRefresh,
      prepareLocalSnapshot,
      preferLocalDataOnCacheHit,
      source,
      sourceKey,
      loader,
    ]
  );

  React.useEffect(() => {
    if (!invalidateOnSnapshotKeyChange) {
      snapshotIdentityRef.current = snapshotIdentityKey;
      return undefined;
    }
    if (snapshotIdentityRef.current === snapshotIdentityKey) return undefined;
    snapshotIdentityRef.current = snapshotIdentityKey;
    requestGenerationRef.current += 1;
    requestAbortRef.current?.abort();
    setSnapshot((current) => ({
      ...current,
      loading: false,
      refreshing: Boolean(current.data),
      error: '',
      hasLoaded: Boolean(current.hasLoaded || current.data),
    }));
    return undefined;
  }, [invalidateOnSnapshotKeyChange, snapshotIdentityKey]);

  React.useEffect(() => {
    if (!enabled || !loadLocalOnMount) return undefined;
    if (refreshOnMount && canUseOzonSnapshotSource(source)) return undefined;
    refresh({ silent: true, localOnly: true });
    return undefined;
  }, [enabled, loadLocalOnMount, refresh, refreshOnMount, source]);

  React.useEffect(() => {
    if (!enabled || !refreshOnMount) return undefined;
    if (!canUseOzonSnapshotSource(source)) return undefined;
    refresh({ silent: true });
    return undefined;
  }, [enabled, refresh, refreshOnMount, source]);

  const manualRefresh = React.useCallback(() => {
    if (!enabled) return Promise.resolve();
    if (manualRefreshCooldownMs > 0 && manualRefreshCooldownKey) {
      if (!isOzonSnapshotOwnerFenced(manualRefreshCooldownKey)) {
        ozonSnapshotManualRefreshAt.set(manualRefreshCooldownKey, Date.now());
      }
    }
    return refresh({ silent: false, force: true });
  }, [manualRefreshCooldownKey, manualRefreshCooldownMs, enabled, refresh]);

  return { ...snapshot, refresh: manualRefresh, reload: refresh };
}

export function firstMarketingValue(...values) {
  return pickFirstMarketingValue(...values);
}

export function getMarketingActionSearchText(action = {}) {
  return [
    action.title,
    action.originalTitle,
    action.name,
    action.action_type,
    action.actionType,
    action.typeCn,
    action.description,
    action.raw?.title,
    action.raw?.name,
    action.raw?.action_type,
    action.raw?.actionType,
    action.raw?.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function isMarketingElasticAction(action = {}) {
  return /(弹性|elastic|flex|flexible|эластич)/i.test(getMarketingActionSearchText(action));
}

export function isMarketingNoLimitElasticAction(action = {}) {
  if (!isMarketingElasticAction(action)) return false;
  const text = getMarketingActionSearchText(action);
  const endDate = firstMarketingValue(
    action.date_end,
    action.dateEnd,
    action.end_at,
    action.endAt,
    action.raw?.date_end,
    action.raw?.dateEnd
  );
  return (
    !endDate ||
    /2027-01-01/.test(String(endDate)) ||
    /(无有效期|不限期|无期限|no\s*limit|unlimited|без\s+ограничич|без\s+огранич|без\s*срок|бессроч)/i.test(text)
  );
}
