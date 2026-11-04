import { describe, expect, it } from 'vitest';

import {
  createProductListQueryFilters,
  getProductListQueryFilterSignature,
  normalizeProductListQueryFilters,
} from './productListQuery.jsx';

describe('product list typed SQLite query filters', () => {
  it('maps renderer labels to the canonical local-api vocabulary', () => {
    expect(
      createProductListQueryFilters({
        selectedMaterialSourceFilters: ['supplier-confirmed', 'cross-border-bus'],
        selectedWarehouseFilters: ['multi', 'default'],
        productDefaultWarehouseId: 'warehouse-9',
        selectedStockFilters: ['zero'],
        selectedProductStatusFilters: ['已下架'],
        selectedSourceStatusFilters: ['1688', 'saved'],
      })
    ).toEqual({
      materialSources: ['cross-border', 'supplier'],
      warehouseFilters: ['default', 'multi'],
      defaultWarehouseId: 'warehouse-9',
      stockFilters: ['zero'],
      productStatuses: ['已下架'],
      sourceStatuses: ['1688', 'saved'],
    });
  });

  it('drops unknown values and produces an order-independent cache signature', () => {
    const left = normalizeProductListQueryFilters({
      materialSources: ['missing', 'unknown', 'supplier-confirmed'],
      sourceStatuses: ['pdd', 'saved'],
    });
    const right = normalizeProductListQueryFilters({
      sourceStatuses: ['saved', 'pdd'],
      materialSources: ['supplier', 'missing'],
    });
    expect(left).toEqual(right);
    expect(getProductListQueryFilterSignature(left)).toBe(getProductListQueryFilterSignature(right));
  });
});
