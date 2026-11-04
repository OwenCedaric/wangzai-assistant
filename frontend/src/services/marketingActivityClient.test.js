import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmMarketingWrite,
  importLegacyMarketingActivitySnapshot,
  pollMarketingActivitySyncJob,
  readMarketingActivityCache,
  readMarketingActivitySnapshotCache,
  readMarketingProductPoolCache,
  readMarketingSummaryCache,
  previewMarketingWrite,
  saveMarketingActivityViewState,
  startMarketingActivitySync,
  startMarketingProductPoolSync,
  startMarketingSummarySync,
} from './marketingActivityClient';
import { buildMarketingProductPoolCacheResult } from '../entities/order/orderShopScope.jsx';
import {
  buildMarketingActivitySnapshotFromRows,
  buildMarketingActivitySnapshotFromLocalApiCache,
  buildMarketingProductPoolResultFromLocalApiCache,
  readMarketingActivityLocalApiSnapshot,
  readMarketingProductPoolLocalApiResult,
  requestOzonMarketingActivateProducts,
} from '../features/orders/purchase/lib/purchaseMarketingApi.jsx';

describe('marketingActivityClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses local-api marketing cache and sync endpoints', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/api/cache/marketing')) {
        return new Response(JSON.stringify({ ok: true, activityRows: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'marketing-job-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });

    await readMarketingActivityCache({ shopId: 'shop-1' });
    await startMarketingActivitySync({ shopId: 'shop-1' });
    await readMarketingProductPoolCache({ shopId: 'shop-1', activityId: '101', productScope: 'joined' });
    await startMarketingProductPoolSync({ shopId: 'shop-1', activityId: '101', productScope: 'joined' });
    await readMarketingSummaryCache({ shopId: 'shop-1' });
    await startMarketingSummarySync({ shopId: 'shop-1' });

    expect(calls[0].url).toContain('/api/cache/marketing');
    expect(calls[0].url).toContain('scope=activities');
    expect(calls[1].url).toContain('/api/sync/marketing');
    expect(calls[1].options.method).toBe('POST');
    const activitySyncBody = JSON.parse(calls[1].options.body);
    expect(activitySyncBody.fastAck).toBe(true);
    expect(activitySyncBody.includeCacheSnapshot).toBe(false);
    expect(activitySyncBody.waitForResult).toBe(false);
    expect(calls[2].url).toContain('/api/cache/marketing');
    expect(calls[2].url).toContain('scope=products');
    expect(calls[3].url).toContain('/api/sync/marketing');
    const productSyncBody = JSON.parse(calls[3].options.body);
    expect(productSyncBody.scope).toBe('products');
    expect(productSyncBody.fastAck).toBe(true);
    expect(productSyncBody.includeCacheSnapshot).toBe(false);
    expect(productSyncBody.waitForResult).toBe(false);
    expect(calls[4].url).toContain('/api/cache/marketing');
    expect(calls[4].url).toContain('scope=summary');
    expect(calls[5].url).toContain('/api/sync/marketing');
    const summarySyncBody = JSON.parse(calls[5].options.body);
    expect(summarySyncBody.scope).toBe('summary');
    expect(summarySyncBody.fastAck).toBe(true);
    expect(summarySyncBody.includeCacheSnapshot).toBe(false);
    expect(summarySyncBody.waitForResult).toBe(false);
  });

  it('uses only SQLite snapshot, legacy-import, and view-state endpoints for cache migration state', async () => {
    const calls = [];
    const snapshot = {
      activityRows: [{ id: 'activity-1', title: '活动' }],
      productPool: [],
      selectedActivityId: 'activity-1',
    };
    const viewState = {
      selectedActivityId: 'activity-1',
      productScope: 'joined',
      selectedProductIds: ['product-1'],
    };
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true, found: true, snapshot }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await readMarketingActivitySnapshotCache({ shopId: 'shop-1' });
    await importLegacyMarketingActivitySnapshot({ shopId: 'shop-1', snapshot });
    await saveMarketingActivityViewState({ shopId: 'shop-1', viewState });

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain('/api/cache/marketing');
    expect(calls[0].url).toContain('scope=snapshot');
    expect(calls[0].url).toContain('shopId=shop-1');
    expect(calls[0].options.method).toBe('GET');

    expect(calls[1].url).toContain('/api/cache/marketing/legacy-import');
    expect(calls[1].options.method).toBe('POST');
    expect(JSON.parse(calls[1].options.body)).toEqual({ shopId: 'shop-1', snapshot });

    expect(calls[2].url).toContain('/api/cache/marketing/view-state');
    expect(calls[2].options.method).toBe('PUT');
    expect(JSON.parse(calls[2].options.body)).toEqual({ shopId: 'shop-1', viewState });
    expect(calls.some((call) => call.url.includes('/api/sync/marketing'))).toBe(false);
  });

  it('fails closed when the snapshot endpoint returns a local-api business error', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(
        JSON.stringify({ ok: false, error: { code: 'MARKETING_SNAPSHOT_READ_FAILED', message: 'SQLite 读取失败' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    await expect(readMarketingActivitySnapshotCache({ shopId: 'shop-1' })).rejects.toMatchObject({
      message: 'SQLite 读取失败',
      payload: {
        ok: false,
        error: { code: 'MARKETING_SNAPSHOT_READ_FAILED', message: 'SQLite 读取失败' },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/cache/marketing');
    expect(calls[0].url).toContain('scope=snapshot');
    expect(calls[0].options.method).toBe('GET');
  });

  it('restores the complete marketing page snapshot from SQLite without degrading it to activities-only cache', async () => {
    const snapshot = {
      activityRows: [
        {
          id: 'activity-1',
          title: '活动一',
          source: '平台活动',
          sourceType: 'official',
          count: 2,
          available: 3,
          isOnline: true,
        },
      ],
      productPool: [
        {
          id: 'product-1',
          name: '商品一',
          status: '已添加',
          price: '100',
        },
      ],
      marketingSummary: {
        activityTotal: 7,
        joinedActivityTotal: 2,
        joinedProductTotal: 5,
        issueProductTotal: 1,
      },
      selectedActivityId: 'activity-1',
      selectedSourceType: 'official',
      productScope: 'all',
      selectedProductIds: ['product-1'],
      cachedAt: '2026-07-13T00:00:00.000Z',
    };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, found: true, snapshot }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await readMarketingActivityLocalApiSnapshot({ id: 'shop-1' });

    expect(String(globalThis.fetch.mock.calls[0][0])).toContain('scope=snapshot');
    expect(result).toMatchObject({
      selectedActivityId: 'activity-1',
      selectedSourceType: 'official',
      productScope: 'all',
      selectedProductIds: ['product-1'],
      productPool: [{ id: 'product-1', status: '已添加' }],
      marketingSummary: snapshot.marketingSummary,
      cachedAt: snapshot.cachedAt,
    });
  });

  it('restores the exact seller activity when official and seller activities share an id', () => {
    const snapshot = buildMarketingActivitySnapshotFromLocalApiCache({
      found: true,
      snapshot: {
        activityRows: [
          { id: 'same-id', title: '平台活动', sourceType: 'official', source: '平台活动' },
          { id: 'same-id', title: '商家活动', sourceType: 'seller', source: '商家自主' },
        ],
        productPool: [],
        selectedActivityId: 'same-id',
        selectedSourceType: 'seller',
        productScope: 'joined',
      },
    });

    expect(snapshot).toMatchObject({ selectedActivityId: 'same-id', selectedSourceType: 'seller' });
  });

  it('does not select array[0] when a multi-source SQLite snapshot lacks a complete selected identity', () => {
    const snapshot = buildMarketingActivitySnapshotFromLocalApiCache({
      found: true,
      snapshot: {
        activityRows: [
          { id: 'same-id', title: '平台活动', sourceType: 'official', source: '平台活动' },
          { id: 'same-id', title: '商家活动', sourceType: 'seller', source: '商家自主' },
        ],
        productPool: [{ id: 'wrong-pool', status: '已添加' }],
        selectedActivityId: 'same-id',
        productScope: 'joined',
      },
    });

    expect(snapshot).toMatchObject({
      selectedActivityId: '',
      selectedSourceType: '',
      productPool: [],
    });
  });

  it('polls marketing sync job until success', async () => {
    let count = 0;
    globalThis.fetch = vi.fn(async () => {
      count += 1;
      return new Response(
        JSON.stringify({ ok: true, job: { jobId: 'marketing-job-1', status: count > 1 ? 'success' : 'running' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const result = await pollMarketingActivitySyncJob('marketing-job-1', { intervalMs: 1, timeoutMs: 1000 });
    expect(result.job.status).toBe('success');
    expect(count).toBe(2);
  });

  it('uses generic marketing write guard endpoints', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true, previewId: 'preview-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await previewMarketingWrite({ shopId: 'shop-1', endpointKey: 'actions.productsActivate' });
    await confirmMarketingWrite({ shopId: 'shop-1', previewId: 'preview-1', confirm: true });

    expect(calls[0].url).toContain('/api/write/marketing/preview');
    expect(calls[1].url).toContain('/api/write/marketing/confirm');
  });

  it('selects the write endpoint from the complete id and source-type activity identity', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true, previewId: 'preview-1', status: 'success' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const product = { id: '101', price: '100' };

    await requestOzonMarketingActivateProducts(
      { id: 'shop-1' },
      { id: 'same-id', sourceType: 'seller', title: '商家活动' },
      [product],
      50
    );
    await requestOzonMarketingActivateProducts(
      { id: 'shop-1' },
      { id: 'same-id', sourceType: 'official', title: '平台活动' },
      [product],
      50
    );

    const previewBodies = calls
      .filter((call) => call.url.includes('/api/write/marketing/preview'))
      .map((call) => JSON.parse(call.options.body));
    expect(previewBodies.map((body) => body.endpointKey)).toEqual([
      'sellerActions.productsAdd',
      'actions.productsActivate',
    ]);
  });

  it('keeps explicit zero marketing product totals instead of falling back to stale activity counts', () => {
    const activity = { id: 'activity-1', count: 33, available: 1 };
    const localApiResult = buildMarketingProductPoolResultFromLocalApiCache(
      {
        productPool: [],
        joinedTotal: 33,
        availableTotal: 0,
      },
      activity
    );
    const snapshotResult = buildMarketingProductPoolCacheResult([], activity);

    expect(localApiResult.joinedTotal).toBe(33);
    expect(localApiResult.availableTotal).toBe(0);
    expect(snapshotResult.joinedTotal).toBe(0);
    expect(snapshotResult.availableTotal).toBe(0);
  });

  it('reads every SQLite product-pool page instead of silently stopping at 1000 rows', async () => {
    const rows = Array.from({ length: 1350 }, (_, index) => ({
      id: `product-${index + 1}`,
      status: '已添加',
    }));
    globalThis.fetch = vi.fn(async (url) => {
      const page = Number(new URL(String(url)).searchParams.get('page')) || 1;
      const pageRows = page === 1 ? rows.slice(0, 1000) : rows.slice(1000);
      return new Response(JSON.stringify({
        ok: true,
        total: rows.length,
        joinedTotal: rows.length,
        availableTotal: 0,
        productPool: pageRows,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await readMarketingProductPoolLocalApiResult(
      { id: 'shop-1' },
      { id: 'activity-1', sourceType: 'official' },
      'joined'
    );

    expect(result.products).toHaveLength(1350);
    expect(result.joinedTotal).toBe(1350);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(String(globalThis.fetch.mock.calls[1][0])).toContain('page=2');
  });

  it('filters ended marketing activities out of restored activity snapshots', () => {
    const snapshot = buildMarketingActivitySnapshotFromRows([
      {
        id: 'active-activity',
        title: 'Active Promo',
        participating_products_count: 1,
        date_start: '2026-01-01T00:00:00Z',
        date_end: '2099-01-01T00:00:00Z',
      },
      {
        id: 'ended-activity',
        title: 'Ended Promo',
        participating_products_count: 3,
        date_start: '2024-01-01T00:00:00Z',
        date_end: '2024-02-01T00:00:00Z',
      },
    ]);

    expect(snapshot.activityRows).toHaveLength(1);
    expect(snapshot.activityRows[0].id).toBe('active-activity');
    expect(snapshot.marketingSummary.activityTotal).toBe(1);
    expect(snapshot.marketingSummary.joinedActivityTotal).toBe(1);
  });
});
