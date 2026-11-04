const text = value => String(value ?? '').trim();
function failure(code, message, status = 502) {
  return Object.assign(new Error(message), { code, publicMessage: message, status });
}
function rangeFor({ date, days } = {}) {
  const requestedDate = text(date);
  if (requestedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(requestedDate)) throw failure('WECHAT_READONLY_DATE_INVALID', '日期必须是 YYYY-MM-DD。', 400);
    const start = new Date(`${requestedDate}T00:00:00+08:00`);
    if (Number.isNaN(start.getTime())) throw failure('WECHAT_READONLY_DATE_INVALID', '日期无效。', 400);
    return { mode: 'calendar-day', date: requestedDate, days: 1, startDate: requestedDate, endDate: requestedDate,
      dateFrom: start.toISOString(), dateTo: new Date(start.getTime() + 86_400_000).toISOString() };
  }
  const dayCount = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  const endDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const start = new Date(`${endDate}T00:00:00+08:00`);
  start.setUTCDate(start.getUTCDate() - (dayCount - 1));
  const startDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(start);
  const end = new Date(`${endDate}T00:00:00+08:00`); end.setUTCDate(end.getUTCDate() + 1);
  return { mode: 'calendar-days', days: dayCount, startDate, endDate,
    dateFrom: new Date(`${startDate}T00:00:00+08:00`).toISOString(), dateTo: end.toISOString() };
}
const METRICS = ['orderCount', 'effectiveOrderCount', 'salesAmount', 'averageOrderValue', 'cancelledCount',
  'actualNetProfit', 'actualNetProfitCoverage', 'inSaleProductCount', 'outOfStockCount', 'lowStockCount', 'productErrorCount'];

/** Fixed read-only operations through the normal desktop authority/permission router. */
export function createWechatAssistantReadonly({ executeRequest } = {}) {
  return async function read({ pathname, query = {}, assertAuthorizationCurrent }) {
    if (!['/v1/readonly/shops', '/v1/readonly/summary'].includes(pathname)) throw failure('LOCAL_RELAY_ROUTE_NOT_FOUND', '不支持的只读工具路径。', 404);
    if (typeof assertAuthorizationCurrent !== 'function') throw failure('LOCAL_RELAY_UNAUTHORIZED', '只读工具授权不可用。', 401);
    const request = async path => {
      assertAuthorizationCurrent();
      const result = await executeRequest({ path, method: 'GET', timeoutMs: 30_000 });
      assertAuthorizationCurrent();
      const data = result?.data ?? result;
      if (result?.ok !== true || data?.ok === false) throw failure(data?.error?.code || 'WECHAT_READONLY_READ_FAILED',
        data?.error?.message || '权威数据读取失败，请稍后重试。', Number(result?.status) || 502);
      return data;
    };
    const listed = await request('/api/shops');
    if (!Array.isArray(listed.shops)) throw failure('WECHAT_READONLY_SHOPS_INVALID', '权威店铺列表未返回。');
    const shops = listed.shops.filter(shop => !shop.disabledAt).map(shop => ({
      id: shop.id, name: shop.name, alias: shop.alias || '', client_id: shop.clientId || '', status: shop.status, updated_at: shop.updatedAt,
    }));
    if (pathname === '/v1/readonly/shops') return { ok: true, shops };
    const requestedShop = text(query.shop);
    const selected = requestedShop ? shops.find(shop => [shop.id, shop.name, shop.alias, shop.client_id].map(text).includes(requestedShop)) : null;
    if (requestedShop && !selected) throw failure('WECHAT_READONLY_SHOP_NOT_FOUND', `没有找到店铺“${requestedShop}”。请先列出旺崽店铺。`, 404);
    const range = rangeFor(query);
    const parameters = new URLSearchParams({ shopIds: (selected ? [selected.id] : shops.map(shop => shop.id)).join(','),
      startDate: range.startDate, endDate: range.endDate });
    const dashboard = await request(`/api/cache/dashboard-overview?${parameters}`);
    const authoritativeSource = dashboard.source === 'sqlite' || (dashboard.source === 'memory'
      && dashboard.runtimeCache?.tier === 'memory-l1' && dashboard.runtimeCache?.domain === 'dashboard-overview');
    if (dashboard.ok !== true || !authoritativeSource || !dashboard.scope || !dashboard.metrics) {
      throw failure('WECHAT_READONLY_SUMMARY_INVALID', '旺崽首页权威汇总读取失败。');
    }
    return { ok: true, contract: 'wangzai-dashboard-overview-v1', access: 'read-only authoritative dashboard aggregate',
      range, scope: dashboard.scope, metrics: Object.fromEntries(METRICS.map(name => [name, dashboard.metrics?.[name] ?? null])),
      currentTasks: dashboard.currentTasks, shopPerformance: dashboard.shopPerformance, freshness: dashboard.freshness,
      interpretationRules: { salesAmount: '只认 metrics.salesAmount；不是财务流水或结算额。',
        currency: '金额必须原样携带 currency；禁止猜测、换算或跨币种合计。',
        status: '只有 status=confirmed 且 value 为有限数值时才允许报告为确定金额。',
        scope: '答复必须复述 scope.range、scope.shops 和 timezone。' } };
  };
}
