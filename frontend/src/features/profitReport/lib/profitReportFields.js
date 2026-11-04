export const PROFIT_REPORT_AMOUNT_COLUMNS = Object.freeze([
  { key: 'invoiceTransfer', label: '应计结算金额' },
  { key: 'ordersAmount', label: '销售金额' },
  { key: 'returnsAmount', label: '退货金额' },
  { key: 'commissionAmount', label: 'Ozon佣金' },
  { key: 'deliveryServiceFee', label: '配送服务' },
  { key: 'agencyServiceFee', label: '代理服务' },
  { key: 'promotionFee', label: '推广和广告' },
  { key: 'fboServiceFee', label: 'FBO服务' },
  { key: 'otherServiceFee', label: '其他服务' },
  { key: 'otherAccrualsFee', label: '其他应计项目' },
  { key: 'compensationAndRestitutionFee', label: '赔偿和赔偿返还' },
  { key: 'loan', label: '借贷及托收信贷' },
]);

export const PROFIT_REPORT_BALANCE_COLUMNS = Object.freeze([
  { key: 'beginBalanceAmount', label: '期初余额' },
  { key: 'endBalanceAmount', label: '期末余额' },
  { key: 'currentBalance', label: '当前余额' },
  { key: 'invoiceTransfer', label: '应计结算金额' },
  { key: 'payment', label: '已打款金额' },
]);

const PROFIT_REPORT_ALL_AMOUNT_KEYS = Object.freeze([
  ...new Set([
    ...PROFIT_REPORT_AMOUNT_COLUMNS.map((column) => column.key),
    ...PROFIT_REPORT_BALANCE_COLUMNS.map((column) => column.key),
  ]),
]);

export function formatProfitReportMoney(value, currencyCode = 'RUB') {
  if (value === null || value === undefined || value === '') return '未返回';
  const number = Number(value);
  if (!Number.isFinite(number)) return '未返回';
  return `${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)} ${currencyCode || 'RUB'}`;
}

export function buildProfitReportBalanceRows(report = {}, shops = []) {
  const balanceByShop = new Map((report.balances || []).map((row) => [String(row.shopId), row]));
  const latestStatementByShop = new Map();
  (report.rows || []).forEach((row) => {
    const key = String(row.shopId || '');
    const current = latestStatementByShop.get(key);
    if (!current || String(row.periodEnd || '') > String(current.periodEnd || '')) latestStatementByShop.set(key, row);
  });
  return (Array.isArray(shops) ? shops : []).map((shop) => {
    const shopId = String(shop.id || shop.shopId || '');
    const balance = balanceByShop.get(shopId) || {};
    const statement = latestStatementByShop.get(shopId) || {};
    return {
      shopId,
      shopName: shop.alias || shop.name || balance.shopName || shopId,
      currencyCode: balance.currencyCode || statement.currencyCode || 'RUB',
      beginBalanceAmount: statement.beginBalanceAmount ?? null,
      endBalanceAmount: statement.endBalanceAmount ?? null,
      currentBalance: balance.balanceAmount ?? null,
      invoiceTransfer: statement.invoiceTransfer ?? null,
      payment: statement.payment ?? null,
      periodBegin: statement.periodBegin || '',
      periodEnd: statement.periodEnd || '',
      recordedAt: balance.recordedAt || statement.updatedAt || '',
    };
  });
}

export function countReturnedReportAmounts(row = {}) {
  return PROFIT_REPORT_AMOUNT_COLUMNS.reduce((count, column) => (
    row[column.key] === null || row[column.key] === undefined ? count : count + 1
  ), 0);
}

export function convertProfitReportRows(rows = [], { mode = 'source', getRate = () => null } = {}) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const sourceCurrencyCode = String(row.currencyCode || 'RUB').trim().toUpperCase();
    if (mode !== 'cny') return { ...row, sourceCurrencyCode, exchangeRate: null, exchangeRateMissing: false };
    const ratePayload = sourceCurrencyCode === 'CNY' ? { rubToCnyRate: 1 } : getRate(row);
    const exchangeRate = Number(ratePayload?.rubToCnyRate ?? ratePayload?.rate);
    const hasRate = sourceCurrencyCode === 'CNY' || (sourceCurrencyCode === 'RUB' && Number.isFinite(exchangeRate) && exchangeRate > 0);
    const converted = {
      ...row,
      sourceCurrencyCode,
      currencyCode: 'CNY',
      exchangeRate: hasRate ? exchangeRate : null,
      exchangeRateSource: String(ratePayload?.source || '').trim(),
      exchangeRateDate: String(ratePayload?.date || ratePayload?.providerDate || '').trim(),
      exchangeRateMissing: false,
    };
    PROFIT_REPORT_ALL_AMOUNT_KEYS.forEach((key) => {
      const value = row[key];
      if (value === null || value === undefined || value === '') return;
      const number = Number(value);
      if (!Number.isFinite(number) || !hasRate) {
        converted[key] = null;
        if (Number.isFinite(number) && !hasRate) converted.exchangeRateMissing = true;
        return;
      }
      converted[key] = number * exchangeRate;
    });
    return converted;
  });
}

export function buildProfitReportTotals(rows = []) {
  const totals = {
    currencyCode: rows[0]?.currencyCode || '',
    rowCount: Array.isArray(rows) ? rows.length : 0,
  };
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    PROFIT_REPORT_AMOUNT_COLUMNS.forEach(({ key }) => {
      const value = row[key];
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return;
      totals[key] = (totals[key] || 0) + Number(value);
      totals[`${key}ReturnedRows`] = (totals[`${key}ReturnedRows`] || 0) + 1;
    });
  });
  return totals;
}
