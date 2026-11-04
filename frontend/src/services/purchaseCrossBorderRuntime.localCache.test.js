import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestCrossBorderOrderSearch: vi.fn(),
  requestCrossBorderReadOnly: vi.fn(),
  requestPurchaseOrderOutInfo: vi.fn(),
}));

vi.mock('../entities/order/crossBorderOrderApi.jsx', () => ({
  canUseCrossBorderOrderOutInfoRead: (settings = {}) => Boolean(settings.crossBorderAccountId),
  getCrossBorderLocalApiAccountId: (settings = {}) => settings.crossBorderAccountId || '',
  requestCrossBorderOrderSearch: mocks.requestCrossBorderOrderSearch,
  requestCrossBorderReadOnly: mocks.requestCrossBorderReadOnly,
  requestPurchaseOrderOutInfo: mocks.requestPurchaseOrderOutInfo,
}));

import {
  requestPurchaseCrossBorderDetail,
  requestPurchaseCrossBorderDetailByOrderId,
} from './purchaseCrossBorderRuntime.js';

describe('purchase cross-border local cache fallback', () => {
  beforeEach(() => {
    mocks.requestCrossBorderOrderSearch.mockReset();
    mocks.requestCrossBorderReadOnly.mockReset().mockResolvedValue(null);
    mocks.requestPurchaseOrderOutInfo.mockReset().mockResolvedValue(null);
  });

  it('keeps restored local volume and status evidence when remote detail reads fail', async () => {
    mocks.requestCrossBorderOrderSearch.mockResolvedValue({
      source: 'local-order-records',
      total: 1,
      items: [
        {
          id: 'bus-order-1',
          order_id: 'bus-order-1',
          order_number: '06477778-0475-1',
          warehouse: '2311济南七号仓',
          statusPayload: { order_status: '3' },
          volumeItems: [
            {
              length: 11.8,
              width: 9.5,
              height: 3.1,
              grossWeight: 0.156,
              sizeText: '11.8 x 9.5 x 3.1 cm',
              weightText: '0.156 kg',
            },
          ],
        },
      ],
    });

    const result = await requestPurchaseCrossBorderDetail(
      {},
      {
        id: '06477778-0475-1',
        posting: '06477778-0475-1',
        salesOrder: '06477778-0475-1',
        shopId: 'shop-1',
        shopClientId: 'client-1',
      }
    );

    expect(result).toMatchObject({
      orderId: 'bus-order-1',
      readStatus: '已发货',
      warehouse: '2311济南七号仓',
      message: '已读取材积',
      volumeItems: [
        expect.objectContaining({
          length: 11.8,
          width: 9.5,
          height: 3.1,
          grossWeight: 0.156,
        }),
      ],
    });
  });

  it('uses at most three exact searches for an order without an existing forecast', async () => {
    mocks.requestCrossBorderOrderSearch.mockResolvedValue({ items: [], total: 0 });

    const result = await requestPurchaseCrossBorderDetail(
      {},
      {
        id: '0213172054-0337-1',
        salesOrder: '0213172054-0337',
        purchaseOrderNo: '3316377399123004165',
        shopId: 'shop-1',
        shopClientId: 'client-1',
      },
    );

    expect(result.orderId).toBe('');
    expect(mocks.requestCrossBorderOrderSearch).toHaveBeenCalledTimes(3);
    expect(mocks.requestCrossBorderOrderSearch.mock.calls.map((call) => call[1])).toEqual([
      { order_number: '0213172054-0337' },
      { platform_order: '0213172054-0337' },
      { from_order: '3316377399123004165' },
    ]);
  });

  it('reads the associated order row after status sync so route and platform fields are returned', async () => {
    mocks.requestCrossBorderOrderSearch.mockResolvedValue({
      items: [{
        id: 'bus-order-associated',
        order_id: 'bus-order-associated',
        platform_order: '90000000-0001-1',
        collection_number: 'collection-1',
        storehouse_name: '2311济南七号仓',
        introduce: 'GUOO Economy Extra Small Jinan PUDO',
        shop_name: 'Ozon 3店',
      }],
      total: 1,
    });
    mocks.requestCrossBorderReadOnly.mockResolvedValue({
      code: 1,
      data: { id: 'bus-order-associated', status_name: '待打包' },
    });

    const result = await requestPurchaseCrossBorderDetailByOrderId(
      { crossBorderAccountId: 'cross-border-test' },
      { id: '90000000-0001-1', shopId: 'shop-1', shopClientId: 'client-1' },
      'bus-order-associated',
      null,
    );

    expect(result).toMatchObject({
      orderId: 'bus-order-associated',
      readStatus: '待打包',
      warehouse: '2311济南七号仓',
      logistics: 'GUOO Economy Extra Small Jinan PUDO',
      orderItem: expect.objectContaining({
        platform_order: '90000000-0001-1',
        shop_name: 'Ozon 3店',
      }),
    });
  });
});
