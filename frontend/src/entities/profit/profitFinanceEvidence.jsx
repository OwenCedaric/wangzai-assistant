import { getProfitPostingBaseKey, getProfitPostingLookupKeys } from './profitPostingRules.jsx';
import { getCrossBorderFixedFeeValue } from './profitFeeRules.jsx';
import { isPartialCompensationSale } from '../../services/profitPartialCompensation.js';
import {
  annotatePurchaseOrder,
  applyPurchaseManualFallbacks,
  createPurchaseOrderLocalOverrideUpsert,
  getCanonicalPurchaseOrderOverrideKey,
  hasConfirmedCrossBorderOrder,
  hasConfirmedPurchasePlacement,
  normalizeOzonSalesRowToPurchaseOrder,
  readPurchaseOrderLocalOverrides,
  writePurchaseOrderLocalOverrideUpsert,
} from '../../services/purchaseOrderRuntime.js';
import { firstCommissionRate } from './profitCommissionRules.jsx';
import {
  getLogisticsFreightForPurchaseOrder,
  getOrderCardLogisticsFeeValue,
} from '../../services/purchaseLogisticsRuntime.js';
import { profitModeOptions } from './profitModeRules.jsx';
import { applyProfitProductMaterialFallbackToOrder } from './profitProductMaterialFallbackRules';
import { getSalesOrderPaymentDateKey } from '../order/orderDateRules.jsx';
import {
  calculateAcquiringFeeCny,
  calculateCommissionFeeCny,
  convertFeeAmountToCny,
  ORDER_CARD_ACQUIRING_RATE,
} from '../../services/feeCalculationService';
import { applyProductMaterialProfiles } from '../../services/productMaterialProfileStore';
import { getFinancePostingLookupGroups } from '../../services/profitFinanceMatching';
import { resolveProfitPurchaseCost } from '../../services/profitLedgerService';
import {
  doesProfitOrderMatchTab as doesProfitOrderMatchTabByResult,
  getProfitOrderActualValue as getProfitOrderActualValueByResult,
  getProfitOrderBestValue as getProfitOrderBestValueByResult,
  getProfitOrderEstimatedValue as getProfitOrderEstimatedValueByResult,
  getProfitOrderModeValue as getProfitOrderModeValueByResult,
  getProfitOrderProfitLossInfo as getProfitOrderProfitLossInfoByResult,
  getProfitOrderProfitLossValue as getProfitOrderProfitLossValueByResult,
  getProfitTabCount as getProfitTabCountByResult,
} from '../../services/profitOrderView';
import {
  OZON_AFTER_SALES_DEFAULT_RANGE_DAYS,
  OZON_FINANCE_CHUNK_DAYS,
  PROFIT_AFTER_SALES_CACHE_TTL_MS,
  PROFIT_FINANCE_CACHE_TTL_MS,
  PROFIT_FINANCE_CACHE_VERSION,
  PROFIT_FINANCE_ROW_LOOKAHEAD_DAYS,
  PROFIT_FINANCE_ROW_LOOKBACK_DAYS,
} from '../../shared/config/appConfigCore.jsx';
import { requestOzonReadOnly } from '../../shared/ozon/ozonRuntime.jsx';
import { createOzonTimeRangeScope, getExplicitOzonTimeRange, getOzonOrderDateRange } from '../order/orderShopScope.jsx';
import { firstFilled, firstUsableOzonId, getOzonShopClientId, normalizeOzonId } from '../order/orderIdentityRules.jsx';
import { getOzonOrderProducts } from '../order/orderDisplayFormat.jsx';
import { getOzonOrderProductSalesAmount } from '../order/orderProductAmountRules.jsx';
import { formatOzonPrice } from '../product/productPriceRules.jsx';
import {
  firstFiniteNumber,
  getOzonAcquiringFee,
  getOzonRealFbsCommissionPercent,
  toFiniteNumber,
} from '../product/productAttributes.jsx';
import { getProfitActualStatusText, isProfitFinalZeroAllowedStatus } from './profitStatusRules.jsx';
import { getProfitPurchaseOrderOverride, getProfitPurchaseOrderOverrideKeys } from './profitPurchaseOverrideRules.jsx';
import { getAfterSalesItemLookupKeys } from '../order/afterSalesLookupRules.jsx';
import { requestOzonAfterSalesSnapshot } from './profitAfterSalesSnapshot.jsx';
import { createOwnerCacheReadFence } from '../../services/ownerCacheReadFence.js';

export function getProfitProductPriceInfo(product = {}, priceInfoMap = new Map()) {
  const keys = [
    product.raw?.product_id,
    product.raw?.productId,
    product.productId,
    product.offerId,
    product.raw?.offer_id,
    product.raw?.offerId,
    product.skuId,
    product.raw?.sku,
    product.sku,
  ];
  return keys.map((key) => priceInfoMap.get(normalizeOzonId(key).trim())).find(Boolean) ?? null;
}

export function getProfitCurrencyCode(order = {}, priceInfo = null) {
  return (
    priceInfo?.price?.currency_code ??
    priceInfo?.currency_code ??
    order.products?.find((product) => product.currencyCode)?.currencyCode ??
    order.products?.find((product) => product.currency_code)?.currency_code ??
    order.products?.find((product) => product.raw?.currencyCode)?.raw?.currencyCode ??
    order.products?.find((product) => product.raw?.currency_code)?.raw?.currency_code ??
    order.raw?.currency_code ??
    order.raw?.currency ??
    'RUB'
  );
}

export function normalizeProfitCurrencyCode(currencyCode) {
  const code = String(currencyCode || '')
    .trim()
    .toUpperCase();
  if (code === '¥' || code === '￥' || code === 'RMB') return 'CNY';
  if (code === 'RUR') return 'RUB';
  return code || 'RUB';
}

export function getProfitSalesCurrencyCode(order = {}) {
  return normalizeProfitCurrencyCode(
    order.currencyCode ||
      order.products?.find((product) => product.currencyCode)?.currencyCode ||
      order.products?.find((product) => product.currency_code)?.currency_code ||
      order.products?.find((product) => product.raw?.currencyCode)?.raw?.currencyCode ||
      order.products?.find((product) => product.raw?.currency_code)?.raw?.currency_code ||
      order.raw?.currency_code ||
      order.raw?.currency ||
      'RUB'
  );
}

export function getProfitDisplayMoney(value, currencyCode = 'RUB', fallback = '待确认') {
  const number = toFiniteNumber(value);
  if (number === null) return fallback;
  if (currencyCode === 'CNY') return `￥${number.toFixed(2)}`;
  return formatOzonPrice(number, currencyCode);
}

export function convertOzonRubToCny(value, options = {}) {
  return convertFeeAmountToCny(value, 'RUB', { rubToCnyRate: options.rubToCnyRate });
}

export function convertProfitAmountToCny(value, currencyCode = 'RUB', options = {}) {
  return convertFeeAmountToCny(value, normalizeProfitCurrencyCode(currencyCode), {
    rubToCnyRate: options.rubToCnyRate,
  });
}

export function getProfitDisplayCny(value, fallback = '待确认') {
  return getProfitDisplayMoney(value, 'CNY', fallback);
}

export function getSignedProfitDisplay(value, currencyCode = 'RUB', fallback = '待确认') {
  const number = toFiniteNumber(value);
  if (number === null) return fallback;
  const amount = getProfitDisplayMoney(Math.abs(number), currencyCode, fallback);
  if (number > 0) return `+${amount}`;
  if (number < 0) return `-${amount}`;
  return amount;
}

export function getProfitResultStatusLabel(value) {
  const number = toFiniteNumber(value);
  if (number === null) return '待确认';
  if (number > 0) return '盈利订单';
  if (number < 0) return '亏损订单';
  return '零利润订单';
}

export function getProfitProductEstimatedFees(product = {}, priceInfo = null, options = {}) {
  const currencyCode = getProfitCurrencyCode({ products: [product] }, priceInfo);
  const salesAmountValue = getOzonOrderProductSalesAmount(product);
  const priceInfoCommissionPercent = getOzonRealFbsCommissionPercent(priceInfo);
  const commissionPercent =
    priceInfoCommissionPercent ??
    firstCommissionRate(product.commissionPercent, product.raw?.commission_percent, product.raw?.commissionPercent);
  const productSalesAmountCny = convertProfitAmountToCny(salesAmountValue, currencyCode, options);
  const commissionValue = calculateCommissionFeeCny({
    orderAmountCny: productSalesAmountCny,
    commissionPercent,
    rubToCnyRate: options.rubToCnyRate,
  });
  const priceInfoAcquiringValue = getOzonAcquiringFee(priceInfo);
  const acquiringValue =
    priceInfoAcquiringValue === null
      ? calculateAcquiringFeeCny({
          orderPaymentCny: productSalesAmountCny,
          acquiringRate: ORDER_CARD_ACQUIRING_RATE,
          rubToCnyRate: options.rubToCnyRate,
        })
      : convertProfitAmountToCny(priceInfoAcquiringValue, currencyCode, options);

  return {
    currencyCode: 'CNY',
    commissionPercent,
    commissionValue,
    acquiringValue,
  };
}

export const PROFIT_MANUAL_OVERRIDE_FIELDS = {
  sourcePurchaseCostCny: {
    storageKey: 'manualProfitSourcePurchaseCostCny',
    updatedAtKey: 'manualProfitSourcePurchaseCostUpdatedAt',
  },
  logisticsFeeCny: {
    storageKey: 'manualProfitLogisticsFeeCny',
    updatedAtKey: 'manualProfitLogisticsFeeUpdatedAt',
  },
  crossBorderBusFeeCny: {
    storageKey: 'manualProfitCrossBorderBusFeeCny',
    updatedAtKey: 'manualProfitCrossBorderBusFeeUpdatedAt',
  },
};

export { getProfitPurchaseOrderOverride, getProfitPurchaseOrderOverrideKeys };

export function getProfitManualOverrideAmount(override = {}, fieldId = '') {
  const config = PROFIT_MANUAL_OVERRIDE_FIELDS[fieldId];
  if (!config) return null;
  const value = firstFiniteNumber(override?.[config.storageKey]);
  return value === null ? null : value;
}

export function getProfitManualOverrideTargetKey(order = {}) {
  const normalizedOrder = normalizeOzonSalesRowToPurchaseOrder(order);
  return getCanonicalPurchaseOrderOverrideKey(normalizedOrder);
}

export function upsertProfitManualOverrideAmount(order = {}, fieldId = '', amountValue = null, options = {}) {
  const config = PROFIT_MANUAL_OVERRIDE_FIELDS[fieldId];
  const number = firstFiniteNumber(amountValue);
  if (!config || number === null || number < 0) return null;
  const normalizedOrder = normalizeOzonSalesRowToPurchaseOrder(order);
  const currentOverrides = options.overrides ?? readPurchaseOrderLocalOverrides();
  const update = (existing) => ({
    ...existing,
    [config.storageKey]: number,
    [config.updatedAtKey]: new Date().toISOString(),
  });
  const result = options.persist === false
    ? createPurchaseOrderLocalOverrideUpsert(currentOverrides, normalizedOrder, options.shop, update)
    : writePurchaseOrderLocalOverrideUpsert(currentOverrides, normalizedOrder, options.shop, update);
  if (!result) return null;
  return {
    key: result.canonicalKey,
    overrides: result.override,
    allOverrides: result.overrides,
    persistence: result.persistence,
  };
}

export function buildProfitPurchaseOrderForLogistics(order = {}, context = {}) {
  const normalizedOrder = normalizeOzonSalesRowToPurchaseOrder(applyProfitProductMaterialFallbackToOrder(order));
  const override = getProfitPurchaseOrderOverride(normalizedOrder, context.purchaseLocalOverrides);
  const orderWithOverrides = applyPurchaseManualFallbacks({
    ...normalizedOrder,
    ...override,
  });
  const orderShop = context.shop ?? {
    id: orderWithOverrides.shopId || orderWithOverrides.shopClientId || orderWithOverrides.shop || 'default',
    clientId: orderWithOverrides.shopClientId || '',
  };
  const productsWithMaterial = Array.isArray(orderWithOverrides.products)
    ? applyProductMaterialProfiles(
        orderWithOverrides.products.map((product) => ({
          ...product,
          shopId: product.shopId || orderWithOverrides.shopId,
          shopClientId: product.shopClientId || orderWithOverrides.shopClientId,
          shop: product.shop || orderWithOverrides.shop,
        })),
        orderShop
      )
    : orderWithOverrides.products;

  return annotatePurchaseOrder({
    ...orderWithOverrides,
    products: productsWithMaterial,
  });
}

export function buildProfitPurchaseOrderWithLocalOverride(order = {}, context = {}) {
  const normalizedOrder = normalizeOzonSalesRowToPurchaseOrder(order);
  const override = getProfitPurchaseOrderOverride(normalizedOrder, context.purchaseLocalOverrides);
  return applyPurchaseManualFallbacks({
    ...normalizedOrder,
    ...override,
  });
}

export function getProfitLogisticsEstimateValueCny(order = {}, context = {}) {
  const crossBorderInfo = order.crossBorderInfo ?? {};
  const sourceOrder = order.sourceOrder ?? {};
  const override = getProfitPurchaseOrderOverride(
    normalizeOzonSalesRowToPurchaseOrder(order),
    context.purchaseLocalOverrides
  );
  const storedValue = firstFiniteNumber(
    order.freightCostValue,
    order.logisticsFreight?.amount,
    order.guooFreight?.amount,
    order.freightCost,
    order.shippingFeeValue,
    order.shippingFee,
    sourceOrder.freightCostValue,
    sourceOrder.logisticsFreight?.amount,
    sourceOrder.guooFreight?.amount,
    sourceOrder.freightCost,
    sourceOrder.shippingFeeValue,
    sourceOrder.shippingFee
  );
  if (storedValue !== null) return storedValue;

  const manualValue = getProfitManualOverrideAmount(override, 'logisticsFeeCny');
  if (manualValue !== null) return manualValue;

  const logisticsFreight = getLogisticsFreightForPurchaseOrder({
    ...order,
    packageWeight: firstFilled(crossBorderInfo.packageWeight, order.packageWeight),
    packageSize: firstFilled(crossBorderInfo.packageSize, order.packageSize),
    logistics: firstFilled(order.logistics, crossBorderInfo.deliveryMethod, crossBorderInfo.logistics),
  });
  if (logisticsFreight.ok && logisticsFreight.amount !== null) return logisticsFreight.amount;

  const purchaseOrder = buildProfitPurchaseOrderForLogistics(order, context);
  return getOrderCardLogisticsFeeValue(purchaseOrder);
}

export function sumNullable(values = []) {
  if (values.some((value) => value === null || value === undefined)) return null;
  return values.reduce((sum, value) => sum + (toFiniteNumber(value) ?? 0), 0);
}

export function getProfitOrderProductCost(order = {}, context = {}) {
  const resolved = resolveProfitPurchaseCost(order, {
    purchaseOverrides: context.purchaseLocalOverrides,
    sourceRecords: context.sourceRecords,
    amounts: context.amounts,
  }).value;
  if (resolved !== null) return resolved;
  const override = getProfitPurchaseOrderOverride(
    normalizeOzonSalesRowToPurchaseOrder(order),
    context.purchaseLocalOverrides
  );
  const manualValue = getProfitManualOverrideAmount(override, 'sourcePurchaseCostCny');
  if (manualValue !== null) return manualValue;
  const purchaseOrder = buildProfitPurchaseOrderWithLocalOverride(order, context);
  const statusText = getProfitActualStatusText(order, []);
  if (
    isProfitFinalZeroAllowedStatus(statusText) &&
    !isProfitRefusedRefundStatusText(statusText) &&
    !hasConfirmedPurchasePlacement(purchaseOrder) &&
    !hasConfirmedCrossBorderOrder(purchaseOrder)
  ) {
    return 0;
  }
  return null;
}

export { getCrossBorderFixedFeeValue };

function isActualFinanceCheckedForCrossBorderFee(context = {}) {
  const status = String(context.actualFinanceStatus || '')
    .trim()
    .toLowerCase();
  return (
    status === 'confirmed' ||
    status === 'provisional' ||
    context.hasActualFinance === true ||
    context.financeLookupChecked === true
  );
}

export function isProfitRefusedRefundStatusText(statusText = '') {
  return /拒收后退款|not_accepted|refus|reject/.test(String(statusText || '').toLowerCase());
}

export function getProfitEstimatedCrossBorderBusFeeValueCny(order = {}, context = {}) {
  const purchaseOrder = buildProfitPurchaseOrderWithLocalOverride(order, context);
  const override = getProfitPurchaseOrderOverride(purchaseOrder, context.purchaseLocalOverrides);
  const manualValue = getProfitManualOverrideAmount(override, 'crossBorderBusFeeCny');
  return manualValue ?? getCrossBorderFixedFeeValue();
}

export function getProfitActualCrossBorderBusFeeValueCny(order = {}, context = {}, afterSalesRows = []) {
  const purchaseOrder = buildProfitPurchaseOrderWithLocalOverride(order, context);
  const override = getProfitPurchaseOrderOverride(purchaseOrder, context.purchaseLocalOverrides);
  const actualLedgerValue = firstFiniteNumber(override.actualCrossBorderBusFeeCny);
  const actualSource = String(
    override.actualCrossBorderBusFeeSource || override.crossBorderChargeEvidence?.source || ''
  )
    .trim()
    .toLowerCase();
  const hasExactActualChargeEvidence = Boolean(
    actualSource === 'cross-border-bus-ledger-cash-converted' ||
      actualSource === 'cross-border-bus-ledger' ||
      actualSource === 'cross-border-charge-exact' ||
      actualSource === 'cross-border-recharge-cash-converted' ||
      /^cross-border-(?:bus-)?(?:charge|ledger)-(?:exact|cash-converted)(?:-|$)/.test(actualSource)
  );
  if (actualLedgerValue !== null && hasExactActualChargeEvidence) return actualLedgerValue;

  const statusText = getProfitActualStatusText(order, afterSalesRows);
  const finalZeroActualStatus = !isPartialCompensationSale(order)
    && (order.hasFinanceRefund === true || isProfitFinalZeroAllowedStatus(statusText));
  if (finalZeroActualStatus && isActualFinanceCheckedForCrossBorderFee(context)) {
    return 0;
  }
  return null;
}

export function getProfitCrossBorderBusFeeValueCny(order = {}, context = {}) {
  return getProfitEstimatedCrossBorderBusFeeValueCny(order, context);
}

export function getFinanceOperationItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.operations)) return data.operations;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.result)) return data.result;
  if (Array.isArray(data?.result?.operations)) return data.result.operations;
  if (Array.isArray(data?.result?.items)) return data.result.items;
  return [];
}

export function getFinancePageCount(data) {
  const value = firstFilled(data?.page_count, data?.result?.page_count, data?.total_pages, data?.result?.total_pages);
  const number = toFiniteNumber(value);
  return number === null ? null : number;
}

export function getOzonFinanceDateChunks(since, to) {
  const startDate = new Date(since);
  const endDate = new Date(to);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return [{ from: since, to }];
  }

  const chunks = [];
  let cursor = new Date(startDate);
  while (cursor <= endDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + OZON_FINANCE_CHUNK_DAYS - 1);
    const safeEnd = chunkEnd > endDate ? endDate : chunkEnd;
    chunks.push({ from: cursor.toISOString(), to: safeEnd.toISOString() });
    cursor = new Date(safeEnd);
    cursor.setMilliseconds(cursor.getMilliseconds() + 1);
  }

  return chunks.length ? chunks : [{ from: since, to }];
}

export function getFinanceOperationDedupKey(operation = {}) {
  const operationId = normalizeOzonId(operation.operation_id).trim();
  if (operationId) return `operation:${operationId}`;
  return JSON.stringify(operation);
}

export { getProfitPostingBaseKey, getProfitPostingLookupKeys };

export function getProfitFinancePostingLookupKeys(postingNumber, options = {}) {
  const keys = getProfitPostingLookupKeys(postingNumber);
  const baseKeys = keys.map(getProfitPostingBaseKey).filter(Boolean);
  const orderedKeys = options.preferBaseLookup === false ? keys : [...new Set([...baseKeys, ...keys])];
  const maxLookupKeys = Math.max(0, Number(options.maxLookupKeys) || 0);
  return maxLookupKeys ? orderedKeys.slice(0, maxLookupKeys) : orderedKeys;
}

export async function requestOzonFinanceOperationsForPosting(shop, postingNumber, dateRange, options = {}) {
  const operations = [];
  const seen = new Set();
  const dateChunks = getOzonFinanceDateChunks(dateRange.since, dateRange.to);
  const lookupPostingNumbers = getProfitFinancePostingLookupKeys(postingNumber, options);
  const requestPostingNumbers = lookupPostingNumbers.length ? lookupPostingNumbers : [''];

  for (const lookupPostingNumber of requestPostingNumbers) {
    const operationsBeforeLookup = operations.length;
    for (const chunk of dateChunks) {
      let page = 1;
      while (true) {
        const filter = {
          date: { from: chunk.from, to: chunk.to },
          operation_type: [],
          transaction_type: 'all',
        };
        const normalizedPostingNumber = normalizeOzonId(lookupPostingNumber).trim();
        if (normalizedPostingNumber) filter.posting_number = normalizedPostingNumber;

        const data = await requestOzonReadOnly('/v3/finance/transaction/list', shop, {
          filter,
          page,
          page_size: 1000,
        });
        const pageItems = getFinanceOperationItems(data);
        const pageCount = getFinancePageCount(data);

        pageItems.forEach((operation) => {
          const key = getFinanceOperationDedupKey(operation);
          if (seen.has(key)) return;
          seen.add(key);
          operations.push(operation);
        });

        if (pageCount !== null) {
          if (page >= pageCount) break;
        } else if (pageItems.length < 1000) {
          break;
        }
        page += 1;
      }
    }
    if (options.stopAfterFirstMatchedLookup !== false && operations.length > operationsBeforeLookup) {
      break;
    }
  }

  return operations;
}

export const profitFinanceOperationCache = new Map();
const profitFinanceFencedOwnerIdentifiers = new Set();
const profitFinanceReadFence = createOwnerCacheReadFence();
const profitAfterSalesReadFence = createOwnerCacheReadFence();

function normalizeProfitCacheIdentifiers(identifiers = []) {
  return [...new Set((Array.isArray(identifiers) ? identifiers : [identifiers])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function getProfitCacheShopIdentifiers(shop = {}) {
  return normalizeProfitCacheIdentifiers([shop?.id, getOzonShopClientId(shop)]);
}

function isProfitCacheShopFenced(shop = {}) {
  return getProfitCacheShopIdentifiers(shop).some((identifier) => (
    profitFinanceFencedOwnerIdentifiers.has(identifier)
  ));
}

function assertProfitCacheShopWritable(shop = {}) {
  if (!isProfitCacheShopFenced(shop)) return;
  const error = new Error('ACCOUNT_REMOVAL_OWNER_QUIESCED');
  error.code = 'ACCOUNT_REMOVAL_OWNER_QUIESCED';
  throw error;
}

function financeCacheKeyMatchesIdentifier(cacheKey, identifier) {
  return String(cacheKey).startsWith(`${PROFIT_FINANCE_CACHE_VERSION}:${identifier}:`);
}

function afterSalesCacheKeyMatchesIdentifier(cacheKey, identifier) {
  return String(cacheKey).startsWith(`${identifier}:`);
}

export function fenceProfitFinanceCachesForOwner(identifiers = []) {
  const normalized = normalizeProfitCacheIdentifiers(identifiers);
  normalized.forEach((identifier) => profitFinanceFencedOwnerIdentifiers.add(identifier));
  profitFinanceReadFence.invalidate(normalized, profitFinanceOperationCache);
  profitAfterSalesReadFence.invalidate(normalized);
  return { identifiers: normalized, fenced: true };
}

export function releaseProfitFinanceOwnerFence(identifiers = []) {
  normalizeProfitCacheIdentifiers(identifiers).forEach(identifier => profitFinanceFencedOwnerIdentifiers.delete(identifier));
}

export function countProfitFinanceCacheEntriesForOwner(identifiers = []) {
  const normalized = normalizeProfitCacheIdentifiers(identifiers);
  return [...profitFinanceOperationCache.keys()].filter((key) => (
    normalized.some((identifier) => financeCacheKeyMatchesIdentifier(key, identifier))
  )).length;
}

export function invalidateProfitFinanceCacheEntriesForOwner(identifiers = []) {
  const normalized = normalizeProfitCacheIdentifiers(identifiers);
  let removedCount = profitFinanceReadFence.invalidate(normalized, profitFinanceOperationCache).removedCacheEntries;
  for (const [key, entry] of profitFinanceOperationCache) {
    if (entry?.readTicket) continue;
    if (!normalized.some((identifier) => financeCacheKeyMatchesIdentifier(key, identifier))) continue;
    profitFinanceOperationCache.delete(key);
    removedCount += 1;
  }
  return { removedCount };
}

export function getProfitFinanceOperationCacheKey(shop, postingNumber, dateRange, options = {}) {
  const ownerId = String(shop?.id || getOzonShopClientId(shop) || '').trim();
  if (!ownerId) throw new Error('利润流水缓存缺少明确的店铺标识。');
  const posting = normalizeOzonId(postingNumber).trim();
  const lookupMode = [
    options.preferBaseLookup === false ? 'raw-first' : 'base-first',
    options.stopAfterFirstMatchedLookup === false ? 'all-matches' : 'first-match',
    Number(options.maxLookupKeys) > 0 ? `max-${Number(options.maxLookupKeys)}` : 'max-all',
  ].join(':');
  return `${PROFIT_FINANCE_CACHE_VERSION}:${ownerId}:${posting}:${dateRange.since}:${dateRange.to}:${lookupMode}`;
}

export async function requestOzonFinanceOperationsForPostingCached(shop, postingNumber, dateRange, options = {}) {
  assertProfitCacheShopWritable(shop);
  const cacheKey = getProfitFinanceOperationCacheKey(shop, postingNumber, dateRange, options);
  const cached = profitFinanceOperationCache.get(cacheKey);
  if (!options.forceRefresh && cached) {
    if (cached.promise) return cached.promise;
    if (Date.now() - cached.createdAt < PROFIT_FINANCE_CACHE_TTL_MS) return cached.value;
  }

  const readTicket = profitFinanceReadFence.capture(getProfitCacheShopIdentifiers(shop));
  const promise = requestOzonFinanceOperationsForPosting(shop, postingNumber, dateRange, options)
    .then((value) => {
      if (readTicket.current && !isProfitCacheShopFenced(shop)
        && profitFinanceOperationCache.get(cacheKey)?.promise === promise) {
        profitFinanceOperationCache.set(cacheKey, { createdAt: Date.now(), value });
      }
      return value;
    })
    .catch((error) => {
      if (profitFinanceOperationCache.get(cacheKey)?.promise === promise) profitFinanceOperationCache.delete(cacheKey);
      throw error;
    })
    .finally(() => readTicket.finish());
  if (readTicket.current && !isProfitCacheShopFenced(shop)) profitFinanceOperationCache.set(cacheKey, { createdAt: Date.now(), promise, readTicket });
  return promise;
}

export function getProfitRowPrimaryPostingNumbers(row = {}) {
  const values = Array.isArray(row.postingNumbers)
    ? row.postingNumbers
    : [row.id, row.posting, row.raw?.posting_number, row.raw?.postingNumber, row.raw?.analytics_data?.posting_number];
  return [
    ...new Set(values.map((value) => normalizeOzonId(value).trim()).filter((value) => value && value !== '未返回')),
  ];
}

export function getProfitFinanceRowDateMs(row = {}) {
  const raw = firstFilled(
    row.paymentDate,
    row.paymentTime,
    row.raw?.paid_at,
    row.raw?.payment_date,
    row.raw?.paymentDate,
    row.raw?.in_process_at,
    row.raw?.created_at,
    row.raw?.createdAt
  );
  if (raw && raw !== '未返回') {
    const directTime = new Date(raw).getTime();
    if (Number.isFinite(directTime)) return directTime;
  }
  const paymentDateKey = getSalesOrderPaymentDateKey(row);
  if (!paymentDateKey) return 0;
  const keyTime = new Date(`${paymentDateKey}T00:00:00`).getTime();
  return Number.isFinite(keyTime) ? keyTime : 0;
}

export function getProfitFinanceDateRangeForRow(row = {}, fallbackRange = getOzonOrderDateRange()) {
  const time = getProfitFinanceRowDateMs(row);
  if (!time) return fallbackRange;
  const start = new Date(time);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - PROFIT_FINANCE_ROW_LOOKBACK_DAYS);

  const end = new Date(time);
  end.setHours(23, 59, 59, 999);
  end.setDate(end.getDate() + PROFIT_FINANCE_ROW_LOOKAHEAD_DAYS);

  const now = new Date();
  const safeEnd = end > now ? now : end;
  if (safeEnd <= start) return fallbackRange;
  return { since: start.toISOString(), to: safeEnd.toISOString() };
}

export function getProfitFinancePostingRequests(rows = [], options = {}) {
  const fallbackRange = getOzonOrderDateRange();
  const selectedRange = getExplicitOzonTimeRange(options);
  const byLookupKey = new Map();
  rows.forEach((row) => {
    getProfitRowPrimaryPostingNumbers(row).forEach((postingNumber) => {
      const lookupKey = getProfitFinancePostingLookupKeys(postingNumber, options)[0] || postingNumber;
      if (!lookupKey || byLookupKey.has(lookupKey)) return;
      byLookupKey.set(lookupKey, {
        postingNumber,
        dateRange: getProfitFinanceDateRangeForRow(row, selectedRange || fallbackRange),
      });
    });
  });
  return Array.from(byLookupKey.values());
}

export function getProfitOrderLookupKeys(order = {}) {
  return getProfitPostingLookupKeys([
    ...(Array.isArray(order.postingNumbers) ? order.postingNumbers : []),
    order.posting,
    order.id,
    order.softwareOrderId,
    order.raw?.posting_number,
    order.raw?.postingNumber,
    order.raw?.order_number,
    order.raw?.orderNumber,
    order.raw?.order_id,
    order.raw?.orderId,
    order.raw?.analytics_data?.posting_number,
    order.raw?.analytics_data?.order_id,
  ]);
}

export function getProfitOrderFinanceLookupGroups(order = {}) {
  const fallbackValues = [
    order.salesOrder,
    order.raw?.order_number,
    order.raw?.orderNumber,
    order.raw?.order_id,
    order.raw?.orderId,
    order.raw?.analytics_data?.order_id,
  ];
  const childFallbackValues = fallbackValues.filter((value) => Boolean(getProfitPostingBaseKey(value)));
  return getFinancePostingLookupGroups(
    [
      ...(Array.isArray(order.postingNumbers) ? order.postingNumbers : []),
      order.posting,
      order.id,
      order.softwareOrderId,
      order.raw?.posting_number,
      order.raw?.postingNumber,
      order.raw?.analytics_data?.posting_number,
      ...childFallbackValues,
    ],
    {
      fallbackValues,
    }
  );
}

export function getProfitOrderStableRecordKey(order = {}) {
  const shopKey =
    normalizeOzonId(firstFilled(order.shopId, order.shopClientId)).trim() || 'unscoped-shop';
  const postingKey =
    firstUsableOzonId(
      order.posting,
      order.id,
      order.salesOrder,
      order.raw?.posting_number,
      order.raw?.postingNumber,
      order.raw?.analytics_data?.posting_number,
      order.softwareOrderId,
      order.raw?.order_number,
      order.raw?.orderNumber,
      order.raw?.order_id,
      order.raw?.orderId
    ) || 'unknown-order';
  return `${shopKey}:${postingKey}`;
}

export function getAfterSalesRowLookupKeys(row = {}) {
  const firstProduct = Array.isArray(row.products) ? (row.products[0] ?? {}) : {};
  return getProfitPostingLookupKeys([
    row.salesOrder,
    row.id,
    row.raw?.posting_number,
    row.raw?.postingNumber,
    row.raw?.order_number,
    row.raw?.orderNumber,
    row.raw?.order_id,
    row.raw?.orderId,
    row.raw?.posting?.posting_number,
    row.raw?.posting?.postingNumber,
    firstProduct.raw?.posting_number,
    firstProduct.raw?.postingNumber,
  ]);
}

export { getAfterSalesItemLookupKeys };

export function getProfitRowsLookupKeys(rows = []) {
  return [...new Set(rows.flatMap((row) => getProfitOrderLookupKeys(row)))];
}

export function addAfterSalesIndexKey(map, key, row) {
  getProfitPostingLookupKeys(key).forEach((text) => {
    const current = map.get(text) ?? [];
    current.push(row);
    map.set(text, current);
  });
}

export function buildAfterSalesRowIndex(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    getAfterSalesRowLookupKeys(row).forEach((key) => addAfterSalesIndexKey(map, key, row));
  });
  return map;
}

export function getProfitOrderAfterSalesRows(order = {}, afterSalesIndex = new Map()) {
  const rows = [];
  const seen = new Set();
  getProfitOrderLookupKeys(order).forEach((key) => {
    const matched = afterSalesIndex.get(key);
    if (!Array.isArray(matched)) return;
    matched.forEach((row) => {
      const rowKey = `${row.source || ''}:${row.id || ''}:${row.salesOrder || ''}:${row.status || ''}`;
      if (seen.has(rowKey)) return;
      seen.add(rowKey);
      rows.push(row);
    });
  });
  return rows;
}

export function getProfitOrderModeValue(order = {}, mode = 'mixed') {
  return getProfitOrderModeValueByResult(order, mode);
}

export function getProfitOrderEstimatedValue(order = {}) {
  return getProfitOrderEstimatedValueByResult(order);
}

export function getProfitOrderActualValue(order = {}) {
  return getProfitOrderActualValueByResult(order);
}

export function getProfitOrderBestValue(order = {}) {
  return getProfitOrderBestValueByResult(order);
}

export function getProfitOrderProfitLossInfo(order = {}) {
  return getProfitOrderProfitLossInfoByResult(order);
}

export function getProfitOrderProfitLossValue(order = {}) {
  return getProfitOrderProfitLossValueByResult(order);
}

export function getProfitOrderModeDisplay(order = {}, mode = 'mixed') {
  const value = getProfitOrderModeValue(order, mode);
  return value === null ? '待确认' : getSignedProfitDisplay(value, order.currencyCode || 'CNY');
}

export function getProfitModeLabel(mode = 'mixed') {
  return profitModeOptions.find((item) => item.value === mode)?.label || '混合计算';
}

export function getProfitModeSummaryValue(rows = [], mode = 'mixed') {
  const values = rows.map((order) => getProfitOrderModeValue(order, mode)).filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

export function getProfitTabCount(rows = [], tabValue = 'all', mode = 'mixed') {
  return getProfitTabCountByResult(rows, tabValue, mode);
}

export function doesProfitOrderMatchTab(order = {}, tabValue = 'all', mode = 'mixed') {
  return doesProfitOrderMatchTabByResult(order, tabValue, mode);
}

export function getProfitAfterSalesCacheKey(shop, options = {}) {
  const ownerId = String(shop?.id || getOzonShopClientId(shop) || '').trim();
  if (!ownerId) throw new Error('利润售后缓存缺少明确的店铺标识。');
  const lookupKeys = getProfitPostingLookupKeys(options.lookupKeys ?? []).sort();
  const lookupPart = lookupKeys.length ? lookupKeys.join(',') : 'all';
  const timeScope =
    options.timeScope ||
    createOzonTimeRangeScope({
      page: 'profit-after-sales',
      dateRange: options.dateRange || options.apiRange,
      startDate: options.startDate,
      endDate: options.endDate,
      defaultDays: options.defaultDays ?? OZON_AFTER_SALES_DEFAULT_RANGE_DAYS,
    });
  return `${ownerId}:${timeScope.cachePart}:${lookupPart}`;
}

export const profitAfterSalesSnapshotCache = new Map();

export function countProfitAfterSalesCacheEntriesForOwner(identifiers = []) {
  const normalized = normalizeProfitCacheIdentifiers(identifiers);
  return [...profitAfterSalesSnapshotCache.keys()].filter((key) => (
    normalized.some((identifier) => afterSalesCacheKeyMatchesIdentifier(key, identifier))
  )).length;
}

export function invalidateProfitAfterSalesCacheEntriesForOwner(identifiers = []) {
  const normalized = normalizeProfitCacheIdentifiers(identifiers);
  profitAfterSalesReadFence.invalidate(normalized);
  let removedCount = 0;
  for (const key of profitAfterSalesSnapshotCache.keys()) {
    if (!normalized.some((identifier) => afterSalesCacheKeyMatchesIdentifier(key, identifier))) continue;
    profitAfterSalesSnapshotCache.delete(key);
    removedCount += 1;
  }
  return { removedCount };
}

export async function requestOzonProfitAfterSalesSnapshotForShop(shop, options = {}) {
  assertProfitCacheShopWritable(shop);
  const cacheKey = getProfitAfterSalesCacheKey(shop, options);
  const cached = profitAfterSalesSnapshotCache.get(cacheKey);
  if (!options.forceRefresh && cached && Date.now() - cached.createdAt < PROFIT_AFTER_SALES_CACHE_TTL_MS) {
    return cached.value;
  }

  const readTicket = profitAfterSalesReadFence.capture(getProfitCacheShopIdentifiers(shop));
  try {
    const value = await requestOzonAfterSalesSnapshot(shop, {
      dateRange: options.dateRange || options.apiRange,
      timeScope: options.timeScope,
      startDate: options.startDate,
      endDate: options.endDate,
      defaultDays: options.defaultDays ?? OZON_AFTER_SALES_DEFAULT_RANGE_DAYS,
      lookupKeys: options.lookupKeys,
    });
    if (readTicket.current && !isProfitCacheShopFenced(shop)) profitAfterSalesSnapshotCache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  } finally {
    readTicket.finish();
  }
}
