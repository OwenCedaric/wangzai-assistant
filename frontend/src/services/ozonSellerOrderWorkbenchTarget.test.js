import { describe, expect, it } from 'vitest';
import {
  normalizeOzonSellerOrderLookup,
  resolveOzonSellerOrderWorkbenchTarget,
} from './ozonSellerOrderWorkbenchTarget.js';

describe('shared Ozon Seller exact-order target', () => {
  it.each([
    ['FBS', 'fbs'],
    ['FBO', 'fbo'],
    ['realFBS', 'rfbs'],
  ])('routes %s to its own area and keeps the exact posting lookup', (fulfillment, routeKind) => {
    expect(resolveOzonSellerOrderWorkbenchTarget({
      posting_number: '0149891397-1014-1',
      fulfillment,
    })).toEqual({
      url: `https://seller.ozon.ru/app/postings/${routeKind}`,
      exact: false,
      posting: '0149891397-1014-1',
      routeKind,
      targetKind: 'seller-order',
      orderLookup: { postingNumber: '0149891397-1014-1', routeKind },
    });
  });

  it('fails closed when a module has no exact posting number', () => {
    expect(resolveOzonSellerOrderWorkbenchTarget({ fulfillment: 'FBS' }).orderLookup).toBeNull();
    expect(normalizeOzonSellerOrderLookup({ postingNumber: '', routeKind: 'fbs' })).toBeNull();
  });
});
