import { getDomainCache } from '../../../api/localApiClient.js';
import { getOzonReadableShops } from '../../../entities/order/orderShopScope.jsx';
import { createDashboardSummaryFromOverview } from '../lib/dashboardSummary.js';

const RANGE_KEYS = new Set(['today', 'week', 'month']);

function shanghaiDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function createDashboardDateRange(rangeKey = 'today', now = new Date()) {
  const normalizedKey = RANGE_KEYS.has(rangeKey) ? rangeKey : 'today';
  const endDate = shanghaiDateKey(now);
  if (normalizedKey === 'week') return { startDate: shiftDateKey(endDate, -6), endDate };
  if (normalizedKey === 'month') return { startDate: `${endDate.slice(0, 8)}01`, endDate };
  return { startDate: endDate, endDate };
}

export function createDashboardOverviewQuery(shops = [], options = {}) {
  const readableShops = getOzonReadableShops(shops);
  const selectedShopId = String(options.selectedShopId || 'all').trim() || 'all';
  const scopedShops =
    selectedShopId === 'all'
      ? readableShops
      : readableShops.filter((shop) => String(shop.id || '') === selectedShopId);
  const rangeKey = RANGE_KEYS.has(options.rangeKey) ? options.rangeKey : 'today';
  const range = createDashboardDateRange(rangeKey, options.now);
  return {
    readableShops,
    scopedShops,
    selectedShopId,
    rangeKey,
    query: {
      shopIds: scopedShops.map((shop) => shop.id).join(','),
      startDate: range.startDate,
      endDate: range.endDate,
      requestRevision: Number(options.refreshToken) || 0,
    },
  };
}

export async function readDashboardOverviewSnapshot(shops = [], options = {}) {
  const request = createDashboardOverviewQuery(shops, options);
  if (!request.scopedShops.length) {
    throw new Error(request.selectedShopId === 'all' ? '当前没有可读取的店铺' : '选择的店铺不可用');
  }
  const payload = await getDomainCache('dashboard-overview', request.query, {
    ...options,
    timeoutMs: options.timeoutMs || 12_000,
  });
  if (payload?.ok !== true || payload?.source !== 'sqlite') {
    throw new Error(payload?.error?.message || '首页数据读取失败');
  }
  const expectedIds = request.scopedShops.map((shop) => String(shop.id)).sort();
  const actualIds = (Array.isArray(payload?.scope?.shopIds) ? payload.scope.shopIds : []).map(String).sort();
  if (expectedIds.join('|') !== actualIds.join('|')) {
    throw new Error('首页数据返回了不一致的店铺范围');
  }
  return createDashboardSummaryFromOverview(payload, request.scopedShops, {
    rangeKey: request.rangeKey,
    selectedShopId: request.selectedShopId,
  });
}
