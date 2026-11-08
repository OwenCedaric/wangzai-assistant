import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmDomainWrite,
  getDomainCache,
  getSyncJob,
  requestLocalOzon,
  startDomainSync,
} from '../api/localApiClient';
import {
  mapLegacyOzonEndpoint,
  readDomainCache,
  requestOzonWrite,
  startDomainRefresh,
  startLegacyEndpointRefresh,
} from './ozonSyncClient';
import { clearOrderDomainCache } from './orderCanonicalCacheRuntime.js';

describe('ozonSyncClient unified scheduler adapter', () => {
  afterEach(() => {
    clearOrderDomainCache();
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('routes registered legacy fallback through local-api real Ozon bridge and surfaces its error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: 'OZON_ENDPOINT_NOT_REGISTERED',
            message: 'Ozon endpoint 尚未在 local-api 注册：/v1/not-connected',
          },
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }
      )
    );

    await expect(requestLocalOzon({ endpoint: '/v1/not-connected' })).rejects.toThrow(
      /Ozon endpoint 尚未在 local-api 注册：\/v1\/not-connected/u
    );
    expect(fetchMock.mock.calls[0][0]).toContain(`/api/ozon/${'request'}`);
  });

  it('routes shop connection read checks through /api/shops/:shopId/test without legacy Ozon request route', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, shop: { id: 'shop-1', hasApiKey: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            connected: true,
            roles: { result: { roles: ['product_view'] } },
            sellerInfo: { result: { name: 'Unit Seller' } },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      );

    const roles = await requestLocalOzon({
      endpoint: '/v1/roles',
      shop: {
        id: 'shop-1',
        shopAlias: 'Ozon 1店',
        clientId: 'client-1',
        ['api' + 'Key']: 'unit-key',
      },
    });

    expect(roles.result.roles).toEqual(['product_view']);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/shops');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[1][0]).toContain('/api/shops/shop-1/test');
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes(`/api/ozon/${'request'}`))).toBe(false);
  });

  it('reads page cache through /api/cache/:domain', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, rows: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await readDomainCache('orders', { pageSize: 20 });
    expect(fetchMock.mock.calls[0][0]).toContain('/api/cache/orders?pageSize=20');
  });

  it('invalidates the shared order view when a refresh task is submitted', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ ok: true, rows: [{ id: 'old-order' }] }))
      .mockResolvedValueOnce(response({ ok: true, accepted: true, jobId: 'job-refresh' }, 202))
      .mockResolvedValueOnce(response({ ok: true, rows: [{ id: 'new-order' }] }));

    const first = await getDomainCache('orders', { shopId: 'shop-1' });
    const memory = await getDomainCache('orders', { shopId: 'shop-1' });
    await startDomainSync('orders', { shopId: 'shop-1' });
    const refreshed = await getDomainCache('orders', { shopId: 'shop-1' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(first.rows[0].id).toBe('old-order');
    expect(memory.rows[0].id).toBe('old-order');
    expect(refreshed.rows[0].id).toBe('new-order');
  });

  it('invalidates again after a confirmed write readback job reaches a final state', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const response = (payload) => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ ok: true, rows: [{ id: 'before-write' }] }))
      .mockResolvedValueOnce(response({
        ok: true,
        writeStatus: 'submitted_waiting_readback',
        readBackJobs: { scheduled: true, jobs: [{ jobId: 'orders-readback-1' }] },
      }))
      .mockResolvedValueOnce(response({ ok: true, rows: [{ id: 'submitted' }] }))
      .mockResolvedValueOnce(response({
        ok: true,
        job: { jobId: 'orders-readback-1', domain: 'orders', status: 'success' },
      }))
      .mockResolvedValueOnce(response({ ok: true, rows: [{ id: 'readback-merged' }] }));

    await getDomainCache('orders', { shopId: 'shop-1' });
    await confirmDomainWrite('orders', { previewId: 'preview-1', confirm: true });
    const submitted = await getDomainCache('orders', { shopId: 'shop-1' });
    await getSyncJob('orders-readback-1');
    const merged = await getDomainCache('orders', { shopId: 'shop-1' });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(submitted.rows[0].id).toBe('submitted');
    expect(merged.rows[0].id).toBe('readback-merged');
  });

  it('starts domain sync through /api/sync/:domain', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, jobId: 'job-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    );
    await startDomainRefresh('orders', { shopId: 'shop-1' });
    expect(fetchMock.mock.calls[0][0]).toContain('/api/sync/orders');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('maps registered legacy endpoint and rejects unknown endpoint clearly', async () => {
    expect(mapLegacyOzonEndpoint('/v3/posting/fbs/list')).toMatchObject({
      ok: true,
      domain: 'orders',
      endpointKey: 'orders.fbsList',
    });
    const unknown = mapLegacyOzonEndpoint('/v1/not-connected');
    expect(unknown.ok).toBe(false);
    expect(unknown.error.message).toBe('该 Ozon 接口尚未接入统一调度');
  });

  it('starts registered legacy endpoint refresh through scheduler sync route', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, jobId: 'job-legacy' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    );
    await startLegacyEndpointRefresh('/v3/posting/fbs/list', { id: 'shop-1' }, { filter: {} });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/sync/orders');
    expect(JSON.parse(options.body).endpointKey).toBe('orders.fbsList');
  });

  it('maps product write endpoints to products write guard metadata', () => {
    expect(mapLegacyOzonEndpoint('/v3/product/import')).toMatchObject({
      ok: true,
      domain: 'products',
      endpointKey: 'products.import',
      action: 'product.updateInfo',
      access: 'write',
    });
    expect(mapLegacyOzonEndpoint('/v1/product/import/prices')).toMatchObject({
      endpointKey: 'products.updatePrices',
      action: 'product.updatePrice',
      access: 'write',
    });
    expect(mapLegacyOzonEndpoint('/v2/products/stocks')).toMatchObject({
      endpointKey: 'products.updateStocks',
      action: 'product.updateStock',
      access: 'write',
    });
    expect(mapLegacyOzonEndpoint('/v1/product/archive')).toMatchObject({
      endpointKey: 'products.archive',
      action: 'product.archive',
      access: 'write',
    });
    expect(mapLegacyOzonEndpoint('/v1/product/unarchive')).toMatchObject({
      endpointKey: 'products.unarchive',
      action: 'product.unarchive',
      access: 'write',
    });
  });

  it('routes write endpoint through preview instead of real Ozon execution', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, previewId: 'p1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await requestOzonWrite(
      '/v2/products/stocks',
      { id: 'shop-1' },
      {
        payload: { stocks: [{ product_id: 1, stock: 1 }] },
        before: { stock: 0 },
        after: { stock: 1 },
        idempotencyKey: 'stock-preview-1',
      }
    );
    const [url, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toContain('/api/write/products/preview');
    expect(url).not.toContain('api-seller.ozon.ru');
    expect(body).toMatchObject({
      shopId: 'shop-1',
      endpointKey: 'products.updateStocks',
      action: 'product.updateStock',
      idempotencyKey: 'stock-preview-1',
    });
    expect(body.payload.stocks[0].stock).toBe(1);
  });

  it('routes confirmed write endpoint through confirm only when previewId exists', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: { code: 'WRITE_EXECUTION_NOT_CONNECTED' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    await requestOzonWrite(
      '/v1/product/archive',
      { id: 'shop-1' },
      { product_id: [101], idempotencyKey: 'archive-1' },
      {
        confirmed: true,
        previewId: 'preview-archive-1',
      }
    );
    const [url, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(url).toContain('/api/write/products/confirm');
    expect(body).toMatchObject({
      shopId: 'shop-1',
      endpointKey: 'products.archive',
      action: 'product.archive',
      previewId: 'preview-archive-1',
      confirm: true,
      realWrite: true,
      dryRun: false,
      idempotencyKey: 'archive-1',
    });
  });

  it('rejects unknown and read endpoints in requestOzonWrite without reading mapping fields unsafely', async () => {
    const unknown = await requestOzonWrite('/v1/not-connected', { id: 'shop-1' }, {});
    expect(unknown.ok).toBe(false);
    expect(unknown.error.code).toBe('OZON_ENDPOINT_NOT_CONNECTED_TO_SCHEDULER');

    const read = await requestOzonWrite('/v3/product/list', { id: 'shop-1' }, {});
    expect(read.ok).toBe(false);
    expect(read.error.code).toBe('OZON_READ_ENDPOINT_CANNOT_WRITE');
  });

  it('reads order list from local SQLite cache without creating a sync job during normal navigation', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, _options) => {
      if (String(url).includes('/api/sync/orders')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'orders-job-1' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/cache/orders')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              rows: [
                {
                  posting_number: '123456789-0001-1',
                  order_id: 'order-1',
                  status: 'awaiting_packaging',
                  source: 'FBS',
                  products: [{ offer_id: 'offer-1', quantity: 1 }],
                  raw: { posting_number: '123456789-0001-1' },
                },
              ],
              total: 1,
              source: 'sqlite',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    const data = await requestLocalOzon({
      endpoint: '/v3/posting/fbs/list',
      shop: { id: 'shop-1' },
      body: { filter: { since: '2026-06-29T00:00:00Z', to: '2026-06-29T23:59:59Z' }, limit: 100, offset: 0 },
    });

    expect(data.result.postings[0]).toMatchObject({
      posting_number: '123456789-0001-1',
      status: 'awaiting_packaging',
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/cache/orders'))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sync/orders'))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/' + 'ozon/request'))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('api-seller.ozon.ru'))).toBe(false);
  });

  it('waits for forced order sync jobs before returning refreshed SQLite cache', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    let cacheReadCount = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, _options) => {
      if (String(url).includes('/api/cache/orders')) {
        cacheReadCount += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              rows: [
                {
                  posting_number: cacheReadCount === 1 ? 'old-posting' : 'new-posting',
                  order_id: 'order-1',
                  status: cacheReadCount === 1 ? 'awaiting_packaging' : 'delivering',
                  source: 'FBS',
                  products: [{ offer_id: 'offer-1', quantity: 1 }],
                  raw: { posting_number: cacheReadCount === 1 ? 'old-posting' : 'new-posting' },
                },
              ],
              total: 1,
              source: 'sqlite',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      if (String(url).includes('/api/sync/jobs/orders-job-force')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              job: {
                jobId: 'orders-job-force',
                status: 'success',
                progress: { done: 1, total: 1 },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      if (String(url).includes('/api/sync/orders')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'orders-job-force' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    const data = await requestLocalOzon(
      {
        endpoint: '/v3/posting/fbs/list',
        shop: { id: 'shop-1' },
        body: {
          filter: { since: '2026-06-29T00:00:00Z', to: '2026-06-29T23:59:59Z' },
          forceRefresh: true,
          limit: 100,
          offset: 0,
        },
      },
      { orderSyncPollIntervalMs: 10, orderSyncTimeoutMs: 1000 }
    );

    expect(data.result.postings[0]).toMatchObject({
      posting_number: 'new-posting',
      status: 'delivering',
    });
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/cache/orders'))).toHaveLength(2);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sync/jobs/orders-job-force'))).toBe(true);
    expect(data.localApiCache.syncJob).toMatchObject({
      jobId: 'orders-job-force',
      status: 'success',
      timedOut: false,
    });
  });

  it('店铺同步失败时仍返回该日期范围已有的 SQLite 订单', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('/api/cache/orders')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              rows: [
                {
                  posting_number: 'cached-posting',
                  order_id: 'cached-order',
                  status: 'delivering',
                  source: 'FBS',
                  products: [],
                },
              ],
              total: 1,
              source: 'sqlite',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      if (String(url).includes('/api/sync/jobs/orders-job-failed')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              job: {
                jobId: 'orders-job-failed',
                status: 'failed',
                lastError: 'shop credential is temporarily paused',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      if (String(url).includes('/api/sync/orders')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'orders-job-failed' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    const data = await requestLocalOzon(
      {
        endpoint: '/v3/posting/fbs/list',
        shop: { id: 'shop-1' },
        body: {
          filter: { since: '2026-06-01T00:00:00Z', to: '2026-06-01T23:59:59Z' },
          forceRefresh: true,
          limit: 100,
          offset: 0,
        },
      },
      { orderSyncPollIntervalMs: 10, orderSyncTimeoutMs: 1000 }
    );

    expect(data.result.postings).toHaveLength(1);
    expect(data.result.postings[0].posting_number).toBe('cached-posting');
    expect(data.localApiCache.syncError).toMatchObject({
      code: 'LOCAL_ORDER_SYNC_FAILED',
      message: 'shop credential is temporarily paused',
    });
  });

  it('names the blocked shop when Ozon has forbidden the company account', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('/api/cache/orders')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, rows: [], total: 0, source: 'sqlite' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/sync/jobs/orders-job-company-blocked')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              job: {
                jobId: 'orders-job-company-blocked',
                status: 'failed',
                lastError: 'page 1: 该店铺已被 Ozon 封禁，无法刷新数据。',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      if (String(url).includes('/api/sync/orders')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'orders-job-company-blocked' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    await expect(
      requestLocalOzon(
        {
          endpoint: '/v2/posting/fbo/list',
          shop: { id: 'shop-3', shopAlias: 'Ozon 3店' },
          body: {
            filter: { since: '2026-08-01T00:00:00Z', to: '2026-08-18T23:59:59Z' },
            forceRefresh: true,
            limit: 100,
            offset: 0,
          },
        },
        { shopLabel: 'Ozon 3店', orderSyncPollIntervalMs: 10, orderSyncTimeoutMs: 1000 }
      )
    ).rejects.toMatchObject({
      code: 'OZON_COMPANY_BLOCKED',
      status: 403,
      message: 'Ozon 3店被 Ozon 封禁，无法刷新订单。',
    });
  });

  it('reads returns list from local SQLite cache without creating a sync job during normal navigation', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    expect(mapLegacyOzonEndpoint('/v2/returns/rfbs/list')).toMatchObject({
      ok: true,
      domain: 'returns',
      endpointKey: 'returns.rfbsList',
      access: 'read',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, _options) => {
      if (String(url).includes('/api/sync/returns')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'returns-job-1' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/cache/returns')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              rows: [
                {
                  return_id: 'rfbs-1',
                  posting_number: '123456789-0001-1',
                  status: '[object Object]',
                  state: '[object Object]',
                  source: 'rfbs-return',
                  product: { offer_id: 'offer-1', quantity: 1 },
                  raw: {
                    return_id: 'rfbs-1',
                    state: {
                      state: 'Utilizing',
                      state_name: 'На утилизации',
                      group_state: 'utilization',
                    },
                  },
                },
              ],
              total: 1,
              source: 'sqlite',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    const data = await requestLocalOzon({
      endpoint: '/v2/returns/rfbs/list',
      shop: { id: 'shop-1' },
      body: {
        filter: { created_since: '2026-06-29T00:00:00Z', created_to: '2026-06-29T23:59:59Z' },
        limit: 100,
        offset: 0,
      },
    });

    expect(data.returns[0]).toMatchObject({
      return_id: 'rfbs-1',
      posting_number: '123456789-0001-1',
      status: 'Utilizing',
    });
    expect(data.returns[0].status).not.toBe('[object Object]');
    expect(data.returns[0].state).toMatchObject({ state: 'Utilizing' });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/cache/returns'))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sync/returns'))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/' + 'ozon/request'))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('api-seller.ozon.ru'))).toBe(false);
  });

  it('reads warehouse list from local logistics cache without creating a sync job during normal navigation', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, _options) => {
      if (String(url).includes('/api/sync/logistics')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'logistics-job-1' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/cache/logistics')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              rows: [{ payload: { result: [{ warehouse_id: 1, name: 'WH' }] } }],
              total: 1,
              source: 'sqlite',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    const data = await requestLocalOzon({
      endpoint: '/v2/warehouse/list',
      shop: { id: 'shop-1' },
      body: {},
    });

    expect(data.result[0]).toMatchObject({ warehouse_id: 1, name: 'WH' });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/cache/logistics'))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sync/logistics'))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/' + 'ozon/request'))).toBe(false);
  });

  it('waits for logistics force refresh and strips frontend-only flags before sync', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, _options) => {
      if (String(url).includes('/api/sync/logistics')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'logistics-job-1' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/sync/jobs/logistics-job-1')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, job: { jobId: 'logistics-job-1', status: 'success' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/cache/logistics')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              rows: [{ payload: { warehouses: [{ warehouse_id: 2, name: 'Fresh WH' }] } }],
              total: 1,
              source: 'sqlite',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    const data = await requestLocalOzon({
      endpoint: '/v2/warehouse/list',
      shop: { id: 'shop-1' },
      body: { limit: 100, forceRefresh: true, autoSync: true },
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/sync/logistics');
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sync/jobs/logistics-job-1'))).toBe(true);
    expect(data.warehouses[0]).toMatchObject({ warehouse_id: 2, name: 'Fresh WH' });
    const syncCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/sync/logistics'));
    const syncBody = JSON.parse(syncCall[1].body);
    expect(syncBody).toMatchObject({
      shopId: 'shop-1',
      endpointKey: 'warehouse.list',
      forceRefresh: true,
    });
    expect(syncBody.params).toMatchObject({ limit: 100 });
    expect(syncBody.params.forceRefresh).toBeUndefined();
    expect(syncBody.params.autoSync).toBeUndefined();
  });

  it('submits warehouse refresh in the background and returns SQLite cache without job polling', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).includes('/api/sync/logistics')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'logistics-job-background' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/cache/logistics')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            ok: true,
            rows: [{ payload: { warehouses: [{ warehouse_id: 7, name: 'Cached WH' }] } }],
            total: 1,
            source: 'sqlite',
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    const data = await requestLocalOzon({
      endpoint: '/v2/warehouse/list',
      shop: { id: 'shop-1' },
      body: { limit: 100, forceRefresh: true, autoSync: true, backgroundRefresh: true },
    });

    expect(data.warehouses[0]).toMatchObject({ warehouse_id: 7, name: 'Cached WH' });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sync/logistics'))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sync/jobs/'))).toBe(false);
    const syncCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/sync/logistics'));
    const syncBody = JSON.parse(syncCall[1].body);
    expect(syncBody.params.backgroundRefresh).toBeUndefined();
    expect(syncBody.requestedBy).toBe('frontend-logistics-background-refresh');
  });

  it('falls back to local logistics cache when forced sync fails and clamps delivery method limit', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, _options) => {
      if (String(url).includes('/api/sync/logistics')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'logistics-job-failed' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/sync/jobs/logistics-job-failed')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              job: {
                jobId: 'logistics-job-failed',
                status: 'failed',
                lastError: 'invalid DeliveryMethodListV2Request.Limit',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      if (String(url).includes('/api/cache/logistics')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              rows: [
                {
                  payload: {
                    delivery_methods: [{ id: 35877421, warehouse_id: 102, name: '标准 PUDO', status: 'ACTIVE' }],
                  },
                },
              ],
              total: 1,
              source: 'sqlite',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    const data = await requestLocalOzon({
      endpoint: '/v2/delivery-method/list',
      shop: { id: 'shop-1' },
      body: { limit: 1000, forceRefresh: true, autoSync: true },
    });

    expect(data.delivery_methods[0]).toMatchObject({ id: 35877421, name: '标准 PUDO' });
    expect(data.localApiCache.syncError.message).toContain('invalid DeliveryMethodListV2Request.Limit');
    const syncCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/sync/logistics'));
    const syncBody = JSON.parse(syncCall[1].body);
    expect(syncBody).toMatchObject({
      shopId: 'shop-1',
      endpointKey: 'deliveryMethod.list',
      forceRefresh: true,
    });
    expect(syncBody.params.limit).toBe(100);
    expect(syncBody.params.forceRefresh).toBeUndefined();
    expect(syncBody.params.autoSync).toBeUndefined();
  });

  it('reads finance transaction list from local SQLite cache without creating a sync job during normal navigation', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, _options) => {
      if (String(url).includes('/api/sync/finance')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'finance-job-1' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/cache/finance')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              rows: [
                {
                  operation_id: 'fin-1',
                  posting_number: '123456789-0001-1',
                  operation_type: 'MarketplaceRedistributionOfAcquiringOperation',
                  acquiringFeeCny: -0.54,
                  raw: { operation_id: 'fin-1', amount: -0.54 },
                },
              ],
              total: 1,
              source: 'sqlite',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    const data = await requestLocalOzon({
      endpoint: '/v3/finance/transaction/list',
      shop: { id: 'shop-1' },
      body: {
        filter: {
          date: { from: '2026-06-29T00:00:00Z', to: '2026-06-29T23:59:59Z' },
          posting_number: '123456789-0001-1',
        },
        page: 1,
        page_size: 1000,
      },
    });

    expect(data.result.operations[0]).toMatchObject({
      operation_id: 'fin-1',
      posting_number: '123456789-0001-1',
      acquiringFeeCny: -0.54,
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/cache/finance'))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sync/finance'))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/' + 'ozon/request'))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('api-seller.ozon.ru'))).toBe(false);
  });

  it('reads rating penalty list from local profit cache without creating a sync job during normal navigation', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, _options) => {
      if (String(url).includes('/api/sync/profit')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, accepted: true, jobId: 'rating-job-1' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/cache/profit')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              complete: true,
              rows: [
                {
                  operation_id: 'op-1',
                  posting_number: 'posting-1',
                  operation_type_name: '错误指数罚款',
                  error_fee_cny: -8,
                  raw: { operation_id: 'op-1' },
                },
              ],
              total: 1,
              source: 'sqlite',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } })
      );
    });

    const data = await requestLocalOzon({
      endpoint: '/v1/rating/index/fbs/posting/list',
      shop: { id: 'shop-1' },
      body: { filter: { posting_number: 'posting-1' }, limit: 1000, offset: 0 },
    });

    expect(data.result.postings[0]).toMatchObject({
      operation_id: 'op-1',
      posting_number: 'posting-1',
      error_fee_cny: -8,
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/cache/profit'))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/sync/profit'))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/' + 'ozon/request'))).toBe(false);
  });

  it('exports direct local api helpers for cache and sync', () => {
    expect(typeof getDomainCache).toBe('function');
    expect(typeof startDomainSync).toBe('function');
  });
});
