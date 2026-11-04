import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  confirmCrossBorderWriteOperation,
  mapLegacyCrossBorderWriteEndpoint,
  previewCrossBorderWriteOperation,
  toCrossBorderWritePayload,
} from './crossBorderWriteClient';

describe('crossBorderWriteClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
    delete globalThis.window?.wangzaiDesktop;
  });

  it('maps legacy write endpoints to local-api write guard endpoint keys', () => {
    expect(mapLegacyCrossBorderWriteEndpoint('/erpapi/order/createOrder')).toBe('order.create');
    expect(mapLegacyCrossBorderWriteEndpoint('/erpapi/order/updateOrder')).toBe('order.update');
    expect(mapLegacyCrossBorderWriteEndpoint('/erpapi/order/updateOrderSheet')).toBe('order.updateSheet');
    expect(mapLegacyCrossBorderWriteEndpoint('/erpapi/order/updateOrderPackage')).toBe('order.updatePackage');
    expect(mapLegacyCrossBorderWriteEndpoint('/erpapi/order/cancelOrder')).toBe('order.cancel');
    expect(mapLegacyCrossBorderWriteEndpoint('/erpapi/ordersync/order_update')).toBe('order.syncStatus');
    expect(mapLegacyCrossBorderWriteEndpoint('/erpapi/orderassociation/association_order_account')).toBe('order.associate');
  });

  it('builds write payload without credentials', () => {
    const payload = toCrossBorderWritePayload({
      legacyEndpoint: '/erpapi/order/createOrder',
      accountId: 'cb-main',
      body: { order_id: 'bus-1' },
      requestedBy: 'unit',
      ['access' + 'Token']: 'must-not-send',
    });

    expect(payload).toMatchObject({
      endpointKey: 'order.create',
      accountId: 'cb-main',
      after: { order_id: 'bus-1' },
      payload: { order_id: 'bus-1' },
      requestedBy: 'unit',
    });
    expect(JSON.stringify(payload)).not.toContain('must-not-send');
  });

  it('uses management preview and confirm in the current desktop runtime', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const licenseRequest = vi.fn(async (input) => ({
      ok: true,
      status: 200,
      data: input.path.endsWith('/preview')
        ? { ok: true, preview_token: 'server-preview-token' }
        : { ok: true, data: { order_id: 'created-1' } },
    }));
    globalThis.window.wangzaiDesktop = {
      license: {
        getRuntime: vi.fn().mockResolvedValue({ thinClient: false }),
        request: licenseRequest,
      },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        ok: true,
        rows: [{ id: 'cb-main', authorizationRef: 'opaque-server-grant' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));

    const preview = await previewCrossBorderWriteOperation({
      accountId: 'cb-main', endpointKey: 'order.create', body: { order_id: 'bus-1' },
    });
    await confirmCrossBorderWriteOperation({
      accountId: 'cb-main',
      previewId: preview.previewId,
      confirm: true,
      endpointKey: 'order.create',
      body: { order_id: 'bus-1' },
    });

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'http://127.0.0.1:3790/api/logistics/cross-border/accounts',
      'http://127.0.0.1:3790/api/logistics/cross-border/accounts',
    ]);
    expect(licenseRequest.mock.calls.map(([input]) => input.path)).toEqual([
      '/api/core-v2/cross-border/write/preview',
      '/api/core-v2/cross-border/write/confirm',
    ]);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api.service.kuajing84.com'))).toBe(true);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api-seller.ozon.ru'))).toBe(true);
  });

  it('requires previewId before confirm', async () => {
    await expect(
      confirmCrossBorderWriteOperation({ endpointKey: 'order.cancel', confirm: true })
    ).rejects.toMatchObject({
      code: 'CROSS_BORDER_WRITE_PREVIEW_REQUIRED',
    });
  });

  it('uses Core V2 with the opaque local grant and never sends enterprise credentials', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3792';
    const licenseRequest = vi.fn(async (input) => ({
      ok: true,
      status: 200,
      data: input.path.endsWith('/preview')
        ? { ok: true, preview_token: 'server-preview-token' }
        : { ok: true, data: { order_id: 'created-1' } },
    }));
    globalThis.window.wangzaiDesktop = {
      license: {
        getRuntime: vi.fn().mockResolvedValue({ thinClient: false }),
        request: licenseRequest,
      },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({
        ok: true,
        rows: [{ id: 'cb-v2', authorizationRef: 'opaque-server-grant' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ));
    const preview = await previewCrossBorderWriteOperation({
      accountId: 'cb-v2',
      endpointKey: 'order.create',
      body: { order_id: 'bus-1' },
    });
    expect(preview.previewId).toBe('server-preview-token');
    await confirmCrossBorderWriteOperation({
      accountId: 'cb-v2',
      previewId: preview.previewId,
      confirm: true,
      endpointKey: 'order.create',
      body: { order_id: 'bus-1' },
    });
    expect(licenseRequest.mock.calls.map(([input]) => input.path)).toEqual([
      '/api/core-v2/cross-border/write/preview',
      '/api/core-v2/cross-border/write/confirm',
    ]);
    expect(JSON.stringify(licenseRequest.mock.calls)).not.toContain('companySecret');
    expect(JSON.stringify(licenseRequest.mock.calls)).not.toContain('accessToken');
    expect(JSON.stringify(licenseRequest.mock.calls)).not.toContain('appUid');
  });
});
