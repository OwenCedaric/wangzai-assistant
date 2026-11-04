import { describe, expect, it } from 'vitest';

import { getLocalProductStockForWarehouse } from './useProductBatchState.jsx';

function createMultiWarehouseProduct(overrides = {}) {
  const warehouseStocks = [
    { warehouseId: '1001', presentQuantity: 2, reservedQuantity: 1, freeQuantity: 1 },
    { warehouseId: '1002', presentQuantity: 4, reservedQuantity: 0, freeQuantity: 4 },
  ];
  const warehouseStockObservation = { status: 'returned', observedAt: '2026-07-17T02:00:00.000Z' };
  return {
    stock: 10,
    stockValue: 10,
    warehouseStocks,
    warehouseStockComplete: true,
    warehouseStockObservation,
    raw: {
      stockInfo: {
        stocks: {
          present: 10,
          stocks: [
            { present: 4, type: 'fbo' },
            { present: 6, type: 'fbs' },
          ],
        },
        warehouse_stocks: warehouseStocks,
        warehouseStockComplete: true,
        warehouseStockObservation,
      },
    },
    ...overrides,
  };
}

describe('product batch exact warehouse stock', () => {
  it('reads real camelCase warehouse DTO quantities instead of the v4 total', () => {
    const product = createMultiWarehouseProduct();

    expect(getLocalProductStockForWarehouse(product, '1001')).toBe(2);
    expect(getLocalProductStockForWarehouse(product, '1002')).toBe(4);
  });

  it('can use the normalized top-level exact facts without falling back to the v4 scalar', () => {
    const product = createMultiWarehouseProduct({ raw: {} });

    expect(getLocalProductStockForWarehouse(product, '1001')).toBe(2);
  });

  it('blocks a selected warehouse missing from a completed set instead of falling back to v4', () => {
    expect(getLocalProductStockForWarehouse(createMultiWarehouseProduct(), '1003')).toBeNull();
  });

  it.each(['stale_previous', 'failed', 'not_returned', 'pending'])(
    'blocks retained warehouse facts when observation status is %s',
    (status) => {
      const product = createMultiWarehouseProduct({
        warehouseStockComplete: false,
        warehouseStockObservation: { status },
      });
      product.raw.stockInfo.warehouseStockComplete = false;
      product.raw.stockInfo.warehouseStockObservation = { status };

      expect(getLocalProductStockForWarehouse(product, '1001')).toBeNull();
    }
  );

  it('requires the explicit completeness flag even when the status says returned', () => {
    const product = createMultiWarehouseProduct({ warehouseStockComplete: false });
    product.raw.stockInfo.warehouseStockComplete = false;

    expect(getLocalProductStockForWarehouse(product, '1001')).toBeNull();
  });

  it('does not invent an exact warehouse row from a returned-empty set', () => {
    const product = createMultiWarehouseProduct({
      warehouseStocks: [],
      warehouseStockObservation: { status: 'returned_empty' },
      raw: {
        stockInfo: {
          stocks: { present: 10, stocks: [{ present: 10, type: 'fbo' }] },
          warehouse_stocks: [],
          warehouseStockComplete: true,
          warehouseStockObservation: { status: 'returned_empty' },
        },
      },
    });

    expect(getLocalProductStockForWarehouse(product, '1001')).toBeNull();
  });
});
