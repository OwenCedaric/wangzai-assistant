import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRubCnyDailyRate: vi.fn(),
  getRubCnyDailyRates: vi.fn(),
  getRubCnyRealtimeRate: vi.fn(),
  listPerformanceAccounts: vi.fn(),
  listRubCnyRateCache: vi.fn(),
  readPerformanceOverview: vi.fn(),
  saveRubCnyRateCache: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => mocks);

import {
  readDashboardPromotionSummary,
  summarizeDashboardPromotionPayloads,
} from './dashboardPromotionService.js';

describe('dashboard promotion service', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listRubCnyRateCache.mockResolvedValue({
      records: [{ rate: 0.08, date: '2026-08-13', source: 'official' }],
    });
  });

  it('aggregates only returned performance facts and calculates ACOS/ROAS', () => {
    const result = summarizeDashboardPromotionPayloads(
      [
        { payload: { summary: { total: 2, spent: 100, revenue: 500, orders: 3 }, campaigns: [{ budgetRemaining: 80 }] } },
        { payload: { summary: { total: 1, spent: 25, revenue: 125, orders: 1 }, campaigns: [{ budgetRemaining: 20 }] } },
      ],
      { rate: { rubToCnyRate: 0.08 } }
    );
    expect(result).toMatchObject({
      campaignCount: 3,
      spentRub: 125,
      spentCny: 10,
      revenueRub: 625,
      revenueCny: 50,
      orders: 4,
      acos: 20,
      roas: 5,
      balanceCny: 8,
    });
    expect(result.byShop).toHaveLength(2);
  });

  it('prefers the verified snapshot and keeps shop/account scope exact', async () => {
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [
        { id: 'perf-a', shopId: 'shop-a', status: 'active', hasClientId: true, hasClientSecret: true },
        { id: 'perf-b', shopId: 'shop-b', status: 'active', hasClientId: true, hasClientSecret: true },
      ],
    });
    mocks.readPerformanceOverview.mockResolvedValue({
      ok: true,
      found: true,
      snapshot: { ok: true, summary: { total: 1, spent: 20, revenue: 100, orders: 2 } },
    });
    const result = await readDashboardPromotionSummary({
      shops: [{ id: 'shop-a' }, { id: 'shop-b' }],
      selectedShopId: 'shop-b',
      dateFrom: '2026-08-13',
      dateTo: '2026-08-13',
    });
    expect(result.accountCount).toBe(1);
    expect(mocks.readPerformanceOverview).toHaveBeenCalledTimes(1);
    expect(mocks.readPerformanceOverview.mock.calls[0][0].values).toMatchObject({
      accountId: 'perf-b',
      shopId: 'shop-b',
      snapshotOnly: true,
    });
  });

  it('shows an explicit unconfigured state instead of mock figures', async () => {
    mocks.listPerformanceAccounts.mockResolvedValue({ accounts: [] });
    const result = await readDashboardPromotionSummary({ shops: [{ id: 'shop-a' }] });
    expect(result.status).toBe('unconfigured');
    expect(result.message).toBe('当前范围尚未配置推广账号');
    expect(result.spentCny).toBeNull();
    expect(mocks.readPerformanceOverview).not.toHaveBeenCalled();
  });
});
