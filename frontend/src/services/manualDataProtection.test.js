import { describe, expect, it } from 'vitest';
import {
  hasProtectedManualValue,
  isProtectedManualDataField,
  mergeProtectedManualData,
  PROTECTED_MANUAL_DATA_FIELDS,
} from './manualDataProtection.js';

describe('manualDataProtection', () => {
  it('declares the manual data fields that cannot be replaced by empty or stale interface values', () => {
    expect(PROTECTED_MANUAL_DATA_FIELDS).toEqual(
      expect.arrayContaining([
        'manualBuyerPlatform',
        'manualPurchaseOrderNo',
        'manualPurchasePriceValue',
        'sourcePurchaseCostCny',
        'manualProfitLogisticsFeeCny',
        'manualProfitCrossBorderBusFeeCny',
        'manualSourceRecord',
        'productSourceLinks',
        'busOrderId',
        'order_id',
      ])
    );
    expect(isProtectedManualDataField('manualPurchaseOrderNo')).toBe(true);
    expect(isProtectedManualDataField('status')).toBe(false);
  });

  it('keeps existing protected manual values when fresh interface rows are empty or conflicting', () => {
    const merged = mergeProtectedManualData(
      {
        manualBuyerPlatform: '1688',
        manualPurchaseOrderNo: 'PO-1',
        manualPurchasePriceValue: 12.34,
        manualProfitLogisticsFeeCny: 6.78,
        productSourceLinks: ['https://supplier.example/item'],
        busOrderId: 'bus-1',
        status: 'old-status',
      },
      {
        manualBuyerPlatform: 'Ozon empty fallback',
        manualPurchaseOrderNo: '',
        manualPurchasePriceValue: 0,
        manualProfitLogisticsFeeCny: null,
        productSourceLinks: [],
        busOrderId: 'bus-2',
        status: 'fresh-status',
      }
    );

    expect(merged).toMatchObject({
      manualBuyerPlatform: '1688',
      manualPurchaseOrderNo: 'PO-1',
      manualPurchasePriceValue: 12.34,
      manualProfitLogisticsFeeCny: 6.78,
      productSourceLinks: ['https://supplier.example/item'],
      busOrderId: 'bus-1',
      status: 'fresh-status',
    });
  });

  it('allows protected manual fields to be filled when the current record has no good value', () => {
    const merged = mergeProtectedManualData(
      {
        manualBuyerPlatform: '',
        manualPurchaseOrderNo: '',
      },
      {
        manualBuyerPlatform: '1688',
        manualPurchaseOrderNo: 'PO-2',
      }
    );

    expect(merged).toMatchObject({
      manualBuyerPlatform: '1688',
      manualPurchaseOrderNo: 'PO-2',
    });
    expect(hasProtectedManualValue({ manualPurchaseOrderNo: 'PO-2' })).toBe(true);
  });
});
