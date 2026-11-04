import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSalesOrderPagedMemoryCache,
  createSalesOrderPagedCacheQuery,
  invalidateSalesOrderPagedMemoryCache,
  readAllSalesOrderPagedCache,
  readSalesOrderPagedCache,
  resolveSalesOrderShopId,
} from './salesOrderPagedCacheClient.js';
import { invalidateOrderDomainCacheForShop } from './orderCanonicalCacheRuntime.js';

const shop = {
  id: 'shop-1',
  clientId: 'client-1',
  apiKey: 'key-1',
  shopAlias: '测试店铺',
};

describe('sales order paged SQLite client', () => {
  afterEach(() => {
    clearSalesOrderPagedMemoryCache();
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('builds one canonical local-cache query with SQLite pagination and summary', () => {
    expect(
      createSalesOrderPagedCacheQuery({
        shops: [shop],
        timeScope: { since: '2026-07-01T00:00:00.000Z', to: '2026-07-11T23:59:59.999Z' },
        status: '等待备货',
        page: 3,
        pageSize: 50,
      })
    ).toMatchObject({
      shopIds: 'shop-1',
      statusScope: '等待备货',
      since: '2026-07-01T00:00:00.000Z',
      to: '2026-07-11T23:59:59.999Z',
      page: 3,
      pageSize: 50,
      includeSummary: 1,
    });
  });

  it('marks the profit all-history scope without adding date boundaries', () => {
    expect(createSalesOrderPagedCacheQuery({
      shops: [shop],
      timeScope: { allHistory: true, since: '', to: '' },
      includeSummary: false,
      allHistory: true,
    })).toMatchObject({
      shopIds: 'shop-1',
      allHistory: 1,
      since: undefined,
      to: undefined,
    });
  });

  it('requests cached product images only for consumers that explicitly need them', () => {
    expect(createSalesOrderPagedCacheQuery({
      shops: [shop],
      includeSummary: false,
      includeProductImages: true,
      projection: 'profit',
    })).toMatchObject({
      shopIds: 'shop-1',
      includeProductImages: 1,
      projection: 'profit',
    });
    expect(createSalesOrderPagedCacheQuery({ shops: [shop] }).includeProductImages).toBeUndefined();
  });

  it('uses the internal shop id even when the shop also has generation-aware identity fields', () => {
    const generatedShop = {
      ...shop,
      profileId: 'default',
      shopIncarnation: 'incarnation-2',
      credentialRevision: 7,
    };
    expect(createSalesOrderPagedCacheQuery({
      shops: [generatedShop],
      shop: generatedShop.id,
    })).toMatchObject({
      shopId: 'shop-1',
      shopIds: undefined,
    });
  });

  it('serializes exact posting numbers for bounded local dependency recovery', () => {
    expect(createSalesOrderPagedCacheQuery({
      shops: [shop],
      shop: shop.id,
      postingNumbers: ['12992798-1056-1', ' 38814751-0061-1 ', ''],
      includeSummary: false,
      pageSize: 2,
    })).toMatchObject({
      shopId: 'shop-1',
      shopIds: undefined,
      postingNumbers: '12992798-1056-1,38814751-0061-1',
      includeSummary: undefined,
      pageSize: 2,
    });
  });

  it('serializes print-shipping filters into the canonical SQLite query', () => {
    expect(createSalesOrderPagedCacheQuery({
      shops: [shop],
      printShippingFilters: {
        warehouse: '莫斯科仓',
        deliveryMethod: 'CDEK',
        deadlineScope: 'within24h',
        trackingState: 'missing',
        carriageState: 'unassigned',
      },
      includePrintShippingFacets: true,
    })).toMatchObject({
      warehouse: '莫斯科仓',
      deliveryMethod: 'CDEK',
      deadlineScope: 'within24h',
      trackingState: 'missing',
      carriageState: 'unassigned',
      includePrintShippingFacets: 1,
    });
  });

  it('canonicalizes legacy client, label and generation-aware selections to the SQLite shop id', () => {
    const generatedShop = {
      ...shop,
      profileId: 'default',
      shopIncarnation: 'incarnation-2',
      credentialRevision: 7,
    };
    expect(resolveSalesOrderShopId([generatedShop], generatedShop.clientId)).toBe('shop-1');
    expect(resolveSalesOrderShopId([generatedShop], generatedShop.shopAlias)).toBe('shop-1');
    expect(
      resolveSalesOrderShopId(
        [generatedShop],
        'ozon-shop:client:client-1:incarnation:incarnation-2:revision:7'
      )
    ).toBe('shop-1');
    expect(createSalesOrderPagedCacheQuery({ shops: [generatedShop], shop: generatedShop.clientId })).toMatchObject({
      shopId: 'shop-1',
      shopIds: undefined,
    });
  });

  it('does not guess when two stores share the same display label', () => {
    const duplicateLabelShop = {
      ...shop,
      id: 'shop-2',
      clientId: 'client-2',
    };
    expect(resolveSalesOrderShopId([shop, duplicateLabelShop], shop.shopAlias)).toBe(shop.shopAlias);
  });

  it('never turns an obsolete single-shop selection into an all-shop query', () => {
    expect(createSalesOrderPagedCacheQuery({
      shops: [shop],
      shop: 'removed-shop-id',
    })).toMatchObject({
      shopId: 'removed-shop-id',
      shopIds: undefined,
    });
  });

  it('reads only the current order page through /api/cache/orders', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          source: 'sqlite',
          rows: [{ shopId: 'shop-1', posting_number: 'POST-1', status: 'awaiting_packaging', products: [] }],
          total: 5000,
          page: 2,
          pageSize: 20,
          summary: { total: 5000, salesStatusCounts: { all: 5000, '等待备货': 5000 }, amountTotal: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await readSalesOrderPagedCache({ shops: [shop], page: 2, pageSize: 20 });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/cache/orders');
    expect(url.searchParams.get('shopIds')).toBe('shop-1');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('20');
    expect(url.searchParams.get('includeSummary')).toBe('1');
    expect(result.total).toBe(5000);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ posting: 'POST-1', status: '等待备货', shopId: 'shop-1' });
  });

  it('reuses a bounded in-memory page during ordinary tab reactivation', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, source: 'sqlite', rows: [], total: 0, page: 1, pageSize: 20, summary: { total: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await readSalesOrderPagedCache({ shops: [shop], shop: shop.id, page: 1, pageSize: 20 });
    const cached = await readSalesOrderPagedCache({ shops: [shop], shop: shop.id, page: 1, pageSize: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cached.memoryHit).toBe(true);
  });

  it('asks local-api to bypass its hot cache after an Ozon refresh completes', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, source: 'sqlite', rows: [], total: 0, page: 1, pageSize: 20 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await readSalesOrderPagedCache(
      { shops: [shop], shop: shop.id, page: 1, pageSize: 20 },
      { bypassMemory: true, bypassHotCache: true }
    );

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('_bypassHotCache')).toBe('1');
  });

  it('stores an exact all-shop aggregate page and invalidates it by an affected shop', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const secondShop = { ...shop, id: 'shop-2', clientId: 'client-2', shopAlias: '测试店铺2' };
    const response = () => new Response(
      JSON.stringify({ ok: true, source: 'sqlite', rows: [], total: 0, page: 1, pageSize: 20, summary: { total: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response());

    const first = await readSalesOrderPagedCache({ shops: [shop, secondShop], page: 1, pageSize: 20 });
    const second = await readSalesOrderPagedCache({ shops: [shop, secondShop], page: 1, pageSize: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.memoryHit).not.toBe(true);
    expect(second.memoryHit).toBe(true);
    expect(invalidateSalesOrderPagedMemoryCache({ shopId: 'shop-2' })).toBe(1);
    invalidateOrderDomainCacheForShop('orders', 'shop-2');
    await readSalesOrderPagedCache({ shops: [shop, secondShop], page: 1, pageSize: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips a malformed null cache row instead of crashing the waiting-packaging tab', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          source: 'sqlite',
          rows: [null, { shopId: 'shop-1', posting_number: 'POST-2', status: 'awaiting_packaging', products: [] }],
          total: 2,
          page: 1,
          pageSize: 20,
          summary: { total: 2, salesStatusCounts: { all: 2, '等待备货': 2 }, amountTotal: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await readSalesOrderPagedCache({ shops: [shop], status: '等待备货' });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ posting: 'POST-2', status: '等待备货' });
  });

  it('reads every SQLite page without a fixed total-order ceiling', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const createRows = (start, count) => Array.from({ length: count }, (_item, index) => ({
      shopId: 'shop-1',
      posting_number: `POST-${start + index}`,
      status: 'awaiting_packaging',
      products: [],
    }));
    const response = (rows, page) => new Response(JSON.stringify({
      ok: true,
      source: 'sqlite',
      rows,
      total: 2505,
      page,
      pageSize: 1000,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(createRows(1, 1000), 1))
      .mockResolvedValueOnce(response(createRows(1001, 1000), 2))
      .mockResolvedValueOnce(response(createRows(2001, 505), 3));

    const result = await readAllSalesOrderPagedCache({ shops: [shop] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.total).toBe(2505);
    expect(result.rows).toHaveLength(2505);
    expect(result.rows.at(-1).posting).toBe('POST-2505');
  });
});
