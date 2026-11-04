import { getRubCnyRateForDate } from './exchangeRateClient.js';

const PLACEHOLDER_VALUES = new Set([
  '',
  '未返回',
  '待确认',
  '读取失败',
  '未读取',
  '读取中',
  'null',
  'undefined',
  'nan',
]);

function normalizeText(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstFilled(...values) {
  for (const value of values) {
    if (value === 0 || value === false) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = normalizeText(value);
    if (text && !PLACEHOLDER_VALUES.has(text) && !PLACEHOLDER_VALUES.has(text.toLowerCase())) return value;
  }
  return '';
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export function normalizeOrderExchangeDateKey(value = '') {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const text = normalizeText(value);
  if (!text || PLACEHOLDER_VALUES.has(text) || PLACEHOLDER_VALUES.has(text.toLowerCase())) return '';
  const normalizedPrefix = text.replace(/\//gu, '-').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(normalizedPrefix)) return normalizedPrefix;

  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) return '';
  return normalizeOrderExchangeDateKey(parsed);
}

export function normalizeOrderExchangeRatePayload(payload = null, options = {}) {
  const source = isPlainObject(payload) ? payload : {};
  const rubToCnyRate = firstFiniteNumber(source.rubToCnyRate, source.rate, payload);
  if (rubToCnyRate === null || rubToCnyRate <= 0) return null;
  const role = normalizeText(options.role || source.role);
  const requestedDate = normalizeOrderExchangeDateKey(
    firstFilled(source.requestedDate, options.requestedDate, options.date)
  );
  const date = normalizeOrderExchangeDateKey(firstFilled(source.date, source.providerDate, requestedDate));
  return {
    ...(role ? { role } : {}),
    mode: normalizeText(source.mode || options.mode || 'unknown') || 'unknown',
    date,
    requestedDate,
    nearestFallback: Boolean(source.nearestFallback),
    lookbackDaysUsed:
      source.lookbackDaysUsed === null || source.lookbackDaysUsed === undefined
        ? null
        : Number.isFinite(Number(source.lookbackDaysUsed))
          ? Number(source.lookbackDaysUsed)
          : null,
    base: normalizeText(source.base || 'RUB') || 'RUB',
    quote: normalizeText(source.quote || 'CNY') || 'CNY',
    rubToCnyRate,
    source: normalizeText(source.source),
    fetchedAt: normalizeText(source.fetchedAt),
  };
}

export function normalizeOrderExchangeRatesBundle(value = {}) {
  const bundle = isPlainObject(value) ? value : {};
  return {
    estimated: normalizeOrderExchangeRatePayload(bundle.estimated, { role: 'estimated' }),
    actual: normalizeOrderExchangeRatePayload(bundle.actual, { role: 'actual' }),
  };
}

function getOrderSourceOrder(order = {}) {
  return isPlainObject(order.sourceOrder) ? order.sourceOrder : {};
}

function getProfitLedger(order = {}) {
  return isPlainObject(order.profitLedger) ? order.profitLedger : {};
}

export function getOrderEstimatedExchangeDateKey(order = {}) {
  const sourceOrder = getOrderSourceOrder(order);
  return normalizeOrderExchangeDateKey(
    firstFilled(
      order.estimatedExchangeRateDate,
      order.estimatedExchangeDate,
      order.paymentDate,
      order.paymentTime,
      order.paidAt,
      order.capturedAt,
      sourceOrder.paymentDate,
      sourceOrder.paymentTime,
      sourceOrder.paidAt,
      sourceOrder.capturedAt,
      order.raw?.paid_at,
      order.raw?.payment_date,
      order.raw?.paymentDate,
      order.raw?.in_process_at,
      order.raw?.created_at,
      order.raw?.createdAt,
      sourceOrder.raw?.paid_at,
      sourceOrder.raw?.payment_date,
      sourceOrder.raw?.paymentDate,
      sourceOrder.raw?.in_process_at,
      sourceOrder.raw?.created_at,
      sourceOrder.raw?.createdAt
    )
  );
}

export function getFinanceOperationExchangeDateKey(operation = {}) {
  return normalizeOrderExchangeDateKey(
    firstFilled(
      operation.operation_date,
      operation.operationDate,
      operation.created_at,
      operation.createdAt,
      operation.date,
      operation.raw?.operation_date,
      operation.raw?.operationDate,
      operation.raw?.created_at,
      operation.raw?.createdAt,
      operation.raw?.date
    )
  );
}

export function getLatestFinanceOperationExchangeDateKey(operations = []) {
  const dateKeys = (Array.isArray(operations) ? operations : [])
    .map(getFinanceOperationExchangeDateKey)
    .filter(Boolean)
    .sort();
  return dateKeys.length ? dateKeys[dateKeys.length - 1] : '';
}

export function getOrderActualExchangeDateKey(order = {}, options = {}) {
  const sourceOrder = getOrderSourceOrder(order);
  const ledger = getProfitLedger(order);
  return normalizeOrderExchangeDateKey(
    firstFilled(
      options.actualDateKey,
      getLatestFinanceOperationExchangeDateKey(options.financeOperations),
      order.actualExchangeRateDate,
      order.actualExchangeDate,
      order.exchangeRates?.actual?.requestedDate,
      order.exchangeRates?.actual?.date,
      order.actualExchangeRate?.requestedDate,
      order.actualExchangeRate?.date,
      ledger.exchangeRates?.actual?.requestedDate,
      ledger.exchangeRates?.actual?.date,
      ledger.actualExchangeRate?.requestedDate,
      ledger.actualExchangeRate?.date,
      sourceOrder.actualExchangeRateDate,
      sourceOrder.actualExchangeDate,
      sourceOrder.exchangeRates?.actual?.requestedDate,
      sourceOrder.exchangeRates?.actual?.date,
      sourceOrder.actualExchangeRate?.requestedDate,
      sourceOrder.actualExchangeRate?.date
    )
  );
}

function getCachedExchangeRateByRole(order = {}, role = 'estimated') {
  const sourceOrder = getOrderSourceOrder(order);
  const ledger = getProfitLedger(order);
  const roleKey = `${role}ExchangeRate`;
  const roleDateKey = `${role}ExchangeRateDate`;
  const requestedDate = normalizeOrderExchangeDateKey(firstFilled(order[roleDateKey], sourceOrder[roleDateKey]));
  return normalizeOrderExchangeRatePayload(
    firstFilled(
      order.exchangeRates?.[role],
      order[roleKey],
      ledger.exchangeRates?.[role],
      ledger[roleKey],
      sourceOrder.exchangeRates?.[role],
      sourceOrder[roleKey]
    ),
    { role, requestedDate }
  );
}

export function getCachedEstimatedExchangeRate(order = {}) {
  const sourceOrder = getOrderSourceOrder(order);
  const ledger = getProfitLedger(order);
  return (
    getCachedExchangeRateByRole(order, 'estimated') ||
    normalizeOrderExchangeRatePayload(
      firstFilled(
        order.exchangeRate,
        ledger.exchangeRate,
        sourceOrder.exchangeRate,
        order.rubToCnyRate,
        sourceOrder.rubToCnyRate
      ),
      {
        role: 'estimated',
        requestedDate: getOrderEstimatedExchangeDateKey(order),
      }
    )
  );
}

export function getCachedActualExchangeRate(order = {}) {
  return getCachedExchangeRateByRole(order, 'actual');
}

export function getOrderEstimatedExchangeRate(order = {}, exchangeRateContext = {}) {
  const cached = getCachedEstimatedExchangeRate(order);
  if (cached) return cached;
  const dateKey = getOrderEstimatedExchangeDateKey(order);
  return normalizeOrderExchangeRatePayload(getRubCnyRateForDate(dateKey, exchangeRateContext), {
    role: 'estimated',
    requestedDate: dateKey,
  });
}

export function getOrderActualExchangeRate(order = {}, exchangeRateContext = {}, options = {}) {
  const financeDateKey = getLatestFinanceOperationExchangeDateKey(options.financeOperations);
  if (financeDateKey) {
    const financeRate = normalizeOrderExchangeRatePayload(getRubCnyRateForDate(financeDateKey, exchangeRateContext), {
      role: 'actual',
      requestedDate: financeDateKey,
    });
    if (financeRate) return financeRate;
  }
  const cached = getCachedActualExchangeRate(order);
  if (cached) return cached;
  const dateKey = getOrderActualExchangeDateKey(order, options);
  if (!dateKey) return null;
  return normalizeOrderExchangeRatePayload(getRubCnyRateForDate(dateKey, exchangeRateContext), {
    role: 'actual',
    requestedDate: dateKey,
  });
}

export function getOrderDisplayExchangeRate(order = {}, exchangeRateContext = {}) {
  return (
    getOrderEstimatedExchangeRate(order, exchangeRateContext) || getOrderActualExchangeRate(order, exchangeRateContext)
  );
}

export function buildOrderExchangeRateBundle(order = {}, exchangeRateContext = {}, options = {}) {
  return {
    estimated: getOrderEstimatedExchangeRate(order, exchangeRateContext),
    actual:
      options.includeActual === false
        ? getCachedActualExchangeRate(order)
        : getOrderActualExchangeRate(order, exchangeRateContext, options),
  };
}

export function getOrderRubToCnyRateForMode(order = {}, exchangeRateContext = {}, options = {}) {
  const mode = normalizeText(options.mode || 'display');
  if (mode === 'actual') return getOrderActualExchangeRate(order, exchangeRateContext, options)?.rubToCnyRate ?? null;
  if (mode === 'estimated') return getOrderEstimatedExchangeRate(order, exchangeRateContext)?.rubToCnyRate ?? null;
  return getOrderDisplayExchangeRate(order, exchangeRateContext)?.rubToCnyRate ?? null;
}

export function getOrderExchangeRateDateKeys(rows = [], options = {}) {
  const financeOperations = Array.isArray(options.financeOperations) ? options.financeOperations : [];
  return [
    ...new Set(
      [
        ...(Array.isArray(rows) ? rows : []).map(getOrderEstimatedExchangeDateKey),
        ...financeOperations.map(getFinanceOperationExchangeDateKey),
      ].filter(Boolean)
    ),
  ];
}
