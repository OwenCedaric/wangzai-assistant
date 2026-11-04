const CHINA_STANDARD_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatChinaStandardDateKey(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Date(parsed.getTime() + CHINA_STANDARD_TIME_OFFSET_MS).toISOString().slice(0, 10);
}

export function getSalesOrderPaymentDateKey(order) {
  const raw = order?.paymentDate || order?.paymentTime || '';
  if (!raw || raw === '未返回') return '';
  const chinaDateKey = formatChinaStandardDateKey(raw);
  if (chinaDateKey) return chinaDateKey;
  const text = String(raw);
  const fullDate = text.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (fullDate) return `${fullDate[1]}-${fullDate[2]}-${fullDate[3]}`;
  const shortDate = text.match(/^(\d{2})[-/](\d{2})/);
  if (shortDate) return `2026-${shortDate[1]}-${shortDate[2]}`;
  return '';
}

export function normalizeSalesOrderDateFilter(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const fullDate = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (fullDate) {
    return `${fullDate[1]}-${fullDate[2].padStart(2, '0')}-${fullDate[3].padStart(2, '0')}`;
  }
  const shortDate = text.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (shortDate) {
    return `2026-${shortDate[1].padStart(2, '0')}-${shortDate[2].padStart(2, '0')}`;
  }
  return '';
}

export function doesSalesOrderMatchPaymentDateRange(order, startDate = '', endDate = '') {
  const startDateKey = normalizeSalesOrderDateFilter(startDate);
  const endDateKey = normalizeSalesOrderDateFilter(endDate);
  if (!startDateKey && !endDateKey) return true;

  const paymentDateKey = getSalesOrderPaymentDateKey(order);
  if (!paymentDateKey) return false;
  if (startDateKey && paymentDateKey < startDateKey) return false;
  if (endDateKey && paymentDateKey > endDateKey) return false;
  return true;
}
