import { convertFeeAmountToCny, normalizeFeeCurrencyCode } from './feeCalculationService.js';

function firstFilled(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const rawText = String(value).trim().replace(/\s+/g, '');
  const commaIndex = rawText.lastIndexOf(',');
  const dotIndex = rawText.lastIndexOf('.');
  const normalizedText =
    commaIndex > -1 && commaIndex > dotIndex ? rawText.replace(/\./g, '').replace(',', '.') : rawText.replace(/,/g, '');
  const text = normalizedText.replace(/[^\d.+-]/g, '');
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function getFinanceOperationSaleCommission(operation = {}) {
  return toFiniteNumber(
    firstFilled(
      operation.sale_commission,
      operation.saleCommission,
      operation.sale_commission_cny,
      operation.saleCommissionCny,
      operation.raw?.sale_commission,
      operation.raw?.saleCommission,
      operation.raw?.sale_commission_cny,
      operation.raw?.saleCommissionCny
    )
  );
}

const OZON_DIRECT_PENALTY_FEE_PATHS = [
  ['error_fee'],
  ['error_fee_cny'],
  ['errorFee'],
  ['error_fee_amount'],
  ['error_fee_amount_cny'],
  ['errorFeeAmount'],
  ['error_cost'],
  ['error_cost_cny'],
  ['errorCost'],
  ['fine_fee'],
  ['fine_fee_cny'],
  ['fineFee'],
  ['fine_amount'],
  ['fine_amount_cny'],
  ['fineAmount'],
  ['penalty_fee'],
  ['penalty_fee_cny'],
  ['penaltyFee'],
  ['penalty_amount'],
  ['penalty_amount_cny'],
  ['penaltyAmount'],
  ['defect_fine_fee'],
  ['defect_fine_fee_cny'],
  ['defectFineFee'],
  ['defect_fine_amount'],
  ['defect_fine_amount_cny'],
  ['defectFineAmount'],
  ['seller_fault_fee'],
  ['seller_fault_fee_cny'],
  ['sellerFaultFee'],
  ['错误费用'],
  ['错误费用金额'],
  ['罚款金额'],
  ['罚款扣费'],
  ['罚款费用'],
  ['posting', 'error_fee'],
  ['posting', 'error_fee_cny'],
  ['posting', 'errorFee'],
  ['posting', 'error_fee_amount'],
  ['posting', 'error_fee_amount_cny'],
  ['posting', 'errorFeeAmount'],
  ['posting', 'fine_fee'],
  ['posting', 'fine_fee_cny'],
  ['posting', 'fineFee'],
  ['posting', 'penalty_fee'],
  ['posting', 'penalty_fee_cny'],
  ['posting', 'penaltyFee'],
  ['posting', '错误费用'],
  ['posting', '错误费用金额'],
  ['posting', '罚款金额'],
  ['posting', '罚款扣费'],
  ['posting', '罚款费用'],
  ['raw', 'error_fee'],
  ['raw', 'error_fee_cny'],
  ['raw', 'errorFee'],
  ['raw', 'error_fee_amount'],
  ['raw', 'error_fee_amount_cny'],
  ['raw', 'errorFeeAmount'],
  ['raw', 'fine_fee'],
  ['raw', 'fine_fee_cny'],
  ['raw', 'fineFee'],
  ['raw', 'penalty_fee'],
  ['raw', 'penalty_fee_cny'],
  ['raw', 'penaltyFee'],
  ['raw', '错误费用'],
  ['raw', '错误费用金额'],
  ['raw', '罚款金额'],
  ['raw', '罚款扣费'],
  ['raw', '罚款费用'],
];

const OZON_PENALTY_OPERATION_KEYWORDS = [
  'defectfine',
  'defect fine',
  'finecancellation',
  'penalty',
  'fine',
  'seller_fault',
  'sellerfault',
  'error_fee',
  'error fee',
  'cancel_due_to_seller',
  '因卖家',
  '卖家过失',
  '过失',
  '错误费用',
  '罚款',
  'штраф',
  'ошиб',
];

const OZON_OPERATION_ID_PATHS = [
  ['operation_id'],
  ['operationId'],
  ['operation_id_str'],
  ['transaction_id'],
  ['transactionId'],
  ['accrual_id'],
  ['accrualId'],
  ['raw', 'operation_id'],
  ['raw', 'operationId'],
  ['raw', 'transaction_id'],
  ['raw', 'transactionId'],
];

const OZON_OPERATION_POSTING_PATHS = [
  ['posting', 'posting_number'],
  ['posting', 'postingNumber'],
  ['posting_number'],
  ['postingNumber'],
  ['items', 0, 'posting_number'],
  ['items', 0, 'postingNumber'],
  ['raw', 'posting', 'posting_number'],
  ['raw', 'posting', 'postingNumber'],
  ['raw', 'posting_number'],
  ['raw', 'postingNumber'],
];

const OZON_OPERATION_DATE_PATHS = [
  ['operation_date'],
  ['operationDate'],
  ['created_at'],
  ['createdAt'],
  ['date'],
  ['raw', 'operation_date'],
  ['raw', 'operationDate'],
  ['raw', 'created_at'],
  ['raw', 'createdAt'],
  ['raw', 'date'],
];

const OZON_OPERATION_CURRENCY_PATHS = [
  ['currency_code'],
  ['currencyCode'],
  ['currency'],
  ['amount_currency'],
  ['amountCurrency'],
  ['amount_currency_code'],
  ['amountCurrencyCode'],
  ['posting', 'currency_code'],
  ['posting', 'currencyCode'],
  ['raw', 'currency_code'],
  ['raw', 'currencyCode'],
  ['raw', 'currency'],
  ['raw', 'amount_currency'],
  ['raw', 'amountCurrency'],
  ['raw', 'amount_currency_code'],
  ['raw', 'amountCurrencyCode'],
];

function getByPath(source = {}, path = []) {
  return path.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), source);
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function getFirstByPaths(source = {}, paths = []) {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function getPathText(path = []) {
  return path.map((part) => String(part)).join('.');
}

function detectCurrencyFromText(value) {
  const text = normalizeText(value);
  const lower = text.toLowerCase();
  if (!text) return '';
  if (text.includes('¥') || text.includes('￥') || lower.includes('cny') || lower.includes('rmb')) return 'CNY';
  if (text.includes('₽') || lower.includes('rub') || lower.includes('rur') || lower.includes('руб')) return 'RUB';
  return '';
}

function getPenaltyAmountCurrency(operation = {}, rawValue, path = [], options = {}) {
  const markerCurrency = detectCurrencyFromText(rawValue);
  if (markerCurrency) return markerCurrency;

  const lowerPathText = getPathText(path).toLowerCase();
  if (
    lowerPathText.includes('_cny') ||
    lowerPathText.includes('.cny') ||
    lowerPathText.includes('rmb') ||
    lowerPathText.includes('yuan')
  ) {
    return 'CNY';
  }
  if (lowerPathText.includes('_rub') || lowerPathText.includes('.rub') || lowerPathText.includes('rur')) {
    return 'RUB';
  }

  const directKey = path[path.length - 1];
  const parent = path.length > 1 ? getByPath(operation, path.slice(0, -1)) : operation;
  if (parent && typeof parent === 'object') {
    const siblingCurrency = firstFilled(
      parent[`${directKey}_currency_code`],
      parent[`${directKey}_currency`],
      parent.currency_code,
      parent.currencyCode,
      parent.currency
    );
    const normalizedSibling = normalizeFeeCurrencyCode(siblingCurrency);
    if (normalizedSibling) return normalizedSibling;
  }

  const operationCurrency = normalizeFeeCurrencyCode(getFirstByPaths(operation, OZON_OPERATION_CURRENCY_PATHS));
  if (operationCurrency) return operationCurrency;

  const optionCurrency = normalizeFeeCurrencyCode(options.currencyCode);
  return optionCurrency || normalizeFeeCurrencyCode(options.defaultCurrencyCode) || 'CNY';
}

function toPenaltyAmountCny(value, operation = {}, path = [], options = {}) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const currencyCode = getPenaltyAmountCurrency(operation, value, path, options);
  const converted = convertFeeAmountToCny(number, currencyCode, {
    rubToCnyRate: options.rubToCnyRate,
  });
  if (converted === null) return null;
  return {
    value: Math.abs(converted),
    currencyCode: normalizeFeeCurrencyCode(currencyCode) || 'CNY',
    rawValue: value,
    amountPath: getPathText(path),
  };
}

function getOzonDirectPenaltyFee(operation = {}, options = {}) {
  for (const path of OZON_DIRECT_PENALTY_FEE_PATHS) {
    const value = getByPath(operation, path);
    const amount = toPenaltyAmountCny(value, operation, path, options);
    if (amount !== null) return amount;
  }
  return null;
}

export function getFinanceOperationAmount(operation = {}) {
  return toFiniteNumber(
    firstFilled(
      operation.amount,
      operation.amount_total,
      operation.amountTotal,
      operation.operation_amount,
      operation.operationAmount,
      operation.price,
      operation.raw?.amount,
      operation.raw?.amount_total,
      operation.raw?.amountTotal
    )
  );
}

function getFinanceServicePrice(service = {}) {
  return toFiniteNumber(firstFilled(service.price, service.amount, service.cost));
}

function addFinanceNet(totals, key, value) {
  const number = toFiniteNumber(value);
  if (number === null || number === 0) return;
  totals[key] += number;
}

function addFinanceNamedCharge(map, label, value) {
  const number = toFiniteNumber(value);
  if (number === null || number === 0) return;
  const current = map.get(label) ?? 0;
  map.set(label, current + number);
}

function expenseFromNet(value) {
  const number = toFiniteNumber(value);
  if (number === null || number >= 0) return 0;
  return Math.abs(number);
}

export function classifyFinanceService(service = {}, operationType = '') {
  const text =
    `${operationType} ${service.name ?? ''} ${service.service_name ?? ''} ${service.type ?? ''}`.toLowerCase();
  if (text.includes('acquiring') || text.includes('эквайр') || text.includes('payment') || text.includes('收单'))
    return 'acquiring';
  if (
    text.includes('agency') ||
    text.includes('aggregator') ||
    text.includes('3pl') ||
    text.includes('agent') ||
    text.includes('агент') ||
    text.includes('международ')
  )
    return 'agency';
  if (
    text.includes('delivery') ||
    text.includes('logistic') ||
    text.includes('shipment') ||
    text.includes('first mile') ||
    text.includes('last mile') ||
    text.includes('достав') ||
    text.includes('配送') ||
    text.includes('物流')
  ) {
    return 'delivery';
  }
  if (text.includes('commission') || text.includes('комисс') || text.includes('佣金')) return 'salesCommission';
  return 'other';
}

function getFinanceServiceLabel(service = {}) {
  return firstFilled(service.name, service.service_name, service.serviceName, service.type) || '未知服务费';
}

function getFinanceOperationTypeKey(operation = {}) {
  return String(
    firstFilled(
      operation.operation_type,
      operation.operationType,
      operation.type,
      operation.operation_type_name,
      operation.operationTypeName
    )
  ).toLowerCase();
}

function getFinanceOperationName(operation = {}) {
  return String(
    firstFilled(
      operation.operation_type_name,
      operation.operationTypeName,
      operation.operation_type,
      operation.operationType,
      operation.type
    )
  );
}

function getFinanceOperationText(operation = {}) {
  return [
    operation.operation_type,
    operation.operationType,
    operation.type,
    operation.operation_type_name,
    operation.operationTypeName,
    operation.name,
    operation.description,
    operation.raw?.operation_type,
    operation.raw?.operationType,
    operation.raw?.operation_type_name,
    operation.raw?.operationTypeName,
    operation.raw?.name,
    operation.raw?.description,
    ...(Array.isArray(operation.services)
      ? operation.services.flatMap((service) => [service?.name, service?.service_name, service?.serviceName, service?.type])
      : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function getFinanceOperationPenaltyText(operation = {}) {
  return [
    operation.operation_type,
    operation.operationType,
    operation.type,
    operation.operation_type_name,
    operation.operationTypeName,
    operation.name,
    operation.description,
    operation.raw?.operation_type,
    operation.raw?.operationType,
    operation.raw?.operation_type_name,
    operation.raw?.operationTypeName,
    operation.raw?.name,
    operation.raw?.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isProfitPenaltyOperation(operation = {}) {
  const text = getFinanceOperationPenaltyText(operation);
  return OZON_PENALTY_OPERATION_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

function getOzonFinancePenaltyAmount(operation = {}, options = {}) {
  if (!isProfitPenaltyOperation(operation)) return null;
  const amount = firstFilled(
    operation.amount,
    operation.amount_total,
    operation.amountTotal,
    operation.operation_amount,
    operation.operationAmount,
    operation.raw?.amount,
    operation.raw?.amount_total,
    operation.raw?.amountTotal
  );
  return toPenaltyAmountCny(amount, operation, ['amount'], {
    ...options,
    defaultCurrencyCode: options.defaultFinanceCurrencyCode || 'RUB',
  });
}

function normalizeFinanceCategory(value = '') {
  if (value === 'agency') return 'deliveryService';
  if (value === 'delivery') return 'logistics';
  return value || 'other';
}

export function classifyFinanceOperationAmount(operation = {}) {
  const operationType = getFinanceOperationTypeKey(operation);
  const text = getFinanceOperationText(operation);
  if (isProfitPenaltyOperation(operation)) return 'penalty';
  if (operationType.includes('operationagentdeliveredtocustomer')) return 'income';
  if (operationType.includes('clientreturnagentoperation')) return 'other';
  if (operationType.includes('operationmarketplaceservicepartialcompensationtoclient')) return 'other';
  if (operationType.includes('marketplaceredistributionofacquiringoperation')) return 'acquiring';
  if (operationType.includes('operationmarketplaceagencyfeeaggregator3plglobal')) return 'deliveryService';
  if (operationType.includes('marketplaceredistributionofdeliveryservicesoperation')) return 'logistics';
  if (operationType.includes('salecommission')) return 'salesCommission';
  if (text.includes('эквайр') || text.includes('acquiring') || text.includes('收单')) return 'acquiring';
  if (text.includes('агент') || text.includes('aggregator') || text.includes('3pl') || text.includes('международ')) {
    return 'deliveryService';
  }
  if (
    text.includes('перевыставление услуг доставки') ||
    text.includes('redistributionofdelivery') ||
    text.includes('last mile') ||
    text.includes('lastmile') ||
    text.includes('物流扣') ||
    text.includes('物流费')
  ) {
    return 'logistics';
  }
  const classified = normalizeFinanceCategory(classifyFinanceService({}, text));
  return classified === 'other' ? 'other' : classified;
}

function getFinanceOperationId(operation = {}) {
  return normalizeText(getFirstByPaths(operation, OZON_OPERATION_ID_PATHS));
}

function getFinanceOperationPosting(operation = {}, options = {}) {
  return normalizeText(
    getFirstByPaths(operation, OZON_OPERATION_POSTING_PATHS) || options.postingNumber || options.orderId
  );
}

function getFinanceOperationDate(operation = {}) {
  return normalizeText(getFirstByPaths(operation, OZON_OPERATION_DATE_PATHS));
}

function getPenaltyFallbackDedupeKey(record = {}, options = {}) {
  return [
    normalizeText(options.shopClientId || options.shopId || record.shopClientId || record.shopId || 'unknown-shop'),
    normalizeText(record.postingNumber || options.postingNumber || options.orderId || 'unknown-order'),
    normalizeText(record.operationType || record.operationName || 'unknown-penalty'),
    record.amountCny === null || record.amountCny === undefined ? 'pending' : Number(record.amountCny).toFixed(4),
    normalizeText(record.operationDate).slice(0, 10),
    normalizeText(record.amountPath),
  ].join('|');
}

function normalizePenaltyRecord(operation = {}, amount = null, options = {}) {
  const operationId = getFinanceOperationId(operation);
  const operationName = getFinanceOperationName(operation) || getFinanceOperationTypeKey(operation) || 'Ozon penalty';
  const operationType = getFinanceOperationTypeKey(operation);
  const postingNumber = getFinanceOperationPosting(operation, options);
  const operationDate = getFinanceOperationDate(operation);
  const record = {
    schemaVersion: 1,
    status: amount ? 'ready' : 'pending',
    operationId,
    postingNumber,
    orderId: normalizeText(options.orderId),
    shopId: normalizeText(options.shopId),
    shopClientId: normalizeText(options.shopClientId),
    operationType,
    operationName,
    operationDate,
    amountCny: amount ? amount.value : null,
    currencyCode: amount ? amount.currencyCode : 'CNY',
    rawAmount: amount ? amount.rawValue : '',
    amountPath: amount ? amount.amountPath : '',
    reason: amount ? '' : 'penalty event without Ozon direct fee amount',
    source: 'ozon-finance-penalty-detail',
  };
  return {
    ...record,
    dedupeKey: operationId ? `operation:${operationId}` : getPenaltyFallbackDedupeKey(record, options),
  };
}

function mergePenaltyRecord(current = null, fresh = null) {
  if (!current) return fresh;
  if (!fresh) return current;
  if (fresh.status === 'ready' && current.status !== 'ready') return fresh;
  if (fresh.status === 'ready' && current.status === 'ready') {
    return {
      ...current,
      ...fresh,
      amountCny: fresh.amountCny,
    };
  }
  return current;
}

export function getProfitPenaltyDetails(operations = [], options = {}) {
  const byKey = new Map();

  (Array.isArray(operations) ? operations : []).forEach((operation) => {
    const amount = getOzonDirectPenaltyFee(operation, options) ?? getOzonFinancePenaltyAmount(operation, options);
    if (!amount && !isProfitPenaltyOperation(operation)) return;

    const record = normalizePenaltyRecord(operation, amount, options);
    const current = byKey.get(record.dedupeKey);
    byKey.set(record.dedupeKey, mergePenaltyRecord(current, record));
  });

  const records = [...byKey.values()];
  const pendingRecords = records.filter((record) => record.status !== 'ready');
  const readyRecords = records.filter((record) => record.status === 'ready');
  const totalCny = pendingRecords.length
    ? null
    : readyRecords.reduce((sum, record) => sum + (toFiniteNumber(record.amountCny) ?? 0), 0);

  return {
    schemaVersion: 1,
    status: pendingRecords.length ? 'pending' : 'ready',
    hasPenaltyEvent: records.length > 0,
    hasReadyPenaltyAmount: readyRecords.length > 0,
    hasPendingPenaltyAmount: pendingRecords.length > 0,
    totalCny,
    count: records.length,
    readyCount: readyRecords.length,
    pendingCount: pendingRecords.length,
    records,
  };
}

export function getFinanceBreakdown(operations = []) {
  const netTotals = {
    salesCommission: 0,
    acquiring: 0,
    deliveryService: 0,
    logistics: 0,
    penalty: 0,
    other: 0,
  };
  const operationAmountByName = new Map();
  const serviceFees = new Map();
  let platformIncome = 0;
  let platformExpense = 0;
  let platformNet = 0;
  const hasOperation = operations.length > 0;

  operations.forEach((operation) => {
    const operationName = getFinanceOperationName(operation);
    const operationType = getFinanceOperationText(operation);
    const amount = getFinanceOperationAmount(operation);
    if (amount !== null && amount !== 0) {
      platformNet += amount;
      if (amount > 0) platformIncome += amount;
      if (amount < 0) platformExpense += amount;
      addFinanceNamedCharge(operationAmountByName, operationName || '未知财务项目', amount);
    }

    const saleCommission = getFinanceOperationSaleCommission(operation);
    if (saleCommission !== null && saleCommission !== 0) {
      addFinanceNet(netTotals, 'salesCommission', saleCommission);
    }

    const services = Array.isArray(operation.services) ? operation.services : [];
    let hasServiceAmount = false;
    services.forEach((service) => {
      const price = getFinanceServicePrice(service);
      if (price === null || price === 0) return;
      hasServiceAmount = true;
      addFinanceNamedCharge(serviceFees, getFinanceServiceLabel(service), price);
      addFinanceNet(netTotals, normalizeFinanceCategory(classifyFinanceService(service, operationType)), price);
    });

    if (amount === null || amount === 0 || hasServiceAmount) return;
    const amountCategory = classifyFinanceOperationAmount(operation);
    if (amountCategory === 'income') {
      return;
    }
    if (amountCategory && !(amountCategory === 'salesCommission' && saleCommission !== null)) {
      addFinanceNet(netTotals, amountCategory, amount);
    } else if (!operationType.includes('sale_commission') && saleCommission === null) {
      addFinanceNet(netTotals, 'other', amount);
    }
  });

  const totals = Object.entries(netTotals).reduce((result, [key, value]) => {
    result[key] = expenseFromNet(value);
    return result;
  }, {});
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  return {
    ...totals,
    agency: totals.deliveryService,
    delivery: totals.logistics,
    platformIncome: hasOperation ? platformIncome : null,
    platformExpense: hasOperation ? platformExpense : null,
    platformNet: hasOperation ? platformNet : null,
    operationAmountByName,
    serviceFees,
    total: hasOperation ? total : null,
  };
}

export function getProfitFinanceEvidenceSummary(operations = []) {
  const rows = Array.isArray(operations) ? operations.filter(Boolean) : [];
  const hasDeliveredSaleOperation = rows.some((operation) => {
    const operationText = getFinanceOperationText(operation);
    const accrualsForSale = toFiniteNumber(
      firstFilled(
        operation.accruals_for_sale,
        operation.accrualsForSale,
        operation.raw?.accruals_for_sale,
        operation.raw?.accrualsForSale
      )
    );
    return operationText.includes('deliveredtocustomer') || (accrualsForSale !== null && accrualsForSale > 0);
  });
  const hasRefundDeductionOperation = rows.some((operation) => {
    const operationText = getFinanceOperationText(operation);
    const amount = getFinanceOperationAmount(operation);
    const accrualsForSale = toFiniteNumber(
      firstFilled(
        operation.accruals_for_sale,
        operation.accrualsForSale,
        operation.raw?.accruals_for_sale,
        operation.raw?.accrualsForSale
      )
    );
    const hasRefundText = /clientreturn|refund|return|возврат|退款|退货|返还/iu.test(operationText);
    return Boolean(
      hasRefundText && ((amount !== null && amount < 0) || (accrualsForSale !== null && accrualsForSale < 0))
    );
  });
  const acquiringRedistributionAmounts = rows
    .filter((operation) =>
      getFinanceOperationText(operation).includes('marketplaceredistributionofacquiringoperation')
    )
    .map((operation) => getFinanceOperationAmount(operation))
    .filter((amount) => amount !== null);
  const hasBalancedAcquiringRedistributionClosure = Boolean(
    acquiringRedistributionAmounts.length >= 2 &&
      acquiringRedistributionAmounts.some((amount) => amount < 0) &&
      acquiringRedistributionAmounts.some((amount) => amount > 0) &&
      Math.abs(acquiringRedistributionAmounts.reduce((total, amount) => total + amount, 0)) <= 0.005
  );

  return {
    operationCount: rows.length,
    hasDeliveredSaleOperation,
    hasRefundDeductionOperation,
    hasBalancedAcquiringRedistributionClosure,
    hasSignedRefundClosure: hasDeliveredSaleOperation && hasRefundDeductionOperation,
  };
}

export function getProfitDetailActualFeeBreakdown(operations = [], options = {}) {
  const netTotals = {
    salesCommission: 0,
    acquiring: 0,
    deliveryService: 0,
    logistics: 0,
  };
  const penaltyDetails = getProfitPenaltyDetails(operations, options);

  operations.forEach((operation) => {
    const amount = getFinanceOperationAmount(operation);
    const saleCommission = getFinanceOperationSaleCommission(operation);

    if (saleCommission !== null && saleCommission !== 0) {
      netTotals.salesCommission += saleCommission;
    }

    const services = Array.isArray(operation.services) ? operation.services : [];
    let hasServiceAmount = false;
    services.forEach((service) => {
      const price = getFinanceServicePrice(service);
      if (price === null || price === 0) return;
      hasServiceAmount = true;
      const category = normalizeFinanceCategory(classifyFinanceService(service, getFinanceOperationText(operation)));
      if (category === 'acquiring' || category === 'deliveryService' || category === 'logistics') {
        netTotals[category] += price;
      }
    });

    if (amount === null || amount === 0 || hasServiceAmount) {
      return;
    }
    const amountCategory = classifyFinanceOperationAmount(operation);
    if (amountCategory === 'acquiring' || amountCategory === 'deliveryService' || amountCategory === 'logistics') {
      netTotals[amountCategory] += amount;
    }
  });

  return {
    salesCommission: expenseFromNet(netTotals.salesCommission),
    penalty: penaltyDetails.totalCny,
    directPenaltyFeeCny: penaltyDetails.hasPenaltyEvent ? penaltyDetails.totalCny : null,
    penaltyDetails,
    acquiring: expenseFromNet(netTotals.acquiring),
    deliveryService: expenseFromNet(netTotals.deliveryService),
    logistics: expenseFromNet(netTotals.logistics),
  };
}
