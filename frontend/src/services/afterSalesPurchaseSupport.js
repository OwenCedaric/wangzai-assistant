import { firstFilled, formatOzonOrderDate, getOzonShopClientId } from '../entities/order/orderShopScope.jsx';
import { resolvePurchaseOrderDetailUrl } from './purchaseOrderDetailUrl';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeLookupKey(value) {
  const text = normalizeText(value);
  return text && text !== '未返回' && text !== '0' ? text : '';
}

function normalizeUrl(value) {
  const text = normalizeText(value);
  return /^https?:\/\//iu.test(text) ? text : '';
}

function normalizeResponsibilityParty(value) {
  const text = normalizeText(value);
  if (!text || text === '未返回') return '';
  if (/^(seller|merchant|shop|vendor)$/iu.test(text) || /продав|селлер|卖家|商家|店铺/iu.test(text)) {
    return '卖家';
  }
  if (/^(buyer|customer|client)$/iu.test(text) || /покупат|клиент|买家|顾客|客户/iu.test(text)) {
    return '买家';
  }
  if (/^(ozon|platform|marketplace)$/iu.test(text) || /озон|平台/iu.test(text)) {
    return 'Ozon';
  }
  return text;
}

function normalizeReasonCandidate(value) {
  if (!value) return '';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return normalizeText(
      firstFilled(
        value.name,
        value.title,
        value.message,
        value.text,
        value.description,
        value.reason,
        value.reason_name,
        value.reasonName
      )
    );
  }
  const text = normalizeText(value);
  return text === '[object Object]' ? '' : text;
}

function inferResponsibilityPartyFromReason(order = {}) {
  const safeOrder = order && typeof order === 'object' ? order : {};
  const raw = safeOrder.raw && typeof safeOrder.raw === 'object' ? safeOrder.raw : {};
  const detail = raw.detail && typeof raw.detail === 'object' && !Array.isArray(raw.detail) ? raw.detail : {};
  const listItem = raw.listItem && typeof raw.listItem === 'object' && !Array.isArray(raw.listItem) ? raw.listItem : {};
  const text = [
    safeOrder.reason,
    safeOrder.return_reason,
    safeOrder.returnReason,
    safeOrder.return_reason_name,
    safeOrder.returnReasonName,
    raw.reason,
    raw.return_reason,
    raw.returnReason,
    raw.return_reason_name,
    raw.returnReasonName,
    detail.reason,
    detail.return_reason,
    detail.returnReason,
    listItem.reason,
    listItem.return_reason,
    listItem.returnReason,
  ]
    .map(normalizeReasonCandidate)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return '';
  if (/ozon|marketplace|platform|не\s+удалось\s+доставить|delivery\s+failed|failed\s+to\s+deliver|未能配送|配送失败/iu.test(text)) {
    return 'Ozon';
  }
  if (
    /покупател|клиент|buyer|customer|client|买家|客户|顾客|拒收|拒签|未取|未取件|不合适|отказался\s+при\s+вручении|не\s+забрал/iu.test(
      text
    )
  ) {
    return '买家';
  }
  if (/продав|seller|merchant|vendor|shop|卖家|商家|店铺|не\s+тот\s+товар|wrong\s+item|товар\s+с\s+браком/iu.test(text)) {
    return '卖家';
  }
  return '';
}

function getOriginalOrderRaw(order = {}) {
  const raw = order.raw && typeof order.raw === 'object' ? order.raw : {};
  const original =
    order.originalOrder ?? order.original_order ?? raw.originalOrder ?? raw.original_order ?? raw.order ?? {};
  if (!original || typeof original !== 'object') return {};
  return (
    original.raw?.result?.posting ||
    original.raw?.result ||
    original.raw ||
    original.result?.posting ||
    original.result ||
    original
  );
}

function getOzonMoneyReturnedStatus(state = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return '';
  const explicit = normalizeText(firstFilled(state.money_return_state_name, state.moneyReturnStateName));
  if (explicit) return explicit;
  const rawText = normalizeText(firstFilled(state.state, state.state_name, state.stateName));
  if (!rawText) return '';
  if (/moneyreturned|деньги\s+возвращены|returned\s+money/iu.test(rawText)) return '已退款给买家';
  if (/moneyreturninginprocess|refundinginprocess|возврат\s+денег/iu.test(rawText)) return '退款处理中';
  return '';
}

function getOzonCancellationRefundEvidence(source = {}) {
  const row = source && typeof source === 'object' ? source : {};
  const state = row.state && typeof row.state === 'object' && !Array.isArray(row.state) ? row.state : {};
  const cancellation =
    row.cancellation && typeof row.cancellation === 'object' && !Array.isArray(row.cancellation)
      ? row.cancellation
      : {};
  const evidenceText = [
    row.status,
    row.state,
    row.return_status,
    row.returnStatus,
    state.state,
    state.state_name,
    state.stateName,
    state.group_state,
    row.reason,
    row.reason_name,
    row.return_reason,
    row.returnReason,
    row.cancellation_reason,
    row.cancellationReason,
    cancellation.cancel_reason,
    cancellation.cancelReason,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const isCancellationRefund =
    row.source === 'order-cancelled' ||
    cancellation.cancelled_after_ship === true ||
    cancellation.canceled_after_ship === true ||
    /posting_canceled|cancelled|canceled|utilizing|utilization|утил|отказался\s+при\s+вручении|拒收|交付时拒收|取消/iu.test(
      evidenceText
    );
  if (!isCancellationRefund) return null;
  const time = firstFilled(
    cancellation.cancelled_at,
    cancellation.cancelledAt,
    cancellation.canceled_at,
    cancellation.canceledAt,
    cancellation.cancel_date,
    cancellation.cancelDate,
    cancellation.cancellation_date,
    cancellation.cancellationDate,
    cancellation.date,
    row.cancelled_at,
    row.cancelledAt,
    row.canceled_at,
    row.canceledAt,
    row.cancel_date,
    row.cancelDate,
    row.cancellation_date,
    row.cancellationDate,
    row.cancelled_date,
    row.cancelledDate,
    row.created_at,
    row.createdAt
  );
  return time ? { status: '已退款', time, source: 'Ozon取消日期' } : null;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getFinanceOperationAmountForCompensation(operation = {}) {
  return toFiniteNumber(
    firstFilled(
      operation.amount,
      operation.amountTotal,
      operation.amount_total,
      operation.operation_amount,
      operation.operationAmount,
      operation.price
    )
  );
}

function getFinanceOperationTextForCompensation(operation = {}) {
  const raw = operation.raw && typeof operation.raw === 'object' ? operation.raw : {};
  return [
    operation.operation_type,
    operation.operationType,
    operation.operation_type_name,
    operation.operationTypeName,
    operation.type,
    operation.name,
    raw.operation_type,
    raw.operationType,
    raw.operation_type_name,
    raw.operationTypeName,
    raw.type,
    raw.name,
    operation.services?.map?.((service) => service.name || service.service_name || service.type).join(' '),
    raw.services?.map?.((service) => service.name || service.service_name || service.type).join(' '),
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isBuyerCompensationFinanceOperation(operation = {}) {
  const amount = getFinanceOperationAmountForCompensation(operation);
  if (amount === null || amount >= 0) return false;
  const text = getFinanceOperationTextForCompensation(operation);
  return (
    text.includes('operationmarketplaceservicepartialcompensationtoclient') ||
    /partial\s+compensation|compensation\s+to\s+(client|customer|buyer)/iu.test(text) ||
    /частичн\S*\s+компенсац\S*\s+покупател/iu.test(text)
  );
}

function getFinanceEvidenceCandidates(source = {}) {
  const safeSource = source && typeof source === 'object' ? source : {};
  const raw = safeSource.raw && typeof safeSource.raw === 'object' ? safeSource.raw : {};
  return [
    safeSource.financeRefundEvidence,
    safeSource.finance_refund_evidence,
    raw.financeRefundEvidence,
    raw.finance_refund_evidence,
    safeSource.refundEvidence,
    safeSource.refund_evidence,
    raw.refundEvidence,
    raw.refund_evidence,
  ].filter((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function collectFinanceOperationCandidates(source = {}) {
  const safeSource = source && typeof source === 'object' ? source : {};
  const raw = safeSource.raw && typeof safeSource.raw === 'object' ? safeSource.raw : {};
  const evidenceCandidates = getFinanceEvidenceCandidates(safeSource);
  return [
    safeSource.financeOperations,
    safeSource.finance_operations,
    safeSource.operations,
    raw.financeOperations,
    raw.finance_operations,
    raw.operations,
    ...evidenceCandidates.flatMap((evidence) => [
      evidence.operations,
      evidence.financeOperations,
      evidence.finance_operations,
      evidence.compensationOperations,
      evidence.compensation_operations,
    ]),
  ].flatMap((value) => (Array.isArray(value) ? value : []));
}

export function getAfterSalesFinanceCompensationStatus(source = {}) {
  const evidenceCandidates = getFinanceEvidenceCandidates(source);
  if (
    evidenceCandidates.some(
      (evidence) =>
        evidence.buyerCompensationConfirmed ||
        evidence.compensationConfirmed ||
        evidence.hasBuyerCompensation ||
        evidence.hasCompensation
    )
  ) {
    return '已补偿买家';
  }

  const evidenceStatus = evidenceCandidates
    .map((evidence) =>
      normalizeText(firstFilled(evidence.buyerCompensationStatus, evidence.compensationStatus, evidence.status))
    )
    .find((status) => /补偿|компенсац|compensation/iu.test(status));
  if (evidenceStatus) return evidenceStatus;

  const operations = collectFinanceOperationCandidates(source);
  return operations.some(isBuyerCompensationFinanceOperation) ? '已补偿买家' : '';
}

function uniqueValues(values = []) {
  const seen = new Set();
  return values.map(normalizeLookupKey).filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function getShopKeys(source = {}) {
  return uniqueValues([source.shopId, source.shop_id, source.shopClientId, source.clientId, source.shop]);
}

export function getAfterSalesPurchaseLookupKeys(order = {}) {
  const raw = order.raw ?? {};
  const original = raw.originalOrder ?? raw.original_order ?? raw.order ?? {};
  return uniqueValues([
    order.salesOrder,
    order.posting,
    order.postingNumber,
    order.posting_number,
    order.originalOrder,
    order.originalOrderId,
    order.originalPostingNumber,
    raw.posting_number,
    raw.postingNumber,
    raw.order_number,
    raw.orderNumber,
    raw.order_id,
    raw.orderId,
    raw.original_order_number,
    raw.originalPostingNumber,
    original.posting_number,
    original.postingNumber,
    original.order_number,
    original.orderNumber,
    original.order_id,
    original.orderId,
  ]);
}

export function buildAfterSalesPurchaseOverrideIndex(rows = []) {
  const byKey = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const keys = uniqueValues([row.orderKey, row.order_key, row.postingNumber, row.posting_number, row.ozonOrderId]);
    const shopKeys = getShopKeys(row);
    keys.forEach((key) => {
      if (!byKey.has(key)) byKey.set(key, row);
      shopKeys.forEach((shopKey) => {
        const scopedKey = `${shopKey}:${key}`;
        if (!byKey.has(scopedKey)) byKey.set(scopedKey, row);
      });
    });
  });
  return byKey;
}

export function findAfterSalesPurchaseOverride(order = {}, overrideIndex = new Map(), shops = []) {
  const lookupKeys = getAfterSalesPurchaseLookupKeys(order);
  const shopKeys = uniqueValues([
    ...getShopKeys(order),
    getOzonShopClientId(
      shops.find((shop) => shop.id === order.shopId || getOzonShopClientId(shop) === order.shopClientId) ?? {}
    ),
  ]);
  for (const key of lookupKeys) {
    for (const shopKey of shopKeys) {
      const scoped = overrideIndex.get(`${shopKey}:${key}`);
      if (scoped) return scoped;
    }
    const unscoped = overrideIndex.get(key);
    if (unscoped) return unscoped;
  }
  return null;
}

export function getAfterSalesRefundStatus(order = {}) {
  const safeOrder = order && typeof order === 'object' ? order : {};
  const raw = safeOrder.raw ?? {};
  const refund = raw.refund ?? raw.refund_info ?? raw.refundInfo ?? safeOrder.refund ?? {};
  const state = raw.state ?? safeOrder.state ?? {};
  const refundEvidence = safeOrder.refundEvidence ?? raw.refundEvidence ?? raw.refund_evidence ?? {};
  const cancellationRefundEvidence =
    getOzonCancellationRefundEvidence(safeOrder) ?? getOzonCancellationRefundEvidence(raw);
  const financeCompensationStatus = getAfterSalesFinanceCompensationStatus(safeOrder);
  if (financeCompensationStatus) return financeCompensationStatus;
  const explicitStatus = normalizeText(
    firstFilled(
      safeOrder.refundStatus,
      safeOrder.refund_status,
      safeOrder.refundStatusText,
      safeOrder.refund_status_text,
      raw.refund_status,
      raw.refundStatus,
      raw.refund_status_name,
      raw.refundStatusName,
      refundEvidence.status,
      state.money_return_state_name,
      state.moneyReturnStateName,
      state.money_return_state,
      state.moneyReturnState,
      getOzonMoneyReturnedStatus(state),
      cancellationRefundEvidence?.status,
      refund.status,
      refund.state,
      refund.refund_status,
      refund.refundStatus,
      refund.money_return_state_name,
      refund.moneyReturnStateName
    )
  );
  if (explicitStatus) return explicitStatus;
  if (safeOrder.financeRefundConfirmed || raw.financeRefundConfirmed || refundEvidence.confirmed) {
    return '已退款（财务流水确认）';
  }
  if (safeOrder.financeRefundChecked || raw.financeRefundChecked || refundEvidence.checked) {
    return '财务未确认退款';
  }
  return '未返回';
}

export function getAfterSalesRefundTime(order = {}) {
  const safeOrder = order && typeof order === 'object' ? order : {};
  const raw = safeOrder.raw ?? {};
  const refund = raw.refund ?? raw.refund_info ?? raw.refundInfo ?? safeOrder.refund ?? {};
  const refundEvidence = safeOrder.refundEvidence ?? raw.refundEvidence ?? raw.refund_evidence ?? {};
  const financeEvidence = safeOrder.financeRefundEvidence ?? raw.financeRefundEvidence ?? {};
  const cancellationRefundEvidence =
    getOzonCancellationRefundEvidence(safeOrder) ?? getOzonCancellationRefundEvidence(raw);
  const value = firstFilled(
    safeOrder.refundTime,
    safeOrder.refund_time,
    safeOrder.refundAt,
    safeOrder.refund_at,
    safeOrder.refundedAt,
    safeOrder.refunded_at,
    raw.refund_time,
    raw.refundTime,
    raw.refund_at,
    raw.refundAt,
    raw.refunded_at,
    raw.refundedAt,
    raw.refund_date,
    raw.refundDate,
    refundEvidence.time,
    refundEvidence.refundTime,
    refundEvidence.refund_time,
    refundEvidence.refundedAt,
    refundEvidence.refunded_at,
    financeEvidence.refundTime,
    financeEvidence.refund_time,
    financeEvidence.refundedAt,
    financeEvidence.refunded_at,
    financeEvidence.confirmedAt,
    financeEvidence.confirmed_at,
    cancellationRefundEvidence?.time,
    refund.time,
    refund.refund_time,
    refund.refunded_at,
    refund.refundedAt,
    refund.created_at,
    refund.processed_at,
    refund.completed_at
  );
  return value ? formatOzonOrderDate(value, normalizeText(value)) : '未返回';
}

export function getAfterSalesResponsibilityParty(order = {}) {
  const safeOrder = order && typeof order === 'object' ? order : {};
  const raw = safeOrder.raw && typeof safeOrder.raw === 'object' ? safeOrder.raw : {};
  const originalRaw = getOriginalOrderRaw(safeOrder);
  const directCancellation =
    safeOrder.cancellation && typeof safeOrder.cancellation === 'object' && !Array.isArray(safeOrder.cancellation)
      ? safeOrder.cancellation
      : raw.cancellation && typeof raw.cancellation === 'object' && !Array.isArray(raw.cancellation)
        ? raw.cancellation
        : {};
  const originalCancellation =
    safeOrder.originalOrderCancellation &&
    typeof safeOrder.originalOrderCancellation === 'object' &&
    !Array.isArray(safeOrder.originalOrderCancellation)
      ? safeOrder.originalOrderCancellation
      : raw.originalOrderCancellation &&
          typeof raw.originalOrderCancellation === 'object' &&
          !Array.isArray(raw.originalOrderCancellation)
        ? raw.originalOrderCancellation
        : originalRaw.cancellation &&
            typeof originalRaw.cancellation === 'object' &&
            !Array.isArray(originalRaw.cancellation)
          ? originalRaw.cancellation
          : {};
  const value = firstFilled(
    safeOrder.responsibilityParty,
    safeOrder.responsibleParty,
    safeOrder.faultParty,
    safeOrder.cancelFaultParty,
    safeOrder.cancellationFaultParty,
    raw.responsibilityParty,
    raw.responsibleParty,
    raw.faultParty,
    raw.cancelFaultParty,
    raw.cancellationFaultParty,
    originalCancellation.cancellation_initiator,
    originalCancellation.cancellationInitiator,
    originalCancellation.cancellation_type,
    originalCancellation.cancellationType,
    originalCancellation.cancel_initiator,
    originalCancellation.cancelInitiator,
    directCancellation.cancellation_initiator,
    directCancellation.cancellationInitiator,
    directCancellation.cancellation_type,
    directCancellation.cancellationType,
    directCancellation.cancel_initiator,
    directCancellation.cancelInitiator,
    originalRaw.cancellation_initiator,
    originalRaw.cancellationInitiator,
    originalRaw.cancellation_type,
    originalRaw.cancellationType,
    raw.cancellation_initiator,
    raw.cancellationInitiator,
    raw.cancellation_type,
    raw.cancellationType
  );
  return normalizeResponsibilityParty(value) || inferResponsibilityPartyFromReason(safeOrder) || '未返回';
}

export function getAfterSalesSourceLabel(order = {}) {
  const safeOrder = order && typeof order === 'object' ? order : {};
  const raw = safeOrder.raw && typeof safeOrder.raw === 'object' ? safeOrder.raw : {};
  const source = normalizeText(firstFilled(safeOrder.source, raw.source));
  const normalizedSource = source.toLowerCase();
  if (normalizedSource === 'order-cancelled') return '已取消订单';
  if (normalizedSource === 'conditional') return '条件取消';
  if (normalizedSource === 'rfbs-return') return '退货申请';
  if (normalizedSource === 'returns' || normalizedSource === 'return') return '退货申请';
  return source || '退货申请';
}

export function getAfterSalesPurchaseSupport(order = {}, overrideIndex = new Map(), shops = []) {
  const safeOrder = order && typeof order === 'object' ? order : {};
  const override = findAfterSalesPurchaseOverride(safeOrder, overrideIndex, shops) ?? {};
  const platform =
    normalizeText(
      firstFilled(override.purchasePlatform, override.purchase_platform, override.platform, safeOrder.purchasePlatform)
    ) || '未返回';
  const orderNumber =
    normalizeText(
      firstFilled(
        override.purchaseOrderNumber,
        override.purchase_order_number,
        override.orderNo,
        override.order_no,
        safeOrder.purchaseOrderNo
      )
    ) || '未返回';
  const explicitOrderUrl = normalizeUrl(
    firstFilled(
      override.purchaseOrderUrl,
      override.purchase_order_url,
      override.orderUrl,
      override.order_url,
      override.url,
      override.link
    )
  );
  const orderUrl = resolvePurchaseOrderDetailUrl({
    platform,
    orderNumber,
    explicitUrl: explicitOrderUrl,
  });

  return {
    platform,
    orderNumber,
    orderUrl,
    hasOrderUrl: Boolean(orderUrl),
  };
}
