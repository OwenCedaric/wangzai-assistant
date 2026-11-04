import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readCrossBorderRecords,
  removeCrossBorderRecord,
  saveCrossBorderRecord,
  saveCrossBorderRecords,
  toCrossBorderRecordPayload,
} from './crossBorderOrderRecordClient';

describe('crossBorderOrderRecordClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('builds compact SQLite payload for a cross-border bus order record', () => {
    const payload = toCrossBorderRecordPayload(
      {
        order_id: 'bus-1',
        platform_order: 'posting-1',
        from_order: 'purchase-1',
        tracking_number: 'track-1',
      },
      { shopId: 'shop-1' }
    );
    expect(payload).toMatchObject({
      shopId: 'shop-1',
      recordKey: 'bus-1',
      orderId: 'bus-1',
      platformOrder: 'posting-1',
      purchaseOrderNumber: 'purchase-1',
      trackingNumber: 'track-1',
    });
  });

  it('rejects Client ID as a SQLite owner when the internal shopId is missing', () => {
    expect(() => toCrossBorderRecordPayload(
      { order_id: 'bus-1', shopClientId: 'client-1' },
      { shopClientId: 'client-1' },
    )).toThrow(expect.objectContaining({ code: 'CROSS_BORDER_INTERNAL_SHOP_ID_REQUIRED' }));
  });

  it('uses local-api cross-border order routes only', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options = {}) => {
      if (String(url).includes('/api/logistics/cross-border/orders') && options.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, record: { recordKey: 'bus-1' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/logistics/cross-border/orders') && options.method === 'DELETE') {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, deleted: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, rows: [], total: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    });

    await saveCrossBorderRecord({ order_id: 'bus-1', platform_order: 'posting-1' }, { shopId: 'shop-1' });
    await saveCrossBorderRecords([{ order_id: 'bus-2' }], { shopId: 'shop-1' });
    await readCrossBorderRecords({ shopId: 'shop-1' });
    await removeCrossBorderRecord({ order_id: 'bus-1' }, { shopId: 'shop-1' });

    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes('/api/logistics/cross-border/orders'))).toBe(
      true
    );
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api-seller.ozon.ru'))).toBe(true);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api.service.kuajing84.com'))).toBe(true);
  });
});
