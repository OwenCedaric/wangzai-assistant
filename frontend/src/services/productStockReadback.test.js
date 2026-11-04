import { describe, expect, it } from 'vitest';
import { getOzonWarehouseStockQuantity } from '../entities/product/productAttributes.jsx';
import {
  createProductEditForm,
  getOzonProductStock,
  getProductStockWriteBatchStatus,
  getProductWriteReadBackStatus,
  isProductWriteReadBackMerged,
} from '../entities/product/productWriteHelpers.jsx';

describe('product stock readback helpers', () => {
  it('keeps unknown stock unknown instead of falling back to zero', () => {
    expect(getOzonProductStock({}, {})).toBeNull();
    expect(createProductEditForm({ name: 'stock pending', stock: null }).stock).toBe('');
  });

  it('still returns explicit zero when Ozon sends stock evidence', () => {
    expect(getOzonProductStock({}, { stocks: [{ present: 0, warehouse_id: 1001 }] })).toBe(0);
  });

  it('reads local cache stockValue fields and object-shaped stocks', () => {
    expect(getOzonProductStock({}, { stockValue: 20 })).toBe(20);
    expect(getOzonProductStock({}, { stock_value: 21 })).toBe(21);
    expect(getOzonProductStock({}, { stocks: { present: 22 } })).toBe(22);
    expect(createProductEditForm({ name: 'cached stock', stockValue: 23 }).stock).toBe('23');
  });

  it('reads canonical camelCase and compatibility snake_case warehouse quantities exactly', () => {
    const stockInfo = {
      warehouse_stocks: [
        { warehouseId: '1001', presentQuantity: 2 },
        { warehouse_id: '1002', present_quantity: 4 },
      ],
    };

    expect(getOzonWarehouseStockQuantity(stockInfo, '1001')).toBe(2);
    expect(getOzonWarehouseStockQuantity(stockInfo, '1002')).toBe(4);
    expect(getOzonWarehouseStockQuantity(stockInfo, '1003')).toBeNull();
  });

  it('keeps submitted stock writes pending until readback is merged', () => {
    const pending = { confirm: { readBack: { status: 'pending' } } };
    const merged = { confirm: { readBack: { status: 'merged' } } };

    expect(getProductWriteReadBackStatus(pending)).toBe('pending');
    expect(isProductWriteReadBackMerged(pending)).toBe(false);
    expect(isProductWriteReadBackMerged(merged)).toBe(true);
  });

  it('does not treat Ozon item failures as successful batch stock writes', () => {
    expect(
      getProductStockWriteBatchStatus({
        ok: false,
        confirm: {
          ok: false,
          writeStatus: 'write_failed',
          error: { code: 'OZON_WRITE_APPLICATION_ERROR', message: 'Ozon rejected item' },
        },
      })
    ).toBe('failed');
    expect(
      getProductStockWriteBatchStatus({
        ok: false,
        confirm: {
          ok: false,
          error: { code: 'WRITE_EXECUTION_NOT_CONNECTED' },
        },
      })
    ).toBe('guarded');
  });
});
