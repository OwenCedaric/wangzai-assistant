const MISSING_ORDER_TIME = 0;
const NOT_RETURNED_TEXT = new Set(['', '未返回', '待确认', 'null', 'undefined', 'nan']);
const orderIdCollator = new Intl.Collator('en', { numeric: true });

function normalizeText(value) {
  return String(value ?? '').trim();
}

function firstFilled(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text && text !== '未返回') return value;
  }
  return '';
}

export function parseOrderTimeMs(value, options = {}) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : MISSING_ORDER_TIME;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const text = normalizeText(value);
  if (!text || NOT_RETURNED_TEXT.has(text.toLowerCase())) return MISSING_ORDER_TIME;

  const shortDateTime = text.match(/^(\d{1,2})[-/.月](\d{1,2})日?\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/u);
  if (shortDateTime) {
    const [, month, day, hour, minute, second = '0'] = shortDateTime;
    const fallbackYear = Number(options.fallbackYear) || new Date().getFullYear();
    const time = new Date(
      fallbackYear,
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ).getTime();
    return Number.isFinite(time) ? time : MISSING_ORDER_TIME;
  }

  const nativeTime = Date.parse(text);
  if (Number.isFinite(nativeTime)) return nativeTime;

  const fullDateTime = text.match(
    /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/u
  );
  if (fullDateTime) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = fullDateTime;
    const time = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ).getTime();
    return Number.isFinite(time) ? time : MISSING_ORDER_TIME;
  }

  return MISSING_ORDER_TIME;
}

function normalizeOrderId(value) {
  return normalizeText(value).toUpperCase();
}

function getOrderStableSortKey(row = {}) {
  const raw = row.raw ?? {};
  const posting = normalizeOrderId(
    firstFilled(
      row.posting,
      row.id,
      row.salesOrder,
      row.ozonOrderId,
      row.postingNumber,
      row.posting_number,
      raw.posting_number,
      raw.postingNumber,
      raw.order_number,
      raw.order_id
    )
  );
  const match = posting.match(/^(.*?)-(\d+)$/u);
  return {
    base: match ? match[1] : posting,
    suffix: match ? Number(match[2]) : Number.MAX_SAFE_INTEGER,
    posting,
  };
}

function sortRowsByTimeDesc(rows = [], getTimeMs) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, index, time: getTimeMs(row), key: null }))
    .sort((leftEntry, rightEntry) => {
      const leftTime = leftEntry.time;
      const rightTime = rightEntry.time;
      if (leftTime !== rightTime) return rightTime - leftTime;
      if (!leftTime && !rightTime) return leftEntry.index - rightEntry.index;

      const leftKey = leftEntry.key ??= getOrderStableSortKey(leftEntry.row);
      const rightKey = rightEntry.key ??= getOrderStableSortKey(rightEntry.row);
      const baseCompare = orderIdCollator.compare(leftKey.base, rightKey.base);
      if (baseCompare !== 0) return baseCompare;
      if (leftKey.suffix !== rightKey.suffix) return leftKey.suffix - rightKey.suffix;
      return orderIdCollator.compare(leftKey.posting, rightKey.posting);
    })
    .map((entry) => entry.row);
}

export function getOrderPaymentTimeMs(row = {}) {
  const raw = row.raw ?? {};
  const sourceOrder = row.sourceOrder ?? {};
  return parseOrderTimeMs(
    firstFilled(
      row.paymentDate,
      row.paymentTime,
      row.paidAt,
      row.paid_at,
      row.payment_date,
      row.inProcessAt,
      row.in_process_at,
      row.createdAt,
      row.created_at,
      raw.paid_at,
      raw.paidAt,
      raw.payment_date,
      raw.paymentDate,
      raw.financial_data?.payment_date,
      raw.financialData?.paymentDate,
      raw.in_process_at,
      raw.inProcessAt,
      raw.created_at,
      raw.createdAt,
      sourceOrder.paymentDate,
      sourceOrder.paymentTime,
      sourceOrder.paid_at,
      sourceOrder.paidAt,
      sourceOrder.in_process_at,
      sourceOrder.created_at
    )
  );
}

export function sortOrderRowsByNewestPaymentTime(rows = []) {
  return sortRowsByTimeDesc(rows, getOrderPaymentTimeMs);
}

export function getAfterSalesOrderActivityTimeMs(row = {}) {
  const raw = row.raw ?? {};
  const cancellation = raw.cancellation ?? row.cancellation ?? {};
  const refund = raw.refund ?? row.refund ?? {};
  return parseOrderTimeMs(
    firstFilled(
      row.refundTime,
      row.refund_time,
      row.refundedAt,
      row.refunded_at,
      row.updatedAt,
      row.updated_at,
      row.updated,
      row.returnDate,
      row.return_date,
      row.requestedAt,
      row.requested_at,
      row.createdAt,
      row.created_at,
      raw.refundTime,
      raw.refund_time,
      raw.refundedAt,
      raw.refunded_at,
      refund.time,
      refund.refundTime,
      refund.refund_time,
      refund.refundedAt,
      refund.refunded_at,
      refund.created_at,
      refund.processed_at,
      refund.completed_at,
      cancellation.cancelled_at,
      cancellation.canceled_at,
      cancellation.cancel_date,
      cancellation.cancellation_date,
      raw.updated_at,
      raw.updatedAt,
      raw.created_at,
      raw.createdAt,
      raw.requested_at,
      raw.return_date,
      raw.date
    )
  );
}

export function sortAfterSalesRowsByNewestActivityTime(rows = []) {
  return sortRowsByTimeDesc(rows, getAfterSalesOrderActivityTimeMs);
}
