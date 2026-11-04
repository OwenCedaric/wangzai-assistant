import { describe, expect, it } from 'vitest';
import {
  OZON_LOCAL_DATA_LAYER_VERSION,
  cleanupOzonLocalDataStoreSnapshots,
  createEmptyOzonLocalDataStore,
  getOzonLocalSnapshotHealth,
  mergeDomainSnapshotIntoLocalStore,
  mergeOzonProductSnapshotIntoLocalStore,
  mergeOzonSnapshotIntoLocalStore,
  normalizeOzonLocalDataStore,
  readDomainSnapshotFromLocalStore,
  readOzonProductSnapshotFromLocalStore,
  readOzonRefreshLogsFromLocalStore,
  readOzonRetryQueueFromLocalStore,
  readOzonSnapshotFromLocalStore,
} from './ozonLocalDataLayer.js';

describe('ozonLocalDataLayer store', () => {
  it('keeps the previous successful snapshot when a failed refresh returns no rows', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [{ recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', products: [] }],
      },
      { now: '2026-06-23T00:00:00.000Z' }
    );

    const failed = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [],
        errors: [{ label: 'FBS', error: new Error('HTTP 429') }],
      },
      { now: '2026-06-23T00:01:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(failed.store, 'ozon-sales-orders:shop-a');
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.errors).toEqual([{ label: 'FBS', message: 'HTTP 429' }]);
  });

  it('keeps one after-sales snapshot for verified current and legacy key candidates, then drops their orphan display rows', () => {
    const legacyKey =
      'ozon-after-sales:ozon-shop:client:4616153:after-sales-orders:range:2026-04-12_2026-07-11:filter:all';
    const primaryKey =
      'ozon-after-sales:ozon-shop:id:ozon-shop-1:after-sales-orders:range:2026-04-13_2026-07-12:filter:all';
    const anotherShopKey =
      'ozon-after-sales:ozon-shop:id:ozon-shop-2:after-sales-orders:range:2026-04-13_2026-07-12:filter:all';
    let store = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      legacyKey,
      {
        rows: [
          {
            recordKey: 'legacy-shop:posting-1',
            shopClientId: '4616153',
            posting: 'posting-1',
            status: 'returned',
            products: [],
          },
        ],
      },
      { now: '2026-07-11T00:00:00.000Z' }
    ).store;
    store = mergeOzonSnapshotIntoLocalStore(
      store,
      anotherShopKey,
      {
        rows: [
          {
            recordKey: 'other-shop:posting-1',
            shopClientId: 'other-shop',
            posting: 'posting-1',
            status: 'returned',
            products: [],
          },
        ],
      },
      { now: '2026-07-12T00:00:00.000Z' }
    ).store;

    const compacted = mergeOzonSnapshotIntoLocalStore(
      store,
      primaryKey,
      {
        rows: [
          {
            recordKey: 'stable-shop:posting-2',
            shopId: 'ozon-shop-1',
            shopClientId: '4616153',
            posting: 'posting-2',
            status: 'returned',
            products: [],
          },
        ],
      },
      {
        now: '2026-07-12T00:01:00.000Z',
        afterSalesCompatibleSnapshotKeys: [primaryKey, legacyKey],
      }
    );

    expect(compacted.stats.afterSalesCompaction).toMatchObject({
      changed: true,
      removedSnapshots: 1,
      removedOrders: 1,
    });
    expect(Object.keys(compacted.store.snapshots)).toEqual(expect.arrayContaining([primaryKey, anotherShopKey]));
    expect(compacted.store.snapshots[legacyKey]).toBeUndefined();
    expect(compacted.store.orders['legacy-shop:posting-1']).toBeUndefined();
    expect(readOzonSnapshotFromLocalStore(compacted.store, primaryKey).rows).toHaveLength(1);
    expect(readOzonSnapshotFromLocalStore(compacted.store, anotherShopKey).rows).toHaveLength(1);
  });

  it('records added, updated, unchanged, skipped empty, and failed counts in order refresh summaries', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [
          { recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', status: 'awaiting_packaging', products: [] },
          { recordKey: 'shop-a:posting-2', shopClientId: 'shop-a', status: 'awaiting_deliver', products: [] },
        ],
      },
      { now: '2026-06-23T00:00:00.000Z' }
    );

    const refreshed = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [
          { recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', status: 'awaiting_deliver', products: [] },
          { recordKey: 'shop-a:posting-2', shopClientId: 'shop-a', status: 'awaiting_deliver', products: [] },
          { recordKey: 'shop-a:posting-3', shopClientId: 'shop-a', status: 'awaiting_packaging', products: [] },
        ],
      },
      { now: '2026-06-23T00:01:00.000Z' }
    );

    expect(readOzonSnapshotFromLocalStore(refreshed.store, 'ozon-sales-orders:shop-a').changeSummary).toMatchObject({
      previous: 2,
      next: 3,
      added: 1,
      retained: 2,
      updated: 1,
      unchanged: 1,
      removed: 0,
      failed: 0,
      skippedEmpty: 0,
    });

    const failed = mergeOzonSnapshotIntoLocalStore(
      refreshed.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [],
        errors: [{ label: 'FBS', message: 'HTTP 500' }],
      },
      { now: '2026-06-23T00:02:00.000Z' }
    );

    expect(readOzonSnapshotFromLocalStore(failed.store, 'ozon-sales-orders:shop-a').changeSummary).toMatchObject({
      failed: 1,
      skippedEmpty: 1,
      updated: 0,
      unchanged: 3,
    });
  });

  it('records updated and unchanged product counts in product refresh summaries', () => {
    const initial = mergeOzonProductSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-products:shop-a:all',
      {
        rows: [
          { productId: 'product-1', offerId: 'offer-1', sku: 'sku-1', name: 'Product A' },
          { productId: 'product-2', offerId: 'offer-2', sku: 'sku-2', name: 'Product B' },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T00:00:00.000Z' }
    );

    const refreshed = mergeOzonProductSnapshotIntoLocalStore(
      initial.store,
      'ozon-products:shop-a:all',
      {
        rows: [
          { productId: 'product-1', offerId: 'offer-1', sku: 'sku-1', name: 'Product A Changed' },
          { productId: 'product-2', offerId: 'offer-2', sku: 'sku-2', name: 'Product B' },
          { productId: 'product-3', offerId: 'offer-3', sku: 'sku-3', name: 'Product C' },
        ],
      },
      { shopKey: 'shop-a', now: '2026-06-23T00:01:00.000Z' }
    );

    expect(
      readOzonProductSnapshotFromLocalStore(refreshed.store, 'ozon-products:shop-a:all').changeSummary
    ).toMatchObject({
      added: 1,
      retained: 2,
      updated: 1,
      unchanged: 1,
      failed: 0,
      skippedEmpty: 0,
    });
  });

  it('records failed snapshots as isolated retry queue items and clears them after success', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [{ recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', products: [] }],
      },
      { now: '2026-06-23T00:00:00.000Z' }
    );

    const failed = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [],
        errors: [
          {
            label: 'FBS',
            endpoint: '/v3/posting/fbs/list',
            error: { message: 'HTTP 429', status: 429, retryAfterMs: 120000 },
          },
        ],
      },
      { now: '2026-06-23T00:01:00.000Z' }
    );

    const retryQueue = readOzonRetryQueueFromLocalStore(failed.store, {
      snapshotKey: 'ozon-sales-orders:shop-a',
    });
    expect(retryQueue).toHaveLength(1);
    expect(retryQueue[0]).toMatchObject({
      snapshotKey: 'ozon-sales-orders:shop-a',
      type: 'orders',
      label: 'FBS',
      endpoint: '/v3/posting/fbs/list',
      status: 429,
      attemptCount: 1,
      maxAttempts: 8,
      retryStatus: 'pending',
      nextRetryAt: '2026-06-23T00:03:00.000Z',
    });
    expect(
      readOzonRetryQueueFromLocalStore(failed.store, {
        snapshotKey: 'ozon-sales-orders:shop-a',
        dueOnly: true,
        now: '2026-06-23T00:02:59.000Z',
      })
    ).toHaveLength(0);
    expect(
      readOzonRetryQueueFromLocalStore(failed.store, {
        snapshotKey: 'ozon-sales-orders:shop-a',
        dueOnly: true,
        now: '2026-06-23T00:03:00.000Z',
      })
    ).toHaveLength(1);

    const recovered = mergeOzonSnapshotIntoLocalStore(
      failed.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [{ recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', status: 'awaiting_deliver', products: [] }],
      },
      { now: '2026-06-23T00:04:00.000Z' }
    );

    expect(readOzonRetryQueueFromLocalStore(recovered.store, { snapshotKey: 'ozon-sales-orders:shop-a' })).toEqual([]);
    expect(readOzonSnapshotFromLocalStore(recovered.store, 'ozon-sales-orders:shop-a').rows[0].status).toBe(
      'awaiting_deliver'
    );
  });

  it('pauses repeated failed snapshots after the max retry attempts', () => {
    let currentStore = createEmptyOzonLocalDataStore();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      currentStore = mergeOzonSnapshotIntoLocalStore(
        currentStore,
        'ozon-sales-orders:shop-a',
        {
          rows: [],
          errors: [
            {
              label: 'FBS',
              endpoint: '/v3/posting/fbs/list',
              error: { message: 'HTTP 500', status: 500 },
            },
          ],
        },
        { now: new Date(Date.parse('2026-06-23T00:00:00.000Z') + attempt * 60_000).toISOString() }
      ).store;
    }

    const retryQueue = readOzonRetryQueueFromLocalStore(currentStore, { snapshotKey: 'ozon-sales-orders:shop-a' });
    expect(retryQueue).toHaveLength(1);
    expect(retryQueue[0]).toMatchObject({
      attemptCount: 8,
      maxAttempts: 8,
      retryStatus: 'paused',
      nextRetryAt: '',
      retryDelayMs: 0,
    });
    expect(
      readOzonRetryQueueFromLocalStore(currentStore, {
        snapshotKey: 'ozon-sales-orders:shop-a',
        dueOnly: true,
        now: '2026-06-23T01:00:00.000Z',
      })
    ).toEqual([]);
  });

  it('keeps the retry queue bounded so historical failures cannot grow forever', () => {
    let currentStore = createEmptyOzonLocalDataStore();
    for (let index = 0; index < 520; index += 1) {
      const timestamp = new Date(Date.parse('2026-06-23T00:00:00.000Z') + index * 1000).toISOString();
      const snapshotKey = `ozon-sales-orders:shop-a:range:${String(index).padStart(3, '0')}`;
      currentStore = mergeOzonSnapshotIntoLocalStore(
        currentStore,
        snapshotKey,
        {
          rows: [],
          errors: [
            {
              label: `FBS-${index}`,
              endpoint: '/v3/posting/fbs/list',
              error: { message: `HTTP 429 ${index}`, status: 429 },
            },
          ],
        },
        { now: timestamp }
      ).store;
    }

    const retryQueue = readOzonRetryQueueFromLocalStore(currentStore);
    expect(retryQueue).toHaveLength(500);
    expect(retryQueue.some((failure) => failure.snapshotKey.endsWith('519'))).toBe(true);
    expect(retryQueue.some((failure) => failure.snapshotKey.endsWith('000'))).toBe(false);
  }, 15000);

  it('keeps page snapshots bounded while preserving recent cache ranges', () => {
    let currentStore = createEmptyOzonLocalDataStore();
    for (let index = 0; index < 1010; index += 1) {
      const suffix = String(index).padStart(4, '0');
      currentStore = mergeOzonProductSnapshotIntoLocalStore(
        currentStore,
        `ozon-products:shop-a:range:${suffix}`,
        {
          rows: [{ offerId: `offer-${suffix}`, sku: `sku-${suffix}` }],
        },
        { shopKey: 'shop-a', now: new Date(Date.parse('2026-06-23T00:00:00.000Z') + index * 1000).toISOString() }
      ).store;
    }

    expect(Object.keys(currentStore.snapshots)).toHaveLength(1000);
    expect(readOzonProductSnapshotFromLocalStore(currentStore, 'ozon-products:shop-a:range:1009').rows).toHaveLength(1);
    expect(readOzonProductSnapshotFromLocalStore(currentStore, 'ozon-products:shop-a:range:0000')).toBeNull();
  }, 15_000);

  it('keeps domain snapshots bounded separately from order and product snapshots', () => {
    let currentStore = createEmptyOzonLocalDataStore();
    for (let index = 0; index < 520; index += 1) {
      const suffix = String(index).padStart(3, '0');
      currentStore = mergeDomainSnapshotIntoLocalStore(
        currentStore,
        `warehouse:shop-a:range:${suffix}`,
        {
          domain: 'warehouse',
          rows: [{ id: `warehouse-${suffix}` }],
        },
        { now: new Date(Date.parse('2026-06-23T00:00:00.000Z') + index * 1000).toISOString() }
      ).store;
    }

    expect(Object.keys(currentStore.domainSnapshots)).toHaveLength(500);
    expect(readDomainSnapshotFromLocalStore(currentStore, 'warehouse:shop-a:range:519').rows).toHaveLength(1);
    expect(readDomainSnapshotFromLocalStore(currentStore, 'warehouse:shop-a:range:000')).toBeNull();
  });

  it('cleans scoped snapshots by domain, shop, and time range without deleting reusable entities', () => {
    let currentStore = createEmptyOzonLocalDataStore();
    currentStore = mergeOzonSnapshotIntoLocalStore(
      currentStore,
      'ozon-sales-orders:sales-orders:range:2026-06-01_2026-06-30:shop-a',
      {
        rows: [{ recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', posting: 'posting-1', products: [] }],
        errors: [{ label: 'FBS', endpoint: '/v3/posting/fbs/list', message: 'HTTP 429' }],
      },
      { now: '2026-06-30T00:00:00.000Z' }
    ).store;
    currentStore = mergeOzonSnapshotIntoLocalStore(
      currentStore,
      'ozon-sales-orders:sales-orders:range:2026-06-01_2026-06-30:shop-b',
      {
        rows: [{ recordKey: 'shop-b:posting-1', shopClientId: 'shop-b', posting: 'posting-1', products: [] }],
      },
      { now: '2026-06-30T00:01:00.000Z' }
    ).store;
    currentStore = mergeOzonProductSnapshotIntoLocalStore(
      currentStore,
      'ozon-products:products:range:2026-06-01_2026-06-30:shop-a',
      {
        rows: [{ productId: 'product-1', offerId: 'offer-1', sku: 'sku-1' }],
      },
      { shopKey: 'shop-a', now: '2026-06-30T00:02:00.000Z' }
    ).store;

    const cleaned = cleanupOzonLocalDataStoreSnapshots(currentStore, {
      domains: ['salesOrders'],
      shopKeys: ['shop-a'],
      rangeStart: '2026-06-01',
      rangeEnd: '2026-06-30',
      now: '2026-06-30T00:03:00.000Z',
    });

    expect(cleaned.stats).toMatchObject({
      changed: true,
      removedSnapshots: 1,
      removedDomainSnapshots: 0,
      removedFailures: 1,
      removedLogs: 1,
    });
    expect(
      readOzonSnapshotFromLocalStore(cleaned.store, 'ozon-sales-orders:sales-orders:range:2026-06-01_2026-06-30:shop-a')
    ).toBeNull();
    expect(
      readOzonSnapshotFromLocalStore(cleaned.store, 'ozon-sales-orders:sales-orders:range:2026-06-01_2026-06-30:shop-b')
        .rows
    ).toHaveLength(1);
    expect(
      readOzonProductSnapshotFromLocalStore(cleaned.store, 'ozon-products:products:range:2026-06-01_2026-06-30:shop-a')
        .rows
    ).toHaveLength(1);
    expect(Object.keys(cleaned.store.orders)).toEqual(expect.arrayContaining(['shop-a:posting-1', 'shop-b:posting-1']));
    expect(readOzonRetryQueueFromLocalStore(cleaned.store)).toEqual([]);
  });

  it('does not clean snapshots from another shop with a similar cache key segment', () => {
    let currentStore = createEmptyOzonLocalDataStore();
    currentStore = mergeOzonSnapshotIntoLocalStore(
      currentStore,
      'ozon-sales-orders:sales-orders:range:2026-06-01_2026-06-30:shop-a',
      {
        rows: [{ recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', posting: 'posting-1', products: [] }],
      },
      { now: '2026-06-30T00:00:00.000Z' }
    ).store;
    currentStore = mergeOzonSnapshotIntoLocalStore(
      currentStore,
      'ozon-sales-orders:sales-orders:range:2026-06-01_2026-06-30:shop-aa',
      {
        rows: [{ recordKey: 'shop-aa:posting-1', shopClientId: 'shop-aa', posting: 'posting-1', products: [] }],
      },
      { now: '2026-06-30T00:01:00.000Z' }
    ).store;
    currentStore = mergeDomainSnapshotIntoLocalStore(
      currentStore,
      'warehouse:range:2026-06-01_2026-06-30:shop-aa',
      {
        domain: 'warehouse',
        rows: [{ id: 'warehouse-aa' }],
      },
      { now: '2026-06-30T00:02:00.000Z' }
    ).store;

    const cleaned = cleanupOzonLocalDataStoreSnapshots(currentStore, {
      shopKeys: ['shop-a'],
      rangeStart: '2026-06-01',
      rangeEnd: '2026-06-30',
      now: '2026-06-30T00:03:00.000Z',
    });

    expect(cleaned.stats).toMatchObject({
      removedSnapshots: 1,
      removedDomainSnapshots: 0,
    });
    expect(
      readOzonSnapshotFromLocalStore(cleaned.store, 'ozon-sales-orders:sales-orders:range:2026-06-01_2026-06-30:shop-a')
    ).toBeNull();
    expect(
      readOzonSnapshotFromLocalStore(
        cleaned.store,
        'ozon-sales-orders:sales-orders:range:2026-06-01_2026-06-30:shop-aa'
      ).rows
    ).toHaveLength(1);
    expect(
      readDomainSnapshotFromLocalStore(cleaned.store, 'warehouse:range:2026-06-01_2026-06-30:shop-aa').rows
    ).toHaveLength(1);
  });

  it('cleans old domain snapshots by domain and updated time while keeping recent ranges', () => {
    let currentStore = createEmptyOzonLocalDataStore();
    currentStore = mergeDomainSnapshotIntoLocalStore(
      currentStore,
      'warehouse:shop-a:range:2026-05-01_2026-05-31',
      {
        domain: 'warehouse',
        rows: [{ id: 'old-warehouse' }],
      },
      { now: '2026-05-31T00:00:00.000Z' }
    ).store;
    currentStore = mergeDomainSnapshotIntoLocalStore(
      currentStore,
      'warehouse:shop-a:range:2026-06-01_2026-06-30',
      {
        domain: 'warehouse',
        rows: [{ id: 'fresh-warehouse' }],
      },
      { now: '2026-06-30T00:00:00.000Z' }
    ).store;

    const cleaned = cleanupOzonLocalDataStoreSnapshots(currentStore, {
      domains: ['warehouse'],
      updatedBefore: '2026-06-01T00:00:00.000Z',
      now: '2026-06-30T00:01:00.000Z',
    });

    expect(cleaned.stats).toMatchObject({
      changed: true,
      removedSnapshots: 0,
      removedDomainSnapshots: 1,
    });
    expect(readDomainSnapshotFromLocalStore(cleaned.store, 'warehouse:shop-a:range:2026-05-01_2026-05-31')).toBeNull();
    expect(
      readDomainSnapshotFromLocalStore(cleaned.store, 'warehouse:shop-a:range:2026-06-01_2026-06-30').rows
    ).toEqual([{ id: 'fresh-warehouse' }]);
  });

  it('records bounded refresh logs with change summaries and redacted sensitive text', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [{ recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', products: [] }],
      },
      { now: '2026-06-23T00:00:00.000Z' }
    );
    const updated = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [
          { recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', products: [] },
          { recordKey: 'shop-a:posting-2', shopClientId: 'shop-a', products: [] },
        ],
        errors: [{ label: 'FBS', message: 'apiKey=secret-token failed' }],
      },
      { now: '2026-06-23T00:01:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(updated.store, 'ozon-sales-orders:shop-a');
    expect(snapshot.changeSummary).toMatchObject({
      previous: 1,
      next: 2,
      added: 1,
      retained: 1,
      failed: 1,
    });

    const logs = readOzonRefreshLogsFromLocalStore(updated.store, { snapshotKey: 'ozon-sales-orders:shop-a' });
    expect(logs[0]).toMatchObject({
      snapshotKey: 'ozon-sales-orders:shop-a',
      type: 'orders',
      rows: 2,
      partial: true,
    });
    expect(logs[0].errors[0].message).toContain('[REDACTED]');
  });

  it('records updated and unchanged row counts for generic domain snapshots', () => {
    const initial = mergeDomainSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'warehouse:shop-a',
      {
        domain: 'warehouse',
        deliveryMethods: [
          { methodId: 'method-1', name: 'Old Method' },
          { methodId: 'method-2', name: 'Same Method' },
        ],
      },
      { now: '2026-06-23T00:00:00.000Z' }
    );

    const refreshed = mergeDomainSnapshotIntoLocalStore(
      initial.store,
      'warehouse:shop-a',
      {
        domain: 'warehouse',
        deliveryMethods: [
          { methodId: 'method-1', name: 'Updated Method' },
          { methodId: 'method-2', name: 'Same Method' },
          { methodId: 'method-3', name: 'New Method' },
        ],
        errors: [{ label: 'Warehouse', message: 'HTTP 429' }],
      },
      { now: '2026-06-23T00:01:00.000Z' }
    );

    const snapshot = readDomainSnapshotFromLocalStore(refreshed.store, 'warehouse:shop-a');
    expect(refreshed.store.domainSnapshots['warehouse:shop-a'].rowKeys).toEqual(['method-1', 'method-2', 'method-3']);
    expect(snapshot.changeSummary).toMatchObject({
      previous: 2,
      next: 3,
      added: 1,
      retained: 2,
      updated: 1,
      unchanged: 1,
      failed: 1,
    });

    const logs = readOzonRefreshLogsFromLocalStore(refreshed.store, { snapshotKey: 'warehouse:shop-a' });
    expect(logs[0].changeSummary).toMatchObject({
      added: 1,
      updated: 1,
      unchanged: 1,
      failed: 1,
    });
  });

  it('reports snapshot cache health from version, updated time, hash, and force refresh state', () => {
    const current = getOzonLocalSnapshotHealth(
      {
        version: OZON_LOCAL_DATA_LAYER_VERSION,
        updatedAt: '2026-06-23T00:00:00.000Z',
        signature: 'hash-1',
      },
      { now: '2026-06-23T00:01:00.000Z', maxAgeMs: 120000 }
    );

    expect(current).toMatchObject({
      stale: false,
      isCurrentVersion: true,
      hasHash: true,
      isExpired: false,
      reasons: [],
    });

    expect(
      getOzonLocalSnapshotHealth(
        {
          version: OZON_LOCAL_DATA_LAYER_VERSION - 1,
          updatedAt: '2026-06-23T00:00:00.000Z',
        },
        { now: '2026-06-23T00:10:00.000Z', maxAgeMs: 120000, forceRefresh: true }
      )
    ).toMatchObject({
      stale: true,
      hasHash: false,
      isCurrentVersion: false,
      isExpired: true,
      reasons: expect.arrayContaining(['force-refresh', 'version-mismatch', 'missing-hash', 'expired']),
    });
  });

  it('returns cache health with order, product, and domain snapshots', () => {
    const orderSnapshot = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [{ recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', products: [] }],
      },
      { now: '2026-06-23T00:00:00.000Z' }
    ).store;
    const productSnapshot = mergeOzonProductSnapshotIntoLocalStore(
      orderSnapshot,
      'ozon-products:shop-a',
      {
        rows: [{ offerId: 'offer-1', productId: '1001' }],
      },
      { shopKey: 'shop-a', now: '2026-06-23T00:01:00.000Z' }
    ).store;
    const domainSnapshot = mergeDomainSnapshotIntoLocalStore(
      productSnapshot,
      'warehouse:shop-a',
      {
        domain: 'warehouse',
        rows: [{ id: 'warehouse-1' }],
      },
      { now: '2026-06-23T00:02:00.000Z' }
    ).store;

    expect(readOzonSnapshotFromLocalStore(domainSnapshot, 'ozon-sales-orders:shop-a').cacheHealth).toMatchObject({
      stale: false,
      version: OZON_LOCAL_DATA_LAYER_VERSION,
      hasHash: true,
    });
    expect(readOzonProductSnapshotFromLocalStore(domainSnapshot, 'ozon-products:shop-a').cacheHealth).toMatchObject({
      stale: false,
      hasHash: true,
    });
    expect(readDomainSnapshotFromLocalStore(domainSnapshot, 'warehouse:shop-a').cacheHealth).toMatchObject({
      stale: false,
      hasHash: true,
    });
  });

  it('normalizes legacy refresh logs and retry failures with redaction and recent-first ordering', () => {
    const normalized = normalizeOzonLocalDataStore({
      logs: [
        {
          id: 'old',
          at: '2026-06-23T00:00:00.000Z',
          snapshotKey: 'ozon-sales-orders:shop-a:old',
          errors: [{ label: 'Ozon', message: 'password=legacy-password failed' }],
        },
        {
          id: 'new',
          at: '2026-06-23T00:02:00.000Z',
          snapshotKey: 'ozon-sales-orders:shop-a:11111111-2222-3333-4444-555555555555:new',
          errors: [{ label: 'Ozon', message: 'token=legacy-token 22222222-3333-4444-5555-666666666666 failed' }],
        },
        {
          id: 'middle',
          at: '2026-06-23T00:01:00.000Z',
          snapshotKey: 'ozon-sales-orders:shop-a:middle',
          errors: [{ label: 'Ozon', message: 'apiKey=legacy-key failed' }],
        },
      ],
      failures: {
        legacy: {
          key: 'legacy:33333333-4444-5555-6666-777777777777',
          snapshotKey: 'ozon-sales-orders:shop-a:44444444-5555-6666-7777-888888888888',
          type: 'orders',
          label: 'FBS',
          message: 'companySecret=legacy-secret failed',
          endpoint: '/v3/posting/fbs/list',
          lastFailedAt: '2026-06-23T00:01:00.000Z',
        },
      },
    });

    expect(normalized.logs.map((log) => log.id)).toEqual(['new', 'middle', 'old']);
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain('legacy-password');
    expect(serialized).not.toContain('legacy-token');
    expect(serialized).not.toContain('legacy-key');
    expect(serialized).not.toContain('legacy-secret');
    expect(serialized).not.toContain('11111111-2222-3333-4444-555555555555');
    expect(serialized).not.toContain('22222222-3333-4444-5555-666666666666');
    expect(serialized).not.toContain('33333333-4444-5555-6666-777777777777');
    expect(serialized).not.toContain('44444444-5555-6666-7777-888888888888');
    expect(serialized).toContain('[REDACTED]');
  });

  it('keeps order snapshot rows when an empty failed refresh returns', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [{ recordKey: 'shop-a:posting-1', shopClientId: 'shop-a', posting: 'posting-1', products: [] }],
      },
      { now: '2026-06-23T03:00:00.000Z' }
    );

    const failed = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [],
        errors: [{ label: 'FBS', message: 'HTTP 500' }],
      },
      { now: '2026-06-23T03:01:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(failed.store, 'ozon-sales-orders:shop-a');

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].posting).toBe('posting-1');
    expect(snapshot.changeSummary).toMatchObject({ skippedEmpty: 1, failed: 1 });
  });

  it('keeps order snapshot references consistent after entity pruning', () => {
    const rows = Array.from({ length: 5005 }, (_, index) => ({
      recordKey: `shop-a:posting-${index}`,
      id: `posting-${index}`,
      posting: `posting-${index}`,
      shopClientId: 'shop-a',
      products: [],
    }));

    const merged = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'orders:shop-a:wide-range',
      { rows },
      { now: '2026-06-01T00:00:00.000Z' }
    );

    const snapshot = merged.store.snapshots['orders:shop-a:wide-range'];
    expect(Object.keys(merged.store.orders)).toHaveLength(5000);
    expect(snapshot.rowKeys).toHaveLength(5000);
    expect(snapshot.rowKeys.every((key) => Boolean(merged.store.orders[key]))).toBe(true);
    expect(readOzonSnapshotFromLocalStore(merged.store, 'orders:shop-a:wide-range').rows).toHaveLength(5000);
  });

  it('reports domain snapshot source keys so old compatible reads can be logged without overwriting new data', () => {
    const oldSecretLikeSegment = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const { store } = mergeDomainSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      `warehouse:shop-a:client-a:${oldSecretLikeSegment}`,
      {
        domain: 'warehouse',
        rows: [{ id: 'warehouse-legacy', name: 'Legacy warehouse' }],
      },
      { domain: 'warehouse', now: '2026-06-24T00:00:00.000Z' }
    );

    const snapshot = readDomainSnapshotFromLocalStore(store, 'warehouse:shop-a:client-a');

    expect(snapshot.rows).toEqual([{ id: 'warehouse-legacy', name: 'Legacy warehouse' }]);
    expect(snapshot).toMatchObject({
      localSnapshotKey: `warehouse:shop-a:client-a:${oldSecretLikeSegment}`,
      legacyCompatibleRead: true,
    });
  });

  it('stores generic domain snapshots without replacing good data on failed empty refreshes', () => {
    const first = mergeDomainSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-warehouse-config:shop-a',
      {
        domain: 'warehouse',
        warehouses: [{ id: 'warehouse-1', name: 'Main warehouse' }],
        deliveryMethods: [{ id: 'method-1', warehouseId: 'warehouse-1' }],
        fetchedAt: '2026-06-24 10:00:00',
      },
      { domain: 'warehouse', now: '2026-06-24T02:00:00.000Z' }
    );

    const failed = mergeDomainSnapshotIntoLocalStore(
      first.store,
      'ozon-warehouse-config:shop-a',
      {
        domain: 'warehouse',
        errors: [{ label: '仓库配置', message: 'token=secret-value 请求失败' }],
      },
      { domain: 'warehouse', now: '2026-06-24T02:01:00.000Z' }
    );

    const snapshot = readDomainSnapshotFromLocalStore(failed.store, 'ozon-warehouse-config:shop-a');

    expect(snapshot).toMatchObject({
      warehouses: [{ id: 'warehouse-1', name: 'Main warehouse' }],
      deliveryMethods: [{ id: 'method-1', warehouseId: 'warehouse-1' }],
      source: 'local-data-layer',
    });
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.changeSummary).toMatchObject({ skippedEmpty: 1, failed: 1 });
    expect(
      readOzonRefreshLogsFromLocalStore(failed.store, { snapshotKey: 'ozon-warehouse-config:shop-a' })[0]
    ).toMatchObject({
      errors: [{ message: 'token=[REDACTED] 请求失败' }],
    });
  });
});
