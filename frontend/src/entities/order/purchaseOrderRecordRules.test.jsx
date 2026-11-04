import { describe, expect, it } from 'vitest';
import {
  getPurchaseOrderRecordKey,
  getPurchaseOrderSourceMapKey,
} from './purchaseOrderRecordRules.jsx';

describe('purchaseOrderRecordRules', () => {
  it('uses the shop-scoped record key instead of the display order id for source lookup', () => {
    const order = {
      id: '64720469-0563-1',
      recordKey: '4097603:64720469-0563-1',
      shopId: 'ozon-shop-example-04',
      shopClientId: '4097603',
    };

    expect(getPurchaseOrderRecordKey(order)).toBe('4097603:64720469-0563-1');
    expect(getPurchaseOrderSourceMapKey(order, { id: 'ozon-shop-example-04' })).toBe(
      'ozon-shop-example-04:4097603:64720469-0563-1'
    );
  });

  it('falls back to the visible order id only when no scoped record key exists', () => {
    expect(getPurchaseOrderSourceMapKey({ id: 'posting-1', shopId: 'shop-1' })).toBe('shop-1:posting-1');
  });
});
