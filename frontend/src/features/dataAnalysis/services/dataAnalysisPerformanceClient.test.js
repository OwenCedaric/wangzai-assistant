import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listPerformanceAccounts, readPerformanceOverview } from '../../../api/localApiClient.js';
import { readDataAnalysisPerformance } from './dataAnalysisPerformanceClient.js';

vi.mock('../../../api/localApiClient.js', () => ({
  listPerformanceAccounts: vi.fn(),
  readPerformanceOverview: vi.fn(),
}));

describe('dataAnalysisPerformanceClient persisted credential selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses an inactive account with encrypted credentials after restart', async () => {
    listPerformanceAccounts.mockResolvedValue({
      accounts: [{
        id: 'performance-persisted',
        name: 'Ozon Performance API',
        status: 'inactive',
        shopId: 'shop-1',
        hasClientId: true,
        hasClientSecret: true,
      }],
    });
    readPerformanceOverview.mockResolvedValue({ ok: true, summary: { campaignCount: 2 } });

    const result = await readDataAnalysisPerformance({
      shopId: 'shop-1',
      shopName: '一号店',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-26',
    });

    expect(result.ok).toBe(true);
    expect(readPerformanceOverview).toHaveBeenCalledWith(
      {
        type: 'ozon-performance',
        values: {
          accountId: 'performance-persisted',
          shopId: 'shop-1',
          shopName: '一号店',
          dateFrom: '2026-07-01',
          dateTo: '2026-07-26',
          readDepth: 'full',
        },
      },
      { signal: undefined, timeoutMs: 120000 }
    );
    expect(JSON.stringify(readPerformanceOverview.mock.calls)).not.toContain('clientSecret');
  });

  it('selects only accounts bound to the requested shop and ignores disabled/unbound credentials', async () => {
    listPerformanceAccounts.mockResolvedValue({
      accounts: [
        { id: 'disabled', shopId: 'shop-2', status: 'disabled', hasClientId: true, hasClientSecret: true },
        { id: 'unbound', shopId: '', status: 'active', hasClientId: true, hasClientSecret: true },
        { id: 'shop-1-account', shopId: 'shop-1', status: 'inactive', hasClientId: true, hasClientSecret: true },
        { id: 'shop-2-account', shopId: 'shop-2', status: 'active', hasClientId: true, hasClientSecret: true },
      ],
    });
    readPerformanceOverview.mockResolvedValue({ ok: true });

    await readDataAnalysisPerformance({ shopId: 'shop-2' });

    expect(readPerformanceOverview).toHaveBeenCalledTimes(1);
    expect(readPerformanceOverview.mock.calls[0][0].values).toMatchObject({
      accountId: 'shop-2-account',
      shopId: 'shop-2',
    });
  });

  it('reads every bound account for all shops and aggregates successful payloads', async () => {
    listPerformanceAccounts.mockResolvedValue({
      accounts: [
        { id: 'account-a', shopId: 'shop-a', status: 'active', hasClientId: true, hasClientSecret: true },
        { id: 'account-b', shopId: 'shop-b', status: 'inactive', hasClientId: true, hasClientSecret: true },
      ],
    });
    readPerformanceOverview
      .mockResolvedValueOnce({
        ok: true,
        readDepth: 'full',
        summary: { campaignCount: 2 },
        campaigns: [{ id: 'campaign-a' }],
        productStats: [{ campaignId: 'campaign-a', spent: 3 }],
      })
      .mockResolvedValueOnce({
        ok: true,
        readDepth: 'full',
        summary: { campaignCount: 4 },
        campaigns: [{ id: 'campaign-b' }],
        productStats: [{ campaignId: 'campaign-b', spent: 5 }],
      });

    const result = await readDataAnalysisPerformance();

    expect(readPerformanceOverview).toHaveBeenCalledTimes(2);
    expect(result.summary.campaignCount).toBe(6);
    expect(result.campaigns).toHaveLength(2);
    expect(result.productStats).toHaveLength(2);
    expect(result.accounts).toEqual([
      { id: 'account-a', shopId: 'shop-a' },
      { id: 'account-b', shopId: 'shop-b' },
    ]);
  });

  it('does not guess when credentials are unbound', async () => {
    listPerformanceAccounts.mockResolvedValue({
      accounts: [
        { id: 'unbound', shopId: '', status: 'active', hasClientId: true, hasClientSecret: true },
      ],
    });

    const result = await readDataAnalysisPerformance({ shopId: 'shop-1' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('PERFORMANCE_ACCOUNT_SHOP_BINDING_REQUIRED');
    expect(readPerformanceOverview).not.toHaveBeenCalled();
  });
});
