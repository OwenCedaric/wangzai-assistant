import { describe, expect, it } from 'vitest';
import {
  applyPurchaseManualFallbacks,
  buildPurchaseCrossBorderPersistFields,
  sanitizePurchaseOrderLocalOverrideForMerge,
} from '../features/orders/purchase/lib/purchaseOrderNormalize.jsx';

describe('purchaseOrderOverrideMergeRules', () => {
  it('keeps Ozon order identity when SQLite override rows carry internal ids', () => {
    const normalizedOrder = {
      id: '0209987208-0062-1',
      recordKey: '0209987208-0062-1',
      salesOrder: '0209987208-0062-1',
      shipmentNo: '0209987208-0062-1',
      ozonOrderId: '3310600370852003850',
      shopId: 'shop-1',
      shop: 'Ozon 1店',
      product: '真实 Ozon 商品',
      productNo: 'mz-26050813-905658',
      sku: '4392243976',
      buyerPlatform: '待拍单',
      supplier: '待拍单',
      purchaseOrderNo: '',
      purchasePrice: '待确认',
      purchasePriceValue: null,
      ozonStatus: 'delivering',
      status: '已拍单-已发货',
    };
    const sqliteOverrideRow = {
      id: 'purchase_override_79d14a46d79f0c1b0d63fd8dbe4e1121',
      orderKey: '0209987208-0062-1',
      postingNumber: '',
      posting_number: '',
      ozonOrderId: '',
      product: '不应覆盖的商品名',
      productNo: 'bad-offer',
      sku: 'bad-sku',
      shop: '错误店铺',
      purchasePlatform: 'PDD',
      purchaseOrderNumber: 'pdd-1',
      sourceCostCny: 16,
      manualStatus: '已发货',
      forcePurchaseStatus: '已拍单-已发货',
    };

    const safeOverride = sanitizePurchaseOrderLocalOverrideForMerge(sqliteOverrideRow);
    const mergedOrder = applyPurchaseManualFallbacks({
      ...normalizedOrder,
      ...safeOverride,
    });

    expect(safeOverride).not.toHaveProperty('id');
    expect(safeOverride).not.toHaveProperty('orderKey');
    expect(safeOverride).not.toHaveProperty('ozonOrderId');
    expect(safeOverride).not.toHaveProperty('productNo');
    expect(safeOverride).not.toHaveProperty('sku');
    expect(mergedOrder.id).toBe('0209987208-0062-1');
    expect(mergedOrder.ozonOrderId).toBe('3310600370852003850');
    expect(mergedOrder.product).toBe('真实 Ozon 商品');
    expect(mergedOrder.productNo).toBe('mz-26050813-905658');
    expect(mergedOrder.sku).toBe('4392243976');
    expect(mergedOrder.shop).toBe('Ozon 1店');
    expect(mergedOrder.buyerPlatform).toBe('PDD');
    expect(mergedOrder.purchaseOrderNo).toBe('pdd-1');
    expect(mergedOrder.purchasePriceValue).toBe(16);
    expect(mergedOrder.forcePurchaseStatus).toBe('已拍单-已发货');
  });

  it('restores persisted cross-border bus fields from raw SQLite override payloads after refresh', () => {
    const safeOverride = sanitizePurchaseOrderLocalOverrideForMerge({
      orderKey: '4616153:0123640791-0163-1',
      order: {
        packageOrderId: '49774985',
        crossBorderOrderId: '49774985',
        crossBorderOrderNumber: 'E362-20260624152625793387141',
        crossBorderStatus: '已发货',
        readStatus: '已读取材积',
        packageWeight: '0.07 kg',
        volumeItems: [{ length: 11.8, width: 9.5, height: 3.1, grossWeight: 0.07 }],
        warehouse: '2311济南七号仓',
        sheetOrderSn: '0123640791-0163-1',
        freightCost: '¥5.67',
      },
      patch: {
        packageSize: '11.8 × 9.5 × 3.1 cm',
      },
    });

    expect(safeOverride).not.toHaveProperty('order');
    expect(safeOverride).not.toHaveProperty('patch');
    expect(safeOverride).toMatchObject({
      packageOrderId: '49774985',
      crossBorderOrderId: '49774985',
      crossBorderOrderNumber: 'E362-20260624152625793387141',
      crossBorderStatus: '已发货',
      readStatus: '已读取材积',
      packageWeight: '0.07 kg',
      packageSize: '11.8 × 9.5 × 3.1 cm',
      volumeItems: [{ length: 11.8, width: 9.5, height: 3.1, grossWeight: 0.07 }],
      warehouse: '2311济南七号仓',
      sheetOrderSn: '0123640791-0163-1',
      freightCost: '¥5.67',
    });
  });

  it('persists bus dimensions from volumeItems when packageSize is not returned', () => {
    const persistFields = buildPurchaseCrossBorderPersistFields({
      orderId: '49774985',
      message: '已读取材积',
      packageWeight: '0.07 kg',
      packageSize: '未返回',
      volumeItems: [
        {
          length: 11.8,
          width: 9.5,
          height: 3.1,
          grossWeight: 0.07,
          sizeText: '11.8 x 9.5 x 3.1 cm',
          weightText: '0.07 kg',
        },
      ],
    });

    expect(persistFields).toMatchObject({
      packageOrderId: '49774985',
      packageWeight: '0.07 kg',
      packageSize: '11.8 x 9.5 x 3.1 cm',
      volumeItems: [
        {
          length: 11.8,
          width: 9.5,
          height: 3.1,
          grossWeight: 0.07,
          sizeText: '11.8 x 9.5 x 3.1 cm',
          weightText: '0.07 kg',
        },
      ],
    });
  });
});
