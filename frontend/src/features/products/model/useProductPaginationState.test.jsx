import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useProductPaginationState } from './useProductPaginationState.jsx';

function createProducts(page, count = 100) {
  return Array.from({ length: count }, (_item, index) => ({
    shopId: 'shop-2',
    productId: `${page}-${index + 1}`,
    offerId: `offer-${page}-${index + 1}`,
    name: `第 ${page} 页商品 ${index + 1}`,
  }));
}

function createProps(overrides = {}) {
  return {
    productSort: { key: '', direction: 'desc' },
    productListQueryFilterSignature: '',
    localProductServerPageMeta: {
      scopeKey: 'shop-2',
      status: '全部商品',
      keyword: '',
      page: 2,
      pageSize: 100,
      sort: 'stable',
      filterSignature: '',
      total: 4322,
    },
    productMirrorScopeKey: 'shop-2',
    status: '全部商品',
    keyword: '',
    pageSize: 100,
    page: 2,
    products: createProducts(2),
    localProductMirrorStatusCounts: { scopeKey: 'shop-2', counts: { 全部商品: 4322 } },
    productPerformance: null,
    loading: false,
    selectedProductKeys: new Set(),
    batchAnchorEl: null,
    setPage: vi.fn(),
    setSelectedProductKeys: vi.fn(),
    ...overrides,
  };
}

describe('useProductPaginationState stable page presentation', () => {
  it('keeps the total but never displays page 2 rows while page 3 loads or fails', () => {
    let props = createProps();
    const { result, rerender } = renderHook(() => useProductPaginationState(props));

    expect(result.current.productPagination.totalRows).toBe(4322);
    expect(result.current.totalPages).toBe(44);
    expect(result.current.renderedPageProducts).toHaveLength(100);
    expect(result.current.renderedPageProducts[0].productId).toBe('2-1');

    act(() => {
      props = createProps({ page: 3, loading: true });
      rerender();
    });

    expect(result.current.isWaitingForLocalApiServerPage).toBe(true);
    expect(result.current.productPagination.totalRows).toBe(4322);
    expect(result.current.totalPages).toBe(44);
    expect(result.current.productPagination.currentPage).toBe(3);
    expect(result.current.renderedPageProducts).toEqual([]);
    expect(result.current.pageProductKeys).toEqual([]);

    act(() => {
      props = createProps({
        page: 3,
        products: [],
        localProductServerPageMeta: {
          scopeKey: '',
          status: '',
          keyword: '',
          page: 1,
          pageSize: 100,
          total: 0,
          source: '',
        },
      });
      rerender();
    });

    expect(result.current.productPagination.totalRows).toBe(4322);
    expect(result.current.productPagination.currentPage).toBe(3);
    expect(result.current.renderedPageProducts).toEqual([]);

    act(() => {
      props = createProps({
        page: 3,
        products: createProducts(3),
        localProductServerPageMeta: {
          ...createProps().localProductServerPageMeta,
          page: 3,
        },
      });
      rerender();
    });

    expect(result.current.productPagination.totalRows).toBe(4322);
    expect(result.current.totalPages).toBe(44);
    expect(result.current.renderedPageProducts).toHaveLength(100);
    expect(result.current.renderedPageProducts[0].productId).toBe('3-1');
    expect(result.current.pageProductKeys).toHaveLength(100);
  });
});
