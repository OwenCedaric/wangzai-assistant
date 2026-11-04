import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestLocalOzon } from '../api/localApiClient';
import {
  pollProductListSyncJob,
  pollProductListSyncJobs,
  readProductListCache,
  startProductFullSync,
  startProductListSync,
} from './productListSyncClient';

describe('productListSyncClient local-api adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('reads product cache through /api/cache/products', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, rows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await readProductListCache({ shopId: 'shop-1', pageSize: 20 });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/cache/products');
    expect(url.searchParams.get('shopId')).toBe('shop-1');
    expect(url.searchParams.get('pageSize')).toBe('20');
    expect(url.searchParams.get('scope')).toBe('software_all');
    expect(url.searchParams.get('sort')).toBe('stable');
  });

  it('uses status scope for product status tabs while preserving pagination query', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, rows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await readProductListCache({ shopId: 'shop-1', visibility: 'ARCHIVED', page: 2, pageSize: 100, keyword: 'abc' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/cache/products');
    expect(url.searchParams.get('scope')).toBe('status');
    expect(url.searchParams.get('visibility')).toBe('ARCHIVED');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('100');
    expect(url.searchParams.get('keyword')).toBe('abc');
  });

  it('starts product sync through /api/sync/products', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'products-job' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    );
    await startProductListSync({ shopId: 'shop-1', visibility: 'IN_SALE' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/sync/products');
    expect(JSON.parse(options.body)).toMatchObject({
      endpointKey: 'products.list',
      action: 'sync-products-list-hydrate',
      hydrate: true,
    });
  });

  it('never persists or forwards shop credentials from the product sync client', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'products-job' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    );

    await startProductListSync({
      shopId: 'shop-1',
      visibility: 'IN_SALE',
      shop: {
        id: 'shop-1',
        shopAlias: 'Ozon 1店',
        sellerName: '旺崽 Ozon 店铺',
        clientId: 'client-1',
        apiKey: 'test-key',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/sync/products');
    expect(fetchMock.mock.calls[0][0]).not.toContain('/api/shops');
    const syncBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(syncBody.shopId).toBe('shop-1');
    expect(syncBody).not.toHaveProperty('shop');
    expect(JSON.stringify(syncBody)).not.toContain('test-key');
  });

  it('rejects an unbound product sync without a canonical shopId before any request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(startProductListSync({ shop: { clientId: 'client-1', apiKey: 'test-key' } })).rejects.toThrow(
      /已经绑定的本地 shopId/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts full product sync for all statuses without page cap', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, accepted: true, batch: true, jobIds: ['job-a', 'job-b'] }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    );
    await startProductFullSync({ shopId: 'all' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/sync/products');
    expect(JSON.parse(options.body)).toMatchObject({
      allStatuses: true,
      hydrate: true,
      maxPages: 'all',
      pageSize: 1000,
      shopId: 'all',
    });
  });

  it('adapts migrated product list endpoint to local cache without legacy blocked route', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          rows: [{ productId: '101', offerId: 'offer-101', name: '商品 A', visibility: 'IN_SALE' }],
          total: 1,
          source: 'sqlite',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const data = await requestLocalOzon({
      endpoint: '/v3/product/list',
      shop: { id: 'shop-1' },
      body: { filter: { visibility: 'IN_SALE' }, limit: 20, projection: 'warehouse-picker' },
    });
    expect(fetchMock.mock.calls[0][0]).toContain('/api/cache/products');
    expect(fetchMock.mock.calls[0][0]).toContain('projection=warehouse-picker');
    expect(fetchMock.mock.calls[0][0]).not.toContain('/api/' + 'ozon/request');
    expect(data.result.items[0]).toMatchObject({ offer_id: 'offer-101', name: '商品 A' });
  });

  it('adapts hydrated product detail endpoints from /api/cache/products', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const row = {
      productId: '101',
      offerId: 'offer-101',
      name: '补水商品',
      primaryImageUrl: 'https://img/main.jpg',
      images: ['https://img/main.jpg', 'https://img/2.jpg'],
      priceValue: 12.5,
      currencyCode: 'RUB',
      stockValue: 10,
      stockJson: {
        present: 10,
        stocks: [
          { present: 4, type: 'fbo' },
          { present: 6, type: 'fbs' },
        ],
      },
      warehouseStocks: [
        { warehouseId: '1001', presentQuantity: 2, reservedQuantity: 1, freeQuantity: 1 },
        { warehouseId: '1002', presentQuantity: 4, reservedQuantity: 0, freeQuantity: 4 },
      ],
      sellerWarehouseStockTotal: 6,
      warehouseStockComplete: true,
      warehouseStockObservation: { status: 'returned', observedAt: '2026-07-17T02:00:00.000Z' },
      commissionPercent: 11,
      acquiringFeeValue: 0.54,
      weightKg: 0.2,
      widthCm: 10,
      heightCm: 20,
      depthCm: 30,
      categoryId: 'cat-1',
      typeId: 'type-101',
      categoryName: '类目',
      softwareCategoryPath: '宠物用品 > 兽医药房（耗材）',
      softwareCategoryName: '兽医药房（耗材）',
      attributes: [{ id: 1, name: 'Brand', values: [{ value: 'ACME' }] }],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, rows: [row], total: 1, source: 'sqlite' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const info = await requestLocalOzon({
      endpoint: '/v3/product/info/list',
      shop: { id: 'shop-1' },
      body: { product_id: ['101'] },
    });
    const attrs = await requestLocalOzon({
      endpoint: '/v4/product/info/attributes',
      shop: { id: 'shop-1' },
      body: { filter: { product_id: ['101'] } },
    });
    const pictures = await requestLocalOzon({
      endpoint: '/v2/product/pictures/info',
      shop: { id: 'shop-1' },
      body: { product_id: ['101'] },
    });
    const prices = await requestLocalOzon({
      endpoint: '/v5/product/info/prices',
      shop: { id: 'shop-1' },
      body: { filter: { product_id: ['101'] } },
    });
    const stocks = await requestLocalOzon({
      endpoint: '/v4/product/info/stocks',
      shop: { id: 'shop-1' },
      body: { filter: { product_id: ['101'] } },
    });

    expect(info.items[0]).toMatchObject({
      name: '补水商品',
      primary_image: 'https://img/main.jpg',
      category_name: '宠物用品 > 兽医药房（耗材）',
      type_id: 'type-101',
      currency_code: 'CNY',
      sellerWarehouseStockTotal: 6,
      warehouseStockComplete: true,
    });
    expect(info.items[0].warehouse_stocks).toEqual([
      { warehouseId: '1001', presentQuantity: 2, reservedQuantity: 1, freeQuantity: 1 },
      { warehouseId: '1002', presentQuantity: 4, reservedQuantity: 0, freeQuantity: 4 },
    ]);
    expect(info.items[0].warehouseStockObservation).toMatchObject({ status: 'returned' });
    expect(attrs.result[0].attributes).toHaveLength(1);
    expect(attrs.result[0].category_name).toBe('宠物用品 > 兽医药房（耗材）');
    expect(attrs.result[0].type_id).toBe('type-101');
    expect(pictures.items[0].images).toHaveLength(2);
    expect(prices.items[0].price.marketing_seller_price).toBe(12.5);
    expect(prices.items[0].price.currency_code).toBe('CNY');
    expect(prices.items[0].acquiring).toBe(0.54);
    expect(stocks.items[0].present).toBe(10);
    expect(stocks.items[0].stocks).toEqual([
      { present: 4, type: 'fbo' },
      { present: 6, type: 'fbs' },
    ]);
    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes('/api/cache/products'))).toBe(true);
  });

  it('preserves archived Ozon price evidence and all commission modes without turning zero sentinels into a rate', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const row = {
      productId: '4674301534',
      offerId: 'mzr-20260520-638834907-9348',
      visibility: 'ARCHIVED',
      priceValue: 55.16,
      commissionPercent: null,
      commissionPercents: { fbo: null, fbs: null, rfbs: null, fbp: null },
      commissionStatus: 'unavailable',
      commissionProvenance: { sourceReason: 'ozon-zero-commission-sentinel' },
      acquiringFeeValue: null,
      acquiringStatus: 'unavailable',
      priceJson: {
        price: '55.16',
        marketing_price: '0',
        marketing_seller_price: '0',
        currency_code: 'RUB',
        commissions: {
          sales_percent_fbo: 0,
          sales_percent_fbs: 0,
          sales_percent_rfbs: 0,
          sales_percent_fbp: 0,
        },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, rows: [row], total: 1, source: 'sqlite' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const prices = await requestLocalOzon({
      endpoint: '/v5/product/info/prices',
      shop: { id: 'shop-1' },
      body: { filter: { product_id: ['4674301534'] } },
    });

    expect(prices.items[0].price).toMatchObject({
      price: '55.16',
      marketing_price: '0',
      marketing_seller_price: '0',
    });
    expect(prices.items[0].commissions).toEqual({
      sales_percent_fbo: 0,
      sales_percent_fbs: 0,
      sales_percent_rfbs: 0,
      sales_percent_fbp: 0,
    });
    expect(prices.items[0].commission_status).toBe('unavailable');
    expect(prices.items[0].commission_provenance.sourceReason).toBe('ozon-zero-commission-sentinel');
    expect(prices.items[0].acquiring).toBeUndefined();
  });

  it('uses requested product-id count as hydrated cache page size so picture rows are not cut to 20', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const ids = Array.from({ length: 80 }, (_, index) => String(index + 1));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, rows: [], total: 0, source: 'sqlite' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await requestLocalOzon({
      endpoint: '/v2/product/pictures/info',
      shop: { id: 'shop-1' },
      body: { product_id: ids },
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/cache/products');
    expect(url.searchParams.get('pageSize')).toBe('80');
    expect(url.searchParams.get('productIds')).toContain('1,2,3');
    expect(url.searchParams.get('productIds')).toContain('80');
  });

  it('keeps 1000-row product-list cache reads local-only during normal navigation', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, rows: [], total: 0, source: 'sqlite' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await requestLocalOzon({
      endpoint: '/v3/product/list',
      shop: { id: 'shop-1' },
      body: { filter: { visibility: 'ALL' }, limit: 1000 },
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/cache/products');
    expect(url.searchParams.get('pageSize')).toBe('1000');
    expect(url.searchParams.get('visibility')).toBe('ALL');
    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes('/api/cache/products'))).toBe(true);
  });

  it('polls product sync job until a final status', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, job: { status: 'running' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, job: { status: 'success' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    const result = await pollProductListSyncJob('job-1', { intervalMs: 1, timeoutMs: 1000 });
    expect(result.job.status).toBe('success');
  });

  it('polls multiple product sync jobs for multi-shop batches', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          jobs: [
            { jobId: 'job-a', status: 'success' },
            { jobId: 'job-b', status: 'partial' },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const result = await pollProductListSyncJobs(['job-a', 'job-b'], { intervalMs: 1, timeoutMs: 1000 });
    expect(result.map((item) => item.job.status)).toEqual(['success', 'partial']);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/sync/jobs/status');
    expect(url.searchParams.get('ids')).toBe('job-a,job-b');
  });
});
