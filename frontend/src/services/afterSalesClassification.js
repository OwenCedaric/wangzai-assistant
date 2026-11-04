import {
  translateAfterSalesLogisticsStatusToChinese,
  translateAfterSalesReasonToChinese,
} from './afterSalesReasonTranslate';

export const AFTER_SALES_TYPE_PRE_SHIP_CANCEL = 'pre_ship_cancel';
export const AFTER_SALES_TYPE_POST_SHIP_CANCEL = 'post_ship_cancel';
export const AFTER_SALES_TYPE_REJECTED_REFUND = 'rejected_refund';
export const AFTER_SALES_TYPE_SIGNED_REFUND = 'signed_refund';
export const AFTER_SALES_TYPE_NEEDS_EVIDENCE = 'needs_evidence';

export const AFTER_SALES_TYPE_LABELS = {
  [AFTER_SALES_TYPE_PRE_SHIP_CANCEL]: '发货前取消',
  [AFTER_SALES_TYPE_POST_SHIP_CANCEL]: '发货后取消',
  [AFTER_SALES_TYPE_REJECTED_REFUND]: '拒收后退款',
  [AFTER_SALES_TYPE_SIGNED_REFUND]: '签收后退款',
  [AFTER_SALES_TYPE_NEEDS_EVIDENCE]: '待核对',
};

const TEXT_SCAN_MAX_DEPTH = 6;
const TEXT_SCAN_MAX_ITEMS = 500;
const MISSING_TEXT_VALUES = new Set(['', '未返回', '读取失败', '待确认', 'null', 'undefined', 'nan']);

const REFUSED_PATTERNS = [
  /买家.{0,8}(拒收|未取|没取|未提取|未领取)/i,
  /(收货时|交付时|派送时).{0,8}(拒收|拒绝)/i,
  /拒收|未取件|未取|未退回/i,
  /Покупатель\s+отказался/i,
  /не\s+забрал(?:и)?\s+заказ/i,
  /buyer\s+refused/i,
  /not\s+picked\s+up/i,
  /did\s+not\s+pick\s+up/i,
  /not[_\s-]*accepted/i,
  /\brefus(?:ed|al|e)\b/i,
];

const DESTROYED_PATTERNS = [
  /Ozon.{0,8}(处置|销毁)/i,
  /商品.{0,8}(处置|销毁)/i,
  /处置中|已处置|销毁/i,
  /UtilizedByOzon|Utilizing|utilized_by_ozon/i,
  /\b(disposed|destroyed|utilized)\b/i,
  /утилиз|уничтож/i,
];

const PRE_SHIP_CANCEL_PATTERNS = [
  /未按时(发货|发送|发运)|没有按时(发货|发送|发运)|发货超时/i,
  /未发货|未发运|未寄出|没有真实发货|没有物流交接|没有出库/i,
  /仓库商品已售完|商品已售完|缺货|库存不足/i,
  /卖家取消|买家取消|订单已取消|取消订单/i,
  /you\s+did\s+not\s+ship\s+on\s+time/i,
  /did\s+not\s+ship|didn't\s+ship|not\s+shipped|failed\s+to\s+ship/i,
  /out\s+of\s+stock|stockout|sold\s+out/i,
  /Вы\s+не\s+отгрузили\s+заказ\s+вовремя/i,
  /Вы\s+не\s+отправили\s+заказ\s+вовремя/i,
  /Товар\s+закончился/i,
];

const SHIPPED_PATTERNS = [
  /已发货|已发运|已出库|物流交接|运输中|派送中|送达中/i,
  /\b(delivering|shipped|shipping|in\s*transit|handover|awaiting_deliver)\b/i,
  /отправлен|доставк|вручени/i,
];

const DELIVERED_PATTERNS = [
  /已签收|签收完成|已送达|已妥投/i,
  /\b(delivered|signed)\b/i,
  /\b(buyer|customer|client|recipient).{0,40}(received|accepted)\b|\b(received|accepted).{0,40}(buyer|customer|client|recipient)\b/i,
  /(买家|顾客|客户|收件人).{0,40}(已接收|已收货)|(已接收|已收货).{0,40}(买家|顾客|客户|收件人)/i,
  /(покупател|клиент|получател).{0,40}(получен|получил)|(получен|получил).{0,40}(покупател|клиент|получател)/i,
  /доставлен(?:а|о|ы)?(?![а-яё])|вручен(?:а|о|ы)?(?![а-яё])/i,
];

const RECEIVED_PRODUCT_RETURN_PATTERNS = [
  /配送了错误的商品|收到(?:了)?错误的商品|收到(?:了)?不对的商品|错发商品/i,
  /Привезли\s+не\s+тот\s+товар/i,
  /(?:received|delivered).{0,32}(?:wrong|incorrect).{0,16}(?:item|product|goods)|(?:wrong|incorrect).{0,16}(?:item|product|goods).{0,32}(?:received|delivered)/i,
];

const NOT_DELIVERED_PATTERNS = [/未签收|未送达|not[_\s-]*delivered|not[_\s-]*signed/i];

const CANCELLED_PATTERNS = [/已取消|取消订单|关闭订单|订单取消/i, /\b(cancell?ed|cancel|closed)\b/i, /отмен/i];

function normalizeText(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstFilled(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text && !MISSING_TEXT_VALUES.has(text.toLowerCase())) return text;
  }
  return '';
}

function collectEvidenceStrings(value, depth = 0, seen = new WeakSet(), output = []) {
  if (output.length >= TEXT_SCAN_MAX_ITEMS || value === null || value === undefined || depth > TEXT_SCAN_MAX_DEPTH) {
    return output;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = normalizeText(value);
    if (text && !MISSING_TEXT_VALUES.has(text.toLowerCase())) output.push(text);
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => collectEvidenceStrings(item, depth + 1, seen, output));
    return output;
  }

  Object.entries(value).forEach(([key, item]) => {
    if (output.length >= TEXT_SCAN_MAX_ITEMS) return;
    if (item === null || item === undefined) return;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      const text = normalizeText(item);
      if (text && !MISSING_TEXT_VALUES.has(text.toLowerCase())) output.push(`${key}: ${text}`);
      return;
    }
    collectEvidenceStrings(item, depth + 1, seen, output);
  });
  return output;
}

function toEvidenceText(...sources) {
  return sources
    .flatMap((source) => collectEvidenceStrings(source))
    .map(normalizeText)
    .filter(Boolean)
    .join('\n');
}

function findEvidenceSnippet(text = '', patterns = []) {
  const normalized = normalizeText(text).replace(/\s+/g, ' ');
  if (!normalized) return '';
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return String(match[0] || '').slice(0, 160);
  }
  return '';
}

function hasEvidence(text = '', patterns = []) {
  return Boolean(findEvidenceSnippet(text, patterns));
}

function hasNotDeliveredText(text = '') {
  return hasEvidence(text, NOT_DELIVERED_PATTERNS);
}

function buildClassificationResult({
  type,
  reasonZh,
  logisticsStatusZh,
  evidence = [],
  evidenceMap = {},
  needsReadback = false,
  confidence = 0,
  classificationReason = '',
}) {
  return {
    type,
    typeLabel: AFTER_SALES_TYPE_LABELS[type],
    status: AFTER_SALES_TYPE_LABELS[type],
    reasonZh,
    logisticsStatusZh,
    evidence,
    evidenceMap,
    needsReadback,
    confidence,
    classificationReason,
  };
}

function buildEvidenceList(evidenceMap = {}) {
  return Object.entries(evidenceMap)
    .filter(([, text]) => Boolean(text))
    .map(([type, text]) => ({ type, text }));
}

function getOriginalOrderSource({ afterSalesRow = {}, originalOrderRow = {}, rawPosting = {} }) {
  const directOriginal = [
    originalOrderRow,
    afterSalesRow.originalOrder,
    afterSalesRow.original_order,
    afterSalesRow.originalPosting,
    afterSalesRow.original_posting,
    afterSalesRow.originalOrderDetail,
    afterSalesRow.original_order_detail,
    rawPosting,
  ].find((value) => isPlainObject(value) && Object.keys(value).length > 0);
  if (!isPlainObject(directOriginal)) return {};
  return (
    directOriginal.raw?.result?.posting ||
    directOriginal.raw?.result ||
    directOriginal.raw ||
    directOriginal.result?.posting ||
    directOriginal.result ||
    directOriginal
  );
}

function getReasonSource(row = {}) {
  const getReasonCandidate = (value) => {
    if (!isPlainObject(value)) return normalizeText(value);
    return firstFilled(
      value.name,
      value.display_name,
      value.displayName,
      value.reason,
      value.reason_name,
      value.reasonName,
      value.message,
      value.description,
      value.label
    );
  };

  return firstFilled(
    getReasonCandidate(row.return_reason),
    getReasonCandidate(row.returnReason),
    row.return_reason_name,
    row.returnReasonName,
    getReasonCandidate(row.refund_reason),
    getReasonCandidate(row.refundReason),
    getReasonCandidate(row.cancel_reason),
    getReasonCandidate(row.cancelReason),
    getReasonCandidate(row.cancellation_reason),
    getReasonCandidate(row.cancellationReason),
    row.originalOrderCancellationReason,
    row.originalOrderCancelReason,
    getReasonCandidate(row.reason),
    row.reason_name,
    row.reasonName,
    row.reason_message,
    row.reasonMessage,
    row.buyer_comment,
    row.buyerComment,
    row.customer_comment,
    row.customerComment,
    row.comment,
    row.message,
    row.explanation
  );
}

function getLogisticsSource(row = {}) {
  return firstFilled(
    row.logistics_status,
    row.logisticsStatus,
    row.delivery_status,
    row.deliveryStatus,
    row.return_status,
    row.returnStatus,
    row.cancellation_state,
    row.cancellationState,
    row.status,
    row.state,
    row.state?.state_name,
    row.visual?.status?.name,
    row.visual?.status?.display_name
  );
}

function getAfterSalesReturnRecordSnippet(row = {}, rawReturn = {}) {
  const sourceText = firstFilled(row.source, rawReturn.source, row.channel, rawReturn.channel).toLowerCase();
  const hasKnownReturnSource =
    sourceText.includes('rfbs-return') ||
    sourceText.includes('return') ||
    sourceText.includes('refund') ||
    sourceText.includes('退货') ||
    sourceText.includes('退款');
  const directReturnId = firstFilled(
    row.return_id,
    row.returnId,
    row.request_id,
    row.requestId,
    row.refund_id,
    row.refundId,
    rawReturn.return_id,
    rawReturn.returnId,
    rawReturn.request_id,
    rawReturn.requestId,
    rawReturn.refund_id,
    rawReturn.refundId
  );
  const supplementGroup = row.afterSalesSupplements || rawReturn.afterSalesSupplements || {};
  const hasSupplementRecord = [
    supplementGroup.returns,
    supplementGroup.rfbsReturns,
    supplementGroup.conditional,
    row.returnSupplement,
    row.rfbsReturnSupplement,
    row.conditionalCancellationSupplement,
    rawReturn.returnSupplement,
    rawReturn.rfbsReturnSupplement,
    rawReturn.conditionalCancellationSupplement,
  ].some((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value)));
  const recordText = toEvidenceText(
    {
      status: row.status,
      state: row.state,
      return_status: row.return_status,
      refundStatus: row.refundStatus,
      refundTime: row.refundTime,
      return_reason: row.return_reason,
      refund_reason: row.refund_reason,
    },
    rawReturn,
    supplementGroup
  );
  const statusSnippet = findEvidenceSnippet(
    recordText,
    [/return|refund|utiliz|compensat|возврат|вернул|утилиз|компенс|退货|退款|已退款|销毁|处置/i]
  );

  if (hasSupplementRecord) return 'Ozon退货/退款补充记录';
  if (hasKnownReturnSource) return directReturnId || statusSnippet || 'Ozon退货/退款记录';
  if (directReturnId && statusSnippet) return directReturnId;
  return '';
}

export function classifyAfterSalesOrder({
  afterSalesRow = {},
  originalOrderRow = {},
  splitRelation = null,
  rawReturn = {},
  rawPosting = {},
} = {}) {
  const original = getOriginalOrderSource({ afterSalesRow, originalOrderRow, rawPosting });
  const reasonSource = getReasonSource(afterSalesRow) || getReasonSource(rawReturn) || getReasonSource(original);
  const logisticsSource =
    getLogisticsSource(afterSalesRow) || getLogisticsSource(rawReturn) || getLogisticsSource(original);
  const reasonZh = translateAfterSalesReasonToChinese(reasonSource) || '';
  const logisticsStatusZh = translateAfterSalesLogisticsStatusToChinese(logisticsSource) || '';
  const combinedText = [
    reasonSource,
    logisticsSource,
    reasonZh,
    logisticsStatusZh,
    toEvidenceText(afterSalesRow, rawReturn, rawPosting, splitRelation),
  ]
    .filter(Boolean)
    .join('\n');
  const originalText = [
    afterSalesRow.originalOrderCancelledEvidence,
    afterSalesRow.originalOrderDeliveredEvidence,
    afterSalesRow.originalOrderStatus,
    afterSalesRow.originalOrderSubstatus,
    toEvidenceText(original),
  ]
    .filter(Boolean)
    .join('\n');
  const originalLifecycleText = [
    afterSalesRow.originalOrderStatus,
    afterSalesRow.originalOrderSubstatus,
    afterSalesRow.originalStatus,
    afterSalesRow.originalSubstatus,
    original.status,
    original.substatus,
    original.delivery_status,
    original.deliveryStatus,
    original.posting_status,
    original.postingStatus,
  ]
    .filter(Boolean)
    .join('\n');

  const refusedSnippet = findEvidenceSnippet(combinedText, REFUSED_PATTERNS);
  const destroyedSnippet = findEvidenceSnippet(combinedText, DESTROYED_PATTERNS);
  const preShipSnippet = findEvidenceSnippet(combinedText, PRE_SHIP_CANCEL_PATTERNS);
  const shippedSnippet = preShipSnippet ? '' : findEvidenceSnippet(combinedText, SHIPPED_PATTERNS);
  const deliveredSnippet = hasNotDeliveredText(combinedText)
    ? ''
    : findEvidenceSnippet(combinedText, DELIVERED_PATTERNS);
  const cancelledSnippet = findEvidenceSnippet(`${combinedText}\n${originalText}`, CANCELLED_PATTERNS);
  const originalCancelledSnippet =
    firstFilled(afterSalesRow.originalOrderCancelledEvidence, afterSalesRow.cancelledEvidence) ||
    findEvidenceSnippet(originalText || combinedText, CANCELLED_PATTERNS);
  const originalDeliveredAt = firstFilled(
    afterSalesRow.originalOrderDeliveredAt,
    afterSalesRow.delivered_at,
    afterSalesRow.deliveredAt,
    original.delivered_at,
    original.deliveredAt
  );
  const originalLifecycleDeliveredSnippet = hasNotDeliveredText(originalLifecycleText)
    ? ''
    : findEvidenceSnippet(originalLifecycleText, DELIVERED_PATTERNS);
  const cachedOriginalDeliveredEvidence = firstFilled(afterSalesRow.originalOrderDeliveredEvidence);
  const safeCachedOriginalDeliveredEvidence = hasEvidence(cachedOriginalDeliveredEvidence, REFUSED_PATTERNS)
    ? ''
    : cachedOriginalDeliveredEvidence;
  const explicitOriginalDeliveredSnippet =
    originalDeliveredAt ||
    originalLifecycleDeliveredSnippet ||
    (hasNotDeliveredText(originalText) || hasEvidence(originalText, REFUSED_PATTERNS)
      ? ''
      : safeCachedOriginalDeliveredEvidence || findEvidenceSnippet(originalText, DELIVERED_PATTERNS));
  const returnRecordSnippet = getAfterSalesReturnRecordSnippet(afterSalesRow, rawReturn);
  const receivedProductReasonSnippet =
    findEvidenceSnippet(reasonSource, RECEIVED_PRODUCT_RETURN_PATTERNS) ||
    findEvidenceSnippet(reasonZh, RECEIVED_PRODUCT_RETURN_PATTERNS);
  const inferredReceivedProductSnippet =
    !explicitOriginalDeliveredSnippet &&
    returnRecordSnippet &&
    receivedProductReasonSnippet &&
    !preShipSnippet &&
    !refusedSnippet &&
    !hasNotDeliveredText(`${combinedText}\n${originalText}`)
      ? receivedProductReasonSnippet
      : '';
  const originalDeliveredSnippet = explicitOriginalDeliveredSnippet || inferredReceivedProductSnippet;

  const evidenceMap = {
    refused: refusedSnippet,
    destroyed: destroyedSnippet,
    preShip: preShipSnippet,
    shipped: shippedSnippet,
    delivered: deliveredSnippet,
    cancelled: cancelledSnippet,
    originalCancelled: originalCancelledSnippet,
    originalDelivered: originalDeliveredSnippet,
    receivedProductReason: receivedProductReasonSnippet,
  };
  const evidence = buildEvidenceList(evidenceMap);
  const financeEvidence =
    afterSalesRow.financeRefundEvidence && typeof afterSalesRow.financeRefundEvidence === 'object'
      ? afterSalesRow.financeRefundEvidence
      : {};
  const financeConfirmed = Boolean(afterSalesRow.financeRefundConfirmed || financeEvidence.confirmed);
  const financeSignedRefundConfirmed = Boolean(
    financeEvidence.signedRefundConfirmed && (originalDeliveredSnippet || financeEvidence.hasDeliveredSaleOperation)
  );
  const financeConfirmedWithDelivered = Boolean(financeConfirmed && originalDeliveredSnippet);
  const signedReturnRecordSnippet = originalDeliveredSnippet ? returnRecordSnippet : '';
  const signedRefundConfirmed = Boolean(
    financeSignedRefundConfirmed || financeConfirmedWithDelivered || signedReturnRecordSnippet
  );
  const authoritativeDeliveredSnippet =
    explicitOriginalDeliveredSnippet || (financeEvidence.hasDeliveredSaleOperation ? 'finance:delivered-to-customer' : '');
  // The final Ozon order lifecycle is a business fact. A return reason explains
  // why after-sales started, but cannot turn an already delivered order back
  // into an unsigned/refused order.
  const signedRefundAllowed = Boolean(
    signedRefundConfirmed && (!refusedSnippet || authoritativeDeliveredSnippet)
  );

  if (signedRefundAllowed) {
    return buildClassificationResult({
      type: AFTER_SALES_TYPE_SIGNED_REFUND,
      reasonZh,
      logisticsStatusZh: logisticsStatusZh || '已签收后退款',
      evidence,
      evidenceMap,
      confidence: inferredReceivedProductSnippet ? 96 : 98,
      classificationReason:
        refusedSnippet && authoritativeDeliveredSnippet
          ? '原订单已签收且存在退货/退款记录，签收状态优先于售后原因，按签收后退款处理'
          : inferredReceivedProductSnippet &&
        signedReturnRecordSnippet &&
        !financeSignedRefundConfirmed &&
        !financeConfirmedWithDelivered
          ? '退货原因确认买家已收到商品，且存在退货/退款记录，按签收后退款处理'
          : signedReturnRecordSnippet && !financeSignedRefundConfirmed && !financeConfirmedWithDelivered
            ? 'Ozon 已签收且存在退货/退款记录，按签收后退款处理'
            : '原订单已签收且财务流水确认退款扣款，按签收后退款处理',
    });
  }

  if (refusedSnippet || (destroyedSnippet && !originalDeliveredSnippet)) {
    return buildClassificationResult({
      type: AFTER_SALES_TYPE_REJECTED_REFUND,
      reasonZh: reasonZh || '买家拒收 / 未取',
      logisticsStatusZh: logisticsStatusZh || 'Ozon 已处置/销毁',
      evidence,
      evidenceMap,
      confidence: 92,
      classificationReason: '命中拒收/拒签或商品销毁/处置证据，按拒收后退款损失处理',
    });
  }

  if (preShipSnippet && !shippedSnippet) {
    return buildClassificationResult({
      type: AFTER_SALES_TYPE_PRE_SHIP_CANCEL,
      reasonZh: reasonZh || '未按时发货',
      logisticsStatusZh,
      evidence,
      evidenceMap,
      confidence: 88,
      classificationReason: '命中未发货/发货前取消证据，且未命中真实发货证据',
    });
  }

  if ((shippedSnippet || deliveredSnippet) && !refusedSnippet && !destroyedSnippet) {
    return buildClassificationResult({
      type: AFTER_SALES_TYPE_POST_SHIP_CANCEL,
      reasonZh,
      logisticsStatusZh,
      evidence,
      evidenceMap,
      confidence: 72,
      classificationReason: '订单已进入发货/运输流程，且未命中拒收/处置证据',
    });
  }

  if (cancelledSnippet && !shippedSnippet && !deliveredSnippet) {
    return buildClassificationResult({
      type: AFTER_SALES_TYPE_PRE_SHIP_CANCEL,
      reasonZh: reasonZh || '订单已取消',
      logisticsStatusZh,
      evidence,
      evidenceMap,
      confidence: 62,
      classificationReason: '命中取消证据但未命中发货证据，按发货前取消处理',
    });
  }

  return buildClassificationResult({
    type: AFTER_SALES_TYPE_NEEDS_EVIDENCE,
    reasonZh: reasonZh || '其他售后原因',
    logisticsStatusZh,
    evidence,
    evidenceMap,
    needsReadback: true,
    confidence: 30,
    classificationReason: '缺少足够的发货阶段、拒收/处置或原订单证据',
  });
}
