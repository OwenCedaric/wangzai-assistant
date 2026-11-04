import { OZON_AFTER_SALES_DEFAULT_RANGE_DAYS } from '../../shared/config/appConfigCore.jsx';
import {
  enrichAfterSalesRowsWithLocalOriginalOrderEvidence,
  enrichAfterSalesRowsWithLocalProductSummary,
  requestOzonSalesOrderDetail,
} from '../marketing/marketingOrderFields.jsx';
import {
  getOzonOriginalOrderRaw,
  mergeAfterSalesOriginalOrderEvidence,
} from '../order/afterSalesOriginalOrderEvidence.jsx';
import { getAfterSalesItemLookupKeys } from '../order/afterSalesLookupRules.jsx';
import { requestOzonAfterSalesOriginalOrderDetail } from '../order/afterSalesOriginalOrderRead.jsx';
import {
  enrichOzonRfbsReturnItemsWithDetails,
} from '../order/afterSalesRfbsRead.jsx';
import {
  getOzonAfterSalesSnapshotCacheKey,
  getOzonAfterSalesSnapshotCacheKeys,
  getOzonAfterSalesSnapshotReadKeys,
} from '../order/afterSalesSnapshotKeys.jsx';
import {
  firstFilled,
  getOzonReadableShops,
  getOzonShopClientId,
  getOzonShopLabel,
  normalizeOzonId,
  resolveOzonTimeRange,
} from '../order/orderShopScope.jsx';
import {
  dedupeAfterSalesRowsByBusinessKey,
  getAfterSalesPostingLookupKeys,
  OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION,
  runIsolatedShopAsync,
  runLimitedAsync,
} from '../order/orderAsyncRules.jsx';
import { hasUsefulOzonOrderProductInfo } from '../order/orderDisplayFormat.jsx';
import {
  dedupeRowsById,
  normalizeOzonAfterSalesRow,
  readOzonOrderEndpoint,
  requestOzonPagedOffset,
} from './profitOrderSnapshot.jsx';
import { getProfitPostingLookupKeys } from './profitPostingRules.jsx';

function getExactAfterSalesPostingKeys(item = {}) {
  return [
    item.posting_number,
    item.postingNumber,
    item.order_number,
    item.orderNumber,
    item.order_id,
    item.orderId,
    item.posting?.posting_number,
    item.posting?.postingNumber,
    item.posting?.order_id,
    item.posting?.orderId,
  ]
    .map((value) => normalizeOzonId(value).trim())
    .filter((value, index, values) => value && value !== '未返回' && values.indexOf(value) === index);
}

function normalizeOzonCancelledOrderForAfterSales(item = {}) {
  const cancellation =
    item.cancellation && typeof item.cancellation === 'object' && !Array.isArray(item.cancellation)
      ? item.cancellation
      : {};
  const cancellationReason = firstFilled(
    cancellation.cancel_reason,
    cancellation.cancelReason,
    cancellation.cancel_reason_name,
    cancellation.cancelReasonName,
    cancellation.cancel_reason_message,
    cancellation.cancelReasonMessage,
    cancellation.reason,
    cancellation.reason_name,
    cancellation.reasonName,
    cancellation.reason_message,
    cancellation.reasonMessage,
    item.cancel_reason,
    item.cancelReason,
    item.cancel_reason_name,
    item.cancelReasonName,
    item.cancel_reason_message,
    item.cancelReasonMessage,
    item.cancellation_reason,
    item.cancellationReason,
    item.cancellation_reason_name,
    item.cancellationReasonName,
    item.cancellation_reason_message,
    item.cancellationReasonMessage
  );
  const cancelledAt = firstFilled(
    cancellation.cancelled_at,
    cancellation.cancelledAt,
    cancellation.canceled_at,
    cancellation.canceledAt,
    cancellation.cancel_date,
    cancellation.cancelDate,
    cancellation.cancellation_date,
    cancellation.cancellationDate,
    item.cancelled_at,
    item.cancelledAt,
    item.canceled_at,
    item.canceledAt,
    item.updated_at,
    item.in_process_at,
    item.created_at
  );
  const preferredCancellationReason = isLowValueSupplementTarget(cancellationReason)
    ? firstSupplementText(
        item.return_reason,
        item.returnReason,
        item.refund_reason,
        item.refundReason,
        item.reason,
        item.cancel_reason,
        item.cancelReason,
        item.cancellation_reason,
        item.cancellationReason,
        cancellationReason
      )
    : cancellationReason;
  const normalizedCancellation = preferredCancellationReason
    ? {
        ...cancellation,
        cancel_reason: isLowValueSupplementTarget(cancellation.cancel_reason)
          ? preferredCancellationReason
          : cancellation.cancel_reason,
        cancelReason: isLowValueSupplementTarget(cancellation.cancelReason)
          ? preferredCancellationReason
          : cancellation.cancelReason,
      }
    : cancellation;
  return {
    ...item,
    reason: firstFilled(preferredCancellationReason, item.reason),
    return_reason: firstFilled(preferredCancellationReason, item.return_reason),
    refund_reason: firstFilled(preferredCancellationReason, item.refund_reason),
    cancel_reason: firstFilled(preferredCancellationReason, item.cancel_reason),
    cancellation_reason: firstFilled(preferredCancellationReason, item.cancellation_reason),
    cancellation: normalizedCancellation,
    originalOrder: item,
    original_order: item,
    originalPosting: item,
    originalOrderStatus: firstFilled(item.status, item.substatus),
    originalOrderSubstatus: firstFilled(item.substatus, item.status),
    originalOrderCancellation: normalizedCancellation,
    originalOrderCancellationReason: preferredCancellationReason,
    updated_at: firstFilled(cancelledAt, item.updated_at),
    created_at: firstFilled(item.created_at, cancelledAt),
  };
}

function getAfterSalesSnapshotLookupKeys(item = {}) {
  return getProfitPostingLookupKeys([
    ...getAfterSalesItemLookupKeys(item),
    item.return_id,
    item.returnId,
    item.id,
    item.request_id,
    item.requestId,
    item.cancellation_id,
    item.cancellationId,
  ]);
}

function createAfterSalesSupplementGroup() {
  return {
    returns: [],
    rfbsReturns: [],
    conditional: [],
    all: [],
  };
}

function addUniqueAfterSalesSupplement(list, item) {
  if (!item || list.includes(item)) return;
  list.push(item);
}

function addAfterSalesSupplement(index, item, type) {
  const keys = getExactAfterSalesPostingKeys(item);
  if (!keys.length) return;
  keys.forEach((key) => {
    const group = index.get(key) ?? createAfterSalesSupplementGroup();
    if (type === 'returns') addUniqueAfterSalesSupplement(group.returns, item);
    if (type === 'rfbsReturns') addUniqueAfterSalesSupplement(group.rfbsReturns, item);
    if (type === 'conditional') addUniqueAfterSalesSupplement(group.conditional, item);
    addUniqueAfterSalesSupplement(group.all, item);
    index.set(key, group);
  });
}

function buildAfterSalesSupplementIndex({ returnItems = [], rfbsReturnItems = [], conditionalItems = [] } = {}) {
  const index = new Map();
  returnItems.forEach((item) => addAfterSalesSupplement(index, item, 'returns'));
  rfbsReturnItems.forEach((item) => addAfterSalesSupplement(index, item, 'rfbsReturns'));
  conditionalItems.forEach((item) => addAfterSalesSupplement(index, item, 'conditional'));
  return index;
}

function mergeAfterSalesSupplementGroups(groups = []) {
  const merged = createAfterSalesSupplementGroup();
  groups.forEach((group) => {
    if (!group) return;
    group.returns.forEach((item) => addUniqueAfterSalesSupplement(merged.returns, item));
    group.rfbsReturns.forEach((item) => addUniqueAfterSalesSupplement(merged.rfbsReturns, item));
    group.conditional.forEach((item) => addUniqueAfterSalesSupplement(merged.conditional, item));
    group.all.forEach((item) => addUniqueAfterSalesSupplement(merged.all, item));
  });
  return merged;
}

function getAfterSalesSupplementGroupForItem(index, item = {}) {
  const groups = getExactAfterSalesPostingKeys(item)
    .map((key) => index.get(key))
    .filter(Boolean);
  return mergeAfterSalesSupplementGroups(groups);
}

function getSupplementFirstFilled(items = [], readers = []) {
  for (const item of items) {
    const values = readers.map((reader) => reader(item));
    const value = firstFilled(...values);
    if (value) return value;
  }
  return '';
}

function normalizeSupplementText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    return String(
      firstFilled(
        value.name,
        value.title,
        value.reason,
        value.reason_name,
        value.reasonName,
        value.message,
        value.text,
        value.value,
        value.state_name,
        value.stateName,
        value.state,
        value.status
      ) || ''
    ).trim();
  }
  const text = String(value).trim();
  return text === '[object Object]' ? '' : text;
}

function firstSupplementText(...values) {
  for (const value of values) {
    const text = normalizeSupplementText(value);
    if (text) return text;
  }
  return '';
}

function getSupplementRaw(item = {}) {
  return item.raw && typeof item.raw === 'object' && !Array.isArray(item.raw) ? item.raw : {};
}

function getSupplementReturnId(item = {}) {
  const raw = getSupplementRaw(item);
  const postingKeys = new Set(getExactAfterSalesPostingKeys(item));
  const candidates = [
    item.return_id,
    item.returnId,
    item.return_number,
    item.returnNumber,
    raw.return_id,
    raw.returnId,
    raw.return_number,
    raw.returnNumber,
    item.id,
    raw.id,
  ];
  for (const candidate of candidates) {
    const id = normalizeOzonId(candidate).trim();
    if (!id || id === '未返回' || id.startsWith('return_') || postingKeys.has(id)) continue;
    return id;
  }
  return '';
}

function isLowValueSupplementTarget(value) {
  const text = normalizeSupplementText(value);
  return (
    !text ||
    text === '-' ||
    text === '未返回' ||
    text === '待确认' ||
    text === '读取失败' ||
    text === '其他售后原因' ||
    text === '[object Object]'
  );
}

function preferSupplementValue(currentValue, supplementValue) {
  const supplementText = normalizeSupplementText(supplementValue);
  if (!supplementText) return currentValue;
  return isLowValueSupplementTarget(currentValue) ? supplementText : currentValue;
}

function getSupplementReason(item = {}) {
  const cancellation =
    item.cancellation && typeof item.cancellation === 'object' && !Array.isArray(item.cancellation)
      ? item.cancellation
      : {};
  const state = item.state && typeof item.state === 'object' && !Array.isArray(item.state) ? item.state : {};
  const raw = getSupplementRaw(item);
  const rawCancellation =
    raw.cancellation && typeof raw.cancellation === 'object' && !Array.isArray(raw.cancellation)
      ? raw.cancellation
      : {};
  return firstSupplementText(
    item.return_reason,
    item.returnReason,
    item.return_reason_name,
    item.returnReasonName,
    item.refund_reason,
    item.refundReason,
    item.cancel_reason,
    item.cancelReason,
    item.cancellation_reason,
    item.cancellationReason,
    item.reason,
    item.reason_name,
    item.reasonName,
    raw.return_reason,
    raw.returnReason,
    raw.return_reason_name,
    raw.returnReasonName,
    raw.reason,
    raw.reason_name,
    raw.reasonName,
    cancellation.cancel_reason,
    cancellation.cancelReason,
    cancellation.reason,
    cancellation.reason_name,
    rawCancellation.cancel_reason,
    rawCancellation.cancelReason,
    rawCancellation.reason,
    rawCancellation.reason_name,
    state.state_name,
    state.stateName
  );
}

function getSupplementRefundStatus(item = {}) {
  const refund = item.refund && typeof item.refund === 'object' && !Array.isArray(item.refund) ? item.refund : {};
  const state = item.state && typeof item.state === 'object' && !Array.isArray(item.state) ? item.state : {};
  return firstFilled(
    item.refundStatus,
    item.refund_status,
    item.refundStatusText,
    item.refund_status_text,
    refund.status,
    refund.state,
    refund.refund_status,
    refund.refundStatus,
    state.money_return_state_name,
    state.moneyReturnStateName,
    state.money_return_state,
    state.moneyReturnState
  );
}

function getSupplementRefundTime(item = {}) {
  const refund = item.refund && typeof item.refund === 'object' && !Array.isArray(item.refund) ? item.refund : {};
  return firstFilled(
    item.refundTime,
    item.refund_time,
    item.refundAt,
    item.refund_at,
    item.refundedAt,
    item.refunded_at,
    refund.time,
    refund.refund_time,
    refund.refunded_at,
    refund.refundedAt,
    refund.created_at,
    refund.processed_at,
    refund.completed_at
  );
}

function buildCancelledOrderIndex(cancelledItems = []) {
  const index = new Map();
  cancelledItems.forEach((item) => {
    getExactAfterSalesPostingKeys(item).forEach((key) => {
      if (!index.has(key)) index.set(key, item);
    });
  });
  return index;
}

function getCancelledOrderForSupplement(index, item = {}) {
  return getExactAfterSalesPostingKeys(item)
    .map((key) => index.get(key))
    .find(Boolean);
}

function buildSupplementPostingKeySet(items = []) {
  const keys = new Set();
  items.forEach(({ item }) => {
    getExactAfterSalesPostingKeys(item).forEach((key) => keys.add(key));
  });
  return keys;
}

function mergeSupplementWithCancelledOrderEvidence(supplementItem = {}, cancelledItem = null) {
  if (!cancelledItem) return supplementItem;

  const cancellationReason = getSupplementReason(cancelledItem);
  const supplementRefundStatus = getSupplementRefundStatus(cancelledItem);
  const supplementRefundTime = getSupplementRefundTime(cancelledItem);
  const supplementRefundEvidence =
    supplementRefundStatus || supplementRefundTime
      ? {
          status: supplementRefundStatus,
          time: supplementRefundTime,
          source: 'Ozon???????',
        }
      : null;

  return {
    ...supplementItem,
    originalOrder: cancelledItem.originalOrder ?? cancelledItem,
    original_order: cancelledItem.original_order ?? cancelledItem,
    originalPosting: cancelledItem.originalPosting ?? cancelledItem,
    originalOrderStatus: firstFilled(cancelledItem.status, cancelledItem.substatus, supplementItem.originalOrderStatus),
    originalOrderSubstatus: firstFilled(
      cancelledItem.substatus,
      cancelledItem.status,
      supplementItem.originalOrderSubstatus
    ),
    originalOrderCancellation: cancelledItem.cancellation ?? supplementItem.originalOrderCancellation,
    originalOrderCancellationReason: firstFilled(cancellationReason, supplementItem.originalOrderCancellationReason),
    reason: preferSupplementValue(supplementItem.reason, cancellationReason),
    return_reason: preferSupplementValue(supplementItem.return_reason, cancellationReason),
    refund_reason: preferSupplementValue(supplementItem.refund_reason, cancellationReason),
    cancel_reason: preferSupplementValue(supplementItem.cancel_reason, cancellationReason),
    cancellation_reason: preferSupplementValue(supplementItem.cancellation_reason, cancellationReason),
    refundStatus: firstFilled(supplementItem.refundStatus, supplementItem.refund_status, supplementRefundStatus),
    refund_status: firstFilled(supplementItem.refund_status, supplementItem.refundStatus, supplementRefundStatus),
    refundTime: firstFilled(supplementItem.refundTime, supplementItem.refund_time, supplementRefundTime),
    refund_time: firstFilled(supplementItem.refund_time, supplementItem.refundTime, supplementRefundTime),
    refundEvidence: supplementItem.refundEvidence || supplementItem.refund_evidence || supplementRefundEvidence,
  };
}

export function buildOzonAfterSalesRowsFromCancelledOrderBase({
  cancelledItems = [],
  returnItems = [],
  rfbsReturnItems = [],
  conditionalItems = [],
  lookupKeys = [],
  shop,
} = {}) {
  const normalizedLookupKeys = new Set(getProfitPostingLookupKeys(lookupKeys));
  const matchesLookupKeys = (item) => {
    if (!normalizedLookupKeys.size) return true;
    return getAfterSalesSnapshotLookupKeys(item).some((key) => normalizedLookupKeys.has(key));
  };

  const filteredReturnItems = returnItems.filter(matchesLookupKeys);
  const filteredRfbsReturnItems = rfbsReturnItems.filter(matchesLookupKeys);
  const filteredConditionalItems = conditionalItems.filter(matchesLookupKeys);

  const supplementIndex = buildAfterSalesSupplementIndex({
    returnItems: filteredReturnItems,
    rfbsReturnItems: filteredRfbsReturnItems,
    conditionalItems: filteredConditionalItems,
  });

  const cancelledOrderIndex = buildCancelledOrderIndex(cancelledItems);

  const supplementSources = [
    ...filteredReturnItems.map((item) => ({ item, source: 'returns' })),
    ...filteredRfbsReturnItems.map((item) => ({ item, source: 'rfbs-return' })),
    ...filteredConditionalItems.map((item) => ({ item, source: 'conditional' })),
  ];

  const supplementPostingKeys = buildSupplementPostingKeySet(supplementSources);

  const supplementRows = supplementSources.map(({ item, source }) => {
    const cancelledItem = getCancelledOrderForSupplement(cancelledOrderIndex, item);
    const enrichedItem = mergeSupplementWithCancelledOrderEvidence(item, cancelledItem);
    return normalizeOzonAfterSalesRow(enrichedItem, { source, shop });
  });

  const cancelledOrderRows = cancelledItems.flatMap((item) => {
    const supplementGroup = getAfterSalesSupplementGroupForItem(supplementIndex, item);
    const supplementMatchesLookup = supplementGroup.all.some(matchesLookupKeys);

    if (!matchesLookupKeys(item) && !supplementMatchesLookup) return [];

    const exactPostingKeys = getExactAfterSalesPostingKeys(item);
    const hasConcreteSupplement = exactPostingKeys.some((key) => supplementPostingKeys.has(key));

    if (hasConcreteSupplement) return [];

    return normalizeOzonAfterSalesRow(normalizeOzonCancelledOrderForAfterSales(item), {
      source: 'order-cancelled',
      shop,
    });
  });

  return dedupeRowsById([...supplementRows, ...cancelledOrderRows]);
}

export async function requestOzonAfterSalesSnapshot(shop, options = {}) {
  const { since, to } = resolveOzonTimeRange(
    options.dateRange || options.timeScope || options,
    options.defaultDays ?? OZON_AFTER_SALES_DEFAULT_RANGE_DAYS
  );
  const pageOptions = {
    ...(options.maxPages ? { maxPages: options.maxPages } : {}),
    signal: options.signal,
  };
  const [returnsList, rfbsReturnsList, conditionalList, cancelledOrdersList] = await Promise.all([
    readOzonOrderEndpoint('退货列表', () =>
      requestOzonPagedOffset(
        '/v1/returns/list',
        shop,
        ({ offset, limit }) => ({
          filter: { since, to },
          limit,
          offset,
        }),
        pageOptions
      )
    ),
    readOzonOrderEndpoint('rFBS 退货申请', () =>
      requestOzonPagedOffset(
        '/v2/returns/rfbs/list',
        shop,
        ({ offset, limit }) => ({
          filter: { created_since: since, created_to: to },
          limit,
          offset,
        }),
        pageOptions
      )
    ),
    readOzonOrderEndpoint('rFBS 条件取消', () =>
      requestOzonPagedOffset(
        '/v2/conditional-cancellation/list',
        shop,
        ({ offset, limit }) => ({
          filter: { created_since: since, created_to: to },
          limit,
          offset,
        }),
        pageOptions
      )
    ),
    readOzonOrderEndpoint('已取消 FBS/rFBS 订单', () =>
      requestOzonPagedOffset(
        '/v3/posting/fbs/list',
        shop,
        ({ offset, limit }) => ({
          dir: 'DESC',
          filter: { since, to, status: 'cancelled' },
          limit,
          offset,
          with: { analytics_data: true, barcodes: true, financial_data: true, translit: true },
        }),
        pageOptions
      )
    ),
  ]);

  const lookupKeys = new Set(getProfitPostingLookupKeys(options.lookupKeys ?? []));
  const matchesLookupKeys = (item) => {
    if (!lookupKeys.size) return true;
    return getAfterSalesSnapshotLookupKeys(item).some((key) => lookupKeys.has(key));
  };
  const returnItems = returnsList.ok ? returnsList.value.items.filter(matchesLookupKeys) : [];
  const rfbsItems = rfbsReturnsList.ok ? rfbsReturnsList.value.items.filter(matchesLookupKeys) : [];
  const conditionalItems = conditionalList.ok ? conditionalList.value.items.filter(matchesLookupKeys) : [];
  const shouldEnrichRfbsDetails = options.enrichRfbsDetails !== false;
  const rfbsReturnItems =
    shouldEnrichRfbsDetails && rfbsItems.length
      ? await enrichOzonRfbsReturnItemsWithDetails(shop, rfbsItems)
      : rfbsItems;
  const rows = buildOzonAfterSalesRowsFromCancelledOrderBase({
    cancelledItems: cancelledOrdersList.ok ? cancelledOrdersList.value.items : [],
    returnItems,
    rfbsReturnItems,
    conditionalItems,
    lookupKeys: [...lookupKeys],
    shop,
  });
  let mergedRows = dedupeAfterSalesRowsByBusinessKey(rows);

  if (options.enrichLocalOriginalOrderEvidence !== false) {
    mergedRows = dedupeAfterSalesRowsByBusinessKey(
      await enrichAfterSalesRowsWithLocalOriginalOrderEvidence(shop, mergedRows, {
        localDataFileKey: options.localDataFileKey,
        signal: options.signal,
      })
    );
  }

  let classificationEvidence = { attempted: 0, pending: 0, failed: 0 };
  let classificationEvidenceErrors = [];
  const enrichClassificationEvidence =
    typeof options.enrichClassificationEvidence === 'function' ? options.enrichClassificationEvidence : null;
  if (enrichClassificationEvidence) {
    const enrichment = await enrichClassificationEvidence(shop, mergedRows, {
      maxRows: options.maxClassificationEvidenceRows,
      dateRange: { since, to },
      timeScope: options.timeScope,
    });
    mergedRows = dedupeAfterSalesRowsByBusinessKey(enrichment.rows);
    classificationEvidenceErrors = enrichment.errors;
    classificationEvidence = {
      attempted: enrichment.attempted,
      pending: enrichment.pending,
      failed: enrichment.errors.length,
    };
  }
  mergedRows = await enrichAfterSalesRowsWithLocalProductSummary(shop, mergedRows, {
    localDataFileKey: options.localDataFileKey,
    signal: options.signal,
  });

  return {
    rows: mergedRows,
    ruleVersion: OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION,
    errors: [returnsList, rfbsReturnsList, conditionalList, cancelledOrdersList]
      .filter((result) => !result.ok)
      .concat(classificationEvidenceErrors),
    classificationEvidence,
    fetchedAt: new Date().toISOString(),
  };
}

export async function requestOzonAfterSalesSnapshotForShops(shops = [], options = {}) {
  const readableShops = getOzonReadableShops(shops);
  if (!readableShops.length) {
    throw new Error('请先在设置里配置 Ozon 店铺 Client ID 和 API Key。');
  }
  const snapshotScope = options.timeScope || options.dateRangeScope || null;

  const snapshots = await runIsolatedShopAsync(readableShops, (shop) =>
    readOzonOrderEndpoint(getOzonShopLabel(shop), () =>
      requestOzonAfterSalesSnapshot(shop, {
        ...options,
        localDataSnapshotKey: getOzonAfterSalesSnapshotCacheKey(shop, snapshotScope),
        localDataSnapshotKeys: getOzonAfterSalesSnapshotReadKeys(shop, snapshotScope),
      })
    )
  );
  const settledSnapshots = snapshots.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : { ok: false, label: getOzonShopLabel(readableShops[index]), error: result.reason }
  );
  const rows = settledSnapshots.flatMap((snapshot) => (snapshot.ok ? (snapshot.value.rows ?? []) : []));
  const errors = settledSnapshots.flatMap((snapshot) => {
    if (!snapshot.ok) return [snapshot];
    return snapshot.value.errors ?? [];
  });
  const classificationEvidence = settledSnapshots.reduce(
    (summary, snapshot) => {
      if (!snapshot.ok) {
        summary.failed += 1;
        return summary;
      }
      const evidence = snapshot.value.classificationEvidence ?? {};
      summary.attempted += Number(evidence.attempted) || 0;
      summary.pending += Number(evidence.pending) || 0;
      summary.failed += Number(evidence.failed) || 0;
      return summary;
    },
    { attempted: 0, pending: 0, failed: 0 }
  );

  return {
    rows: dedupeAfterSalesRowsByBusinessKey(rows),
    ruleVersion: OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION,
    errors,
    classificationEvidence,
    shops: readableShops.map((shop) => ({
      id: shop.id,
      clientId: getOzonShopClientId(shop),
      label: getOzonShopLabel(shop),
    })),
    fetchedAt: new Date().toISOString(),
  };
}

export function shouldHideOrderNotification(notification = {}) {
  return Boolean(notification?.hidden);
}

export { getOzonOriginalOrderRaw, mergeAfterSalesOriginalOrderEvidence };
export { requestOzonAfterSalesOriginalOrderDetail };
