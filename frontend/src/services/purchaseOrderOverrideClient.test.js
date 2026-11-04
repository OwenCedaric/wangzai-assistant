import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readPurchaseOverrides,
  removePurchaseOverride,
  savePurchaseOverride,
  toPurchaseOverridePayload,
} from './purchaseOrderOverrideClient';

describe('purchaseOrderOverrideClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.__WANGZAI_LOCAL_API_BASE_URL__;
  });

  it('builds stable SQLite override payload from order and patch', () => {
    const payload = toPurchaseOverridePayload(
      { shopId: 'shop-1', postingNumber: 'posting-1', offerId: 'offer-1' },
      {
        platform: 'PDD',
        purchaseOrderNumber: 'pdd-1',
        purchaseOrderUrl: 'https://mms.pinduoduo.com/order/pdd-1',
        cost: 12,
      }
    );
    expect(payload).toMatchObject({
      shopId: 'shop-1',
      orderKey: 'posting-1',
      postingNumber: 'posting-1',
      purchasePlatform: 'PDD',
      purchaseOrderNumber: 'pdd-1',
      purchaseOrderUrl: 'https://mms.pinduoduo.com/order/pdd-1',
      sourceCostCny: 12,
    });
  });

  it('keeps the persisted override key when patch carries an empty legacy orderKey', () => {
    const payload = toPurchaseOverridePayload(
      { orderKey: 'posting-from-map', shopId: 'shop-1' },
      { orderKey: '', postingNumber: '', platform: 'PDD' }
    );

    expect(payload.orderKey).toBe('posting-from-map');
    expect(payload.postingNumber).toBe('');
  });

  it('persists manual purchase fields into the SQLite override payload', () => {
    const payload = toPurchaseOverridePayload(
      {
        shopId: 'shop-1',
        postingNumber: 'posting-2',
        manualBuyerPlatform: '天猫',
        manualPurchaseOrderNo: 'tmall-2',
        manualPurchasePrice: '19.8',
        manualPurchaseOrderStatus: '已付款',
      },
      {}
    );

    expect(payload).toMatchObject({
      shopId: 'shop-1',
      orderKey: 'posting-2',
      purchasePlatform: '天猫',
      purchaseOrderNumber: 'tmall-2',
      sourceCostCny: '19.8',
      manualStatus: '已付款',
    });
  });

  it('keeps cross-border bus readback fields at the top level for durable refresh restore', () => {
    const payload = toPurchaseOverridePayload(
      {
        shopId: 'shop-1',
        postingNumber: 'posting-3',
        manualBuyerPlatform: 'PDD',
        manualPurchaseOrderNo: 'pdd-3',
      },
      {
        crossBorderOrderFound: true,
        packageOrderId: '49774985',
        crossBorderOrderNumber: 'E362-20260624152625793387141',
        readStatus: '已读取材积',
        packageWeight: '0.07 kg',
        packageSize: '11.8 x 9.5 x 3.1 cm',
        volumeItems: [{ length: 11.8, width: 9.5, height: 3.1, grossWeight: 0.07 }],
        warehouse: '2311济南七号仓',
        freightCost: '¥5.67',
      }
    );

    expect(payload).toMatchObject({
      orderKey: 'posting-3',
      crossBorderOrderFound: true,
      packageOrderId: '49774985',
      crossBorderOrderNumber: 'E362-20260624152625793387141',
      readStatus: '已读取材积',
      packageWeight: '0.07 kg',
      packageSize: '11.8 x 9.5 x 3.1 cm',
      volumeItems: [{ length: 11.8, width: 9.5, height: 3.1, grossWeight: 0.07 }],
      warehouse: '2311济南七号仓',
      freightCost: '¥5.67',
    });
    expect(payload.raw).toMatchObject({
      packageOrderId: '49774985',
      readStatus: '已读取材积',
      volumeItems: [{ length: 11.8, width: 9.5, height: 3.1, grossWeight: 0.07 }],
    });
  });

  it('does not duplicate full order and patch payloads while retaining manual-only extensions', () => {
    const payload = toPurchaseOverridePayload(
      {
        shopId: 'shop-1',
        postingNumber: 'posting-4',
        largeOzonPayload: 'x'.repeat(80 * 1024),
        manualProfitSourcePurchaseCostCny: 23.5,
        manualProfitSourcePurchaseCostUpdatedAt: '2026-07-12T00:00:00.000Z',
      },
      {
        manualProfitSourcePurchaseCostCny: 23.5,
        manualProfitSourcePurchaseCostUpdatedAt: '2026-07-12T00:00:00.000Z',
      }
    );

    expect(payload.raw).toEqual({
      manualProfitSourcePurchaseCostCny: 23.5,
      manualProfitSourcePurchaseCostUpdatedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(JSON.stringify(payload).length).toBeLessThan(64 * 1024);
  });

  it('persists allowlisted local action fields and transports one-shot clearFields safely', () => {
    const payload = toPurchaseOverridePayload(
      {
        shopId: 'shop-1',
        orderKey: 'client-1:posting-5',
        purchaseOrderNumber: 'old-purchase-order',
        sourceCostCny: 88,
        forcePurchaseStatus: '待拍单',
        transferPendingReason: '用户确认退款后转回',
        purchaseRecordStatus: 'none',
        randomInternalField: 'must-not-persist',
        apiKey: 'must-not-persist',
      },
      {
        clearFields: ['purchaseOrderNumber', 'sourceCostCny', 'notAllowed'],
      }
    );

    expect(payload.clearFields).toEqual(['purchaseOrderNumber', 'sourceCostCny']);
    expect(payload.raw).toMatchObject({
      forcePurchaseStatus: '待拍单',
      transferPendingReason: '用户确认退款后转回',
      purchaseRecordStatus: 'none',
    });
    expect(payload.raw).not.toHaveProperty('randomInternalField');
    expect(payload.raw).not.toHaveProperty('apiKey');
    expect(payload.raw).not.toHaveProperty('clearFields');
  });

  it('persists the resumable purchase forecast flow without copying the full order', () => {
    const purchaseForecastFlow = {
      version: 1,
      postingNumber: 'posting-forecast-1',
      shopId: 'shop-1',
      stage: 'label_ready',
      ozonStatus: 'awaiting_delivery',
      sheetOrderSn: 'sheet-1',
      sheetUrl: 'https://example.test/sheet-1.pdf',
    };
    const payload = toPurchaseOverridePayload(
      {
        shopId: 'shop-1',
        postingNumber: 'posting-forecast-1',
        largeOzonPayload: 'must-not-persist',
      },
      { purchaseForecastFlow }
    );

    expect(payload.raw).toEqual({ purchaseForecastFlow });
    expect(payload.raw).not.toHaveProperty('largeOzonPayload');
  });

  it('uses local-api purchase override routes only', async () => {
    globalThis.__WANGZAI_LOCAL_API_BASE_URL__ = 'http://127.0.0.1:3790';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options = {}) => {
      if (String(url).includes('/api/purchase/orders/overrides') && options.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, override: { orderKey: 'posting-1' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
      }
      if (String(url).includes('/api/purchase/orders/overrides') && options.method === 'DELETE') {
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

    await savePurchaseOverride({ shopId: 'shop-1', postingNumber: 'posting-1' }, { platform: 'PDD' });
    await readPurchaseOverrides({ shopId: 'shop-1' });
    await removePurchaseOverride({ shopId: 'shop-1', postingNumber: 'posting-1' });

    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes('/api/purchase/orders/overrides'))).toBe(true);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('api-seller.ozon.ru'))).toBe(true);
  });
});
