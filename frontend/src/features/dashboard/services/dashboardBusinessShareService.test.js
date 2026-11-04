import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDomainCache } from '../../../api/localApiClient.js';
import {
  EMPTY_DASHBOARD_BUSINESS_SHARE_COUNTS,
  createDashboardBusinessShareCounts,
  createDashboardBusinessShareQuery,
  readDashboardBusinessShareSnapshot,
} from './dashboardBusinessShareService.js';

vi.mock('../../../api/localApiClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getDomainCache: vi.fn(),
}));

const shopA = { id: 'shop-a', clientId: 'client-a', hasApiKey: true };
const shopB = { id: 'shop-b', clientId: 'client-b', hasApiKey: true };

describe('dashboard business share service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes only the four aggregate counters', () => {
    expect(
      createDashboardBusinessShareCounts({
        counts: { salesOrderCount: 5, pendingPurchaseCount: 2, afterSalesTodoCount: 1, stockWarningCount: 1 },
        rows: [{ shouldNeverReachRenderer: true }],
      })
    ).toEqual({ salesOrderCount: 5, pendingPurchaseCount: 2, afterSalesTodoCount: 1, stockWarningCount: 1 });
    expect(createDashboardBusinessShareCounts()).toEqual(EMPTY_DASHBOARD_BUSINESS_SHARE_COUNTS);
  });

  it('uses one stable scoped aggregate request and verifies the response scope', async () => {
    getDomainCache.mockResolvedValue({
      ok: true,
      source: 'sqlite',
      scope: { shopIds: ['shop-b', 'shop-a'] },
      counts: { salesOrderCount: 5, pendingPurchaseCount: 2, afterSalesTodoCount: 1, stockWarningCount: 1 },
    });

    const result = await readDashboardBusinessShareSnapshot([shopB, shopA, shopA], {
      salesTimeScope: { since: '2026-07-01T00:00:00.000Z', to: '2026-07-14T23:59:59.999Z' },
      afterSalesTimeScope: { since: '2026-07-01T00:00:00.000Z', to: '2026-07-14T23:59:59.999Z' },
    });

    expect(result.salesOrderCount).toBe(5);
    expect(getDomainCache).toHaveBeenCalledTimes(1);
    expect(getDomainCache).toHaveBeenCalledWith(
      'dashboard-business-share',
      expect.objectContaining({ shopIds: 'shop-a,shop-b', salesSince: '2026-07-01T00:00:00.000Z' }),
      expect.any(Object)
    );
  });

  it('rejects failed and cross-scope responses instead of showing false data', async () => {
    getDomainCache.mockResolvedValueOnce({
      ok: false,
      source: 'sqlite',
      error: { message: 'fixture SQLite unavailable' },
    });
    await expect(readDashboardBusinessShareSnapshot([shopA])).rejects.toThrow('fixture SQLite unavailable');

    getDomainCache.mockResolvedValueOnce({
      ok: true,
      source: 'sqlite',
      scope: { shopIds: ['shop-b'] },
      counts: EMPTY_DASHBOARD_BUSINESS_SHARE_COUNTS,
    });
    await expect(readDashboardBusinessShareSnapshot([shopA])).rejects.toThrow('不一致的店铺范围');
  });

  it('does not call local-api when there is no readable shop', async () => {
    expect(createDashboardBusinessShareQuery([shopA, shopB]).shopIds).toBe('shop-a,shop-b');
    await expect(readDashboardBusinessShareSnapshot([])).resolves.toEqual(EMPTY_DASHBOARD_BUSINESS_SHARE_COUNTS);
    expect(getDomainCache).not.toHaveBeenCalled();
  });
});
