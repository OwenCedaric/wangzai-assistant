import { describe, expect, it } from 'vitest';
import { collectOzonWarehouseStockRequestIds } from '../entities/product/productAttributes';

describe('collectOzonWarehouseStockRequestIds', () => {
  it('uses business sku text as offer_id and only sends numeric values as Ozon sku', () => {
    expect(
      collectOzonWarehouseStockRequestIds([
        { sku: 'mz-26050109-135366', ozonSku: '123456789' },
        { offerId: 'offer-1', sku: '987654321' },
        { offer_id: 'offer-1', sku: '987654321' },
        { productId: 4392243976, sku: '-' },
      ])
    ).toEqual({
      offerIds: ['mz-26050109-135366', 'offer-1'],
      skuIds: ['123456789', '987654321'],
    });
  });
});
