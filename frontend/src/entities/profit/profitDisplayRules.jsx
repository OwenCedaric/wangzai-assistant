import { firstCommissionRate } from './profitCommissionRules.jsx';
import { getProfitLedgerEntryValue, getProfitLedgerRowKey } from './profitLedgerEntryRules.jsx';
import { getAssociatedOrderSearchValues, getProfitValueClass } from './profitSearchRules.jsx';
import { formatShopBindingTime } from '../../shared/lib/dateTimeFormat.js';
import { getProfitOrderRecordKey } from './profitOrderRecordRules.jsx';
import { getProfitActualStatusText, isProfitFinalZeroAllowedStatus } from './profitStatusRules.jsx';
import { isPartialCompensationSale, readPartialCompensationEvidence, prepareProfitCalculationOrder } from '../../services/profitPartialCompensation.js';
import { getAfterSalesPendingRemovalReason } from '../../services/afterSalesDisplayRules.js';
import {
  calculateCommissionFeeCny,
  calculateDeliveryServiceFeeCny,
  OZON_MILEAGE_FEE_RUB,
} from '../../services/feeCalculationService';
import { getPurchaseInfoSupport } from '../../services/purchaseInfoSupport';
import {
  getFinanceBreakdown,
  getProfitFinanceEvidenceSummary,
  getProfitDetailActualFeeBreakdown,
  getProfitPenaltyDetails,
} from '../../services/profitFinanceBreakdown';
import { createProfitLedgerRow, PROFIT_LEDGER_CALCULATION_VERSION, resolveProfitPurchaseCost } from '../../services/profitLedgerService';
import { buildOrderExchangeRateBundle } from '../../services/orderExchangeRateRules';
import { getOzonRatingPenaltyOperationPostingKeys } from '../../services/profitRatingPenalty';
import { PROFIT_FINANCE_CACHE_VERSION } from '../../shared/config/appConfigCore.jsx';
import { countRowsImages } from '../../shared/ozon/ozonRuntime.jsx';
import { firstFilled, firstUsableOzonId } from '../order/orderIdentityRules.jsx';
import {
  isAfterSalesRefundLossStatus,
  isAfterSalesSignedRefundStatus,
  normalizeAfterSalesStatus,
} from '../order/afterSalesStatusRules.jsx';
import { getOzonOrderProductSalesAmount } from '../order/orderProductAmountRules.jsx';
import { firstFiniteNumber, toFiniteNumber } from '../product/productAttributes.jsx';
import {
  buildProfitPurchaseOrderForLogistics,
  buildProfitPurchaseOrderWithLocalOverride,
  convertOzonRubToCny,
  convertProfitAmountToCny,
  getProfitActualCrossBorderBusFeeValueCny,
  getProfitDisplayCny,
  getProfitDisplayMoney,
  getProfitEstimatedCrossBorderBusFeeValueCny,
  getProfitLogisticsEstimateValueCny,
  getProfitOrderAfterSalesRows,
  getProfitOrderFinanceLookupGroups,
  getProfitOrderProductCost,
  getProfitOrderStableRecordKey,
  getProfitPostingBaseKey,
  getProfitProductEstimatedFees,
  getProfitProductPriceInfo,
  getProfitResultStatusLabel,
  getProfitSalesCurrencyCode,
  getSignedProfitDisplay,
  PROFIT_MANUAL_OVERRIDE_FIELDS,
  sumNullable,
} from './profitFinanceEvidence.jsx';
import { getProfitPurchaseOrderOverride } from './profitPurchaseOverrideRules.jsx';
import {
  getPenaltyOperationPostingLookupKeys,
  getProfitOrderFinanceOperations,
  getProfitOrderPenaltyFinanceOperations,
  getProfitOrderRatingPenaltyOperations,
} from './profitLedgerMapping.jsx';

export function mergeProfitPenaltyOperations(financeOperations = [], ratingPenaltyOperations = [], options = {}) {
  if (!ratingPenaltyOperations.length) return financeOperations;
  const ratingPostingKeys = new Set(
    ratingPenaltyOperations.flatMap((operation) => getOzonRatingPenaltyOperationPostingKeys(operation))
  );
  const filteredFinanceOperations = financeOperations.filter((operation) => {
    const details = getProfitPenaltyDetails([operation], { rubToCnyRate: options.rubToCnyRate });
    if (!details.hasPenaltyEvent) return true;
    const operationKeys = getPenaltyOperationPostingLookupKeys(operation);
    return !operationKeys.some((key) => ratingPostingKeys.has(key));
  });
  return [...filteredFinanceOperations, ...ratingPenaltyOperations];
}

export function isProfitOrderFinanceLookupChecked(order = {}, financeLookupCheckedIndex = new Map()) {
  const groups = getProfitOrderFinanceLookupGroups(order);
  if (groups.exactKeys.some((key) => financeLookupCheckedIndex.get(key))) return true;
  if (groups.hasChildExactKey) return false;
  return groups.fallbackKeys.some((key) => financeLookupCheckedIndex.get(key));
}

export function isFreshProfitFinanceRow(row = null) {
  return row?.profitFinanceVersion === PROFIT_FINANCE_CACHE_VERSION;
}

export function getProfitDisplayStatus(value, currencyCode, fallback = '待确认') {
  return value === null || value === undefined ? fallback : getProfitDisplayMoney(value, currencyCode, fallback);
}

export function mapProfitLedgerRowsByKey(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((map, row) => {
    const key = getProfitLedgerRowKey(row);
    if (key) map[key] = row;
    return map;
  }, {});
}

export { getProfitLedgerEntryValue, getProfitLedgerRowKey };

export function getProfitOrderSourcePurchaseHint(order = {}) {
  const products = Array.isArray(order.products) ? order.products : [];
  return firstFiniteNumber(
    order.manualPurchasePriceValue,
    order.manualPurchasePrice,
    order.purchasePriceValue,
    order.purchasePrice,
    order.sourcePurchaseCostCny,
    ...products.flatMap((product) => [
      product?.manualPurchasePriceValue,
      product?.manualPurchasePrice,
      product?.purchasePriceValue,
      product?.purchasePrice,
      product?.sourcePurchaseCostCny,
      product?.sourcePriceValue,
      product?.sourcePrice,
    ])
  );
}

export function hasProfitOrderCommissionHint(order = {}) {
  const products = Array.isArray(order.products) ? order.products : [];
  if (
    firstCommissionRate(order.commissionPercent, order.raw?.commissionPercent, order.raw?.commission_percent) !==
      null &&
    firstFiniteNumber(order.amountValue, order.amount) !== null
  ) {
    return true;
  }
  return products.some((product) => {
    const rate = firstCommissionRate(
      product?.commissionPercent,
      product?.raw?.commissionPercent,
      product?.raw?.commission_percent
    );
    return rate !== null && getOzonOrderProductSalesAmount(product) !== null;
  });
}

export function isProfitLedgerUsableForOrder(order = {}, ledger = null) {
  if (!ledger?.results || !ledger?.amounts) return false;
  if (String(ledger.calculationVersion || '') !== PROFIT_LEDGER_CALCULATION_VERSION) return false;
  if (!isPartialCompensationSale({ ...order, orderSnapshot: ledger.orderSnapshot }) && (
    order.hasAfterSalesRefund === true ||
    order.hasFinanceRefund === true ||
    isProfitFinalZeroAllowedStatus(getProfitActualStatusText(order, []))
  )) {
    const actualSalesAmount = getProfitLedgerEntryValue(ledger.amounts.actualSalesAmountCny);
    if (actualSalesAmount !== null && actualSalesAmount !== 0) return false;
  }
  if (countRowsImages([order]) > 0 && countRowsImages([{ products: ledger.orderSnapshot?.products ?? [] }]) === 0) {
    return false;
  }
  const sourcePurchaseHint = getProfitOrderSourcePurchaseHint(order);
  if (sourcePurchaseHint !== null && sourcePurchaseHint > 0) {
    const ledgerSourcePurchaseCost = getProfitLedgerEntryValue(ledger.amounts.sourcePurchaseCostCny);
    if (ledgerSourcePurchaseCost === null || ledgerSourcePurchaseCost <= 0) return false;
  }
  if (hasProfitOrderCommissionHint(order)) {
    const ledgerCommission = getProfitLedgerEntryValue(ledger.amounts.estimatedCommissionFeeCny);
    if (ledgerCommission === null || ledgerCommission <= 0) return false;
  }
  const orderEstimatedExchangeRate = buildOrderExchangeRateBundle(order, {}, { includeActual: false }).estimated;
  if (orderEstimatedExchangeRate?.rubToCnyRate) {
    const ledgerDeliveryService = getProfitLedgerEntryValue(ledger.amounts.estimatedDeliveryServiceFeeCny);
    if (ledgerDeliveryService === null) return false;
  }
  return true;
}

export function getProfitLedgerEntryDisplay(entry = null, currencyCode = 'CNY', fallback = '待确认') {
  return getProfitDisplayStatus(getProfitLedgerEntryValue(entry), currencyCode, fallback);
}

export function getProfitLedgerResultDisplay(entry = null, currencyCode = 'CNY', fallback = '待确认') {
  const value = getProfitLedgerEntryValue(entry);
  return value === null ? fallback : getSignedProfitDisplay(value, currencyCode, fallback);
}

export function getProfitLedgerAmountFallback(entry = null, fallback = '待确认') {
  const status = String(entry?.status ?? '').trim();
  if (!status || status === 'pending') return fallback;
  if (status === 'ready' || status === 'provisional') return fallback;
  return '数据异常';
}

export function getProfitLedgerExpenseDisplay(entry = null, currencyCode = 'CNY', fallback = '待确认') {
  const value = getProfitLedgerEntryValue(entry);
  if (value === null) return getProfitLedgerAmountFallback(entry, fallback);
  return getSignedProfitDisplay(value > 0 ? -value : value, currencyCode, fallback);
}

const PROFIT_LEDGER_SOURCE_LABELS = {
  'ozon-order': 'Ozon订单金额',
  'actual-order-income': 'Ozon实际收入',
  'actual-order-income-after-compensation': '销售收入扣除实际部分补偿',
  'ozon-buyer-partial-compensation': 'Ozon部分补偿流水',
  'purchase-override': '采购覆盖缓存',
  'order-total': '订单采购成本',
  'order-products': '商品采购成本汇总',
  'source-record-product': '货源记录商品成本',
  'missing-purchase-cost-zero': '缺货源成本，占位0',
  'confirmed-no-purchase': '明确无采购成本',
  'ozon-product-price': 'Ozon商品价格接口',
  'order-card-acquiring': '订单收单规则',
  'ozon-mileage-fee': 'Ozon配送服务规则',
  'cross-border-bus-settings': '跨境巴士费用设置',
  'local-logistics': '本地物流/巴士材积',
  'ozon-finance': 'Ozon财务流水',
  'ozon-finance-detail': 'Ozon财务流水明细',
  'ozon-finance-penalty-detail': 'Ozon罚款证据',
  'estimated-ozon-fees': '预估平台扣费汇总',
  'ozon-finance-refund': 'Ozon退款扣费',
};

function getProfitLedgerSourceLabel(entry = null) {
  const source = String(entry?.source || '').trim();
  return PROFIT_LEDGER_SOURCE_LABELS[source] || source || '未返回';
}

function getProfitLedgerFormulaHint(label = '', formula = '', entry = null) {
  const sourceLabel = getProfitLedgerSourceLabel(entry);
  return [label, formula ? `公式：${formula}` : '', sourceLabel ? `来源：${sourceLabel}` : '']
    .filter(Boolean)
    .join('；');
}

export function hasProfitLedgerAmountKeys(ledger = null, keys = []) {
  const amounts = ledger?.amounts;
  if (!amounts || typeof amounts !== 'object') return false;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(amounts, key));
}

export function getProfitLedgerEstimatedFees(ledger = null, currencyCode = 'CNY') {
  if (!ledger?.amounts) return [];
  const estimatedCommission = ledger.amounts?.estimatedCommissionFeeCny;
  const estimatedAcquiring = ledger.amounts?.estimatedAcquiringFeeCny;
  const estimatedDelivery = ledger.amounts?.estimatedDeliveryServiceFeeCny;
  const logisticsFee = ledger.amounts?.logisticsFeeCny;
  const sourcePurchaseCost = ledger.amounts?.sourcePurchaseCostCny;
  const crossBorderBusFee = ledger.amounts?.estimatedCrossBorderBusFeeCny || ledger.amounts?.crossBorderBusFeeCny;
  return [
    {
      label: '商品佣金',
      value: getProfitLedgerEntryDisplay(estimatedCommission, currencyCode),
      hint: getProfitLedgerFormulaHint('商品佣金', '商品成交额 × Ozon佣金比例', estimatedCommission),
    },
    {
      label: '收单业务',
      value: getProfitLedgerEntryDisplay(estimatedAcquiring, currencyCode),
      hint: getProfitLedgerFormulaHint('收单业务', '优先Ozon acquiring；缺失时成交额 × 2%', estimatedAcquiring),
    },
    {
      label: '配送服务',
      value: getProfitLedgerEntryDisplay(estimatedDelivery, currencyCode),
      hint: getProfitLedgerFormulaHint('配送服务', '15 RUB × 当前卢布汇率', estimatedDelivery),
    },
    {
      label: '物流预估',
      value: getProfitLedgerEntryDisplay(logisticsFee, currencyCode),
      hint: getProfitLedgerFormulaHint('物流预估', '巴士材积/手动物流/拍单物流规则', logisticsFee),
    },
    {
      label: '货源成本',
      value: getProfitLedgerEntryDisplay(sourcePurchaseCost, currencyCode),
      hint: getProfitLedgerFormulaHint('货源成本', '采购覆盖成本或商品货源成本汇总', sourcePurchaseCost),
    },
    {
      label: '巴士费用',
      value: getProfitLedgerEntryDisplay(crossBorderBusFee, currencyCode),
      hint: getProfitLedgerFormulaHint('巴士费用', '(面单费×充值)/(充值+赠送)+预报费', crossBorderBusFee),
    },
  ];
}

export function getProfitLedgerActualFees(ledger = null, currencyCode = 'CNY') {
  const actualAmountKeys = [
    'actualCommissionFeeCny',
    'actualPenaltyFeeCny',
    'actualAcquiringFeeCny',
    'actualDeliveryServiceFeeCny',
    'actualLogisticsFeeCny',
    'actualCrossBorderBusFeeCny',
    'actualOzonFeeCny',
    'platformNetCny',
  ];
  if (!hasProfitLedgerAmountKeys(ledger, actualAmountKeys)) return [];
  const zeroActualFee = getProfitDisplayMoney(0, currencyCode);
  return [
    ...(isPartialCompensationSale(ledger) && ledger.amounts?.buyerCompensationCny ? [{
      label: '买家补偿（已扣）',
      value: getProfitLedgerExpenseDisplay(ledger.amounts.buyerCompensationCny, currencyCode),
      hint: '已从实际收入中扣除，不重复计入下方费用合计。',
    }] : []),
    {
      label: '佣金扣费',
      value: getProfitLedgerExpenseDisplay(ledger.amounts?.actualCommissionFeeCny, currencyCode, zeroActualFee),
      hint: getProfitLedgerFormulaHint('佣金扣费', 'Ozon财务流水佣金明细', ledger.amounts?.actualCommissionFeeCny),
    },
    {
      label: '罚款扣费',
      value: getProfitLedgerExpenseDisplay(ledger.amounts?.actualPenaltyFeeCny, currencyCode, zeroActualFee),
      hint: getProfitLedgerFormulaHint(
        '罚款扣费',
        'Ozon财务流水罚款 + rating罚款证据',
        ledger.amounts?.actualPenaltyFeeCny
      ),
    },
    {
      label: '收单扣费',
      value: getProfitLedgerExpenseDisplay(ledger.amounts?.actualAcquiringFeeCny, currencyCode, zeroActualFee),
      hint: getProfitLedgerFormulaHint('收单扣费', 'Ozon财务流水收单明细', ledger.amounts?.actualAcquiringFeeCny),
    },
    {
      label: '配送服务',
      value: getProfitLedgerExpenseDisplay(ledger.amounts?.actualDeliveryServiceFeeCny, currencyCode, zeroActualFee),
      hint: getProfitLedgerFormulaHint(
        '配送服务',
        'Ozon财务流水配送服务明细',
        ledger.amounts?.actualDeliveryServiceFeeCny
      ),
    },
    {
      label: '物流扣费',
      value: getProfitLedgerExpenseDisplay(ledger.amounts?.actualLogisticsFeeCny, currencyCode, zeroActualFee),
      hint: getProfitLedgerFormulaHint('物流扣费', 'Ozon财务流水物流明细', ledger.amounts?.actualLogisticsFeeCny),
    },
    {
      label: '巴士费用',
      value: getProfitLedgerExpenseDisplay(
        ledger.amounts?.actualCrossBorderBusFeeCny || ledger.amounts?.crossBorderBusFeeCny,
        currencyCode,
        '待确认'
      ),
      hint: getProfitLedgerFormulaHint(
        '巴士费用',
        '(面单费×充值)/(充值+赠送)+预报费',
        ledger.amounts?.actualCrossBorderBusFeeCny || ledger.amounts?.crossBorderBusFeeCny
      ),
    },
  ];
}

export function createProfitOrderFromLedgerRow(ledger = null) {
  if (!ledger?.results) return null;
  const snapshot = ledger.orderSnapshot && typeof ledger.orderSnapshot === 'object' ? ledger.orderSnapshot : {};
  const ledgerKey = getProfitLedgerRowKey(ledger);
  const products = Array.isArray(snapshot.products) ? snapshot.products : [];
  const firstProduct = products[0] ?? {};
  const currencyCode = snapshot.currencyCode || 'CNY';
  const salesAmount = getProfitLedgerEntryDisplay(ledger.amounts?.salesAmountCny, currencyCode, '未返回');
  const amountValue = getProfitLedgerEntryValue(ledger.amounts?.salesAmountCny);
  const order = {
    id: snapshot.id || snapshot.posting || snapshot.salesOrder || ledger.orderKey || ledgerKey,
    posting: snapshot.posting || snapshot.id || '',
    salesOrder: snapshot.salesOrder || snapshot.id || '',
    softwareOrderId: snapshot.softwareOrderId || '',
    recordKey: snapshot.recordKey || ledgerKey,
    profitRecordKey: snapshot.profitRecordKey || ledgerKey,
    shop: snapshot.shop || '未返回',
    shopId: snapshot.shopId || ledger.shopId || '',
    shopClientId: snapshot.shopClientId || ledger.shopClientId || '',
    status: snapshot.status || '',
    statusLabel: snapshot.statusLabel || '',
    detailStatus: snapshot.detailStatus || '',
    ozonStatus: snapshot.ozonStatus || '',
    ozonStatusLabel: snapshot.ozonStatusLabel || '',
    rawStatus: snapshot.rawStatus || '',
    rawSubstatus: snapshot.rawSubstatus || '',
    rawPostingStatus: snapshot.rawPostingStatus || '',
    afterSalesStatus: snapshot.afterSalesStatus || '',
    hasAfterSalesRefund: snapshot.hasAfterSalesRefund === true,
    hasFinanceRefund: snapshot.hasFinanceRefund === true,
    partialCompensationOnly: snapshot.partialCompensationOnly === true,
    buyerCompensationCny: ledger.amounts?.buyerCompensationCny?.value,
    product: snapshot.product || firstProduct.name || '未返回',
    qty: snapshot.qty || firstProduct.qty || 1,
    offerId: snapshot.offerId || firstProduct.offerId || firstProduct.sku || '未返回',
    sku: snapshot.sku || firstProduct.sku || '',
    skuId: snapshot.skuId || firstProduct.skuId || '',
    paymentTime: snapshot.paymentTime || snapshot.paymentDate || '未返回',
    paymentDate: snapshot.paymentDate || snapshot.paymentTime || '',
    fulfillment: snapshot.fulfillment || 'FBS',
    purchasePlatform: snapshot.purchasePlatform || '',
    purchaseOrderNo: snapshot.purchaseOrderNo || '',
    purchaseOrderUrl: snapshot.purchaseOrderUrl || '',
    purchaseCost: snapshot.sourcePurchaseCostCny || '',
    sourcePurchaseCostCny: snapshot.sourcePurchaseCostCny,
    sourceRecords: Array.isArray(snapshot.sourceRecords) ? snapshot.sourceRecords : [],
    searchText: snapshot.searchText || '',
    afterSalesSearchText: snapshot.afterSalesSearchText || '',
    afterSalesSearchValues: Array.isArray(snapshot.afterSalesSearchValues) ? snapshot.afterSalesSearchValues : [],
    currencyCode,
    sourceCurrencyCode: snapshot.sourceCurrencyCode || currencyCode,
    amountValue: amountValue ?? snapshot.amountValue ?? null,
    amount: snapshot.amount || snapshot.salesAmount || salesAmount,
    salesAmount: snapshot.salesAmount || snapshot.amount || salesAmount,
    rubToCnyRate: ledger.exchangeRate?.rubToCnyRate ?? snapshot.rubToCnyRate ?? null,
    exchangeRate: ledger.exchangeRate ?? snapshot.exchangeRate ?? null,
    estimatedExchangeRate:
      ledger.estimatedExchangeRate ?? ledger.exchangeRates?.estimated ?? snapshot.estimatedExchangeRate ?? null,
    actualExchangeRate:
      ledger.actualExchangeRate ?? ledger.exchangeRates?.actual ?? snapshot.actualExchangeRate ?? null,
    exchangeRates: ledger.exchangeRates ?? snapshot.exchangeRates ?? null,
    products,
    profitLedger: ledger,
  };
  return applyProfitLedgerToProfitOrder(order, ledger);
}

export function applyProfitLedgerToProfitOrder(order = {}, ledgerRow = null) {
  const ledger = ledgerRow || order.profitLedger;
  if (!ledger?.results) return order;
  const currencyCode = order.currencyCode || 'CNY';
  const estimatedProfitValue = getProfitLedgerEntryValue(ledger.results?.estimatedProfitCny);
  const actualProfitValue = getProfitLedgerEntryValue(ledger.results?.actualProfitCny);
  const refundLossValue = getProfitLedgerEntryValue(ledger.results?.refundLossCny);
  const signedRefundLossValue = refundLossValue === null ? null : -refundLossValue;
  const profitLossValue =
    signedRefundLossValue !== null
      ? signedRefundLossValue
      : actualProfitValue !== null
        ? actualProfitValue
        : estimatedProfitValue;
  const profitLossSource =
    signedRefundLossValue !== null || actualProfitValue !== null
      ? 'actual'
      : estimatedProfitValue !== null
        ? 'estimated'
        : 'pending';
  const next = {
    ...order,
    profitLedger: ledger,
  };

  if (estimatedProfitValue !== null) {
    next.estimatedProfitValue = estimatedProfitValue;
    next.estimatedProfit = getSignedProfitDisplay(estimatedProfitValue, currencyCode);
  } else {
    next.estimatedProfitValue = null;
    next.estimatedProfit = '待确认';
  }
  if (actualProfitValue !== null) {
    next.actualProfitValue = actualProfitValue;
    next.actualProfit = getSignedProfitDisplay(actualProfitValue, currencyCode);
  } else {
    next.actualProfitValue = null;
    next.actualProfit = '待确认';
  }
  if (signedRefundLossValue !== null) {
    next.signedRefundLossValue = signedRefundLossValue;
    next.signedRefundLoss = true;
  }
  if (profitLossValue !== null) {
    next.profitLossValue = profitLossValue;
    next.profitLoss = getSignedProfitDisplay(profitLossValue, currencyCode);
    next.detailStatus = getProfitResultStatusLabel(profitLossValue);
    next.profitLossSource = profitLossSource;
    next.profitLossEstimatedFallback = profitLossSource === 'estimated';
    next.type = profitLossValue < 0 ? 'loss' : profitLossSource === 'actual' ? 'actual' : 'estimated';
  } else {
    next.profitLossValue = null;
    next.profitLoss = '待确认';
    next.detailStatus = '待确认';
    next.profitLossSource = 'pending';
    next.profitLossEstimatedFallback = false;
    next.type = 'pending';
  }

  const estimatedOzonFeeValue = getProfitLedgerEntryValue(ledger.amounts?.estimatedOzonFeeCny);
  if (estimatedOzonFeeValue !== null) next.estimatedOzonFeeValueCny = estimatedOzonFeeValue;
  next.estimatedFees = getProfitLedgerEstimatedFees(ledger, currencyCode);
  const actualFees = getProfitLedgerActualFees(ledger, currencyCode);
  if (actualFees.length) next.actualFees = actualFees;

  return next;
}

export function isReturnedProfitFeeValue(value) {
  const text = String(value ?? '').trim();
  return Boolean(text) && text !== '未返回' && text !== '待确认';
}

export function getProfitFeeValueByLabel(items = [], labels = [], fallback = '未返回') {
  const safeLabels = labels.map((label) => String(label || '').trim()).filter(Boolean);
  const matched = (items || []).find((item) => safeLabels.includes(String(item?.label || '').trim()));
  return matched?.value ?? fallback;
}

export function getProfitActualFeeValueByLabel(items = [], labels = [], fallback = '未返回') {
  const value = getProfitFeeValueByLabel(items, labels, fallback);
  return isReturnedProfitFeeValue(value) ? value : fallback;
}

export function getProfitLedgerEstimatedTotalDeductionValue(ledger = null) {
  const amounts = ledger?.amounts;
  if (!amounts) return null;
  return sumNullable([
    getProfitLedgerEntryValue(amounts.estimatedOzonFeeCny),
    getProfitLedgerEntryValue(amounts.sourcePurchaseCostCny),
    getProfitLedgerEntryValue(amounts.logisticsFeeCny),
    getProfitLedgerEntryValue(amounts.estimatedCrossBorderBusFeeCny || amounts.crossBorderBusFeeCny),
  ]);
}

export function getProfitDetailOrderInfo(selectedOrder = null, context = {}) {
  if (!selectedOrder) return null;
  const purchaseOrder = buildProfitPurchaseOrderForLogistics(selectedOrder, context);
  const purchaseOverride = getProfitPurchaseOrderOverride(purchaseOrder, context.purchaseLocalOverrides);
  const purchaseInfo = getPurchaseInfoSupport(purchaseOrder, purchaseOverride);
  const raw = selectedOrder.raw ?? {};
  const ozonOrderId = firstUsableOzonId(
    selectedOrder.softwareOrderId,
    raw.order_number,
    raw.orderNumber,
    raw.order_id,
    raw.orderId,
    getProfitPostingBaseKey(selectedOrder.id),
    selectedOrder.id
  );
  const offerId = firstUsableOzonId(
    selectedOrder.offerId,
    selectedOrder.sku,
    selectedOrder.products?.[0]?.offerId,
    selectedOrder.products?.[0]?.sku,
    purchaseOrder.productNo,
    purchaseOrder.sku
  );
  return {
    ozonOrderId: ozonOrderId || '未返回',
    offerId: offerId || '未返回',
    shop: selectedOrder.shop || purchaseOrder.shop || '未返回',
    paymentTime: selectedOrder.paymentDate
      ? formatShopBindingTime(selectedOrder.paymentDate, selectedOrder.paymentTime || '未返回')
      : selectedOrder.paymentTime || '未返回',
    purchasePlatform: purchaseInfo.platform || purchaseOrder.buyerPlatform || purchaseOrder.supplier || '未返回',
    purchaseOrderNo: purchaseInfo.orderNumber || purchaseOrder.purchaseOrderNo || '未返回',
    purchaseCost: purchaseInfo.cost || '未返回',
  };
}

export function getProfitDetailRealStatusLabel(selectedOrder = null) {
  if (!selectedOrder) return '';
  const raw = selectedOrder.raw ?? {};
  return (
    firstFilled(
      selectedOrder.afterSalesStatus,
      selectedOrder.ozonStatusLabel,
      selectedOrder.ozonStatus,
      selectedOrder.statusLabel,
      selectedOrder.status,
      raw.status,
      raw.substatus,
      raw.posting_status,
      raw.postingStatus,
      raw.analytics_data?.status,
      raw.financial_data?.status
    ) || ''
  );
}

export function getProfitDetailEstimateSummary(selectedOrder = null) {
  if (!selectedOrder) return [];
  const ledger = selectedOrder.profitLedger;
  const currencyCode = selectedOrder.currencyCode || 'CNY';
  return [
    {
      label: '销售收入',
      value: getProfitLedgerEntryDisplay(
        ledger?.amounts?.salesAmountCny,
        currencyCode,
        selectedOrder.salesAmount || '未返回'
      ),
      hint: getProfitLedgerFormulaHint(
        '销售收入',
        'Ozon订单金额 × 卢布汇率，已是人民币时直接取订单金额',
        ledger?.amounts?.salesAmountCny
      ),
    },
    {
      label: '总预估扣费',
      value: getProfitDisplayStatus(getProfitLedgerEstimatedTotalDeductionValue(ledger), currencyCode),
      hint: '总预估扣费；公式：商品佣金 + 收单业务 + 配送服务 + 物流预估 + 货源成本 + 巴士费用；来源：利润台账 amounts',
    },
    {
      label: '预估利润',
      value: getProfitLedgerResultDisplay(
        ledger?.results?.estimatedProfitCny,
        currencyCode,
        selectedOrder.estimatedProfit || '待确认'
      ),
      tone: getProfitValueClass(
        getProfitLedgerResultDisplay(
          ledger?.results?.estimatedProfitCny,
          currencyCode,
          selectedOrder.estimatedProfit || '待确认'
        )
      ),
      hint: getProfitLedgerFormulaHint('预估利润', '销售收入 - 总预估扣费', ledger?.results?.estimatedProfitCny),
    },
  ];
}

export function getProfitDetailActualFees(selectedOrder = null) {
  if (!selectedOrder) return [];
  const currencyCode = selectedOrder.currencyCode || 'CNY';
  const ledgerFees = getProfitLedgerActualFees(selectedOrder.profitLedger, currencyCode);
  if (ledgerFees.length) return ledgerFees;
  const actualFees = selectedOrder.actualFees ?? [];
  const zeroActualFee = getProfitDisplayMoney(0, currencyCode);
  return [
    {
      label: '佣金扣费',
      value: getProfitActualFeeValueByLabel(actualFees, ['佣金扣费', '销售佣金'], zeroActualFee),
      hint: '佣金扣费；公式：Ozon财务流水佣金扣费汇总；来源：actualFees / finance ledger',
    },
    {
      label: '罚款扣费',
      value: getProfitActualFeeValueByLabel(actualFees, ['罚款扣费', '罚款', '赔偿扣费'], zeroActualFee),
      hint: '罚款扣费；公式：Ozon财务流水罚款 + rating罚款证据；来源：actualFees / rating penalty',
    },
    {
      label: '收单扣费',
      value: getProfitActualFeeValueByLabel(actualFees, ['收单扣费', '收单业务'], zeroActualFee),
      hint: '收单扣费；公式：Ozon财务流水收单扣费汇总；来源：actualFees / finance ledger',
    },
    {
      label: '配送服务',
      value: getProfitActualFeeValueByLabel(actualFees, ['配送服务'], zeroActualFee),
      hint: '配送服务；公式：Ozon财务流水配送服务扣费汇总；来源：actualFees / finance ledger',
    },
    {
      label: '物流扣费',
      value: getProfitActualFeeValueByLabel(actualFees, ['物流扣费'], zeroActualFee),
      hint: '物流扣费；公式：Ozon财务流水物流扣费汇总；来源：actualFees / finance ledger',
    },
    {
      label: '巴士费用',
      value: getProfitActualFeeValueByLabel(actualFees, ['巴士费用'], zeroActualFee),
      hint: '巴士费用；公式：已预报跨境巴士订单按费用设置扣费；已核查无预报记录的关闭订单为0；来源：profit ledger',
    },
  ];
}

export { getProfitActualStatusText, isProfitFinalZeroAllowedStatus };

export function isProfitCompletedStatus(statusText = '') {
  return /成功订单|已签收|签收|已送达|delivered|received|signed|success/.test(statusText);
}

export function isProfitInProgressStatus(statusText = '') {
  return /等待|待发货|待备货|即将超时|发货超时|配送超时|已经发货|已发货|发货中|运输中|派送|awaiting|deliver|shipping|in_transit|processing/.test(
    statusText
  );
}

export function getProfitActualFinanceStatus(
  order = {},
  { financeLookupChecked = false, financeOperations = [], afterSalesRows = [] } = {}
) {
  const statusText = getProfitActualStatusText(order, afterSalesRows);
  const financeEvidence = getProfitFinanceEvidenceSummary(financeOperations);
  const hasSignedRefund =
    afterSalesRows.some((row) => isAfterSalesSignedRefundStatus(row?.status || row?.type)) ||
    /签收后退款|signed\s*refund/iu.test(statusText) ||
    (isProfitCompletedStatus(statusText) && /moneyreturned|money_returned/iu.test(statusText));
  const hasRefund =
    hasSignedRefund ||
    afterSalesRows.some((row) => isAfterSalesRefundLossStatus(row?.status || row?.type)) ||
    /拒收后退款|已退款|退款|moneyreturned|money_returned|refund/iu.test(statusText);

  if (financeEvidence.operationCount > 0) {
    if (!financeLookupChecked) {
      if (hasRefund || isProfitCompletedStatus(statusText)) return 'pending';
      return isProfitInProgressStatus(statusText) ? 'provisional' : 'pending';
    }
    if (isPartialCompensationSale(order)) return 'confirmed';
    if (hasSignedRefund) return financeEvidence.hasSignedRefundClosure ? 'confirmed' : 'pending';
    if (hasRefund) {
      const hasFinalZeroFinanceClosure =
        isProfitFinalZeroAllowedStatus(statusText) && financeEvidence.hasBalancedAcquiringRedistributionClosure;
      return financeEvidence.hasRefundDeductionOperation || hasFinalZeroFinanceClosure ? 'confirmed' : 'pending';
    }
    if (isProfitCompletedStatus(statusText)) {
      return financeEvidence.hasDeliveredSaleOperation ? 'confirmed' : 'pending';
    }
    if (isProfitInProgressStatus(statusText)) return 'provisional';
    if (isProfitFinalZeroAllowedStatus(statusText)) return 'confirmed';
    return financeEvidence.hasDeliveredSaleOperation ? 'confirmed' : 'pending';
  }
  if (isProfitFinalZeroAllowedStatus(statusText)) return financeLookupChecked ? 'confirmed' : 'pending';
  if (isProfitCompletedStatus(statusText)) return 'pending';
  if (isProfitInProgressStatus(statusText)) return 'provisional';
  if (!financeLookupChecked) return 'provisional';
  return 'pending';
}

export function rebuildProfitLedgerWithManualOverride(order = {}, fieldId = '', amountValue = null) {
  const ledger = order.profitLedger;
  if (!ledger?.amounts) return null;
  const amountKeys = [
    'salesAmountCny',
    'actualSalesAmountCny',
    'sourcePurchaseCostCny',
    'estimatedCommissionFeeCny',
    'estimatedAcquiringFeeCny',
    'estimatedDeliveryServiceFeeCny',
    'estimatedOzonFeeCny',
    'actualOzonFeeCny',
    'actualCommissionFeeCny',
    'actualPenaltyFeeCny',
    'actualAcquiringFeeCny',
    'actualDeliveryServiceFeeCny',
    'actualLogisticsFeeCny',
    'platformNetCny',
    'estimatedCrossBorderBusFeeCny',
    'actualCrossBorderBusFeeCny',
    'crossBorderBusFeeCny',
    'logisticsFeeCny',
    'refundOrderDeductionFeeCny',
  ];
  const amounts = {};
  amountKeys.forEach((key) => {
    amounts[key] = key === 'actualCrossBorderBusFeeCny'
      ? ledger.amounts?.[key]
      : getProfitLedgerEntryValue(ledger.amounts?.[key]);
  });
  const number = firstFiniteNumber(amountValue);
  if (!PROFIT_MANUAL_OVERRIDE_FIELDS[fieldId] || number === null || number < 0) return null;
  amounts[fieldId] = number;

  const actualStatusText = getProfitActualStatusText(order, []);
  const actualEntries = [
    ledger.amounts.actualCommissionFeeCny,
    ledger.amounts.actualPenaltyFeeCny,
    ledger.amounts.actualAcquiringFeeCny,
    ledger.amounts.actualDeliveryServiceFeeCny,
    ledger.amounts.actualLogisticsFeeCny,
    ledger.amounts.actualOzonFeeCny,
  ];
  const hasAnyActualEntry = actualEntries.some((entry) =>
    ['ready', 'provisional'].includes(String(entry?.status || '').trim())
  );
  const previousActualFinanceStatus = String(ledger.actualFinanceStatus || '').trim();
  const actualFinanceStatus = ['confirmed', 'provisional'].includes(previousActualFinanceStatus)
    ? previousActualFinanceStatus
    : getProfitActualFinanceStatus(order, {
        financeLookupChecked: hasAnyActualEntry,
        financeOperations: [],
      });
  const isFinalZeroStatus = isProfitFinalZeroAllowedStatus(actualStatusText);
  return createProfitLedgerRow(order, {
    orderKey: getProfitOrderRecordKey(order) || getProfitOrderStableRecordKey(order),
    amounts,
    hasActualFinance: ['confirmed', 'provisional'].includes(actualFinanceStatus),
    actualFinanceStatus,
    actualCrossBorderBusFeeSource: ledger.amounts?.actualCrossBorderBusFeeCny?.source || '',
    crossBorderChargeEvidence: ledger.amounts?.actualCrossBorderBusFeeCny?.evidence ?? null,
    crossBorderChargeUpdatedAt: ledger.amounts?.actualCrossBorderBusFeeCny?.updatedAt || '',
    financeOperationCount: ledger.financeOperationCount,
    afterSalesCount: ledger.afterSalesCount,
    forceActualProfitPending:
      !isFinalZeroStatus && !isProfitCompletedStatus(actualStatusText) && isProfitInProgressStatus(actualStatusText),
    allowZeroPurchaseCost: amounts.sourcePurchaseCostCny === 0,
    hasRefundLoss: Boolean(order.signedRefundLoss || isAfterSalesRefundLossStatus(order.afterSalesStatus)),
    updatedAt: new Date().toISOString(),
  });
}

export function normalizeOzonProfitOrder(order = {}, context = {}) {
  order = prepareProfitCalculationOrder(order, order.profitLedger);
  const priceInfoMap = context.priceInfoMap ?? new Map();
  const financeIndex = context.financeIndex ?? new Map();
  const ratingPenaltyIndex = context.ratingPenaltyIndex ?? new Map();
  const financeLookupCheckedIndex = context.financeLookupCheckedIndex ?? new Map();
  const afterSalesIndex = context.afterSalesIndex ?? new Map();
  const firstProduct = order.products?.[0] ?? {};
  const sourceCurrencyCode = getProfitSalesCurrencyCode(order);
  const currencyCode = 'CNY';
  const contextExchangeRates = {
    estimated: context.estimatedExchangeRate ?? context.exchangeRates?.estimated ?? context.exchangeRate,
    actual: context.actualExchangeRate ?? context.exchangeRates?.actual,
  };
  const orderWithContextExchangeRates = {
    ...order,
    rubToCnyRate: context.rubToCnyRate ?? order.rubToCnyRate,
    exchangeRate: context.exchangeRate ?? order.exchangeRate,
    estimatedExchangeRate: contextExchangeRates.estimated ?? order.estimatedExchangeRate,
    actualExchangeRate: contextExchangeRates.actual ?? order.actualExchangeRate,
    exchangeRates: {
      ...(order.exchangeRates ?? {}),
      ...(context.exchangeRates ?? {}),
      ...(contextExchangeRates.estimated ? { estimated: contextExchangeRates.estimated } : {}),
      ...(contextExchangeRates.actual ? { actual: contextExchangeRates.actual } : {}),
    },
  };
  const initialExchangeRates = buildOrderExchangeRateBundle(
    orderWithContextExchangeRates,
    {},
    { includeActual: false }
  );
  const exchangeRate = initialExchangeRates.estimated;
  const rubToCnyRate = firstFiniteNumber(exchangeRate?.rubToCnyRate, context.rubToCnyRate);
  const productFees = (order.products ?? []).map((product) =>
    getProfitProductEstimatedFees(product, getProfitProductPriceInfo(product, priceInfoMap), { rubToCnyRate })
  );
  const salesValue = firstFiniteNumber(order.amountValue, order.amount);
  const productSalesValueCny = sumNullable(
    (order.products ?? []).map((product) =>
      convertProfitAmountToCny(
        getOzonOrderProductSalesAmount(product),
        firstFilled(
          product.currencyCode,
          product.currency_code,
          product.raw?.currencyCode,
          product.raw?.currency_code,
          getProfitSalesCurrencyCode(order)
        ),
        {
          rubToCnyRate,
        }
      )
    )
  );
  const salesValueCny =
    convertProfitAmountToCny(salesValue, sourceCurrencyCode, { rubToCnyRate }) ?? productSalesValueCny;
  const productEstimatedCommissionValueCny = sumNullable(
    productFees.map((item) => convertProfitAmountToCny(item.commissionValue, item.currencyCode, { rubToCnyRate }))
  );
  const orderCommissionPercent = firstCommissionRate(
    order.commissionPercent,
    order.raw?.commissionPercent,
    order.raw?.commission_percent
  );
  const estimatedCommissionValueCny =
    productEstimatedCommissionValueCny ??
    calculateCommissionFeeCny({
      orderAmountCny: salesValueCny,
      commissionPercent: orderCommissionPercent,
      rubToCnyRate,
    });
  const estimatedAcquiringValueCny = sumNullable(
    productFees.map((item) => convertProfitAmountToCny(item.acquiringValue, item.currencyCode, { rubToCnyRate }))
  );
  const estimatedDeliveryValueCny = calculateDeliveryServiceFeeCny({
    deliveryServiceFeeRub: OZON_MILEAGE_FEE_RUB,
    rubToCnyRate,
  });
  const estimatedOzonFeeValueCny = sumNullable([
    estimatedCommissionValueCny,
    estimatedAcquiringValueCny,
    estimatedDeliveryValueCny,
  ]);
  const financeOperations = getProfitOrderFinanceOperations(order, financeIndex, {
    financeParentFallbackIndex: context.financeParentFallbackIndex,
  });
  const exchangeRates = buildOrderExchangeRateBundle(orderWithContextExchangeRates, {}, { financeOperations });
  const actualExchangeRate = exchangeRates.actual;
  const actualRubToCnyRate = actualExchangeRate?.rubToCnyRate ?? null;
  const penaltyFinanceOperations = getProfitOrderPenaltyFinanceOperations(order, financeIndex);
  const ratingPenaltyOperations = getProfitOrderRatingPenaltyOperations(order, ratingPenaltyIndex);
  const penaltyOperations = mergeProfitPenaltyOperations(penaltyFinanceOperations, ratingPenaltyOperations, {
    rubToCnyRate: actualRubToCnyRate,
  });
  const financeLookupChecked = isProfitOrderFinanceLookupChecked(order, financeLookupCheckedIndex);
  const financeEvidence = getProfitFinanceEvidenceSummary(financeOperations);
  const hasFinanceRefund = financeEvidence.hasRefundDeductionOperation
    || (!financeLookupChecked && order.hasFinanceRefund === true);
  const financeBreakdown = getFinanceBreakdown(financeOperations);
  const profitDetailActualFeeBreakdown = getProfitDetailActualFeeBreakdown(financeOperations, {
    rubToCnyRate: actualRubToCnyRate,
  });
  const profitPenaltyDetails = getProfitPenaltyDetails(penaltyOperations, {
    rubToCnyRate: actualRubToCnyRate,
    shopId: order.shopId,
    shopClientId: order.shopClientId,
    postingNumber: firstUsableOzonId(order.id, order.posting, order.raw?.posting_number, order.raw?.postingNumber),
    orderId: firstUsableOzonId(order.salesOrder, order.raw?.order_number, order.raw?.orderNumber, order.raw?.order_id),
  });
  const afterSalesRows = getProfitOrderAfterSalesRows(order, afterSalesIndex);
  const refundLossRow = afterSalesRows.find((row) => isAfterSalesRefundLossStatus(row.status)) ?? null;
  const signedRefundRow = afterSalesRows.find((row) => isAfterSalesSignedRefundStatus(row.status)) ?? null;
  const hasRefundLoss = Boolean(refundLossRow);
  const compensation = readPartialCompensationEvidence(financeOperations, { rubToCnyRate: actualRubToCnyRate });
  const fullRefundConfirmed = afterSalesRows.some(row => getAfterSalesPendingRemovalReason(row) === 'full-refund-completed');
  const partialCompensationOnly = !fullRefundConfirmed && (financeLookupChecked
    ? compensation.partialOnly && isPartialCompensationSale({ ...order, partialCompensationOnly: true, hasFinanceRefund })
    : isPartialCompensationSale(order));
  const buyerCompensationCny = financeLookupChecked ? compensation.amountCny
    : order.profitLedger?.amounts?.buyerCompensationCny?.value ?? order.buyerCompensationCny ?? null;
  const hasAfterSalesRefund =
    !partialCompensationOnly && (Boolean(refundLossRow || signedRefundRow) ||
    afterSalesRows.some((row) => /moneyreturned|money_returned|已退款|退款|refund/iu.test(`${row?.status} ${row?.type}`))
    || (!afterSalesRows.length && order.hasAfterSalesRefund === true));
  const normalizedAfterSalesStatus = normalizeAfterSalesStatus(
    refundLossRow?.status || signedRefundRow?.status || afterSalesRows[0]?.status || order.afterSalesStatus || ''
  );
  const afterSalesSearchValues = [
    ...new Set(
      afterSalesRows.flatMap((row) =>
        getAssociatedOrderSearchValues(row, [row.id, row.salesOrder, row.reason, row.status, row.type])
      )
    ),
  ];
  const orderForLedger = {
    ...order,
    afterSalesStatus: normalizedAfterSalesStatus,
    hasAfterSalesRefund,
    hasFinanceRefund,
    partialCompensationOnly,
    afterSalesSearchValues,
    afterSalesSearchText: afterSalesSearchValues.join(' '),
  };
  const purchaseOrderWithLocalOverride = buildProfitPurchaseOrderWithLocalOverride(orderForLedger, context);
  const productCostValue = getProfitOrderProductCost(
    {
      ...orderForLedger,
      afterSalesStatus: normalizedAfterSalesStatus,
    },
    context
  );
  const estimatedCrossBorderFeeValue = getProfitEstimatedCrossBorderBusFeeValueCny(order, context, afterSalesRows);
  const logisticsFeeValueCny = getProfitLogisticsEstimateValueCny(order, context);
  const rawActualFinanceStatus = getProfitActualFinanceStatus(orderForLedger, {
    financeLookupChecked,
    financeOperations,
    afterSalesRows,
  });
  const actualStatusText = getProfitActualStatusText(orderForLedger, afterSalesRows);
  const isFinalZeroStatus = !partialCompensationOnly && isProfitFinalZeroAllowedStatus(actualStatusText);
  const hasReadyFinalPenaltyEvidence = isFinalZeroStatus && profitPenaltyDetails.hasReadyPenaltyAmount === true;
  const effectiveFinanceLookupChecked = financeLookupChecked || hasReadyFinalPenaltyEvidence;
  const actualSalesValueCny = partialCompensationOnly
    ? (salesValueCny != null && buyerCompensationCny != null ? salesValueCny - buyerCompensationCny : null)
    : isFinalZeroStatus || hasAfterSalesRefund || hasFinanceRefund ? 0 : salesValueCny;
  const actualFinanceStatus =
    financeOperations.length > 0 && actualRubToCnyRate === null
      ? 'pending'
      : hasReadyFinalPenaltyEvidence
        ? 'confirmed'
        : rawActualFinanceStatus;
  const actualCrossBorderFeeValue = getProfitActualCrossBorderBusFeeValueCny(
    orderForLedger,
    {
      ...context,
      actualFinanceStatus,
      financeLookupChecked: effectiveFinanceLookupChecked,
    },
    afterSalesRows
  );
  const hasActualFinance = actualFinanceStatus === 'confirmed' || actualFinanceStatus === 'provisional';
  const platformNetValueCny = hasActualFinance
    ? convertOzonRubToCny(financeBreakdown.platformNet ?? 0, { rubToCnyRate: actualRubToCnyRate })
    : null;
  const platformRealDeductionTotalCny = hasActualFinance
    ? convertOzonRubToCny(financeBreakdown.total ?? 0, { rubToCnyRate: actualRubToCnyRate })
    : null;
  const actualCommissionFeeValueCny = hasActualFinance
    ? convertOzonRubToCny(profitDetailActualFeeBreakdown.salesCommission ?? 0, { rubToCnyRate: actualRubToCnyRate })
    : null;
  const requiresDirectPenaltyFee = hasActualFinance && profitPenaltyDetails.status === 'pending';
  const actualPenaltyFeeValueCny = hasActualFinance ? profitPenaltyDetails.totalCny : null;
  const actualAcquiringFeeValueCny = hasActualFinance
    ? convertOzonRubToCny(profitDetailActualFeeBreakdown.acquiring ?? 0, { rubToCnyRate: actualRubToCnyRate })
    : null;
  const actualDeliveryServiceFeeValueCny = hasActualFinance
    ? convertOzonRubToCny(profitDetailActualFeeBreakdown.deliveryService ?? 0, {
        rubToCnyRate: actualRubToCnyRate,
      })
    : null;
  const actualLogisticsFeeValueCny = hasActualFinance
    ? convertOzonRubToCny(profitDetailActualFeeBreakdown.logistics ?? 0, { rubToCnyRate: actualRubToCnyRate })
    : null;
  const actualOzonFeeValueCny = hasActualFinance
    ? requiresDirectPenaltyFee
      ? null
      : (sumNullable([
          actualCommissionFeeValueCny,
          actualPenaltyFeeValueCny,
          actualAcquiringFeeValueCny,
          actualDeliveryServiceFeeValueCny,
          actualLogisticsFeeValueCny,
        ]) ?? platformRealDeductionTotalCny)
    : null;
  const refundOrderDeductionValueCny = hasActualFinance
    ? convertOzonRubToCny(financeBreakdown.other ?? 0, { rubToCnyRate: actualRubToCnyRate })
    : null;
  const profitRecordKey = getProfitOrderStableRecordKey(order);
  const profitLedger = createProfitLedgerRow(orderForLedger, {
    ...(compensation.operationCount > 0 || partialCompensationOnly ? { buyerCompensationCny } : {}),
    orderKey: profitRecordKey,
    rubToCnyRate,
    exchangeRate,
    estimatedExchangeRate: exchangeRates.estimated,
    actualExchangeRate: exchangeRates.actual,
    exchangeRates,
    purchaseOverrides: context.purchaseLocalOverrides,
    sourceRecords: context.sourceRecords,
    // Preserve the existing distinction between a cache miss and a confirmed
    // zero. A not-yet-loaded purchase record must not erase a saved cost.
    allowZeroPurchaseCost: productCostValue === 0 && resolveProfitPurchaseCost(orderForLedger, {
      purchaseOverrides: context.purchaseLocalOverrides,
      sourceRecords: context.sourceRecords,
      amounts: context.amounts,
      allowZeroPurchaseCost: context.allowZeroPurchaseCost,
    }).source !== 'missing-purchase-cost-zero',
    hasActualFinance,
    actualFinanceStatus,
    financeLookupChecked: effectiveFinanceLookupChecked,
    profitFinanceVersion: context.profitFinanceVersion,
    actualCrossBorderBusFeeSource:
      purchaseOrderWithLocalOverride.actualCrossBorderBusFeeSource ||
      purchaseOrderWithLocalOverride.crossBorderChargeEvidence?.source ||
      '',
    crossBorderChargeEvidence: purchaseOrderWithLocalOverride.crossBorderChargeEvidence ?? null,
    crossBorderChargeUpdatedAt:
      purchaseOrderWithLocalOverride.crossBorderUpdatedAt ||
      purchaseOrderWithLocalOverride.crossBorderChargeEvidence?.updatedAt ||
      '',
    crossBorderOrderFound: purchaseOrderWithLocalOverride.crossBorderOrderFound === true,
    packageOrderId: purchaseOrderWithLocalOverride.packageOrderId || '',
    packageOrderIds: Array.isArray(purchaseOrderWithLocalOverride.packageOrderIds)
      ? purchaseOrderWithLocalOverride.packageOrderIds
      : [],
    crossBorderOrderId: purchaseOrderWithLocalOverride.crossBorderOrderId || '',
    crossBorderOrderNumber: purchaseOrderWithLocalOverride.crossBorderOrderNumber || '',
    financeOperationCount: financeOperations.length,
    afterSalesCount: afterSalesRows.length,
    actualPenaltyFeeRequiresDirectAmount: requiresDirectPenaltyFee,
    penaltyDetails: profitPenaltyDetails.records,
    penaltySummary: profitPenaltyDetails,
    forceActualProfitPending:
      !isFinalZeroStatus && !isProfitCompletedStatus(actualStatusText) && isProfitInProgressStatus(actualStatusText),
    hasRefundLoss,
    updatedAt: context.fetchedAt || new Date().toISOString(),
    amounts: {
      salesAmountCny: salesValueCny,
      actualSalesAmountCny: actualSalesValueCny,
      sourcePurchaseCostCny: productCostValue,
      estimatedCommissionFeeCny: estimatedCommissionValueCny,
      estimatedAcquiringFeeCny: estimatedAcquiringValueCny,
      estimatedDeliveryServiceFeeCny: estimatedDeliveryValueCny,
      actualOzonFeeCny: actualOzonFeeValueCny,
      actualCommissionFeeCny: actualCommissionFeeValueCny,
      actualPenaltyFeeCny: actualPenaltyFeeValueCny,
      actualAcquiringFeeCny: actualAcquiringFeeValueCny,
      actualDeliveryServiceFeeCny: actualDeliveryServiceFeeValueCny,
      actualLogisticsFeeCny: actualLogisticsFeeValueCny,
      platformNetCny: platformNetValueCny,
      estimatedCrossBorderBusFeeCny: estimatedCrossBorderFeeValue,
      actualCrossBorderBusFeeCny: actualCrossBorderFeeValue,
      crossBorderBusFeeCny: estimatedCrossBorderFeeValue,
      logisticsFeeCny: logisticsFeeValueCny,
      refundOrderDeductionFeeCny: refundOrderDeductionValueCny,
    },
  });
  const estimatedProfitValue = profitLedger.results.estimatedProfitCny.value;
  const actualProfitValue = profitLedger.results.actualProfitCny.value;
  const refundLossValue = profitLedger.results.refundLossCny.value;
  const signedRefundLossValue = refundLossValue === null ? null : -refundLossValue;
  const profitLossValue =
    signedRefundLossValue !== null
      ? signedRefundLossValue
      : actualProfitValue !== null
        ? actualProfitValue
        : estimatedProfitValue;
  const profitLossSource =
    signedRefundLossValue !== null || actualProfitValue !== null
      ? 'actual'
      : estimatedProfitValue !== null
        ? 'estimated'
        : 'pending';
  const status = getProfitResultStatusLabel(profitLossValue);
  const profitPurchaseInfo = getProfitDetailOrderInfo(order, context);

  return {
    ...order,
    afterSalesSearchValues,
    afterSalesSearchText: afterSalesSearchValues.join(' '),
    profitLedger,
    profitFinanceVersion: context.profitFinanceVersion || order.profitFinanceVersion || '',
    profitRecordKey,
    id: order.id || order.posting || '未返回',
    offerId: firstProduct.offerId || order.sku || '未返回',
    skuId: firstProduct.skuId || '未返回',
    product: order.product || firstProduct.name || '未返回',
    qty: order.items || firstProduct.qty || 1,
    salesAmount: getProfitDisplayCny(salesValueCny, '未返回'),
    estimatedProfit: getSignedProfitDisplay(estimatedProfitValue, currencyCode),
    actualProfit: getSignedProfitDisplay(actualProfitValue, currencyCode, '待确认'),
    profitLoss: getSignedProfitDisplay(profitLossValue, currencyCode),
    profitLossValue,
    profitLossSource,
    profitLossEstimatedFallback: profitLossSource === 'estimated',
    estimatedProfitValue,
    actualProfitValue,
    estimatedOzonFeeValueCny,
    purchasePlatform: profitPurchaseInfo?.purchasePlatform,
    purchaseOrderNo: profitPurchaseInfo?.purchaseOrderNo,
    purchaseCost: profitPurchaseInfo?.purchaseCost,
    sourcePurchaseCostCny: productCostValue,
    sourceRecords: Array.isArray(context.sourceRecords) ? context.sourceRecords.slice(0, 6) : order.sourceRecords,
    signedRefundLossValue,
    afterSalesStatus: normalizedAfterSalesStatus,
    hasAfterSalesRefund,
    hasFinanceRefund,
    signedRefundLoss: hasRefundLoss,
    type:
      profitLossValue !== null && profitLossValue < 0
        ? 'loss'
        : actualProfitValue !== null
          ? 'actual'
          : estimatedProfitValue !== null
            ? 'estimated'
            : 'pending',
    detailStatus: status,
    currencyCode,
    sourceCurrencyCode,
    rubToCnyRate,
    exchangeRate,
    estimatedExchangeRate: exchangeRates.estimated,
    actualExchangeRate: exchangeRates.actual,
    exchangeRates,
  };
}
