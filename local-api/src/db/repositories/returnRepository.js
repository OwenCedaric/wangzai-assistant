import { createStableHash } from '../../utils/stableHash.js';

import {
  getOzonReturnReasonLabel,
  getOzonReturnStatusLabel,
} from '../../ozon/ozonChineseLabels.js';
import { appendShopQueryFilter } from '../shopQueryScope.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

export function containsCyrillicText(value = '') {
  return /[\u0400-\u04FF]/u.test(String(value));
}

export const RETURN_REASON_TRANSLATION_PENDING_LABEL = '售后原因翻译中';
export const RETURN_REASON_TRANSLATION_FAILED_LABEL = '售后原因翻译暂不可用';

function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== '0' && text !== '未返回' ? text : '';
}

function compactJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstFilled(...values) {
  for (const value of values) {
    if (normalizeText(value)) return value;
  }
  return '';
}

function extractReturnProduct(row = {}) {
  if (row.product) return row.product;
  if (Array.isArray(row.products)) return row.products;
  if (Array.isArray(row.items)) return row.items;
  if (row.return_product) return row.return_product;
  if (row.returnProduct) return row.returnProduct;
  if (row.item) return row.item;
  return null;
}

function extractFinance(row = {}) {
  return row.financial_data ?? row.financialData ?? row.finance ?? row.compensation ?? null;
}

function getNestedValue(source, path) {
  if (!isPlainObject(source)) return undefined;
  return path.split('.').reduce((current, part) => {
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
    return current?.[part];
  }, source);
}

function normalizeRefundText(value) {
  if (value === undefined || value === null) return '';
  if (isPlainObject(value)) {
    return normalizeText(
      firstFilled(
        value.status,
        value.state,
        value.name,
        value.title,
        value.status_name,
        value.statusName,
        value.state_name,
        value.stateName,
      )
    );
  }
  const text = normalizeText(value);
  return text === '[object Object]' ? '' : text;
}

function normalizeReasonText(value) {
  if (value === undefined || value === null) return '';
  if (isPlainObject(value)) {
    const text = normalizeText(
      firstFilled(
        value.name,
        value.title,
        value.message,
        value.text,
        value.description,
        value.reason,
        value.reason_name,
        value.reasonName,
        value.comment,
      )
    );
    return text === '[object Object]' ? '' : text;
  }
  const text = normalizeText(value);
  return text === '[object Object]' ? '' : text;
}

function normalizeOzonMoneyReturnedState(state = {}) {
  if (!isPlainObject(state)) return null;
  const explicit = normalizeRefundText(firstFilled(state.money_return_state_name, state.moneyReturnStateName));
  if (explicit) return { value: explicit, source: 'state.money_return_state_name' };
  const rawText = normalizeText(firstFilled(state.state, state.state_name, state.stateName));
  if (!rawText) return null;
  if (/moneyreturned|деньги\s+возвращены|returned\s+money/i.test(rawText)) {
    return { value: '已退款给买家', source: state.state ? 'state.state' : 'state.state_name' };
  }
  if (/moneyreturninginprocess|refundinginprocess|возврат\s+денег/i.test(rawText)) {
    return { value: '退款处理中', source: state.state ? 'state.state' : 'state.state_name' };
  }
  return null;
}

function getCancellationRefundState(row = {}) {
  const state = isPlainObject(row.state) ? row.state : {};
  const cancellation = isPlainObject(row.cancellation) ? row.cancellation : {};
  const text = [
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
    .map(normalizeRefundText)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (cancellation.cancelled_after_ship === true || cancellation.canceled_after_ship === true) return true;
  return /utilizing|utilization|утил|отказался\s+при\s+вручении|拒收|交付时拒收|取消/.test(text);
}

function findOzonCancellationTime(row = {}) {
  return findFirstPathValue(row, [
    'cancellation.cancelled_at',
    'cancellation.cancelledAt',
    'cancellation.canceled_at',
    'cancellation.canceledAt',
    'cancellation.cancel_date',
    'cancellation.cancelDate',
    'cancellation.cancellation_date',
    'cancellation.cancellationDate',
    'cancellation.date',
    'cancelled_at',
    'cancelledAt',
    'canceled_at',
    'canceledAt',
    'cancel_date',
    'cancelDate',
    'cancellation_date',
    'cancellationDate',
    'cancelled_date',
    'cancelledDate',
    'created_at',
    'createdAt',
  ]);
}

function getOzonCancellationRefundEvidence(row = {}) {
  if (!getCancellationRefundState(row)) return null;
  const time = findOzonCancellationTime(row);
  if (!time) return null;
  return {
    status: '已退款',
    statusSource: 'Ozon取消日期',
    time: time.value,
    timeSource: time.source,
  };
}

function findFirstPathValue(source, paths = []) {
  for (const path of paths) {
    const value = getNestedValue(source, path);
    const text = normalizeRefundText(value);
    if (text) return { value: text, source: path };
  }
  return null;
}

function findDeepKeyValue(source, keyCandidates = [], prefix = '', seen = new Set(), normalizeValue = normalizeRefundText) {
  if (!isPlainObject(source) && !Array.isArray(source)) return null;
  if (seen.has(source)) return null;
  seen.add(source);
  if (Array.isArray(source)) {
    for (let index = 0; index < source.length; index += 1) {
      const nested = findDeepKeyValue(source[index], keyCandidates, `${prefix}[${index}]`, seen, normalizeValue);
      if (nested) return nested;
    }
    return null;
  }
  for (const key of Object.keys(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (keyCandidates.includes(key)) {
      const text = normalizeValue(source[key]);
      if (text) return { value: text, source: path };
    }
    const nested = findDeepKeyValue(source[key], keyCandidates, path, seen, normalizeValue);
    if (nested) return nested;
  }
  return null;
}

const RETURN_REASON_KEYS = [
  'return_reason',
  'returnReason',
  'return_reason_name',
  'returnReasonName',
  'return_reason_message',
  'returnReasonMessage',
  'refund_reason',
  'refundReason',
  'refund_reason_name',
  'refundReasonName',
  'cancel_reason',
  'cancelReason',
  'cancel_reason_name',
  'cancelReasonName',
  'cancellation_reason',
  'cancellationReason',
  'reason',
  'reason_name',
  'reasonName',
  'reason_message',
  'reasonMessage',
  'buyer_comment',
  'buyerComment',
  'customer_comment',
  'customerComment',
  'comment',
  'message',
  'explanation',
];

function extractReturnReason(row = {}) {
  const explicit = normalizeReasonText(
    firstFilled(
      row.return_reason,
      row.returnReason,
      row.return_reason_name,
      row.returnReasonName,
      row.refund_reason,
      row.refundReason,
      row.cancel_reason,
      row.cancelReason,
      row.cancellation_reason,
      row.cancellationReason,
      row.reason,
      row.reason_name,
      row.reasonName
    )
  );
  if (explicit) return explicit;
  return findDeepKeyValue(row, RETURN_REASON_KEYS, '', new Set(), normalizeReasonText)?.value || '';
}

const REFUND_STATUS_KEYS = [
  'refund_status',
  'refundStatus',
  'refund_status_name',
  'refundStatusName',
  'refund_state',
  'refundState',
  'refund_state_name',
  'refundStateName',
  'money_return_state',
  'moneyReturnState',
  'money_return_state_name',
  'moneyReturnStateName',
  'money_refund_state',
  'moneyRefundState',
  'money_refund_state_name',
  'moneyRefundStateName',
  'compensation_status',
  'compensationStatus',
];

const REFUND_TIME_KEYS = [
  'refund_time',
  'refundTime',
  'refunded_at',
  'refundedAt',
  'refunded_date',
  'refundedDate',
  'refund_date',
  'refundDate',
  'money_returned_at',
  'moneyReturnedAt',
  'money_return_date',
  'moneyReturnDate',
  'money_refund_time',
  'moneyRefundTime',
  'compensation_paid_at',
  'compensationPaidAt',
  'compensation_date',
  'compensationDate',
];

function extractRefundEvidence(row = {}, finance = null) {
  const explicitStatus = findDeepKeyValue(row, REFUND_STATUS_KEYS) ?? findDeepKeyValue(finance, REFUND_STATUS_KEYS);
  const ozonMoneyReturnedStatus = normalizeOzonMoneyReturnedState(row.state);
  const cancellationRefundEvidence = getOzonCancellationRefundEvidence(row);
  const nestedStatus =
    ozonMoneyReturnedStatus ??
    (cancellationRefundEvidence
      ? { value: cancellationRefundEvidence.status, source: cancellationRefundEvidence.statusSource }
      : null) ??
    explicitStatus ??
    findFirstPathValue(row, [
      'refund.status',
      'refund.state',
      'refund_info.status',
      'refund_info.state',
      'refundInfo.status',
      'refundInfo.state',
      'compensation.status',
      'compensation.state',
      'financial_data.refund.status',
      'financialData.refund.status',
      'finance.refund.status',
    ]);
  const explicitTime = findDeepKeyValue(row, REFUND_TIME_KEYS) ?? findDeepKeyValue(finance, REFUND_TIME_KEYS);
  const nestedTime =
    explicitTime ??
    (cancellationRefundEvidence
      ? { value: cancellationRefundEvidence.time, source: cancellationRefundEvidence.timeSource }
      : null) ??
    findFirstPathValue(row, [
      'refund.time',
      'refund.created_at',
      'refund.updated_at',
      'refund.processed_at',
      'refund.completed_at',
      'refund_info.time',
      'refund_info.created_at',
      'refund_info.updated_at',
      'refund_info.processed_at',
      'refundInfo.time',
      'refundInfo.created_at',
      'refundInfo.updated_at',
      'refundInfo.processed_at',
      'compensation.created_at',
      'compensation.updated_at',
      'compensation.processed_at',
      'compensation.completed_at',
      'financial_data.refund.created_at',
      'financialData.refund.created_at',
      'finance.refund.created_at',
    ]);
  const evidence =
    nestedStatus || nestedTime
      ? {
          status: nestedStatus?.value || '',
          statusSource: nestedStatus?.source || '',
          time: nestedTime?.value || '',
          timeSource: nestedTime?.source || '',
        }
      : null;
  return {
    status: nestedStatus?.value || '',
    time: nestedTime?.value || '',
    evidence,
  };
}

function normalizeSource(source = 'returns') {
  const text = normalizeText(source).toLowerCase();
  if (text.includes('conditional')) return 'conditional';
  if (text.includes('rfbs')) return 'rfbs-return';
  return text || 'returns';
}

function normalizeReturnStateText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    return normalizeText(
      firstFilled(
        value.state,
        value.status,
        value.state_name,
        value.group_state,
        value.name,
        value.title
      )
    );
  }
  const text = normalizeText(value);
  return text === '[object Object]' ? '' : text;
}

function firstReturnStatusText(...values) {
  for (const value of values) {
    const text = normalizeReturnStateText(value);
    if (text) return text;
  }
  return '';
}

function normalizeReturn(row = {}, { shopId, source = 'returns' } = {}) {
  const normalizedSource = normalizeSource(firstFilled(row.source, row.return_source, row.type, source));
  const returnId = normalizeId(firstFilled(row.return_id, row.returnId, row.id, row.request_id, row.requestId, row.cancellation_id, row.cancellationId));
  const postingNumber = normalizeId(firstFilled(
    row.posting_number,
    row.postingNumber,
    row.posting?.posting_number,
    row.order?.posting_number,
    row.order_data?.posting_number,
  ));
  const orderId = normalizeId(firstFilled(row.order_id, row.orderId, row.order?.order_id, row.order_data?.order_id));
  const returnKey = returnId || postingNumber || orderId || createStableHash(row, { length: 40 });
  const status = firstReturnStatusText(row.status, row.state, row.return_status, row.cancellation_state);
  const substatus = normalizeText(firstFilled(row.substatus, row.sub_status, row.return_substatus));
  const reason = getOzonReturnReasonLabel(row) || extractReturnReason(row);
  const decision = normalizeText(firstFilled(row.decision, row.action, row.seller_decision, row.approval_status));
  const createdAtRemote = normalizeText(firstFilled(row.created_at, row.createdAt, row.created_since, row.requested_at));
  const updatedAtRemote = normalizeText(firstFilled(row.updated_at, row.updatedAt, row.changed_at, row.processed_at));
  const product = extractReturnProduct(row);
  const finance = extractFinance(row);
  const refund = extractRefundEvidence(row, finance);
  const remoteHash = createStableHash(
    {
      row,
      normalized: {
        returnKey,
        status,
        substatus,
        source: normalizedSource,
        product,
        finance,
        refundStatus: refund.status,
        refundTime: refund.time,
        refundEvidence: refund.evidence,
      },
    },
    { length: 40 }
  );
  return {
    id: `return_${createStableHash({ shopId, returnKey }, { length: 32 })}`,
    shopId,
    returnKey,
    returnId,
    postingNumber,
    orderId,
    source: normalizedSource,
    status,
    substatus,
    reason,
    decision,
    createdAtRemote,
    updatedAtRemote,
    product,
    finance,
    refundStatus: refund.status,
    refundTime: refund.time,
    refundEvidence: refund.evidence,
    raw: { ...row, source: row.source || normalizedSource },
    remoteHash,
  };
}

function toPublicReturn(row = {}) {
  const raw = parseJson(row.raw_json, {});
  const product = parseJson(row.product_json, raw.product ?? raw.products ?? null);
  const finance = parseJson(row.finance_json, raw.financial_data ?? null);
  const publicReturnId = row.return_id || raw.return_id || raw.returnId || raw.id || raw.request_id || raw.requestId || null;
  const derivedRefund = extractRefundEvidence(raw, finance);
  const refundEvidence =
    parseJson(row.refund_json, raw.refundEvidence ?? raw.refund_evidence ?? null) ?? derivedRefund.evidence;
  const refundStatus = normalizeText(
    firstFilled(
      derivedRefund.status,
      row.refund_status,
      raw.refundStatus,
      raw.refund_status,
      refundEvidence?.status,
      raw.state?.money_return_state_name,
      raw.state?.moneyReturnStateName,
      normalizeOzonMoneyReturnedState(raw.state)?.value,
      derivedRefund.status
    )
  );
  const refundTime = normalizeText(
    firstFilled(row.refund_time, raw.refundTime, raw.refund_time, refundEvidence?.time, derivedRefund.time)
  );
  const status = firstReturnStatusText(row.status, raw.status, raw.state, raw.return_status);
  const statusLabel = getOzonReturnStatusLabel(raw) || getOzonReturnStatusLabel({ status });
  const reasonRaw =
    extractReturnReason(raw) || normalizeText(row.return_reason) || normalizeReasonText(raw.reason) || '';
  const reasonZh = normalizeText(row.return_reason_zh);
  const officialReasonLabel = getOzonReturnReasonLabel(raw);
  const needsTranslation = containsCyrillicText(reasonRaw) && !reasonZh && !officialReasonLabel;
  const translationStatus = officialReasonLabel
    ? 'not_required'
    : normalizeText(row.return_reason_translation_status) ||
      (needsTranslation ? 'pending' : 'not_required');
  const reason =
    officialReasonLabel ||
    reasonZh ||
    (needsTranslation
      ? translationStatus === 'failed'
        ? RETURN_REASON_TRANSLATION_FAILED_LABEL
        : RETURN_REASON_TRANSLATION_PENDING_LABEL
      : normalizeText(row.return_reason) || reasonRaw || null);
  const state = raw.state && typeof raw.state === 'object'
    ? raw.state
    : firstReturnStatusText(row.status, raw.state, raw.status);
  return {
    ...raw,
    id: publicReturnId,
    localId: row.id,
    shopId: row.shop_id,
    returnKey: row.return_key,
    return_id: publicReturnId,
    returnId: publicReturnId,
    posting_number: row.posting_number || raw.posting_number || raw.posting?.posting_number || null,
    postingNumber: row.posting_number || raw.postingNumber || null,
    order_id: row.order_id || raw.order_id || null,
    orderId: row.order_id || raw.orderId || null,
    source: row.source || raw.source || null,
    status: status || null,
    statusLabel: statusLabel || null,
    state: state || null,
    substatus: row.substatus || raw.substatus || null,
    reason,
    return_reason: reason,
    reasonRaw: reasonRaw || null,
    reason_raw: reasonRaw || null,
    return_reason_raw: reasonRaw || null,
    reasonZh: reasonZh || officialReasonLabel || (!containsCyrillicText(reasonRaw) ? reasonRaw || null : null),
    reason_zh: reasonZh || officialReasonLabel || (!containsCyrillicText(reasonRaw) ? reasonRaw || null : null),
    return_reason_zh: reasonZh || officialReasonLabel || (!containsCyrillicText(reasonRaw) ? reasonRaw || null : null),
    reasonTranslationStatus: translationStatus,
    reason_translation_status: translationStatus,
    reasonTranslationProvider: row.return_reason_translation_provider || null,
    reason_translation_provider: row.return_reason_translation_provider || null,
    decision: row.decision || raw.decision || null,
    created_at: row.created_at_remote || raw.created_at || null,
    createdAt: row.created_at_remote || raw.createdAt || null,
    updated_at: row.updated_at_remote || raw.updated_at || null,
    product,
    products: Array.isArray(product) ? product : product ? [product] : raw.products,
    financial_data: finance,
    refund_status: refundStatus || null,
    refundStatus: refundStatus || null,
    refund_time: refundTime || null,
    refundTime: refundTime || null,
    refundEvidence,
    refund:
      isPlainObject(raw.refund) || refundStatus || refundTime || refundEvidence
        ? {
            ...(isPlainObject(raw.refund) ? raw.refund : {}),
            status: refundStatus || raw.refund?.status || null,
            time: refundTime || raw.refund?.time || null,
            evidence: refundEvidence,
          }
        : raw.refund,
    raw,
    isStale: Boolean(row.is_stale),
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

function normalizePageSize(value, fallback = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), 1000);
}

function splitIds(value) {
  if (Array.isArray(value)) return value.map(normalizeId).filter(Boolean);
  return normalizeText(value).split(',').map((item) => item.trim()).filter(Boolean);
}

export function createReturnRepository(db) {
  function upsertReturns({ shopId, rows = [], source = 'returns' } = {}) {
    const normalizedShopId = normalizeId(shopId);
    if (!normalizedShopId) throw new Error('shopId is required for returns merge.');
    const timestamp = nowIso();
    const selectExisting = db.prepare('SELECT * FROM ozon_returns WHERE shop_id = ? AND return_key = ?');
    const insertOrUpdate = db.prepare(`
      INSERT INTO ozon_returns (
        id, shop_id, return_key, return_id, posting_number, order_id, source, status, substatus,
        return_reason, decision, created_at_remote, updated_at_remote, product_json, finance_json,
        refund_status, refund_time, refund_json, raw_json, remote_hash, return_reason_translation_status,
        is_stale, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(shop_id, return_key) DO UPDATE SET
        return_id = COALESCE(excluded.return_id, ozon_returns.return_id),
        posting_number = COALESCE(excluded.posting_number, ozon_returns.posting_number),
        order_id = COALESCE(excluded.order_id, ozon_returns.order_id),
        source = COALESCE(excluded.source, ozon_returns.source),
        status = COALESCE(excluded.status, ozon_returns.status),
        substatus = COALESCE(excluded.substatus, ozon_returns.substatus),
        return_reason_zh = CASE
          WHEN COALESCE(excluded.return_reason, '') = COALESCE(ozon_returns.return_reason, '')
            THEN ozon_returns.return_reason_zh
          ELSE NULL
        END,
        return_reason_translation_status = CASE
          WHEN COALESCE(excluded.return_reason, '') = COALESCE(ozon_returns.return_reason, '')
            THEN ozon_returns.return_reason_translation_status
          ELSE excluded.return_reason_translation_status
        END,
        return_reason_translation_provider = CASE
          WHEN COALESCE(excluded.return_reason, '') = COALESCE(ozon_returns.return_reason, '')
            THEN ozon_returns.return_reason_translation_provider
          ELSE NULL
        END,
        return_reason_translation_updated_at = CASE
          WHEN COALESCE(excluded.return_reason, '') = COALESCE(ozon_returns.return_reason, '')
            THEN ozon_returns.return_reason_translation_updated_at
          ELSE NULL
        END,
        return_reason = COALESCE(excluded.return_reason, ozon_returns.return_reason),
        decision = COALESCE(excluded.decision, ozon_returns.decision),
        created_at_remote = COALESCE(excluded.created_at_remote, ozon_returns.created_at_remote),
        updated_at_remote = COALESCE(excluded.updated_at_remote, ozon_returns.updated_at_remote),
        product_json = COALESCE(excluded.product_json, ozon_returns.product_json),
        finance_json = COALESCE(excluded.finance_json, ozon_returns.finance_json),
        refund_status = COALESCE(excluded.refund_status, ozon_returns.refund_status),
        refund_time = COALESCE(excluded.refund_time, ozon_returns.refund_time),
        refund_json = COALESCE(excluded.refund_json, ozon_returns.refund_json),
        raw_json = COALESCE(excluded.raw_json, ozon_returns.raw_json),
        remote_hash = excluded.remote_hash,
        is_stale = 0,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `);
    const touchUnchanged = db.prepare(`
      UPDATE ozon_returns SET last_seen_at = ?, is_stale = 0, updated_at = ?
      WHERE shop_id = ? AND return_key = ?
    `);
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let missing = 0;
    const changes = [];
    for (const sourceRow of rows) {
      const row = normalizeReturn(sourceRow, { shopId: normalizedShopId, source });
      if (!row.returnKey) {
        missing += 1;
        continue;
      }
      const existing = selectExisting.get(normalizedShopId, row.returnKey);
      if (existing?.remote_hash === row.remoteHash) {
        touchUnchanged.run(timestamp, timestamp, normalizedShopId, row.returnKey);
        unchanged += 1;
        continue;
      }
      insertOrUpdate.run(
        row.id,
        normalizedShopId,
        row.returnKey,
        row.returnId || null,
        row.postingNumber || null,
        row.orderId || null,
        row.source,
        row.status || null,
        row.substatus || null,
        row.reason || null,
        row.decision || null,
        row.createdAtRemote || null,
        row.updatedAtRemote || null,
        compactJson(row.product),
        compactJson(row.finance),
        row.refundStatus || null,
        row.refundTime || null,
        compactJson(row.refundEvidence),
        compactJson(row.raw),
        row.remoteHash,
        containsCyrillicText(row.reason) ? 'pending' : 'not_required',
        timestamp,
        timestamp,
        timestamp,
      );
      changes.push({
        changeType: existing ? 'updated' : 'inserted',
        before: existing ? toPublicReturn(existing) : null,
        after: {
          id: row.returnId || row.postingNumber || row.orderId || row.returnKey,
          localId: row.id,
          shopId: normalizedShopId,
          returnKey: row.returnKey,
          return_id: row.returnId || null,
          returnId: row.returnId || null,
          posting_number: row.postingNumber || null,
          postingNumber: row.postingNumber || null,
          order_id: row.orderId || null,
          orderId: row.orderId || null,
          source: row.source || null,
          status: row.status || null,
          state: row.raw?.state ?? row.status ?? null,
          substatus: row.substatus || null,
          reason: row.reason || null,
          return_reason: row.reason || null,
          decision: row.decision || null,
          refund_status: row.refundStatus || null,
          refundStatus: row.refundStatus || null,
          refund_time: row.refundTime || null,
          refundTime: row.refundTime || null,
          refundEvidence: row.refundEvidence || null,
          raw: row.raw,
        },
      });
      if (existing) updated += 1;
      else inserted += 1;
    }
    return {
      ok: true,
      inserted,
      updated,
      unchanged,
      missing,
      changed: inserted + updated,
      rows: rows.length,
      changes,
      updatedAt: timestamp,
    };
  }

  function listReturns(query = {}) {
    const pageSize = normalizePageSize(query.pageSize ?? query.limit, 100);
    const page = Math.max(Number(query.page) || 1, 1);
    const offset = Math.max(Number(query.offset) || (page - 1) * pageSize, 0);
    const returnIds = splitIds(query.returnIds ?? query.return_id ?? query.returnId);
    const postingNumbers = splitIds(query.postingNumbers ?? query.posting_number ?? query.postingNumber);
    const status = normalizeText(query.status);
    const sourceRaw = query.source ?? query.scope ?? '';
    const source = normalizeText(sourceRaw) ? normalizeSource(sourceRaw) : '';
    const keyword = normalizeText(query.keyword ?? query.q);
    const since = normalizeText(query.since ?? query.from ?? query.dateFrom ?? query.created_since);
    const to = normalizeText(query.to ?? query.dateTo ?? query.created_to);
    const where = ['is_stale = 0'];
    const params = [];
    appendShopQueryFilter(query, where, params);
    if (returnIds.length) {
      where.push(`return_id IN (${returnIds.map(() => '?').join(',')})`);
      params.push(...returnIds);
    }
    if (postingNumbers.length) {
      where.push(`posting_number IN (${postingNumbers.map(() => '?').join(',')})`);
      params.push(...postingNumbers);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (source) {
      where.push('source = ?');
      params.push(source);
    }
    if (since) {
      where.push('(created_at_remote IS NULL OR created_at_remote >= ?)');
      params.push(since);
    }
    if (to) {
      where.push('(created_at_remote IS NULL OR created_at_remote <= ?)');
      params.push(to);
    }
    if (keyword) {
      where.push('(return_id LIKE ? OR posting_number LIKE ? OR order_id LIKE ? OR status LIKE ? OR return_reason LIKE ?)');
      const like = `%${keyword}%`;
      params.push(like, like, like, like, like);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM ozon_returns ${clause}`).get(...params);
    const rows = db.prepare(`
      SELECT * FROM ozon_returns
      ${clause}
      ORDER BY COALESCE(created_at_remote, updated_at) DESC, return_id ASC, posting_number ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    return {
      ok: true,
      domain: 'returns',
      source: 'sqlite',
      rows: rows.map(toPublicReturn),
      page,
      pageSize,
      offset,
      total: Number(totalRow?.total) || 0,
      durationMs: 0,
    };
  }

  function saveReasonTranslation({ shopId, sourceText, translatedText, provider = 'unknown' } = {}) {
    const normalizedShopId = normalizeId(shopId);
    const source = normalizeText(sourceText);
    const translated = normalizeText(translatedText);
    if (!normalizedShopId || !source || !containsCyrillicText(source) || !translated || containsCyrillicText(translated)) {
      return { ok: false, changed: 0 };
    }
    const timestamp = nowIso();
    const result = db.prepare(`
      UPDATE ozon_returns
      SET return_reason_zh = ?,
          return_reason_translation_status = 'translated',
          return_reason_translation_provider = ?,
          return_reason_translation_updated_at = ?,
          updated_at = ?
      WHERE shop_id = ? AND return_reason = ?
    `).run(translated, normalizeText(provider) || 'unknown', timestamp, timestamp, normalizedShopId, source);
    return { ok: true, changed: Number(result.changes) || 0 };
  }

  function markReasonTranslationFailed({ shopId, sourceText, provider = 'unavailable' } = {}) {
    const normalizedShopId = normalizeId(shopId);
    const source = normalizeText(sourceText);
    if (!normalizedShopId || !source || !containsCyrillicText(source)) return { ok: false, changed: 0 };
    const timestamp = nowIso();
    const result = db.prepare(`
      UPDATE ozon_returns
      SET return_reason_translation_status = 'failed',
          return_reason_translation_provider = ?,
          return_reason_translation_updated_at = ?,
          updated_at = ?
      WHERE shop_id = ? AND return_reason = ? AND return_reason_zh IS NULL
    `).run(normalizeText(provider) || 'unavailable', timestamp, timestamp, normalizedShopId, source);
    return { ok: true, changed: Number(result.changes) || 0 };
  }

  return { upsertReturns, listReturns, saveReasonTranslation, markReasonTranslationFailed };
}
