import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readPurchaseSourceLinks,
  removePurchaseSourcesForOrder,
  savePurchaseSourcesForOrder,
  toPurchaseSourceLinksPayload,
} from './purchaseSourceLinkClient';

describe('purchaseSourceLinkClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('builds order-scoped source link payload', () => {
    const payload = toPurchaseSourceLinksPayload({ shopId: 'shop-1', id: 'posting-1', offerId: 'offer-1' }, [
      { platform: 'PDD', url: 'https://example.test/item' },
    ]);
    expect(payload).toMatchObject({
      shopId: 'shop-1',
      orderKey: 'posting-1',
      links: [{ platform: 'PDD', offerId: 'offer-1', slotIndex: 0 }],
    });
  });

  it('keeps the canonical scoped record key when the visible order id is shorter', () => {
    const payload = toPurchaseSourceLinksPayload({
      shopId: 'shop-1',
      id: 'posting-1',
      recordKey: 'client-1:posting-1',
    }, [{ platform: '1688', url: 'https://detail.1688.com/offer/1.html' }]);

    expect(payload.orderKey).toBe('client-1:posting-1');
    expect(payload.links[0].orderKey).toBe('client-1:posting-1');
  });

  it('uses local-api purchase source routes only', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options = {}) => {
      if (options.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, changed: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (options.method === 'DELETE') {
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

    await savePurchaseSourcesForOrder({ shopId: 'shop-1', id: 'posting-1' }, [{ platform: 'PDD' }]);
    await readPurchaseSourceLinks({ shopId: 'shop-1' });
    await removePurchaseSourcesForOrder({ shopId: 'shop-1', id: 'posting-1' });

    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes('/api/purchase/source-links'))).toBe(true);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api-seller.ozon.ru'))).toBe(true);
  });
});
