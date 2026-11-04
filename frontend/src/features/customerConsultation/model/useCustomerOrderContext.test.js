import { describe, expect, it } from 'vitest';
import { findCustomerOrders } from './useCustomerOrderContext.js';

describe('customer order context matching', () => {
  it('matches an Ozon base order number to its child posting without matching nearby orders', () => {
    const rows = findCustomerOrders(
      [
        {
          posting_number: '75577421-0029-1',
          raw: { order_number: '75577421-0029' },
        },
        {
          posting_number: '75577421-0029-2',
          raw: { order_number: '75577421-0029' },
        },
        {
          posting_number: '75577421-00290-1',
          raw: { order_number: '75577421-00290' },
        },
      ],
      '75577421-0029'
    );

    expect(rows.map((row) => row.posting_number)).toEqual(['75577421-0029-1', '75577421-0029-2']);
  });
});
