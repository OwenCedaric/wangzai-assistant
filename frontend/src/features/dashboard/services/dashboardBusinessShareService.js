import { getDomainCache } from '../../../api/localApiClient.js';
import { createOzonTimeRangeScope, getOzonReadableShops } from '../../../entities/order/orderShopScope.jsx';
import { OZON_AFTER_SALES_DEFAULT_RANGE_DAYS } from '../../../shared/config/appConfigCore.jsx';

export const EMPTY_DASHBOARD_BUSINESS_SHARE_COUNTS = Object.freeze({
  salesOrderCount: 0,
  pendingPurchaseCount: 0,
  afterSalesTodoCount: 0,
  stockWarningCount: 0,
});

function toCount(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function normalizeShopIds(values = []) {
  const source = Array.isArray(values) ? values : String(values || '').split(',');
  return [...new Set(source.map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

function toShopIds(shops = []) {
  return normalizeShopIds(shops.map((shop) => shop.id));
}

export function createDashboardBusinessShareCounts(payload = {}) {
  const source = payload?.counts && typeof payload.counts === 'object' ? payload.counts : payload;
  return {
    salesOrderCount: toCount(source?.salesOrderCount),
    pendingPurchaseCount: toCount(source?.pendingPurchaseCount),
    afterSalesTodoCount: toCount(source?.afterSalesTodoCount),
    stockWarningCount: toCount(source?.stockWarningCount),
  };
}

export function createDashboardBusinessShareQuery(shops = [], options = {}) {
  const readableShops = getOzonReadableShops(shops);
  const shopIds = toShopIds(readableShops);
  const salesTimeScope = options.salesTimeScope || createOzonTimeRangeScope({ page: 'sales-orders' });
  const afterSalesTimeScope =
    options.afterSalesTimeScope ||
    createOzonTimeRangeScope({
      page: 'after-sales-orders',
      defaultDays: OZON_AFTER_SALES_DEFAULT_RANGE_DAYS,
    });

  return {
    shopIds: shopIds.join(','),
    salesSince: salesTimeScope.since,
    salesTo: salesTimeScope.to,
    afterSalesSince: afterSalesTimeScope.since,
    afterSalesTo: afterSalesTimeScope.to,
  };
}

/** Reads one minimal SQLite aggregate DTO; it never receives Dashboard rows. */
export async function readDashboardBusinessShareSnapshot(shops = [], options = {}) {
  const query = createDashboardBusinessShareQuery(shops, options);
  if (!query.shopIds) return { ...EMPTY_DASHBOARD_BUSINESS_SHARE_COUNTS };

  const payload = await getDomainCache('dashboard-business-share', query, options);
  if (payload?.ok !== true || payload?.source !== 'sqlite') {
    throw new Error(payload?.error?.message || 'Dashboard 本地 SQLite 聚合读取失败');
  }
  const requestedScope = normalizeShopIds(query.shopIds);
  const responseScope = normalizeShopIds(payload?.scope?.shopIds);
  if (requestedScope.join('|') !== responseScope.join('|')) {
    throw new Error('Dashboard 本地 SQLite 聚合返回了不一致的店铺范围');
  }
  return createDashboardBusinessShareCounts(payload);
}
