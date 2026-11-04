import { describe, expect, it } from 'vitest';
import { mergeProfitSnapshotWithSharedOrders } from './profitOrderSourceMerge.js';

describe('profit order source merge', () => {
  it('keeps the full canonical order universe and only adds matching profit evidence', () => {
    const sharedRows = [
      {
        shopId: 'shop-a',
        posting: 'posting-1',
        status: '关闭订单',
        products: [{ offerId: 'offer-1', price: 88 }],
      },
      { shopId: 'shop-a', posting: 'posting-2', status: '成功订单', products: [{ price: 37 }] },
    ];
    const snapshotRows = [
      {
        shopId: 'shop-a',
        posting: 'posting-1',
        status: '等待备货',
        products: [{ offerId: 'offer-1', price: 80, image: 'https://img.example/offer-1.jpg' }],
        profitLedger: { ledgerKey: 'ledger-1' },
      },
    ];

    const merged = mergeProfitSnapshotWithSharedOrders(sharedRows, snapshotRows);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      posting: 'posting-1',
      status: '关闭订单',
      products: [{ offerId: 'offer-1', price: 88, image: 'https://img.example/offer-1.jpg' }],
      profitLedger: { ledgerKey: 'ledger-1' },
    });
    expect(merged[1]).toMatchObject({ posting: 'posting-2', status: '成功订单' });
  });

  it('does not treat a private profit snapshot as the order universe', () => {
    expect(mergeProfitSnapshotWithSharedOrders([], [{ shopId: 'shop-a', posting: 'posting-1' }])).toEqual([]);
  });
});
