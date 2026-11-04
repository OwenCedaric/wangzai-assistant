import { describe, expect, it } from 'vitest';
import {
  OZON_LOCAL_DATA_LAYER_VERSION,
  createEmptyOzonLocalDataStore,
  mergeDomainSnapshotIntoLocalStore,
  mergeOzonProductSnapshotIntoLocalStore,
  mergeOzonSnapshotIntoLocalStore,
  normalizeOzonLocalDataStore,
  readDomainSnapshotFromLocalStore,
  readOzonProductSnapshotFromLocalStore,
  readOzonSnapshotFromLocalStore,
} from './ozonLocalDataLayer.js';

describe('ozonLocalDataLayer facade', () => {
  it('keeps the public cache facade exports usable', () => {
    const emptyStore = createEmptyOzonLocalDataStore();
    expect(emptyStore.version).toBe(OZON_LOCAL_DATA_LAYER_VERSION);

    const orderMerged = mergeOzonSnapshotIntoLocalStore(
      emptyStore,
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            products: [{ offerId: 'offer-1', name: 'Order product' }],
          },
        ],
        fetchedAt: '2026-07-04T00:00:00.000Z',
      },
      { now: '2026-07-04T00:00:01.000Z' }
    );
    expect(
      readOzonSnapshotFromLocalStore(orderMerged.store, 'ozon-sales-orders:shop-a')?.rows[0]?.products[0]
    ).toMatchObject({
      name: 'Order product',
    });
    expect(orderMerged.store.orders['shop-a:posting-1'].fieldMeta).toBeUndefined();
    expect(orderMerged.store.orderProducts['shop-a:posting-1:0:shop-a:offer-1'].fieldMeta).toBeUndefined();

    const productMerged = mergeOzonProductSnapshotIntoLocalStore(
      orderMerged.store,
      'ozon-products:shop-a',
      { rows: [{ offerId: 'offer-2', shopClientId: 'shop-a', name: 'Catalog product' }] },
      { now: '2026-07-04T00:00:02.000Z', shopKey: 'shop-a' }
    );
    expect(readOzonProductSnapshotFromLocalStore(productMerged.store, 'ozon-products:shop-a')?.rows[0]).toMatchObject({
      name: 'Catalog product',
    });

    const domainMerged = mergeDomainSnapshotIntoLocalStore(
      productMerged.store,
      'ozon-marketing:shop-a',
      { rows: [{ id: 'campaign-1', name: 'Campaign' }] },
      { now: '2026-07-04T00:00:03.000Z', domain: 'marketing' }
    );
    expect(readDomainSnapshotFromLocalStore(domainMerged.store, 'ozon-marketing:shop-a')?.rows[0]).toMatchObject({
      name: 'Campaign',
    });
  });

  it('keeps order values while dropping unconsumed order field metadata during cache normalization', () => {
    const store = normalizeOzonLocalDataStore({
        orders: {
          'shop-a:posting-1': {
            key: 'shop-a:posting-1',
            fields: { recordKey: 'shop-a:posting-1', status: 'awaiting_packaging' },
            orderProductKeys: ['shop-a:posting-1:0:offer-1'],
            fieldMeta: { status: { source: 'ozon', readAt: '2026-07-12T00:00:00.000Z' } },
          },
        },
        orderProducts: {
          'shop-a:posting-1:0:offer-1': {
            key: 'shop-a:posting-1:0:offer-1',
            productKey: 'shop-a:offer-1',
            fields: { offerId: 'offer-1', name: 'Order product' },
            fieldMeta: { name: { source: 'ozon', readAt: '2026-07-12T00:00:00.000Z' } },
          },
        },
        products: {
          'shop-a:offer-1': {
            key: 'shop-a:offer-1',
            fields: { offerId: 'offer-1', name: 'Order product' },
          },
        },
        snapshots: {
          'ozon-sales-orders:shop-a': { rowKeys: ['shop-a:posting-1'] },
        },
      });

    expect(store.orders['shop-a:posting-1'].fields).toMatchObject({ status: 'awaiting_packaging' });
    expect(store.orders['shop-a:posting-1'].fieldMeta).toBeUndefined();
    expect(store.orderProducts['shop-a:posting-1:0:offer-1'].fields).toMatchObject({ name: 'Order product' });
    expect(store.orderProducts['shop-a:posting-1:0:offer-1'].fieldMeta).toBeUndefined();
    expect(readOzonSnapshotFromLocalStore(store, 'ozon-sales-orders:shop-a')?.rows[0]).toMatchObject({
      status: 'awaiting_packaging',
      products: [{ name: 'Order product' }],
    });
  });
});
