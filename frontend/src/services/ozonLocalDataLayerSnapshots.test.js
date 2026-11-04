import { describe, expect, it } from 'vitest';
import {
  OZON_LOCAL_DATA_LAYER_VERSION,
  createEmptyOzonLocalDataStore,
  mergeOzonSnapshotIntoLocalStore,
  readOzonSnapshotFromLocalStore,
} from './ozonLocalDataLayer.js';

describe('ozonLocalDataLayer snapshots', () => {
  it('normalizes orders, products, and image urls into reusable entities', () => {
    const firstOrder = {
      recordKey: 'shop-a:posting-1',
      shopClientId: 'shop-a',
      posting: 'posting-1',
      status: 'awaiting_packaging',
      products: [
        {
          offerId: 'offer-1',
          sku: 'sku-1',
          name: 'Product A',
          image: 'https://cdn.example/a.jpg',
          images: ['https://cdn.example/a.jpg'],
          raw: { large: 'not-saved' },
        },
      ],
      raw: { large: 'not-saved' },
    };
    const secondOrder = {
      recordKey: 'shop-a:posting-2',
      shopClientId: 'shop-a',
      posting: 'posting-2',
      status: 'awaiting_deliver',
      products: [
        {
          offerId: 'offer-1',
          sku: 'sku-1',
          name: 'Product A',
          image: 'https://cdn.example/a.jpg',
        },
      ],
    };

    const { store, stats } = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      { rows: [firstOrder, secondOrder], fetchedAt: '2026-06-23T00:00:00.000Z' },
      { now: '2026-06-23T00:00:01.000Z' }
    );

    expect(stats).toMatchObject({ rows: 2, orders: 2, products: 1, images: 1 });
    expect(store.orders['shop-a:posting-1'].fields.raw).toBeUndefined();
    expect(Object.keys(store.images)).toEqual(['https://cdn.example/a.jpg']);
    expect(Object.values(store.products)[0].fields.image).toBeUndefined();
    expect(Object.values(store.products)[0].fields.images).toBeUndefined();
    expect(store.orders['shop-a:posting-1']).toMatchObject({
      domain: '05_sales_orders',
      clientId: 'shop-a',
      entityId: 'shop-a:posting-1',
      version: OZON_LOCAL_DATA_LAYER_VERSION,
      rawHash: expect.any(String),
    });
    expect(Object.values(store.products)[0]).toMatchObject({
      domain: '03_products',
      clientId: 'shop-a',
      version: OZON_LOCAL_DATA_LAYER_VERSION,
      rawHash: expect.any(String),
    });
    expect(Object.values(store.orderProducts)[0]).toMatchObject({
      domain: '06_order_items',
      clientId: 'shop-a',
      version: OZON_LOCAL_DATA_LAYER_VERSION,
      rawHash: expect.any(String),
    });
    expect(store.images['https://cdn.example/a.jpg']).toMatchObject({
      domain: '04_product_images',
      entityId: 'https://cdn.example/a.jpg',
      version: OZON_LOCAL_DATA_LAYER_VERSION,
      rawHash: expect.any(String),
    });

    const snapshot = readOzonSnapshotFromLocalStore(store, 'ozon-sales-orders:shop-a');
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.rows[0].products[0]).toMatchObject({
      offerId: 'offer-1',
      image: 'https://cdn.example/a.jpg',
      images: ['https://cdn.example/a.jpg'],
    });
  });

  it('updates changed fields without duplicating unchanged entities', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            status: 'awaiting_packaging',
            products: [{ offerId: 'offer-1', image: 'https://cdn.example/a.jpg' }],
          },
        ],
      },
      { now: '2026-06-23T00:00:00.000Z' }
    );

    const updated = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            status: 'awaiting_deliver',
            products: [{ offerId: 'offer-1', image: 'https://cdn.example/a.jpg' }],
          },
        ],
      },
      { now: '2026-06-23T00:01:00.000Z' }
    );

    expect(Object.keys(updated.store.orders)).toHaveLength(1);
    expect(Object.keys(updated.store.products)).toHaveLength(1);
    expect(Object.keys(updated.store.images)).toHaveLength(1);
    expect(readOzonSnapshotFromLocalStore(updated.store, 'ozon-sales-orders:shop-a').rows[0].status).toBe(
      'awaiting_deliver'
    );
  });

  it('appends after-sales snapshot rows instead of replacing the current cache', () => {
    const snapshotKey = 'ozon-after-sales:shop-a:rule:rules-v10-strict-delivery-v1';
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      snapshotKey,
      {
        rows: [
          { shopClientId: 'shop-a', salesOrder: '49225228-0329-1', status: '发货后取消', products: [] },
          { shopClientId: 'shop-a', salesOrder: '75064957-0486-1', status: '签收后退款', products: [] },
        ],
      },
      { now: '2026-07-03T10:00:00.000Z' }
    );

    const refreshed = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      snapshotKey,
      {
        rows: [
          { shopClientId: 'shop-a', salesOrder: '75064957-0486-1', status: '发货后取消', products: [] },
          { shopClientId: 'shop-a', salesOrder: '90652048-0001-1', status: '拒收后退款', products: [] },
        ],
      },
      { now: '2026-07-03T10:01:00.000Z' }
    );

    const rows = readOzonSnapshotFromLocalStore(refreshed.store, snapshotKey).rows;
    expect(rows.map((row) => row.salesOrder)).toEqual(['49225228-0329-1', '75064957-0486-1', '90652048-0001-1']);
    expect(rows.find((row) => row.salesOrder === '75064957-0486-1')?.status).toBe('发货后取消');
  });

  it('can replace after-sales display snapshot row keys to drop stale polluted rows', () => {
    const snapshotKey = 'ozon-after-sales:shop-a:rule:rules-v12-return-id-primary-v1';
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      snapshotKey,
      {
        rows: [
          {
            shopClientId: 'shop-a',
            recordKey: 'posting:96606108-0082-2',
            salesOrder: '96606108-0082-2',
            status: '拒收后退款',
            reason: '其他售后原因',
            products: [],
          },
          {
            shopClientId: 'shop-a',
            id: '92721057',
            returnId: '92721057',
            return_id: '92721057',
            recordKey: 'return:92721057:posting:96606108-0082-2',
            salesOrder: '96606108-0082-2',
            status: '拒收后退款',
            reason: '未能配送商品',
            products: [],
          },
        ],
      },
      { now: '2026-07-08T08:00:00.000Z' }
    );

    expect(initial.store.snapshots[snapshotKey].rowKeys).toHaveLength(2);

    const refreshed = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      snapshotKey,
      {
        replaceAfterSalesSnapshotRows: true,
        rows: [
          {
            shopClientId: 'shop-a',
            id: '92721057',
            returnId: '92721057',
            return_id: '92721057',
            recordKey: 'return:92721057:posting:96606108-0082-2',
            salesOrder: '96606108-0082-2',
            status: '拒收后退款',
            reason: '未能配送商品',
            products: [],
          },
        ],
      },
      { now: '2026-07-08T08:01:00.000Z' }
    );

    expect(refreshed.store.snapshots[snapshotKey].rowKeys).toEqual(['shop-a:return:92721057']);
    expect(readOzonSnapshotFromLocalStore(refreshed.store, snapshotKey).rows).toHaveLength(1);
    expect(readOzonSnapshotFromLocalStore(refreshed.store, snapshotKey).rows[0]).toMatchObject({
      returnId: '92721057',
      salesOrder: '96606108-0082-2',
      reason: '未能配送商品',
    });
  });

  it('does not read legacy v8 after-sales snapshots for current v10 display cache', () => {
    const currentKey = 'ozon-after-sales:shop-a:rule:rules-v10-strict-delivery-v1';
    const legacyKey = 'ozon-after-sales:shop-a:rule:rules-v8-signed-refund-v1';
    const withCurrentEmpty = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      currentKey,
      { rows: [] },
      { now: '2026-07-03T10:00:00.000Z' }
    );
    const withLegacyRows = mergeOzonSnapshotIntoLocalStore(
      withCurrentEmpty.store,
      legacyKey,
      {
        rows: [{ shopClientId: 'shop-a', salesOrder: '49225228-0329-1', status: '发货后取消', products: [] }],
      },
      { now: '2026-07-03T10:01:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(withLegacyRows.store, [currentKey]);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.localSnapshotKey).toBe(currentKey);
  });

  it('protects manual purchase and source fields from external snapshot overwrites', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            status: 'awaiting_packaging',
            manualBuyerPlatform: '1688',
            manualPurchaseOrderNo: 'PO-1',
            manualPurchasePriceValue: 12.34,
            productSourceLinks: ['https://supplier.example/item'],
            busOrderId: 'bus-1',
            products: [],
          },
        ],
      },
      { source: 'manual-override', now: '2026-06-23T00:00:00.000Z' }
    );

    const refreshed = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            status: 'awaiting_deliver',
            manualBuyerPlatform: 'remote-platform',
            manualPurchaseOrderNo: 'remote-po',
            manualPurchasePriceValue: 1,
            productSourceLinks: ['https://remote.example/item'],
            busOrderId: 'bus-remote',
            products: [],
          },
        ],
      },
      { source: 'ozon', now: '2026-06-23T00:01:00.000Z' }
    );

    expect(readOzonSnapshotFromLocalStore(refreshed.store, 'ozon-sales-orders:shop-a').rows[0]).toMatchObject({
      status: 'awaiting_deliver',
      manualBuyerPlatform: '1688',
      manualPurchaseOrderNo: 'PO-1',
      manualPurchasePriceValue: 12.34,
      productSourceLinks: ['https://supplier.example/item'],
      busOrderId: 'bus-1',
    });
  });

  it('allows local manual sources to update protected manual fields', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            manualPurchaseOrderNo: 'PO-1',
            products: [],
          },
        ],
      },
      { source: 'manual-override', now: '2026-06-23T00:00:00.000Z' }
    );

    const updated = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            manualPurchaseOrderNo: 'PO-2',
            products: [],
          },
        ],
      },
      { source: 'local-manual-edit', now: '2026-06-23T00:01:00.000Z' }
    );

    expect(readOzonSnapshotFromLocalStore(updated.store, 'ozon-sales-orders:shop-a').rows[0]).toMatchObject({
      manualPurchaseOrderNo: 'PO-2',
    });
  });

  it('deduplicates after-sales products and keeps the direct CNY return source', () => {
    const { store } = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-after-sales:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:return-1',
            shopClientId: 'shop-a',
            id: 'return-1',
            status: 'refused refund',
            products: [
              {
                offerId: 'offer-1',
                name: 'Returned item',
                price: '¥16.00',
                priceValue: 16,
                currencyCode: 'CNY',
                sourceCurrencyCode: 'CNY',
              },
              {
                offerId: 'offer-1',
                name: 'Returned item from posting financial data',
                price: '¥1.51',
                priceValue: 1.51,
                currencyCode: 'CNY',
                sourceCurrencyCode: 'RUB',
              },
            ],
          },
        ],
      },
      { now: '2026-06-24T00:00:00.000Z' }
    );

    expect(Object.values(store.orders)[0].orderProductKeys).toHaveLength(1);

    const snapshot = readOzonSnapshotFromLocalStore(store, ['missing-after-sales-key', 'ozon-after-sales:shop-a']);
    expect(snapshot.rows[0].products).toHaveLength(1);
    expect(snapshot.rows[0].products[0]).toMatchObject({
      offerId: 'offer-1',
      priceValue: 16,
      sourceCurrencyCode: 'CNY',
    });
  });

  it('keeps refused-refund cache rows when required evidence is present even without finance confirmation', () => {
    const refusedRefund = '\u62d2\u6536\u540e\u9000\u6b3e';
    const { store } = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-after-sales:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:return-1',
            shopClientId: 'shop-a',
            id: 'return-1',
            status: refusedRefund,
            type: refusedRefund,
            tone: 'success',
            classificationVersion: 6,
            refusedEvidence: 'buyer refused delivery',
            destroyedEvidence: 'Utilized',
            originalOrderCancelledEvidence: 'cancelled_after_ship',
            originalOrderDeliveredEvidence: '',
            financeRefundChecked: false,
            financeRefundConfirmed: false,
            financeRefundEvidence: { checked: false, confirmed: false },
            products: [],
          },
        ],
      },
      { now: '2026-06-24T00:00:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(store, 'ozon-after-sales:shop-a');
    expect(snapshot.rows[0]).toMatchObject({
      status: refusedRefund,
      type: refusedRefund,
      tone: 'success',
      refusedEvidence: 'buyer refused delivery',
      destroyedEvidence: 'Utilized',
      originalOrderCancelledEvidence: 'cancelled_after_ship',
      financeRefundConfirmed: false,
    });
  });

  it('migrates duplicate legacy after-sales row keys to one canonical entity by client and return id', () => {
    const refusedRefund = '\u62d2\u6536\u540e\u9000\u6b3e';
    const afterShipCancel = '\u53d1\u8d27\u540e\u53d6\u6d88';
    const { store } = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-after-sales:shop-a',
      {
        rows: [
          {
            recordKey: 'Ozon 1店:87750614',
            clientId: '4616153',
            shopClientId: '4616153',
            shop: 'Ozon 1店',
            id: '87750614',
            returnId: '87750614',
            salesOrder: '88181594-0239-2',
            status: refusedRefund,
            type: refusedRefund,
            refusedEvidence: 'buyer refused delivery',
            destroyedEvidence: 'item disposed',
            originalOrderCancelledEvidence: 'cancelled_after_ship',
            originalOrderDeliveredEvidence: '',
            financeRefundChecked: true,
            financeRefundConfirmed: true,
            financeRefundEvidence: { checked: true, confirmed: true },
            products: [],
          },
          {
            recordKey: 'SuperBaiss:87750614',
            clientId: '4616153',
            shopClientId: '4616153',
            shop: 'SuperBaiss',
            id: '87750614',
            returnId: '87750614',
            salesOrder: '88181594-0239-2',
            status: afterShipCancel,
            type: afterShipCancel,
            refusedEvidence: '',
            destroyedEvidence: 'item disposed',
            financeRefundChecked: true,
            financeRefundConfirmed: false,
            financeRefundEvidence: { checked: true, confirmed: false },
            products: [],
          },
        ],
      },
      { now: '2026-06-24T00:00:00.000Z' }
    );

    const canonicalKey = '4616153:return:87750614';
    expect(store.snapshots['ozon-after-sales:shop-a'].rowKeys).toEqual([canonicalKey]);
    expect(Object.keys(store.orders)).toEqual([canonicalKey]);

    const snapshot = readOzonSnapshotFromLocalStore(store, 'ozon-after-sales:shop-a');
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({
      id: '87750614',
      salesOrder: '88181594-0239-2',
      status: refusedRefund,
      type: refusedRefund,
      refusedEvidence: 'buyer refused delivery',
      destroyedEvidence: 'item disposed',
      originalOrderCancelledEvidence: 'cancelled_after_ship',
      financeRefundChecked: true,
      financeRefundConfirmed: true,
    });
    expect(snapshot.rows[0].financeRefundEvidence).toMatchObject({ checked: true, confirmed: true });
  });

  it('persists cancelled child postings under the same mother posting as separate entities', () => {
    const snapshotKey = 'ozon-after-sales:shop-a';
    const { store } = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      snapshotKey,
      {
        rows: [
          {
            source: 'order-cancelled',
            clientId: '4616153',
            shopClientId: '4616153',
            recordKey: 'posting:41364113-0069-1',
            salesOrder: '41364113-0069-1',
            status: '发货前取消',
            products: [],
          },
          {
            source: 'order-cancelled',
            clientId: '4616153',
            shopClientId: '4616153',
            recordKey: 'posting:41364113-0069-5',
            salesOrder: '41364113-0069-5',
            status: '发货前取消',
            products: [],
          },
        ],
      },
      { now: '2026-07-15T12:00:00.000Z' }
    );

    expect(store.snapshots[snapshotKey].rowKeys).toEqual([
      '4616153:order:41364113-0069-1',
      '4616153:order:41364113-0069-5',
    ]);
    expect(readOzonSnapshotFromLocalStore(store, snapshotKey).rows).toHaveLength(2);
  });

  it('deduplicates older after-sales cache rows that still contain duplicate order product links', () => {
    const store = createEmptyOzonLocalDataStore();
    store.snapshots['ozon-after-sales:shop-a'] = {
      key: 'ozon-after-sales:shop-a',
      type: 'orders',
      rowKeys: ['shop-a:return-1'],
    };
    store.orders['shop-a:return-1'] = {
      key: 'shop-a:return-1',
      shopKey: 'shop-a',
      fields: { recordKey: 'shop-a:return-1', shopClientId: 'shop-a', id: 'return-1' },
      orderProductKeys: ['shop-a:return-1:0:shop-a:offer-1', 'shop-a:return-1:1:shop-a:offer-1'],
    };
    store.products['shop-a:offer-1'] = {
      key: 'shop-a:offer-1',
      shopKey: 'shop-a',
      offerId: 'offer-1',
      fields: { offerId: 'offer-1', name: 'Returned item' },
      imageUrls: [],
      skuImageUrls: [],
      mainImageUrls: [],
    };
    store.orderProducts['shop-a:return-1:0:shop-a:offer-1'] = {
      key: 'shop-a:return-1:0:shop-a:offer-1',
      orderKey: 'shop-a:return-1',
      productKey: 'shop-a:offer-1',
      fields: { price: '¥16.00', priceValue: 16, currencyCode: 'CNY', sourceCurrencyCode: 'CNY' },
    };
    store.orderProducts['shop-a:return-1:1:shop-a:offer-1'] = {
      key: 'shop-a:return-1:1:shop-a:offer-1',
      orderKey: 'shop-a:return-1',
      productKey: 'shop-a:offer-1',
      fields: { price: '¥1.51', priceValue: 1.51, currencyCode: 'CNY', sourceCurrencyCode: 'RUB' },
    };

    const snapshot = readOzonSnapshotFromLocalStore(store, 'ozon-after-sales:shop-a');

    expect(snapshot.rows[0].products).toHaveLength(1);
    expect(snapshot.rows[0].products[0]).toMatchObject({
      offerId: 'offer-1',
      priceValue: 16,
      sourceCurrencyCode: 'CNY',
    });
  });

  it('keeps after-sales original order evidence check flags when fresh skinny rows omit them', () => {
    let store = createEmptyOzonLocalDataStore();
    store = mergeOzonSnapshotIntoLocalStore(
      store,
      'ozon-after-sales:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:return-1',
            shopClientId: 'shop-a',
            id: 'return-1',
            returnId: 'return-1',
            salesOrder: 'posting-1',
            status: '拒收后退款',
            type: '拒收后退款',
            originalOrderEvidenceChecked: true,
            refusedEvidence: 'buyer refused delivery',
            destroyedEvidence: 'Utilized',
            originalOrderCancelledEvidence: 'cancelled_after_ship',
            originalOrderDeliveredEvidence: '',
            financeRefundChecked: false,
            financeRefundConfirmed: false,
            financeRefundEvidence: { checked: false, confirmed: false },
            products: [],
          },
        ],
      },
      { now: '2026-07-01T00:00:00.000Z' }
    ).store;

    store = mergeOzonSnapshotIntoLocalStore(
      store,
      'ozon-after-sales:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:return-1',
            shopClientId: 'shop-a',
            id: 'return-1',
            returnId: 'return-1',
            salesOrder: 'posting-1',
            status: '发货后取消',
            type: '发货后取消',
            originalOrderEvidenceChecked: false,
            products: [],
          },
        ],
      },
      { now: '2026-07-01T00:05:00.000Z' }
    ).store;

    const snapshot = readOzonSnapshotFromLocalStore(store, 'ozon-after-sales:shop-a');
    expect(snapshot.rows[0]).toMatchObject({
      status: '拒收后退款',
      type: '拒收后退款',
      originalOrderEvidenceChecked: true,
      refusedEvidence: 'buyer refused delivery',
      destroyedEvidence: 'Utilized',
      originalOrderCancelledEvidence: 'cancelled_after_ship',
      financeRefundConfirmed: false,
    });
  });

  it('keeps effective nested order fields when a refresh returns missing nested values', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            posting: 'posting-1',
            crossBorderInfo: {
              orderId: '49531424',
              readStatus: '等待预报',
              packageWeight: '0.152 kg',
              packageSize: '未返回',
            },
            products: [],
          },
        ],
      },
      { now: '2026-06-23T00:00:00.000Z' }
    );

    const refreshed = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            posting: 'posting-1',
            crossBorderInfo: {
              orderId: '未返回',
              readStatus: '未返回',
              packageWeight: '未返回',
              packageSize: '未返回',
            },
            products: [],
          },
        ],
      },
      { now: '2026-06-23T00:01:00.000Z' }
    );

    const row = readOzonSnapshotFromLocalStore(refreshed.store, 'ozon-sales-orders:shop-a').rows[0];
    expect(row.crossBorderInfo).toMatchObject({
      orderId: '49531424',
      readStatus: '等待预报',
      packageWeight: '0.152 kg',
    });
    expect(row.crossBorderInfo.packageSize).toBeUndefined();
  });

  it('keeps after-sales rows when an empty refresh returns without explicit clear permission', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-after-sales:shop-a',
      {
        rows: [
          {
            id: 'return-1',
            salesOrder: 'posting-1',
            shopClientId: 'shop-a',
            shopId: 'shop-a',
            status: '发货后取消',
            products: [],
          },
        ],
      },
      { now: '2026-06-23T03:00:00.000Z' }
    );

    const emptyRefresh = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-after-sales:shop-a',
      {
        rows: [],
        errors: [],
      },
      { now: '2026-06-23T03:01:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(emptyRefresh.store, 'ozon-after-sales:shop-a');

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].id).toBe('return-1');
    expect(snapshot.changeSummary).toMatchObject({ skippedEmpty: 1, failed: 0 });
  });

  it('allows after-sales rows to be cleared only when explicitly requested', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-after-sales:shop-a',
      {
        rows: [{ id: 'return-1', salesOrder: 'posting-1', shopClientId: 'shop-a', shopId: 'shop-a', products: [] }],
      },
      { now: '2026-06-23T03:00:00.000Z' }
    );

    const emptyRefresh = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-after-sales:shop-a',
      {
        rows: [],
        errors: [],
      },
      { allowEmptyRows: true, now: '2026-06-23T03:01:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(emptyRefresh.store, 'ozon-after-sales:shop-a');

    expect(snapshot.rows).toHaveLength(0);
    expect(snapshot.changeSummary).toMatchObject({ removed: 1, skippedEmpty: 0 });
  });

  it('marks missing order rows as not seen instead of deleting cached entities', () => {
    const initial = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-1',
            shopClientId: 'shop-a',
            posting: 'posting-1',
            products: [{ offerId: 'offer-1' }],
          },
          {
            recordKey: 'shop-a:posting-2',
            shopClientId: 'shop-a',
            posting: 'posting-2',
            products: [{ offerId: 'offer-2' }],
          },
        ],
      },
      { now: '2026-06-23T04:00:00.000Z' }
    );

    const refreshed = mergeOzonSnapshotIntoLocalStore(
      initial.store,
      'ozon-sales-orders:shop-a',
      {
        rows: [
          {
            recordKey: 'shop-a:posting-2',
            shopClientId: 'shop-a',
            posting: 'posting-2',
            products: [{ offerId: 'offer-2' }],
          },
        ],
      },
      { now: '2026-06-23T04:01:00.000Z' }
    );

    expect(readOzonSnapshotFromLocalStore(refreshed.store, 'ozon-sales-orders:shop-a').rows).toHaveLength(1);
    expect(refreshed.store.orders['shop-a:posting-1']).toMatchObject({
      notSeenInLastRefresh: true,
      needsVerify: true,
      lastNotSeenAt: '2026-06-23T04:01:00.000Z',
      lastNotSeenSnapshotKey: 'ozon-sales-orders:shop-a',
    });
    expect(refreshed.store.orders['shop-a:posting-1'].orderProductKeys).toHaveLength(1);
    expect(refreshed.store.orderProducts[refreshed.store.orders['shop-a:posting-1'].orderProductKeys[0]]).toMatchObject(
      {
        notSeenInLastRefresh: true,
        needsVerify: true,
        lastNotSeenSnapshotKey: 'ozon-sales-orders:shop-a',
      }
    );
    expect(refreshed.store.orders['shop-a:posting-2'].notSeenInLastRefresh).toBeUndefined();
  });

  it('reads legacy snapshot keys that used a secret-like segment without requiring the secret again', () => {
    const oldSecretLikeSegment = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const { store } = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      `ozon-sales-orders:shop-a:client-a:${oldSecretLikeSegment}`,
      {
        rows: [
          {
            recordKey: 'client-a:posting-legacy',
            shopClientId: 'client-a',
            id: 'posting-legacy',
            status: 'ready',
          },
        ],
      },
      { now: '2026-06-24T00:00:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(store, 'ozon-sales-orders:shop-a:client-a');

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].id).toBe('posting-legacy');
    expect(snapshot).toMatchObject({
      localSnapshotKey: `ozon-sales-orders:shop-a:client-a:${oldSecretLikeSegment}`,
      legacyCompatibleRead: true,
    });
  });

  it('prefers the selected range snapshot before legacy unscoped fallback keys', () => {
    const legacy = mergeOzonSnapshotIntoLocalStore(
      createEmptyOzonLocalDataStore(),
      'ozon-sales-orders:client-a',
      {
        rows: [
          {
            recordKey: 'client-a:posting-old',
            shopClientId: 'client-a',
            id: 'posting-old',
            products: [],
          },
        ],
      },
      { now: '2026-06-23T00:00:00.000Z' }
    );
    const scopedKey = 'ozon-sales-orders:client-a:sales-orders:range:2026-06-01_2026-06-30:filter:all:v:time-v1';
    const scoped = mergeOzonSnapshotIntoLocalStore(
      legacy.store,
      scopedKey,
      {
        rows: [
          {
            recordKey: 'client-a:posting-current',
            shopClientId: 'client-a',
            id: 'posting-current',
            products: [],
          },
        ],
      },
      { now: '2026-06-23T00:01:00.000Z' }
    );

    const snapshot = readOzonSnapshotFromLocalStore(scoped.store, [scopedKey, 'ozon-sales-orders:client-a']);

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].id).toBe('posting-current');
    expect(snapshot).toMatchObject({
      localSnapshotKey: scopedKey,
      legacyCompatibleRead: false,
    });
  });
});
