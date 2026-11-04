import { describe, expect, it } from 'vitest';
import {
  buildOzonSellerAfterSalesPageUrl,
  resolveOzonSellerAfterSalesPageTarget,
  resolveOzonSellerAfterSalesWorkbenchTarget,
} from './ozonSellerAfterSalesPageLink.js';

describe('Ozon Seller after-sales page links', () => {
  it('opens the exact rFBS return used by the after-sales row', () => {
    expect(resolveOzonSellerAfterSalesPageTarget({
      returnId: '88964914',
      salesOrder: '07389289-0111-1',
      source: 'rfbs-return',
    })).toEqual({
      url: 'https://seller.ozon.ru/app/returns/details/rfbs/88964914',
      exact: true,
      returnId: '88964914',
      routeKind: 'rfbs',
    });
  });

  it('uses the FBS detail route only when the row has FBS evidence', () => {
    expect(buildOzonSellerAfterSalesPageUrl({ return_id: 'FBS-100', source: 'fbs-return' }))
      .toBe('https://seller.ozon.ru/app/returns/details/fbs/FBS-100');
  });

  it('keeps a matching Seller detail URL returned by the real row', () => {
    expect(buildOzonSellerAfterSalesPageUrl({
      return_id: '88964914',
      source: 'rfbs-return',
      raw: {
        details_url: 'https://seller.ozon.ru/app/returns/details/rfbs/88964914?from=returns',
      },
    })).toBe('https://seller.ozon.ru/app/returns/details/rfbs/88964914?from=returns');
  });

  it('does not trust another host or a detail URL for another return', () => {
    expect(buildOzonSellerAfterSalesPageUrl({
      returnId: '88964914',
      source: 'rfbs-return',
      detailsUrl: 'https://seller.ozon.ru.evil.invalid/app/returns/details/rfbs/88964914',
    })).toBe('https://seller.ozon.ru/app/returns/details/rfbs/88964914');
    expect(buildOzonSellerAfterSalesPageUrl({
      returnId: '88964914',
      source: 'rfbs-return',
      detailsUrl: 'https://seller.ozon.ru/app/returns/details/rfbs/99999999',
    })).toBe('https://seller.ozon.ru/app/returns/details/rfbs/88964914');
  });

  it('never guesses from a generated row id or an unknown fulfillment route', () => {
    expect(resolveOzonSellerAfterSalesPageTarget({
      id: 'return_ddff438275b228f62a01d3b46407bbab',
      salesOrder: '07389289-0111-1',
      source: 'order-cancelled',
    }).url).toBe('');
    expect(resolveOzonSellerAfterSalesPageTarget({
      returnId: '88964914',
      source: 'unknown',
    }).url).toBe('');
  });

  it('keeps the existing after-sales workbench target when an exact return detail exists', () => {
    expect(resolveOzonSellerAfterSalesWorkbenchTarget({
      returnId: '88964914',
      salesOrder: '07389289-0111-1',
      source: 'rfbs-return',
    })).toEqual({
      url: 'https://seller.ozon.ru/app/returns/details/rfbs/88964914',
      exact: true,
      returnId: '88964914',
      routeKind: 'rfbs',
      posting: '07389289-0111-1',
      targetKind: 'after-sales-detail',
    });
  });

  it('opens the original-order area inside the workbench for generated rows without a return id', () => {
    expect(resolveOzonSellerAfterSalesWorkbenchTarget({
      id: 'return_ddff438275b228f62a01d3b46407bbab',
      salesOrder: '0209987208-0062-1',
      fulfillment: 'FBS',
      source: 'order-cancelled',
    })).toEqual({
      url: 'https://seller.ozon.ru/app/postings/fbs',
      exact: false,
      returnId: '',
      routeKind: 'fbs',
      posting: '0209987208-0062-1',
      targetKind: 'original-order-list',
      orderLookup: {
        postingNumber: '0209987208-0062-1',
        routeKind: 'fbs',
      },
    });
  });

  it('routes FBO and rFBS original orders to their own Seller order areas', () => {
    expect(resolveOzonSellerAfterSalesWorkbenchTarget({ salesOrder: 'FBO-1', fulfillment: 'FBO' }).url)
      .toBe('https://seller.ozon.ru/app/postings/fbo');
    expect(resolveOzonSellerAfterSalesWorkbenchTarget({ salesOrder: 'RFBS-1', fulfillment: 'rFBS' }).url)
      .toBe('https://seller.ozon.ru/app/postings/rfbs');
  });
});
