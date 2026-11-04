import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDomainCacheMock = vi.hoisted(() => vi.fn());

vi.mock('../../../api/localApiClient.js', () => ({
  getDomainCache: getDomainCacheMock,
}));

import {
  createDashboardDateRange,
  createDashboardOverviewQuery,
  readDashboardOverviewSnapshot,
} from './dashboardOverviewService.js';

const shops = [
  { id: 'shop-a', clientId: '1001', hasApiKey: true, shopAlias: 'Ozon A店' },
  { id: 'shop-b', clientId: '1002', hasApiKey: true, shopAlias: 'Ozon B店' },
  { id: 'shop-disabled', clientId: '', apiKey: '', shopAlias: '不可读店铺' },
];

function createPayload(shopIds = ['shop-a', 'shop-b']) {
  return {
    ok: true,
    source: 'sqlite',
    generatedAt: '2026-08-13T06:00:00.000Z',
    scope: {
      shopIds,
      range: { startDate: '2026-08-07', endDate: '2026-08-13' },
    },
    freshness: { sourceUpdatedAt: '2026-08-13T05:59:00.000Z', sources: [] },
    metrics: {
      effectiveOrderCount: { value: 15 },
      orderCount: { value: 16 },
      cancelledCount: { value: 1 },
      salesAmount: { value: 4591, currency: 'CNY' },
      averageOrderValue: { value: 306.07, currency: 'CNY' },
      actualNetProfit: { value: null, currency: 'CNY', status: 'partial' },
      actualNetProfitCoverage: { value: 6.7 },
      profitLedgerRowCount: 15,
      profitLedgerReadyCount: 1,
    },
    currentTasks: {
      pendingPurchaseCount: 2,
      waitingDeliveryCount: 6,
      afterSalesTodoCount: 58,
      stockWarningCount: 88,
      productIssueCount: 73,
    },
    trend: [],
    latestOrders: [],
    hotProducts: [],
    shopPerformance: [],
  };
}

describe('dashboard overview service', () => {
  beforeEach(() => getDomainCacheMock.mockReset());

  it('builds Shanghai today, rolling 7-day and month-to-date ranges', () => {
    const now = new Date('2026-08-12T18:30:00.000Z');
    expect(createDashboardDateRange('today', now)).toEqual({ startDate: '2026-08-13', endDate: '2026-08-13' });
    expect(createDashboardDateRange('week', now)).toEqual({ startDate: '2026-08-07', endDate: '2026-08-13' });
    expect(createDashboardDateRange('month', now)).toEqual({ startDate: '2026-08-01', endDate: '2026-08-13' });
  });

  it('sends only readable shops and honors a precise single-shop scope', () => {
    const request = createDashboardOverviewQuery(shops, {
      selectedShopId: 'shop-b',
      rangeKey: 'week',
      now: new Date('2026-08-13T06:00:00.000Z'),
      refreshToken: 7,
    });
    expect(request.readableShops.map((shop) => shop.id)).toEqual(['shop-a', 'shop-b']);
    expect(request.scopedShops.map((shop) => shop.id)).toEqual(['shop-b']);
    expect(request.query).toEqual({
      shopIds: 'shop-b',
      startDate: '2026-08-07',
      endDate: '2026-08-13',
      requestRevision: 7,
    });
  });

  it('returns one renderer-safe summary and rejects a mismatched shop scope', async () => {
    getDomainCacheMock.mockResolvedValueOnce(createPayload());
    const summary = await readDashboardOverviewSnapshot(shops, {
      selectedShopId: 'all',
      rangeKey: 'week',
      now: new Date('2026-08-13T06:00:00.000Z'),
    });
    expect(getDomainCacheMock).toHaveBeenCalledWith(
      'dashboard-overview',
      expect.objectContaining({ shopIds: 'shop-a,shop-b', startDate: '2026-08-07', endDate: '2026-08-13' }),
      expect.objectContaining({ timeoutMs: 12_000 })
    );
    expect(summary.loaded).toBe(true);
    expect(summary.salesOrderCount).toBe(15);
    expect(summary.salesTotalDisplay).toBe('¥4,591.00');
    expect(summary.averageOrderDisplay).toBe('¥306.07');
    expect(summary.netProfitValue).toBeNull();
    expect(summary.netProfitDisplay).toBe('等待核算');
    expect(summary.businessShareCounts).toEqual({
      pendingPurchaseCount: 2,
      waitingDeliveryCount: 6,
      afterSalesTodoCount: 58,
      stockWarningCount: 88,
    });

    getDomainCacheMock.mockResolvedValueOnce(createPayload(['shop-a']));
    await expect(
      readDashboardOverviewSnapshot(shops, {
        selectedShopId: 'all',
        rangeKey: 'week',
        now: new Date('2026-08-13T06:00:00.000Z'),
      })
    ).rejects.toThrow('不一致的店铺范围');
  });
});
