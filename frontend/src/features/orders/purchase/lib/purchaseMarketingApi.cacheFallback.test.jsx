import { beforeEach, describe, expect, it, vi } from 'vitest';

const marketingClientMocks = vi.hoisted(() => ({
  confirmMarketingWrite: vi.fn(),
  pollMarketingActivitySyncJob: vi.fn(),
  previewMarketingWrite: vi.fn(),
  readMarketingActivitySnapshotCache: vi.fn(),
  readMarketingProductPoolCache: vi.fn(),
  readMarketingSummaryCache: vi.fn(),
  startMarketingActivitySync: vi.fn(),
  startMarketingProductPoolSync: vi.fn(),
  startMarketingSummarySync: vi.fn(),
}));

vi.mock('../../../../services/marketingActivityClient', () => marketingClientMocks);

import {
  getFriendlyOzonReadError,
  requestOzonMarketingActivities,
  requestOzonMarketingProductPool,
  requestOzonMarketingSummary,
} from './purchaseMarketingApi.jsx';

const shop = { id: 'shop-marketing-cache-fallback' };
const activity = {
  id: '101',
  sourceType: 'official',
  title: '最大提升',
  count: 1,
  available: 1,
  hasAvailableCount: true,
};

describe('marketing local-first fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the SQLite activity snapshot when starting the background sync times out', async () => {
    marketingClientMocks.readMarketingActivitySnapshotCache.mockResolvedValue({
      ok: true,
      found: true,
      snapshot: {
        activityRows: [activity],
        productPool: [],
        marketingSummary: {
          activityTotal: 1,
          joinedActivityTotal: 1,
          joinedProductTotal: 1,
          issueProductTotal: 0,
        },
        selectedActivityId: '101',
        selectedSourceType: 'official',
        productScope: 'joined',
        selectedProductIds: [],
      },
    });
    marketingClientMocks.startMarketingActivitySync.mockRejectedValue(new Error('local-api 请求超时：2500ms'));

    const result = await requestOzonMarketingActivities(shop);

    expect(result.activityRows).toHaveLength(1);
    expect(result.activityRows[0].id).toBe('101');
    expect(result.syncStartFailed).toBe(true);
    expect(result.pending).toBe(false);
  });

  it('keeps the SQLite product pool when starting the background sync times out', async () => {
    marketingClientMocks.readMarketingProductPoolCache.mockResolvedValue({
      ok: true,
      total: 1,
      joinedTotal: 1,
      availableTotal: 0,
      productPool: [{ id: '9001', productId: '9001', name: 'Cached product', status: '已添加' }],
    });
    marketingClientMocks.startMarketingProductPoolSync.mockRejectedValue(new Error('local-api 请求超时：2500ms'));

    const result = await requestOzonMarketingProductPool(shop, activity, 'joined');

    expect(result.products).toHaveLength(1);
    expect(result.products[0].id).toBe('9001');
    expect(result.syncStartFailed).toBe(true);
    expect(result.pending).toBe(false);
  });

  it('keeps the SQLite summary when starting the background sync times out', async () => {
    marketingClientMocks.readMarketingSummaryCache.mockResolvedValue({
      ok: true,
      activityTotal: 3,
      joinedActivityTotal: 1,
      joinedProductTotal: 1387,
      issueProductTotal: 0,
    });
    marketingClientMocks.startMarketingSummarySync.mockRejectedValue(new Error('本地 API 请求超时'));

    const result = await requestOzonMarketingSummary(shop, [activity]);

    expect(result.activityTotal).toBe(3);
    expect(result.joinedProductTotal).toBe(1387);
    expect(result.syncStartFailed).toBe(true);
  });

  it('keeps authoritative activity totals when a large joined cache read times out', async () => {
    marketingClientMocks.readMarketingProductPoolCache.mockRejectedValue(
      new Error('local-api 请求超时：1800ms')
    );
    marketingClientMocks.startMarketingProductPoolSync.mockResolvedValue({ jobId: 'joined-large-job' });
    const largeActivity = { ...activity, count: 1598, available: 93 };

    const result = await requestOzonMarketingProductPool(shop, largeActivity, 'joined');

    expect(result.products).toEqual([]);
    expect(result.joinedTotal).toBe(1598);
    expect(result.availableTotal).toBe(93);
    expect(result.cacheReadFailed).toBe(true);
    expect(result.pending).toBe(true);
    expect(marketingClientMocks.readMarketingProductPoolCache).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ timeoutMs: 15_000 })
    );
    expect(marketingClientMocks.startMarketingProductPoolSync).toHaveBeenCalledWith(
      expect.objectContaining({ hydrateProducts: false }),
      expect.any(Object)
    );
  });

  it('does not describe a local-api timeout as Ozon returning no activity data', () => {
    expect(getFriendlyOzonReadError(new Error('local-api 请求超时：2500ms'))).toBe(
      '本地营销数据处理繁忙，已保留当前快照，后台会继续更新。',
    );
  });

  it('uses the visible in-memory snapshot during refresh without re-reading the large SQLite payload', async () => {
    const visibleSnapshot = {
      activityRows: [activity],
      productPool: [{ id: '9001', name: 'Visible product', status: '已添加' }],
      marketingSummary: {
        activityTotal: 1,
        joinedActivityTotal: 1,
        joinedProductTotal: 1387,
        issueProductTotal: 0,
      },
      selectedActivityId: '101',
      selectedSourceType: 'official',
      productScope: 'joined',
      selectedProductIds: ['9001'],
    };
    marketingClientMocks.startMarketingActivitySync.mockRejectedValue(new Error('local-api 请求超时：2500ms'));
    marketingClientMocks.startMarketingProductPoolSync.mockRejectedValue(new Error('local-api 请求超时：2500ms'));
    marketingClientMocks.startMarketingSummarySync.mockRejectedValue(new Error('local-api 请求超时：2500ms'));

    const activityResult = await requestOzonMarketingActivities(shop, {
      cacheSnapshot: visibleSnapshot,
      skipCache: true,
    });
    const productResult = await requestOzonMarketingProductPool(shop, activity, 'joined', {
      cacheResult: { products: visibleSnapshot.productPool, joinedTotal: 1387, availableTotal: 547 },
      skipCache: true,
    });
    const summaryResult = await requestOzonMarketingSummary(shop, [activity], {
      cacheResult: visibleSnapshot.marketingSummary,
      skipCache: true,
    });

    expect(marketingClientMocks.readMarketingActivitySnapshotCache).not.toHaveBeenCalled();
    expect(marketingClientMocks.readMarketingProductPoolCache).not.toHaveBeenCalled();
    expect(marketingClientMocks.readMarketingSummaryCache).not.toHaveBeenCalled();
    expect(activityResult.activityRows).toHaveLength(1);
    expect(productResult.products).toHaveLength(1);
    expect(productResult.joinedTotal).toBe(1387);
    expect(summaryResult.joinedProductTotal).toBe(1387);
  });

  it('starts background syncs without embedding a second large cache snapshot in the fast ack', async () => {
    marketingClientMocks.startMarketingActivitySync.mockResolvedValue({ jobId: 'activity-job' });
    marketingClientMocks.startMarketingProductPoolSync.mockResolvedValue({ jobId: 'product-job' });
    marketingClientMocks.startMarketingSummarySync.mockResolvedValue({ jobId: 'summary-job' });
    const visibleSummary = {
      activityTotal: 1,
      joinedActivityTotal: 1,
      joinedProductTotal: 1387,
      issueProductTotal: 0,
    };

    await requestOzonMarketingActivities(shop, {
      cacheSnapshot: {
        activityRows: [activity],
        productPool: [],
        marketingSummary: visibleSummary,
        selectedActivityId: '101',
        selectedSourceType: 'official',
        productScope: 'joined',
        selectedProductIds: [],
      },
      skipCache: true,
    });
    await requestOzonMarketingProductPool(shop, activity, 'joined', {
      cacheResult: { products: [], joinedTotal: 1387, availableTotal: 547 },
      skipCache: true,
    });
    await requestOzonMarketingSummary(shop, [activity], {
      cacheResult: visibleSummary,
      skipCache: true,
    });

    expect(marketingClientMocks.startMarketingActivitySync).toHaveBeenCalledWith(
      expect.objectContaining({ includeCacheSnapshot: false }),
      expect.any(Object),
    );
    expect(marketingClientMocks.startMarketingProductPoolSync).toHaveBeenCalledWith(
      expect.objectContaining({ includeCacheSnapshot: false }),
      expect.any(Object),
    );
    expect(marketingClientMocks.startMarketingSummarySync).toHaveBeenCalledWith(
      expect.objectContaining({ includeCacheSnapshot: false }),
      expect.any(Object),
    );
  });
});
