import { describe, expect, it } from 'vitest';
import { getAfterSalesOrderRecordKey, getSalesOrderRecordKey } from './orderRecordRules.jsx';

describe('order record keys', () => {
  it('treats malformed null order rows as no record instead of throwing', () => {
    expect(getSalesOrderRecordKey(null)).toBe('');
    expect(getAfterSalesOrderRecordKey(null)).toBe('');
  });

  it('keeps the canonical sales and after-sales key order', () => {
    expect(getSalesOrderRecordKey({ recordKey: 'shop-a:posting-1', id: 'ignored' })).toBe('shop-a:posting-1');
    expect(getAfterSalesOrderRecordKey({ returnId: 'return-1', salesOrder: 'posting-1' })).toBe('return-1');
  });
});
