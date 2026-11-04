export const OZON_INITIAL_ORDER_QUICK_RANGE_DAYS = 90;

export function getOzonOrderDateRange(days = OZON_INITIAL_ORDER_QUICK_RANGE_DAYS, now = new Date()) {
  const to = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const safeDays = Number.isFinite(Number(days)) ? Number(days) : OZON_INITIAL_ORDER_QUICK_RANGE_DAYS;
  const since = new Date(to.getTime() - safeDays * 24 * 60 * 60 * 1000);
  return {
    since: since.toISOString(),
    to: to.toISOString(),
  };
}

export function normalizeOzonId(value) {
  return String(value ?? '').trim();
}

export function getSalesOrderRecordKey(order = {}) {
  return normalizeOzonId(order.recordKey || order.id || order.posting || '');
}

export function getAfterSalesOrderRecordKey(order = {}) {
  return getSalesOrderRecordKey(order) || normalizeOzonId(order.id || order.salesOrder || '');
}

export function getProfitOrderStableRecordKey(order = {}) {
  const shopKey = normalizeOzonId(order.shopId || order.shopClientId || order.shop || 'unknown-shop');
  const orderKey = normalizeOzonId(
    order.posting ||
      order.id ||
      order.salesOrder ||
      order.ozonOrderId ||
      order.orderId ||
      order.raw?.posting_number ||
      order.raw?.order_number ||
      order.raw?.order_id ||
      'unknown-order'
  );
  return `${shopKey}:${orderKey}`;
}

export function getProfitOrderRecordKey(order = {}) {
  const stableKey = getProfitOrderStableRecordKey(order);
  return stableKey.includes('unknown-order') ? order.profitRecordKey || stableKey : stableKey;
}

export function mergeRowsByKey(
  rows = [],
  getKey = getSalesOrderRecordKey,
  merge = (previous, row) => ({ ...previous, ...row })
) {
  const map = new Map();
  rows.forEach((row) => {
    const key = getKey(row);
    if (!key) return;
    map.set(key, map.has(key) ? merge(map.get(key), row) : row);
  });
  return Array.from(map.values());
}

export function isOzonRetryableReadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP\s*(401|403|400|404)/i.test(message)) return false;
  return /HTTP\s*(429|5\d\d)|Failed to fetch|NetworkError|timeout|超时|aborted/i.test(message);
}

export function getOzonApiErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /(?:EPERM|EACCES|EBUSY|operation not permitted)[\s\S]*purchase-bridge-license|rename[\s\S]*purchase-bridge-license/iu.test(
      message
    )
  ) {
    return '本机授权状态同步短暂冲突，请点击刷新重试。';
  }
  return message.replace(/\/v\d+\/[a-z0-9/-]+\s*请求失败：?/gi, '').trim() || message;
}

export function getFriendlyOzonOrderError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/本地\s*API\s*请求超时|local-api\s*请求超时|LOCAL_API_TIMEOUT/iu.test(message)) {
    return '读取失败：本地订单读取超时，请稍后重试。';
  }
  if (/SALES_ORDER_(?:TOTAL_CHANGED|RANGE_INCOMPLETE|PAGE_REPEATED|SHOP_MISMATCH)/u.test(message)) {
    return '读取失败：订单范围已变化或尚未完整读取，请刷新重试。';
  }
  if (message.includes('请先') || message.includes('缺少')) return message;
  if (message.includes('401') || message.includes('403')) return '读取失败：店铺接口权限不足或密钥无效。';
  if (message.includes('429')) return '读取失败：Ozon 限流中，请稍后重试。';
  if (message.includes('Failed to fetch') || message.includes('NetworkError'))
    return '读取失败：请检查本地代理或网络。';
  if (message.includes('aborted')) return '读取已中断。';
  return '读取失败：Ozon 暂未返回可用订单数据，请稍后重试。';
}
