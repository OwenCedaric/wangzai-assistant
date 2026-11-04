import { describe, expect, it } from 'vitest';
import { normalizeAfterSalesAmountCurrencyForDisplay } from './orderDisplayFormat.jsx';

describe('after-sales amount display safety', () => {
  it.each([null, undefined, false, ''])('normalizes malformed row %j without crashing', (row) => {
    expect(() => normalizeAfterSalesAmountCurrencyForDisplay(row)).not.toThrow();
    expect(normalizeAfterSalesAmountCurrencyForDisplay(row)).toMatchObject({
      refundAmount: '未返回',
      currencyCode: 'CNY',
    });
  });

  it('drops malformed products before currency conversion', () => {
    expect(normalizeAfterSalesAmountCurrencyForDisplay({
      products: [null, { priceValue: 10, qty: 2, currencyCode: 'CNY' }],
    })).toMatchObject({
      refundAmount: '¥20.00',
      currencyCode: 'CNY',
    });
  });
});
