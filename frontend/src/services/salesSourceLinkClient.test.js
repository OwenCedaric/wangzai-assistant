import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSalesSourceLinks, saveSalesSourcesForOrder } from './salesSourceLinkClient';

describe('salesSourceLinkClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('uses the dedicated local-api sales source route with an explicit shop/order scope', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, rows: [], total: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, rows: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    await readSalesSourceLinks({ shopId: 'shop-1', orderKey: 'posting-1' });
    await saveSalesSourcesForOrder({
      shopId: 'shop-1',
      orderKey: 'posting-1',
      record: { primaryIndex: 0, links: [{ link: 'https://detail.1688.com/offer/1.html' }] },
    });

    expect(fetchMock.mock.calls[0][0]).toContain('/api/sales/source-links?shopId=shop-1&orderKey=posting-1');
    expect(fetchMock.mock.calls[1][0]).toContain('/api/sales/source-links');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      shopId: 'shop-1',
      orderKey: 'posting-1',
      links: [{ slotIndex: 0, shopId: 'shop-1', orderKey: 'posting-1' }],
    });
  });
});
