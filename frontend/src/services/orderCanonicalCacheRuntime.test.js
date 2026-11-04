import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearOrderDomainCache,
  createOrderDomainCacheKey,
  getOrderDomainCacheStats,
  invalidateOrderDomainCacheForShop,
  readOrderDomainCache,
} from './orderCanonicalCacheRuntime.js';

describe('shared canonical order cache runtime', () => {
  afterEach(() => {
    clearOrderDomainCache();
    vi.restoreAllMocks();
  });

  it('uses one stable key for equivalent exact queries', () => {
    expect(createOrderDomainCacheKey('orders', { shopId: 'shop-1', page: 1 }))
      .toBe(createOrderDomainCacheKey('orders', { page: 1, shopId: 'shop-1', empty: '' }));
  });

  it('shares one exact SQLite read and returns mutation-isolated payloads', async () => {
    const loader = vi.fn().mockResolvedValue({ rows: [{ id: 'order-1', products: [{ sku: 'sku-1' }] }], total: 1 });
    const first = await readOrderDomainCache('orders', { shopId: 'shop-1' }, {}, loader);
    first.rows[0].products[0].sku = 'mutated-by-page';
    const second = await readOrderDomainCache('orders', { shopId: 'shop-1' }, {}, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second.rows[0].products[0].sku).toBe('sku-1');
    expect(getOrderDomainCacheStats()).toMatchObject({ entries: 1, orders: 1, returns: 0 });
  });

  it('deduplicates simultaneous page reads without sharing caller-owned objects', async () => {
    let resolveLoad;
    const loader = vi.fn(() => new Promise((resolve) => {
      resolveLoad = resolve;
    }));
    const firstPromise = readOrderDomainCache('returns', { shopId: 'shop-1' }, {}, loader);
    const secondPromise = readOrderDomainCache('returns', { shopId: 'shop-1' }, {}, loader);
    await Promise.resolve();
    resolveLoad({ rows: [{ id: 'return-1' }], total: 1 });
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('bypasses and refreshes the shared value for explicit manual reloads', async () => {
    const loader = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'old' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'new' }] });
    await readOrderDomainCache('orders', { shopId: 'shop-1' }, {}, loader);
    const refreshed = await readOrderDomainCache(
      'orders',
      { shopId: 'shop-1' },
      { bypassMemory: true },
      loader
    );
    const cached = await readOrderDomainCache('orders', { shopId: 'shop-1' }, {}, loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(refreshed.rows[0].id).toBe('new');
    expect(cached.rows[0].id).toBe('new');
  });

  it('does not let a pre-invalidation request repopulate stale data', async () => {
    let resolveLoad;
    const oldLoader = vi.fn(() => new Promise((resolve) => {
      resolveLoad = resolve;
    }));
    const oldRequest = readOrderDomainCache('orders', { shopId: 'shop-1' }, {}, oldLoader);
    await Promise.resolve();
    clearOrderDomainCache('orders');
    resolveLoad({ rows: [{ id: 'old' }] });
    await oldRequest;

    const newLoader = vi.fn().mockResolvedValue({ rows: [{ id: 'new' }] });
    const current = await readOrderDomainCache('orders', { shopId: 'shop-1' }, {}, newLoader);
    expect(newLoader).toHaveBeenCalledTimes(1);
    expect(current.rows[0].id).toBe('new');
  });

  it('leaves unrelated local domains unchanged', async () => {
    const loader = vi.fn().mockResolvedValue({ rows: [] });
    await readOrderDomainCache('products', { shopId: 'shop-1' }, {}, loader);
    await readOrderDomainCache('products', { shopId: 'shop-1' }, {}, loader);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(getOrderDomainCacheStats().entries).toBe(0);
  });

  it('shares exact multi-shop aggregate reads and invalidates them by any owner shop', async () => {
    const loader = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    const query = { shopIds: 'shop-1,shop-2', page: 1, pageSize: 20 };
    await readOrderDomainCache('orders', query, {}, loader);
    await readOrderDomainCache('orders', { ...query, shopIds: 'shop-2,shop-1' }, {}, loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getOrderDomainCacheStats().entries).toBe(1);
    invalidateOrderDomainCacheForShop('orders', 'shop-2');
    await readOrderDomainCache('orders', query, {}, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not cache an ownerless aggregate read', async () => {
    const loader = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    await readOrderDomainCache('orders', { page: 1 }, {}, loader);
    await readOrderDomainCache('orders', { page: 1 }, {}, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
