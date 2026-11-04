import {
  AFTER_SALES_TYPE_NEEDS_EVIDENCE,
  AFTER_SALES_TYPE_REJECTED_REFUND,
  AFTER_SALES_TYPE_SIGNED_REFUND,
  classifyAfterSalesOrder,
} from '../../services/afterSalesClassification';
import { mergeOzonAfterSalesCachedRows } from '../../services/ozonOrderExperience';
import {
  getAfterSalesBasePostingNumber as getSharedAfterSalesBasePostingNumber,
  getAfterSalesCanonicalEntityKey,
  getAfterSalesCanonicalEntityKeyCandidates,
  getAfterSalesExactPostingNumber,
  getAfterSalesReturnIdentity,
  getAfterSalesStableIdentityKey as getSharedAfterSalesStableIdentityKey,
} from '../../shared/lib/afterSalesIdentity.js';
import { hasAfterSalesOriginalOrderCheck } from './afterSalesOriginalOrderRules.jsx';
import { getProfitPostingLookupKeys } from '../profit/profitPostingRules.jsx';
import { firstFilled } from './orderIdentityRules.jsx';
import {
  AFTER_SALES_CLASSIFICATION_VERSION,
  AFTER_SALES_LEGACY_SIGNED_REFUND_STATUS,
  AFTER_SALES_REFUSED_REFUND_STATUS,
  AFTER_SALES_SIGNED_REFUND_STATUS,
  getAfterSalesTone,
  isAfterSalesRefundLossStatus,
  isAfterSalesSignedRefundStatus,
  normalizeAfterSalesStatus,
  OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION,
} from './afterSalesStatusRules.jsx';
import {
  getOzonOrderBaseStatusLabel,
  getOzonOrderDeadlineRiskStatus,
  getOzonOrderStatusLabel,
  getOzonOrderStatusTags,
  getSalesOrderTone,
} from './orderStatusRules.jsx';

export async function runLimitedAsync(items = [], limit = 3, worker = async () => undefined) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(Number(limit) || 1, 1), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    })
  );

  return results;
}

export const DEFAULT_OZON_SHOP_POOL_CONCURRENCY = 3;

function createShopPoolCircuitError(reason) {
  const error = new Error('本地服务连接中断，已停止启动剩余店铺的订单读取。');
  error.name = 'OzonShopPoolCircuitError';
  error.code = 'LOCAL_API_BATCH_CIRCUIT_OPEN';
  error.cause = reason;
  return error;
}

/**
 * Runs independent shop lanes through a bounded pool. A fatal result can open
 * the batch circuit so already-running shops settle while untouched shops are
 * skipped instead of adding more pressure to local-api.
 */
export async function runIsolatedShopAsync(
  shops = [],
  worker = async () => undefined,
  options = {}
) {
  const items = Array.isArray(shops) ? shops : [];
  const results = new Array(items.length);
  const requestedConcurrency = Number(options.concurrency);
  const concurrency = Math.min(
    Math.max(
      Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.floor(requestedConcurrency)
        : DEFAULT_OZON_SHOP_POOL_CONCURRENCY,
      1
    ),
    Math.max(items.length, 1)
  );
  const getStopReason = typeof options.getStopReason === 'function' ? options.getStopReason : null;
  let cursor = 0;
  let circuitReason = null;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!circuitReason && cursor < items.length) {
        const index = cursor;
        cursor += 1;
        let settled;
        try {
          settled = { status: 'fulfilled', value: await worker(items[index], index) };
        } catch (reason) {
          settled = { status: 'rejected', reason };
        }
        results[index] = settled;

        if (!circuitReason && getStopReason) {
          const reason = getStopReason(settled, items[index], index);
          if (reason) circuitReason = reason;
        }
      }
    })
  );

  if (circuitReason) {
    const skippedReason = createShopPoolCircuitError(circuitReason);
    for (let index = 0; index < results.length; index += 1) {
      if (!results[index]) results[index] = { status: 'rejected', reason: skippedReason };
    }
  }

  return results;
}

export {
  getOzonOrderBaseStatusLabel,
  getOzonOrderDeadlineRiskStatus,
  getOzonOrderStatusLabel,
  getOzonOrderStatusTags,
  getSalesOrderTone,
};

export {
  AFTER_SALES_CLASSIFICATION_VERSION,
  AFTER_SALES_LEGACY_SIGNED_REFUND_STATUS,
  AFTER_SALES_REFUSED_REFUND_STATUS,
  AFTER_SALES_SIGNED_REFUND_STATUS,
  getAfterSalesTone,
  isAfterSalesRefundLossStatus,
  isAfterSalesSignedRefundStatus,
  normalizeAfterSalesStatus,
  OZON_AFTER_SALES_SNAPSHOT_RULE_VERSION,
};

export function getAfterSalesStatusByRules(item = {}, source = 'returns') {
  const ruleState = getAfterSalesRefundLossRuleState(item, source);
  const { evidence, deliveryEvidence, originalOrderEvidence } = ruleState;
  const rawStatus = String(
    firstFilled(item.status, item.state, item.return_status, item.cancellation_state) || ''
  ).toLowerCase();

  if ((evidence.blocked || deliveryEvidence.preShipment) && !ruleState.authoritativeDeliveredEvidence) {
    return {
      status: '发货前取消',
      evidence,
      deliveryEvidence,
      confidence: 90,
      reason: '命中未发货/发货前取消证据',
    };
  }

  if (source === 'rfbs-return') {
    const refundLossDecision = getAfterSalesRefundLossDecision(ruleState, {
      confirmedConfidence: 90,
      pendingConfidence: 65,
    });
    if (refundLossDecision) return refundLossDecision;
    if (deliveryEvidence.shipped) {
      return {
        status: '发货后取消',
        evidence,
        deliveryEvidence,
        originalOrderEvidence,
        confidence: 70,
        reason: '命中发货后物流证据',
      };
    }
    if (deliveryEvidence.delivered) {
      return {
        status: '发货后取消',
        evidence,
        deliveryEvidence,
        originalOrderEvidence,
        confidence: 70,
        reason: '命中已送达证据，但未同时命中拒收和销毁证据，按发货后取消处理',
      };
    }
    return {
      status: '发货后取消',
      evidence,
      deliveryEvidence,
      originalOrderEvidence,
      confidence: 45,
      reason: 'rFBS 退货申请未命中签收证据，按发货后取消处理',
    };
  }
  if (source === 'conditional') {
    return {
      status: rawStatus.includes('delivered') || rawStatus.includes('delivering') ? '发货后取消' : '发货前取消',
      evidence,
      deliveryEvidence,
      originalOrderEvidence,
      confidence: 60,
      reason: 'rFBS 条件取消按发货阶段归类',
    };
  }
  const refundLossDecision = getAfterSalesRefundLossDecision(ruleState);
  if (refundLossDecision) return refundLossDecision;
  if (deliveryEvidence.delivered) {
    return {
      status: '发货后取消',
      evidence,
      deliveryEvidence,
      originalOrderEvidence,
      confidence: 70,
      reason: '命中已送达证据，但未同时命中拒收和销毁证据，按发货后取消处理',
    };
  }
  if (rawStatus.includes('delivering') || rawStatus.includes('shipped')) {
    return {
      status: '发货后取消',
      evidence,
      deliveryEvidence,
      originalOrderEvidence,
      confidence: 65,
      reason: 'Ozon 售后状态显示发货后阶段',
    };
  }
  return {
    status: '发货后取消',
    evidence,
    deliveryEvidence,
    originalOrderEvidence,
    confidence: 35,
    reason: '未同时命中拒收和销毁证据，按发货后取消处理',
  };
}

function updateAfterSalesTimelineStatus(timeline = [], status) {
  const rows = Array.isArray(timeline) ? timeline : [];
  const nextStatusLine = `售后状态：${status}`;
  let hasStatusLine = false;
  const next = [];
  rows.forEach((item) => {
    const text = String(item || '');
    if (text.startsWith('售后状态：')) {
      if (!hasStatusLine) next.push(nextStatusLine);
      hasStatusLine = true;
      return;
    }
    next.push(item);
  });
  return hasStatusLine ? next : [nextStatusLine, ...next];
}

function isOrderCancelledFallbackRow(row = {}) {
  const source = String(row.source || row.raw?.source || '').toLowerCase();
  return source === 'order-cancelled' && !getAfterSalesReturnIdentity(row);
}

function addAfterSalesConcretePostingKeys(target, row = {}) {
  const exactPosting = getAfterSalesExactPostingNumber(row);
  const basePosting = getAfterSalesBasePostingNumber(row);
  if (exactPosting) target.add(`exact:${exactPosting}`);
  if (basePosting) target.add(`base:${basePosting}`);
}

function shouldSkipOrderCancelledFallbackRow(row = {}, concreteReturnPostingKeys = new Set()) {
  if (!isOrderCancelledFallbackRow(row)) return false;

  const exactPosting = getAfterSalesExactPostingNumber(row);
  if (exactPosting && concreteReturnPostingKeys.has(`exact:${exactPosting}`)) return true;

  const basePosting = getAfterSalesBasePostingNumber(row);
  if (basePosting && (!exactPosting || exactPosting === basePosting)) {
    return concreteReturnPostingKeys.has(`base:${basePosting}`);
  }

  return false;
}

export function getAfterSalesBusinessDedupeKey(row = {}) {
  return getAfterSalesCanonicalEntityKey(row);
}

export function getAfterSalesStableIdentityKey(row = {}) {
  return getSharedAfterSalesStableIdentityKey(row);
}

export function getAfterSalesBasePostingNumber(row = {}) {
  return getSharedAfterSalesBasePostingNumber(row);
}

export function getAfterSalesBusinessDedupeKeyCandidates(row = {}) {
  const candidates = getAfterSalesCanonicalEntityKeyCandidates(row);
  const returnId = getAfterSalesReturnIdentity(row);

  if (returnId) {
    const legacyReturnKey = (() => {
      const recordKey = String(row.recordKey || '').trim();
      if (/^return:/i.test(recordKey) && recordKey.includes(returnId)) return recordKey;
      return '';
    })();

    return [...candidates, legacyReturnKey]
      .map((value) => String(value || '').trim())
      .filter((value, index, values) => value && values.indexOf(value) === index);
  }

  return candidates;
}

export function getAfterSalesBusinessDedupeRank(row = {}) {
  const status = normalizeAfterSalesStatus(row.status || row.type);
  const signedRefundConfirmed = status === AFTER_SALES_SIGNED_REFUND_STATUS && getAfterSalesSignedRefundConfirmed(row);
  let rank = 0;
  if (signedRefundConfirmed) rank += 1100;
  else if (status === AFTER_SALES_SIGNED_REFUND_STATUS) rank += 100;
  if (status === AFTER_SALES_REFUSED_REFUND_STATUS) rank += 1000;
  if (status === '发货前取消') rank += 600;
  if (status === '发货后取消') rank += 300;
  rank += Number(row.classificationConfidence || row.confidence || 0);
  if (
    (row.financeRefundConfirmed || row.financeRefundEvidence?.confirmed) &&
    status !== AFTER_SALES_SIGNED_REFUND_STATUS
  ) {
    rank += 120;
  }
  if (row.classificationReason || row.evidence || row.deliveryEvidence || row.originalOrderEvidence) rank += 60;
  if (row.excludeFromAfterSales) rank -= 200;
  return rank;
}

export function getAfterSalesFinanceEvidenceObject(row = {}) {
  if (row.financeRefundEvidence && typeof row.financeRefundEvidence === 'object') return row.financeRefundEvidence;
  return row.raw?.financeRefundEvidence && typeof row.raw.financeRefundEvidence === 'object'
    ? row.raw.financeRefundEvidence
    : {};
}

function hasAfterSalesExplicitFinanceNonConfirmation(row = {}) {
  const financeEvidence = getAfterSalesFinanceEvidenceObject(row);
  const hasCheckedResult = Boolean(row.financeRefundChecked || financeEvidence.checked);
  return Boolean(
    hasCheckedResult &&
    !row.financeRefundConfirmed &&
    !financeEvidence.confirmed &&
    !financeEvidence.signedRefundConfirmed
  );
}

function hasAfterSalesDurableFinanceConfirmation(row = {}) {
  const status = normalizeAfterSalesStatus(row.status || row.type);
  if (status === AFTER_SALES_SIGNED_REFUND_STATUS) return getAfterSalesSignedRefundConfirmed(row);
  if (status !== AFTER_SALES_REFUSED_REFUND_STATUS) return false;
  return Boolean((row.refusedEvidence || row.destroyedEvidence) && !row.originalOrderDeliveredEvidence);
}

export function protectAfterSalesStrongEvidenceFields(merged = {}, left = {}, right = {}) {
  const next = { ...merged };
  [
    'refusedEvidence',
    'destroyedEvidence',
    'blockedEvidence',
    'deliveredEvidence',
    'shippedEvidence',
    'originalOrderCancelledEvidence',
    'originalOrderDeliveredEvidence',
  ].forEach((field) => {
    const rightValue = String(right[field] || '').trim();
    const leftValue = String(left[field] || '').trim();
    const rightCanClearStaleDeliveryEvidence =
      ['deliveredEvidence', 'originalOrderDeliveredEvidence'].includes(field) &&
      Object.prototype.hasOwnProperty.call(right, field) &&
      !rightValue &&
      (Number(right.classificationVersion) || 0) >= (Number(left.classificationVersion) || 0);
    if (rightCanClearStaleDeliveryEvidence) {
      next[field] = '';
      return;
    }
    if (rightValue) next[field] = right[field];
    else if (leftValue) next[field] = left[field];
  });
  const leftFinance = getAfterSalesFinanceEvidenceObject(left);
  const rightFinance = getAfterSalesFinanceEvidenceObject(right);
  const rightClearsStaleFinance =
    hasAfterSalesExplicitFinanceNonConfirmation(right) && !hasAfterSalesDurableFinanceConfirmation(left);
  const financeRefundEvidence = {
    ...leftFinance,
    ...rightFinance,
  };
  const financeConfirmed = rightClearsStaleFinance
    ? false
    : Boolean(
        financeRefundEvidence.confirmed ||
        leftFinance.confirmed ||
        rightFinance.confirmed ||
        left.financeRefundConfirmed ||
        right.financeRefundConfirmed
      );
  const financeChecked = Boolean(
    financeConfirmed ||
    financeRefundEvidence.checked ||
    leftFinance.checked ||
    rightFinance.checked ||
    left.financeRefundChecked ||
    right.financeRefundChecked
  );
  if (left.originalOrderEvidenceChecked || right.originalOrderEvidenceChecked) {
    next.originalOrderEvidenceChecked = true;
  }
  if (financeChecked) next.financeRefundChecked = true;
  if (financeChecked) next.financeRefundConfirmed = financeConfirmed;
  if (financeChecked || Object.keys(financeRefundEvidence).length) {
    next.financeRefundEvidence = {
      ...financeRefundEvidence,
      checked: financeChecked,
      confirmed: financeConfirmed,
    };
  }
  if (left.raw || right.raw) {
    next.raw = {
      ...(left.raw ?? {}),
      ...(right.raw ?? {}),
      refusedEvidence: next.refusedEvidence || right.raw?.refusedEvidence || left.raw?.refusedEvidence,
      destroyedEvidence: next.destroyedEvidence || right.raw?.destroyedEvidence || left.raw?.destroyedEvidence,
      financeRefundChecked:
        next.financeRefundChecked || right.raw?.financeRefundChecked || left.raw?.financeRefundChecked,
      financeRefundConfirmed:
        next.financeRefundConfirmed ?? right.raw?.financeRefundConfirmed ?? left.raw?.financeRefundConfirmed,
      financeRefundEvidence:
        next.financeRefundEvidence || right.raw?.financeRefundEvidence || left.raw?.financeRefundEvidence,
    };
  }
  return next;
}

export function recalculateAfterSalesMergedClassification(row = {}) {
  const source =
    row.source || row.raw?.source || (row.refusedEvidence && row.destroyedEvidence ? 'rfbs-return' : 'returns');
  const statusRecalculationSource = {
    ...(row.raw ?? {}),
    ...row,
    raw: row.raw,
  };
  const classification = getAfterSalesStatusByRules(statusRecalculationSource, source);
  const status = classification.status;
  return {
    ...row,
    status,
    type: status,
    tone: getAfterSalesTone(status),
    excludeFromAfterSales: Boolean(classification.excludeFromAfterSales),
    classificationVersion: AFTER_SALES_CLASSIFICATION_VERSION,
    classificationConfidence: classification.confidence ?? row.classificationConfidence ?? 0,
    classificationReason: classification.reason || row.classificationReason || '售后归类',
    refusedEvidence:
      classification.deliveryEvidence?.refusedSnippet ||
      classification.evidence.refusedSnippet ||
      row.refusedEvidence ||
      '',
    destroyedEvidence:
      classification.deliveryEvidence?.destroyedSnippet ||
      classification.evidence.destroyedSnippet ||
      row.destroyedEvidence ||
      '',
    blockedEvidence:
      classification.deliveryEvidence?.blockedSnippet ||
      classification.evidence.blockedSnippet ||
      row.blockedEvidence ||
      '',
    deliveredEvidence: classification.deliveryEvidence?.deliveredSnippet || row.deliveredEvidence || '',
    shippedEvidence: classification.deliveryEvidence?.shippedSnippet || row.shippedEvidence || '',
    originalOrderCancelledEvidence:
      classification.originalOrderEvidence?.cancelledSnippet || row.originalOrderCancelledEvidence || '',
    originalOrderDeliveredEvidence:
      classification.originalOrderEvidence?.deliveredSnippet || row.originalOrderDeliveredEvidence || '',
    originalOrderEvidenceChecked: Boolean(
      row.originalOrderEvidenceChecked || hasAfterSalesOriginalOrderCheck(row.raw ?? row)
    ),
    timeline: updateAfterSalesTimelineStatus(row.timeline, status),
  };
}

export function mergeAfterSalesRowsForBusinessDedupe(current = {}, row = {}) {
  const mergedRows = mergeOzonAfterSalesCachedRows([current], [row]);
  const merged = protectAfterSalesStrongEvidenceFields(mergedRows[0] ?? { ...current, ...row }, current, row);
  return recalculateAfterSalesMergedClassification(merged);
}

export function mergeAfterSalesRowsByBusinessKey(rows = []) {
  const originalRows = Array.isArray(rows) ? rows : [];
  const concreteReturnPostingKeys = new Set();

  originalRows.forEach((row) => {
    if (getAfterSalesReturnIdentity(row)) {
      addAfterSalesConcretePostingKeys(concreteReturnPostingKeys, row);
    }
  });

  const result = [];
  const indexByKey = new Map();

  originalRows.forEach((row) => {
    if (shouldSkipOrderCancelledFallbackRow(row, concreteReturnPostingKeys)) {
      return;
    }

    const keyCandidates = getAfterSalesBusinessDedupeKeyCandidates(row);
    const matchedIndex = keyCandidates
      .map((candidate) => indexByKey.get(candidate))
      .find((value) => value !== undefined);

    if (!keyCandidates.length) {
      result.push(row);
      return;
    }

    if (matchedIndex === undefined) {
      keyCandidates.forEach((candidate) => indexByKey.set(candidate, result.length));
      result.push(row);
      return;
    }

    const currentIndex = matchedIndex;
    const current = result[currentIndex];
    const [left, right] =
      getAfterSalesBusinessDedupeRank(row) >= getAfterSalesBusinessDedupeRank(current)
        ? [current, row]
        : [row, current];

    result[currentIndex] = mergeAfterSalesRowsForBusinessDedupe(left, right);
    keyCandidates.forEach((candidate) => indexByKey.set(candidate, currentIndex));
  });

  return result;
}

export function dedupeAfterSalesRowsByBusinessKey(rows = []) {
  return mergeAfterSalesRowsByBusinessKey(rows);
}

export const AFTER_SALES_BUYER_REFUSED_DELIVERY_PATTERN =
  /(买家|顾客|客户|收件人|покупател|клиент|buyer|customer|client|recipient).{0,80}(交货|送达|配送|签收|вруч|получ|достав|delivery|delivered|handover).{0,80}(拒收|拒签|拒绝|未取|未领取|未提取|не\s*забрал|не\s*получил|отказ|refus|reject|not\s*picked\s*up|did\s*not\s*pick)|(买家|顾客|客户|收件人|покупател|клиент|buyer|customer|client|recipient).{0,80}(拒收|拒签|拒绝|未取|未领取|未提取|не\s*забрал|не\s*получил|отказ|refus|reject|not\s*picked\s*up|did\s*not\s*pick).{0,80}(交货|送达|配送|签收|вруч|получ|достав|delivery|delivered|handover|заказ)|(拒收|拒签|未取|未领取|未提取|не\s*забрал|не\s*получил|отказ|refus|reject|not\s*picked\s*up|did\s*not\s*pick).{0,80}(交货|送达|配送|签收|вруч|получ|достав|delivery|delivered|handover|заказ)/i;

export const AFTER_SALES_SIMPLE_REFUSED_PATTERN =
  /\b(buyer|customer|client|recipient).{0,40}(refus|reject|not\s+picked\s+up|did\s+not\s+pick\s+up)|\b(refus(?:ed|al|e)|not\s+picked\s+up|did\s+not\s+pick\s+up)\b/i;

export const AFTER_SALES_DESTROYED_PATTERN =
  /(商品|товар|item|goods).{0,120}(已被销毁|被销毁|已销毁|销毁|уничтож|утилиз|destroyed|disposed)|(已被销毁|被销毁|已销毁|销毁|уничтож|утилиз|destroyed|disposed|disposal|utilization|utilizing)/i;

export const AFTER_SALES_PRE_SIGNED_CANCEL_PATTERN =
  /(您没有按时发送商品|未按时发货|没有按时发货|没有按时发送|未发货|未发运|未寄出|缺货|库存不足|商品缺货|超时发货|卖家未按时发货|卖家原因|Вы не отгрузили заказ вовремя|Вы не отправили заказ вовремя|не отгрузили заказ вовремя|не отправили заказ вовремя|Товар закончился на складе|товар закончился|закончился на складе|Вы отменили заказ|Покупатель отменил заказ|отменил заказ по вашей просьбе|не\s+отгрузил|не\s+отправил|seller.{0,60}(did not|didn't|not).{0,60}(ship|dispatch|send)|did not ship|didn't ship|not shipped|failed to ship|ship the order on time|late shipment|out\s+of\s+stock|stockout|sold\s+out)/i;

export const AFTER_SALES_DELIVERED_PATTERN =
  /(已签收|签收完成|已送达|已妥投|delivered|signed|доставлен(?:а|о|ы)?(?![а-яё])|вручен(?:а|о|ы)?(?![а-яё])|(买家|顾客|客户|收件人|buyer|customer|client|recipient|покупател|клиент|получател).{0,40}(已接收|已收货|received|accepted|получен|получил)|(已接收|已收货|received|accepted|получен|получил).{0,40}(买家|顾客|客户|收件人|buyer|customer|client|recipient|покупател|клиент|получател))/i;

export const AFTER_SALES_NOT_DELIVERED_PATTERN =
  /\b(?:not[_\s-]*delivered|not[_\s-]*signed|not\s+picked\s+up|did\s+not\s+pick\s+up|not\s+received|not\s+accepted|not\s+handed\s+over|undelivered|unclaimed)\b/i;

export const AFTER_SALES_SHIPPED_PATTERN =
  /(已发货|已发运|运输中|派送中|送达中|delivering|shipped|shipping|in\s*transit|handover|вручени|доставк|отправлен)/i;

export const AFTER_SALES_CANCELLED_PATTERN = /(已取消|取消订单|关闭订单|cancelled|canceled|cancel|отмен|annul|closed)/i;

export function getAfterSalesEvidenceText(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || depth > 5) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .map((item) => getAfterSalesEvidenceText(item, depth + 1, seen))
      .filter(Boolean)
      .join('\n');
  }

  return Object.entries(value)
    .flatMap(([key, item]) => {
      const nestedText = getAfterSalesEvidenceText(item, depth + 1, seen);
      // Empty structural fields such as `rejection_reason: []` must not become
      // business evidence merely because their key contains "reject".  Keep a
      // key only when the corresponding Ozon value actually contains evidence.
      return nestedText ? [`${key}: ${nestedText}`] : [];
    })
    .join('\n');
}

export function getAfterSalesEvidenceSnippet(text = '', pattern) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  const match = normalized.match(pattern);
  if (!match) return '';
  return String(match[0] || '').slice(0, 120);
}

export function getAfterSalesReturnEvidence(item = {}) {
  const reasonText = [
    item.reason,
    item.cancel_reason,
    item.return_reason,
    item.comment,
    item.message,
    item.status,
    item.state,
    item.state?.state_name,
    item.visual?.status?.name,
    item.visual?.status?.display_name,
  ]
    .filter(Boolean)
    .join('\n');
  const evidenceText = `${reasonText}\n${getAfterSalesEvidenceText(item)}`;
  const blockedSnippet = getAfterSalesEvidenceSnippet(evidenceText, AFTER_SALES_PRE_SIGNED_CANCEL_PATTERN);
  const refusedSnippet = blockedSnippet
    ? ''
    : getAfterSalesEvidenceSnippet(evidenceText, AFTER_SALES_BUYER_REFUSED_DELIVERY_PATTERN) ||
      getAfterSalesEvidenceSnippet(evidenceText, AFTER_SALES_SIMPLE_REFUSED_PATTERN);
  const destroyedSnippet = getAfterSalesEvidenceSnippet(evidenceText, AFTER_SALES_DESTROYED_PATTERN);

  return {
    blocked: Boolean(blockedSnippet),
    refused: Boolean(refusedSnippet),
    destroyed: Boolean(destroyedSnippet),
    confirmed: Boolean((refusedSnippet || destroyedSnippet) && !blockedSnippet),
    blockedSnippet,
    refusedSnippet,
    destroyedSnippet,
  };
}

export function getAfterSalesDeliveryEvidence(item = {}, evidence = {}) {
  const text = `${getAfterSalesEvidenceText(item)}\n${[
    item.status,
    item.state,
    item.return_status,
    item.cancellation_state,
    item.logistics_status,
    item.delivery_status,
    item.visual?.status?.name,
    item.visual?.status?.display_name,
  ]
    .filter(Boolean)
    .join('\n')}`;
  const blockedSnippet =
    evidence.blockedSnippet || getAfterSalesEvidenceSnippet(text, AFTER_SALES_PRE_SIGNED_CANCEL_PATTERN);
  const refusedSnippet =
    evidence.refusedSnippet || getAfterSalesEvidenceSnippet(text, AFTER_SALES_BUYER_REFUSED_DELIVERY_PATTERN);
  const destroyedSnippet =
    evidence.destroyedSnippet || getAfterSalesEvidenceSnippet(text, AFTER_SALES_DESTROYED_PATTERN);
  const notDeliveredSnippet = getAfterSalesEvidenceSnippet(text, AFTER_SALES_NOT_DELIVERED_PATTERN);
  const deliveredSnippet =
    refusedSnippet || notDeliveredSnippet ? '' : getAfterSalesEvidenceSnippet(text, AFTER_SALES_DELIVERED_PATTERN);
  const shippedSnippet = getAfterSalesEvidenceSnippet(text, AFTER_SALES_SHIPPED_PATTERN);
  return {
    blockedSnippet,
    refusedSnippet,
    destroyedSnippet,
    deliveredSnippet,
    shippedSnippet,
    preShipment: Boolean(blockedSnippet),
    refused: Boolean(refusedSnippet),
    destroyed: Boolean(destroyedSnippet),
    delivered: Boolean(deliveredSnippet && !refusedSnippet),
    shipped: Boolean(shippedSnippet),
  };
}

export function getOzonBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'да'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'нет'].includes(normalized)) return false;
  }
  return false;
}

export function getAfterSalesOriginalOrderSource(item = {}) {
  const source =
    item.originalOrder ||
    item.original_order ||
    item.originalPosting ||
    item.original_posting ||
    item.originalOrderDetail ||
    item.original_order_detail ||
    item.posting ||
    item.order ||
    item.orderDetail ||
    item.salesOrderDetail ||
    item.rawOriginalOrder ||
    null;
  if (!source || typeof source !== 'object') return {};
  return (
    source.raw?.result?.posting || source.raw?.result || source.raw || source.result?.posting || source.result || source
  );
}

export function getAfterSalesOriginalOrderEvidence(item = {}) {
  const original = getAfterSalesOriginalOrderSource(item);
  const cancellation = item.originalOrderCancellation || original.cancellation || item.cancellation || {};
  const cachedCancelledEvidence = firstFilled(
    item.originalOrderCancelledEvidence,
    item.cancelledEvidence,
    item.originalCancelledEvidence
  );
  const cachedDeliveredEvidence = firstFilled(item.originalOrderDeliveredEvidence, item.originalDeliveredEvidence);
  const cancelledAfterShip = getOzonBooleanFlag(
    firstFilled(
      item.originalOrderCancelledAfterShip,
      item.cancelled_after_ship,
      item.cancelledAfterShip,
      cancellation.cancelled_after_ship,
      cancellation.cancelledAfterShip
    )
  );
  const deliveredAt = firstFilled(
    item.originalOrderDeliveredAt,
    item.delivered_at,
    item.deliveredAt,
    original.delivered_at,
    original.deliveredAt
  );
  const statusText = [
    item.originalOrderStatus,
    item.originalOrderSubstatus,
    item.originalStatus,
    item.originalSubstatus,
    item.orderStatus,
    item.orderSubstatus,
    original.status,
    original.substatus,
    original.delivery_status,
    original.deliveryStatus,
    original.posting_status,
    original.postingStatus,
  ]
    .filter(Boolean)
    .join('\n');
  const cancellationText = [
    cancellation.cancel_reason,
    cancellation.cancelReason,
    cancellation.reason,
    cancellation.comment,
  ]
    .filter(Boolean)
    .join('\n');
  const cancellationEvidenceText = [statusText, cancellationText].filter(Boolean).join('\n');
  const cancelledSnippet = cancelledAfterShip
    ? 'cancelled_after_ship'
    : cachedCancelledEvidence || getAfterSalesEvidenceSnippet(cancellationEvidenceText, AFTER_SALES_CANCELLED_PATTERN);
  const notDeliveredSnippet = getAfterSalesEvidenceSnippet(statusText, AFTER_SALES_NOT_DELIVERED_PATTERN);
  const deliveredSnippet = deliveredAt
    ? 'delivered_at'
    : notDeliveredSnippet
      ? ''
      : cachedDeliveredEvidence || getAfterSalesEvidenceSnippet(statusText, AFTER_SALES_DELIVERED_PATTERN);

  return {
    cancelled: Boolean(cancelledSnippet),
    delivered: Boolean(deliveredSnippet),
    cancelledAfterShip,
    cancelledSnippet,
    deliveredSnippet,
  };
}

export function getAfterSalesFinanceRefundConfirmed(item = {}) {
  const financeEvidence = getAfterSalesFinanceEvidenceObject(item);
  return Boolean(item.financeRefundConfirmed || financeEvidence.confirmed);
}

export function getAfterSalesSignedRefundConfirmed(item = {}, ruleState = {}) {
  const financeEvidence = getAfterSalesFinanceEvidenceObject(item);
  const financeConfirmed = Boolean(ruleState.financeConfirmed || getAfterSalesFinanceRefundConfirmed(item));
  const financeSignedRefundConfirmed = Boolean(
    financeEvidence.signedRefundConfirmed &&
    (financeEvidence.hasDeliveredSaleOperation ||
      ruleState.financeRefundEvidence?.hasDeliveredSaleOperation ||
      ruleState.originalOrderEvidence?.delivered ||
      ruleState.deliveryEvidence?.delivered)
  );
  const hasSignedOrderEvidence = Boolean(
    financeSignedRefundConfirmed ||
    (ruleState.financeRefundEvidence?.signedRefundConfirmed &&
      (ruleState.financeRefundEvidence?.hasDeliveredSaleOperation ||
        ruleState.originalOrderEvidence?.delivered ||
        ruleState.deliveryEvidence?.delivered)) ||
    ruleState.originalOrderEvidence?.delivered ||
    ruleState.deliveryEvidence?.delivered
  );
  return financeConfirmed && hasSignedOrderEvidence;
}

function getAfterSalesReturnRecordSnippet(item = {}, source = '') {
  const sourceText = [source, item.source, item.raw?.source, item.channel, item.returnSource, item.return_source]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  const hasKnownReturnSource =
    sourceText.includes('rfbs-return') ||
    sourceText.includes('return') ||
    sourceText.includes('refund') ||
    sourceText.includes('退货') ||
    sourceText.includes('退款');
  const directReturnId = firstFilled(
    item.return_id,
    item.returnId,
    item.request_id,
    item.requestId,
    item.refund_id,
    item.refundId
  );
  const supplementGroup = item.afterSalesSupplements || item.raw?.afterSalesSupplements || {};
  const hasSupplementRecord = [
    supplementGroup.returns,
    supplementGroup.rfbsReturns,
    supplementGroup.conditional,
    item.returnSupplement,
    item.rfbsReturnSupplement,
    item.conditionalCancellationSupplement,
  ].some((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value)));
  const recordText = [
    item.status,
    item.state,
    item.state?.state,
    item.state?.state_name,
    item.return_status,
    item.returnStatus,
    item.refundStatus,
    item.refund_status,
    item.refundTime,
    item.refund_time,
    item.return_reason,
    item.returnReason,
    item.refund_reason,
    item.refundReason,
    getAfterSalesEvidenceText(supplementGroup),
  ]
    .filter(Boolean)
    .join('\n');
  const statusSnippet = getAfterSalesEvidenceSnippet(
    recordText,
    /(return|refund|utiliz|compensat|возврат|вернул|утилиз|компенс|退货|退款|已退款|销毁|处置)/i
  );

  if (hasSupplementRecord) return 'Ozon退货/退款补充记录';
  if (hasKnownReturnSource) return directReturnId || statusSnippet || 'Ozon退货/退款记录';
  if (directReturnId && statusSnippet) return directReturnId;
  return '';
}

export function getAfterSalesPostingLookupKeys(row = {}) {
  return getProfitPostingLookupKeys(
    row.salesOrder,
    row.posting,
    row.id,
    row.raw?.posting_number,
    row.raw?.postingNumber,
    row.raw?.order_number,
    row.raw?.orderNumber,
    row.raw?.order_id,
    row.raw?.orderId
  );
}

export function getAfterSalesRefundLossRuleState(item = {}, source = 'returns') {
  const evidence = getAfterSalesReturnEvidence(item);
  const deliveryEvidence = getAfterSalesDeliveryEvidence(item, evidence);
  const rawOriginalOrderEvidence = getAfterSalesOriginalOrderEvidence(item);
  const originalOrderRow = getAfterSalesOriginalOrderSource(item);
  const classificationItem = item.source || item.raw?.source ? item : { ...item, source };
  const canonicalClassification = classifyAfterSalesOrder({
    afterSalesRow: classificationItem,
    originalOrderRow,
    splitRelation: item.splitRelation,
    rawReturn: classificationItem,
    rawPosting: originalOrderRow,
  });
  const canonicalSignedRefundConfirmed = canonicalClassification.type === AFTER_SALES_TYPE_SIGNED_REFUND;
  const canonicalDeliveredSnippet = canonicalSignedRefundConfirmed
    ? canonicalClassification.evidenceMap?.originalDelivered || ''
    : '';
  const originalOrderEvidence =
    canonicalDeliveredSnippet && !rawOriginalOrderEvidence.delivered
      ? {
          ...rawOriginalOrderEvidence,
          delivered: true,
          deliveredSnippet: canonicalDeliveredSnippet,
        }
      : rawOriginalOrderEvidence;
  const hasRefusedAndDestroyedEvidence = deliveryEvidence.refused && deliveryEvidence.destroyed;
  const hasRefusedOrDestroyedEvidence = deliveryEvidence.refused || deliveryEvidence.destroyed;
  const hasCancelledRefusedDestroyedEvidence =
    hasRefusedAndDestroyedEvidence && originalOrderEvidence.cancelled && !originalOrderEvidence.delivered;
  const financeRefundEvidence = getAfterSalesFinanceEvidenceObject(item);
  const financeConfirmed = getAfterSalesFinanceRefundConfirmed(item);
  const financeSignedRefundConfirmed = getAfterSalesSignedRefundConfirmed(item, {
    financeConfirmed,
    financeRefundEvidence,
    originalOrderEvidence,
    deliveryEvidence,
  });
  const signedReturnRecordSnippet = originalOrderEvidence.delivered
    ? getAfterSalesReturnRecordSnippet(item, source)
    : '';
  const authoritativeDeliveredEvidence = Boolean(
    originalOrderEvidence.delivered ||
      financeRefundEvidence.hasDeliveredSaleOperation ||
      canonicalClassification.evidenceMap?.originalDelivered
  );
  // A reason explains why after-sales started. It cannot override the final
  // delivered/received lifecycle state returned by Ozon.
  const refusalConflictsWithSignedEvidence = Boolean(
    deliveryEvidence.refused && !authoritativeDeliveredEvidence
  );
  const signedRefundConfirmed =
    !refusalConflictsWithSignedEvidence &&
    (financeSignedRefundConfirmed || Boolean(signedReturnRecordSnippet) || canonicalSignedRefundConfirmed);

  return {
    evidence,
    deliveryEvidence,
    originalOrderEvidence,
    hasRefusedOrDestroyedEvidence,
    hasRefusedAndDestroyedEvidence,
    hasCancelledRefusedDestroyedEvidence,
    financeRefundEvidence,
    financeConfirmed,
    financeSignedRefundConfirmed,
    canonicalSignedRefundConfirmed,
    signedReturnRecordSnippet,
    authoritativeDeliveredEvidence,
    refusalConflictsWithSignedEvidence,
    signedRefundConfirmed,
    confirmedRefundLoss: hasRefusedOrDestroyedEvidence && !deliveryEvidence.preShipment,
    canonicalClassification,
    source,
  };
}

export function getAfterSalesRefundLossDecision(ruleState = {}, options = {}) {
  const { evidence, deliveryEvidence, originalOrderEvidence } = ruleState;
  if (ruleState.signedRefundConfirmed) {
    return {
      status: AFTER_SALES_SIGNED_REFUND_STATUS,
      evidence,
      deliveryEvidence,
      originalOrderEvidence,
      excludeFromAfterSales: false,
      confidence: options.signedRefundConfidence ?? 98,
      reason:
        ruleState.deliveryEvidence?.refused && ruleState.authoritativeDeliveredEvidence
          ? '原订单已签收且存在退货/退款记录，签收状态优先于售后原因，按签收后退款处理'
          : ruleState.canonicalSignedRefundConfirmed &&
        !ruleState.financeSignedRefundConfirmed &&
        !ruleState.financeConfirmed
          ? ruleState.canonicalClassification.classificationReason
          : ruleState.signedReturnRecordSnippet &&
              !ruleState.financeSignedRefundConfirmed &&
              !ruleState.financeConfirmed
            ? 'Ozon 已签收且存在退货/退款记录，按签收后退款处理'
            : '原订单已签收且财务流水确认退款扣款，按签收后退款处理',
    };
  }
  if (ruleState.confirmedRefundLoss || ruleState.canonicalClassification?.type === AFTER_SALES_TYPE_REJECTED_REFUND) {
    return {
      status: AFTER_SALES_REFUSED_REFUND_STATUS,
      evidence,
      deliveryEvidence,
      originalOrderEvidence,
      confidence: options.confirmedConfidence ?? 85,
      reason: '命中拒收/拒签或商品销毁/处置证据，按拒收后退款损失处理',
    };
  }
  if (originalOrderEvidence?.delivered) {
    const shouldKeepKnownAfterSalesSource =
      ruleState.source === 'order-cancelled' || ruleState.source === 'rfbs-return';
    return {
      status: '发货后取消',
      evidence,
      deliveryEvidence,
      originalOrderEvidence,
      excludeFromAfterSales: shouldKeepKnownAfterSalesSource ? false : true,
      confidence: 98,
      reason: shouldKeepKnownAfterSalesSource
        ? '原订单已签收且未命中拒收/处置证据，保留为发货后取消'
        : '原订单已签收且未命中拒收/处置证据，不纳入拒收后退款',
    };
  }
  if (ruleState.hasRefusedAndDestroyedEvidence) {
    return {
      status: AFTER_SALES_REFUSED_REFUND_STATUS,
      evidence,
      deliveryEvidence,
      originalOrderEvidence,
      confidence: options.pendingConfidence ?? 60,
      needsReadback: false,
      reason: '命中拒收/未取和销毁证据，恢复按拒收后退款处理',
    };
  }
  return null;
}
