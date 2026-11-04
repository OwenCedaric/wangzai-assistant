import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listCrossBorderReadEndpoints,
  mapLegacyCrossBorderEndpoint,
  readCrossBorderEndpoint,
} from './crossBorderReadClient';

describe('crossBorderReadClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
    delete globalThis.window?.wangzaiDesktop;
  });

  it('maps legacy cross-border endpoints to local-api endpoint keys', () => {
    expect(mapLegacyCrossBorderEndpoint('/erpapi/orderlist/search')).toBe('order.search');
    expect(mapLegacyCrossBorderEndpoint('/erpapi/orderlist/status')).toBe('order.status');
    expect(mapLegacyCrossBorderEndpoint('/erpapi/order/get_order_out_info')).toBe('order.outInfo');
  });

  it('uses the management core in the current desktop runtime and never falls back to local enterprise credentials', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const licenseRequest = vi.fn(async (input) => ({
      ok: true,
      status: 200,
      data: input.path.endsWith('/endpoints')
        ? { ok: true, endpoints: [{ key: 'order.search', risk: 'read' }] }
        : { ok: true, endpoint_key: 'order.search', data: { code: 1, data: { list: [] } } },
    }));
    globalThis.window.wangzaiDesktop = {
      license: {
        getRuntime: vi.fn().mockResolvedValue({ thinClient: false }),
        request: licenseRequest,
      },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        rows: [{ id: 'cb-1', authorizationRef: 'opaque-server-grant' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await listCrossBorderReadEndpoints();
    await readCrossBorderEndpoint({
      legacyEndpoint: '/erpapi/orderlist/search',
      accountId: 'cb-1',
      shopId: 'shop-1',
      body: { order_id: 'bus-1' },
    });

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'http://127.0.0.1:3790/api/logistics/cross-border/accounts',
    ]);
    expect(licenseRequest.mock.calls.map(([input]) => input.path)).toEqual([
      '/api/core-v2/cross-border/endpoints',
      '/api/core-v2/cross-border/read',
    ]);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api.service.kuajing84.com'))).toBe(true);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api-seller.ozon.ru'))).toBe(true);
    expect(JSON.stringify(licenseRequest.mock.calls)).not.toContain('companySecret');
    expect(JSON.stringify(licenseRequest.mock.calls)).not.toContain('accessToken');
  });

  it('uses the management core in V2 and reads only the opaque grant from local cache', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3792';
    const licenseRequest = vi.fn(async (_input) => ({
      ok: true,
      status: 200,
      data: { ok: true, endpoint_key: 'order.search', data: { code: 1, data: { list: [] } } },
    }));
    globalThis.window.wangzaiDesktop = {
      license: {
        getRuntime: vi.fn().mockResolvedValue({ thinClient: false }),
        request: licenseRequest,
      },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        rows: [{ id: 'cb-v2', authorizationRef: 'opaque-server-grant' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const result = await readCrossBorderEndpoint({
      endpointKey: 'order.search',
      accountId: 'cb-v2',
      body: { order_number: 'order-1' },
    });
    expect(result.endpointKey).toBe('order.search');
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(licenseRequest.mock.calls[0][0].body).toMatchObject({
      authorization_ref: 'opaque-server-grant',
      endpoint_key: 'order.search',
      body: { order_number: 'order-1' },
    });
    expect(JSON.stringify(licenseRequest.mock.calls)).not.toContain('companySecret');
    expect(JSON.stringify(licenseRequest.mock.calls)).not.toContain('accessToken');
  });
});
