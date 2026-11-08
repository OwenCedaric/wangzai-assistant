import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProductSelectionKey } from '../../../entities/product/productWriteHelpers.jsx';

const imageRenders = new Map();

vi.mock('../ui/ProductListImageThumb.jsx', () => ({
  ProductListImageThumb: ({ product }) => {
    imageRenders.set(product.sku, (imageRenders.get(product.sku) || 0) + 1);
    return <span>{product.sku}</span>;
  },
}));

vi.mock('../../../entities/order/orderSourceLinks.jsx', () => ({
  ProductMaterialTags: () => null,
}));

vi.mock('../../../entities/order/orderSourceLinkFields.jsx', () => ({
  SourceLinkDropdownField: () => null,
}));

import { getProductStockCellPresentation, ProductTableRows } from './ProductTableRows.jsx';

afterEach(() => {
  cleanup();
  imageRenders.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const firstProduct = { productId: '1', sku: 'SKU-1', name: '商品一', status: '正常', tone: 'success' };
const secondProduct = { productId: '2', sku: 'SKU-2', name: '商品二', status: '正常', tone: 'success' };
const emptySourceRecord = { links: [], primaryIndex: 0 };
const stableHandlers = {
  toggleProductSelection: vi.fn(),
  getProductSourceLinkValue: () => '',
  getProductSourceRecord: () => emptySourceRecord,
  getProductSourceSelectedSlot: () => 0,
  selectProductSourceSlot: vi.fn(),
  updateProductSourceLink: vi.fn(),
  saveProductSourceLink: vi.fn(),
  getProductArchiveOperationKey: (product) => product.productId,
  handleEditProduct: vi.fn(),
  handleProductArchiveAction: vi.fn(),
  handleOpenOzonProductPage: vi.fn(),
};

function renderRows({
  products = [firstProduct, secondProduct],
  selectedProductKeys = new Set(),
  renderEnabled = true,
} = {}) {
  return (
    <table>
      <tbody>
        <ProductTableRows
          products={products}
          renderEnabled={renderEnabled}
          selectedProductKeys={selectedProductKeys}
          savingProductId=""
          pendingProductArchiveKeys={new Set()}
          canReadOzon
          {...stableHandlers}
        />
      </tbody>
    </table>
  );
}

describe('ProductTableRows', () => {
  it('mounts a full 20-row page in separate tasks without dropping rows', async () => {
    const products = Array.from({ length: 20 }, (_item, index) => ({
      ...firstProduct,
      productId: String(index + 1),
      sku: `SKU-${index + 1}`,
      name: `商品${index + 1}`,
    }));
    const { container } = render(renderRows({ products }));

    expect(container.querySelectorAll('tbody > tr.product-native-row')).toHaveLength(1);
    await waitFor(() => {
      expect(container.querySelectorAll('tbody > tr.product-native-row')).toHaveLength(20);
    });
  });

  it('keeps the hidden preloaded page at one row until the workspace becomes visible', async () => {
    const products = Array.from({ length: 20 }, (_item, index) => ({
      ...firstProduct,
      productId: String(index + 1),
      sku: `SKU-${index + 1}`,
      name: `商品${index + 1}`,
    }));
    const view = render(renderRows({ products, renderEnabled: false }));

    expect(view.container.querySelectorAll('tbody > tr.product-native-row')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(view.container.querySelectorAll('tbody > tr.product-native-row')).toHaveLength(1);

    view.rerender(renderRows({ products, renderEnabled: true }));
    await waitFor(() => {
      expect(view.container.querySelectorAll('tbody > tr.product-native-row')).toHaveLength(20);
    });
  });

  it('keeps the completed page visible until the next page finishes staged rendering', async () => {
    // Verify each scheduled task deterministically; this is a transition contract,
    // not a one-second jsdom/CI rendering benchmark. The earlier tests exercise real timers.
    vi.stubGlobal('scheduler', undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const drainRenderTasks = async (checkTransition = () => {}) => {
      for (let tasks = 0; vi.getTimerCount() > 0; tasks += 1) {
        expect(tasks).toBeLessThan(100);
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        checkTransition();
      }
    };
    const pageOne = Array.from({ length: 100 }, (_item, index) => ({
      ...firstProduct,
      productId: String(index + 1),
      sku: `PAGE-1-${index + 1}`,
      name: `第一页商品${index + 1}`,
    }));
    const pageTwo = Array.from({ length: 100 }, (_item, index) => ({
      ...firstProduct,
      productId: String(index + 1001),
      sku: `PAGE-2-${index + 1}`,
      name: `第二页商品${index + 1}`,
    }));
    const view = render(renderRows({ products: pageOne }));

    await drainRenderTasks();
    expect(view.container.querySelectorAll('tbody > tr.product-native-row:not([hidden])')).toHaveLength(100);

    view.rerender(renderRows({ products: pageTwo }));

    const retainedRows = [...view.container.querySelectorAll('tbody > tr.product-native-row:not([hidden])')];
    expect(retainedRows).toHaveLength(100);
    expect(retainedRows[0]).toHaveTextContent('PAGE-1-1');

    await drainRenderTasks(() => {
      const visibleRows = [...view.container.querySelectorAll('tbody > tr.product-native-row:not([hidden])')];
      expect(visibleRows).toHaveLength(100);
      const nextPageVisible = visibleRows[0].textContent.includes('PAGE-2-1');
      expect(visibleRows.every(row => row.textContent.includes(nextPageVisible ? 'PAGE-2-' : 'PAGE-1-'))).toBe(true);
    });
    {
      const visibleRows = [...view.container.querySelectorAll('tbody > tr.product-native-row:not([hidden])')];
      expect(visibleRows).toHaveLength(100);
      expect(visibleRows[0]).toHaveTextContent('PAGE-2-1');
      expect(visibleRows[99]).toHaveTextContent('PAGE-2-100');
      expect(visibleRows.some((row) => row.textContent.includes('PAGE-1-1'))).toBe(false);
      expect(view.container.querySelectorAll('tbody > tr[hidden]')).toHaveLength(0);
    }
  });

  it('uses native table rows and cells so the bounded first page does not create per-cell MUI component trees', () => {
    const { container } = render(renderRows());
    expect(container.querySelectorAll('tbody > tr.product-native-row')).toHaveLength(2);
    expect(container.querySelectorAll('td.product-native-cell')).toHaveLength(24);
    expect(container.querySelector('.MuiTableRow-root, .MuiTableCell-root')).toBeNull();
  });

  it('uses the same joined compact source control as the sales order list', () => {
    const { container } = render(renderRows({ products: [firstProduct] }));
    const sourceRow = container.querySelector('.product-source-link-row');
    const saveButton = sourceRow.querySelector('.product-source-list-save');

    expect(sourceRow).toHaveClass('compact-source-link-row');
    expect(saveButton).toHaveClass('compact-source-save-button');
    expect(saveButton).toHaveTextContent('保存');
    expect(saveButton).toHaveAttribute('aria-label', '保存货源');
  });

  it('opens the Ozon product page when the product title is clicked', () => {
    render(renderRows({ products: [firstProduct] }));

    fireEvent.click(screen.getByRole('button', { name: '商品一' }));

    expect(stableHandlers.handleOpenOzonProductPage).toHaveBeenCalledWith(firstProduct);
  });

  it('only recommits the changed row when selection or row data changes', () => {
    const { rerender } = render(renderRows());
    expect(imageRenders.get('SKU-1')).toBe(1);
    expect(imageRenders.get('SKU-2')).toBe(1);

    const firstKey = getProductSelectionKey(firstProduct);
    rerender(renderRows({ selectedProductKeys: new Set([firstKey]) }));
    expect(imageRenders.get('SKU-1')).toBe(2);
    expect(imageRenders.get('SKU-2')).toBe(1);

    rerender(
      renderRows({
        products: [firstProduct, { ...secondProduct, stock: 19 }],
        selectedProductKeys: new Set([firstKey]),
      })
    );
    expect(imageRenders.get('SKU-1')).toBe(2);
    expect(imageRenders.get('SKU-2')).toBe(2);
  });

  it.each([
    {
      name: '明确数字 0',
      product: { stock: 0 },
      expected: { value: 0, display: 0, state: 'confirmed_zero' },
    },
    {
      name: '数字字符串 0',
      product: { stockValue: '0' },
      expected: { value: 0, display: 0, state: 'confirmed_zero' },
    },
    {
      name: '明确正库存',
      product: { stock: 18 },
      expected: { value: 18, display: 18, state: 'returned' },
    },
    {
      name: '待处理的库存分面',
      product: { stock: null, facetObservations: { stocks: { status: 'pending' } } },
      expected: { value: null, display: '同步中', state: 'pending' },
    },
    {
      name: '同步中保留的上次数字库存',
      product: { stock: 8, facetObservations: { stocks: { status: 'pending' } } },
      expected: { value: 8, display: '8（上次）', state: 'pending_previous' },
    },
    {
      name: '同步中保留的上次零库存',
      product: { stock: 0, facetObservations: { stocks: { status: 'pending' } } },
      expected: { value: 0, display: '0（上次）', state: 'pending_previous' },
    },
    {
      name: '明确返回的当前零库存',
      product: { stock: 0, facetObservations: { stocks: { status: 'returned' } } },
      expected: { value: 0, display: 0, state: 'confirmed_zero' },
    },
    {
      name: '明确返回的当前正库存',
      product: { stock: 23, facetObservations: { stocks: { status: 'returned' } } },
      expected: { value: 23, display: 23, state: 'returned' },
    },
    {
      name: '明确空库存响应',
      product: { stock: null, facetObservations: { stocks: { status: 'returned_empty' } } },
      expected: { value: null, display: '无库存明细', state: 'returned_empty' },
    },
    {
      name: '空库存响应不采信遗留数字',
      product: { stock: 9, facetObservations: { stocks: { status: 'returned_empty' } } },
      expected: { value: null, display: '无库存明细', state: 'returned_empty' },
    },
    {
      name: 'Ozon 不可用状态',
      product: { stock: null, facetObservations: { stocks: { status: 'unavailable' } } },
      expected: { value: null, display: '不可用', state: 'unavailable' },
    },
    {
      name: 'Ozon 不可用状态不采信遗留零库存',
      product: { stock: 0, facetObservations: { stocks: { status: 'unavailable' } } },
      expected: { value: null, display: '不可用', state: 'unavailable' },
    },
    {
      name: 'Ozon 未返回该商品',
      product: { stock: null, facetObservations: { stocks: { status: 'not_returned' } } },
      expected: { value: null, display: '未返回', state: 'not_returned' },
    },
    {
      name: '库存契约异常',
      product: { stock: null, facetObservations: { stocks: { status: 'contract_invalid' } } },
      expected: { value: null, display: '数据异常', state: 'contract_invalid' },
    },
    {
      name: '返回成功但数值缺失',
      product: { stock: null, facetObservations: { stocks: { status: 'returned' } } },
      expected: { value: null, display: '数据异常', state: 'contract_invalid' },
    },
    {
      name: '同步失败',
      product: { stock: null, facetObservations: { stocks: { status: 'failed' } } },
      expected: { value: null, display: '同步失败', state: 'failed' },
    },
    {
      name: '不适用库存接口',
      product: { stock: null, facetObservations: { stocks: { status: 'not_applicable' } } },
      expected: { value: null, display: '不适用', state: 'not_applicable' },
    },
    {
      name: '不适用状态不采信遗留数字',
      product: { stock: 4, facetObservations: { stocks: { status: 'not_applicable' } } },
      expected: { value: null, display: '不适用', state: 'not_applicable' },
    },
    {
      name: '保留的上次库存',
      product: { stock: 7, facetObservations: { stocks: { status: 'stale_previous' } } },
      expected: { value: 7, display: '7（上次）', state: 'stale_previous' },
    },
    {
      name: '本次未返回时保留的数字库存',
      product: { stock: 11, facetObservations: { stocks: { status: 'not_returned' } } },
      expected: { value: 11, display: '11（上次）', state: 'stale_previous' },
    },
    {
      name: '本次同步失败时保留的零库存',
      product: { stock: 0, facetObservations: { stocks: { status: 'failed' } } },
      expected: { value: 0, display: '0（上次）', state: 'stale_previous' },
    },
    {
      name: '本次契约异常时保留的数字库存',
      product: { stock: 6, facetObservations: { stocks: { status: 'contract_invalid' } } },
      expected: { value: 6, display: '6（上次）', state: 'stale_previous' },
    },
    {
      name: '未知分面状态不把遗留数字当当前库存',
      product: { stock: 5, facetObservations: { stocks: { status: 'future_status' } } },
      expected: { value: 5, display: '5（上次）', state: 'stale_previous' },
    },
    {
      name: '上次库存缺失',
      product: { stock: null, facetObservations: { stocks: { status: 'stale_previous' } } },
      expected: { value: null, display: '旧值缺失', state: 'stale_previous' },
    },
    {
      name: '已同步但无分面状态的旧 DTO',
      product: { stock: null, stocksSyncedAt: '2026-07-17T01:11:32.034Z' },
      expected: { value: null, display: '未返回', state: 'not_returned' },
    },
    {
      name: '未同步的旧 DTO',
      product: { stock: null },
      expected: { value: null, display: '待同步', state: 'awaiting' },
    },
    {
      name: '非数字库存',
      product: { stock: 'unknown' },
      expected: { value: null, display: '数据异常', state: 'contract_invalid' },
    },
    {
      name: '负库存',
      product: { stock: -1 },
      expected: { value: null, display: '数据异常', state: 'contract_invalid' },
    },
  ])('正确区分$name', ({ product, expected }) => {
    expect(getProductStockCellPresentation(product)).toMatchObject(expected);
  });

  it('只对明确 pending 显示同步中，并在 DOM 保留库存证据状态', () => {
    const pendingProduct = {
      ...firstProduct,
      stock: null,
      facetObservations: { stocks: { status: 'pending' } },
    };
    const unavailableProduct = {
      ...secondProduct,
      stock: null,
      facetObservations: { stocks: { status: 'unavailable', observedAt: '2026-07-17T01:11:32.034Z' } },
    };
    const { container } = render(renderRows({ products: [pendingProduct, unavailableProduct] }));
    const stockCells = [...container.querySelectorAll('.product-stock-value')];

    expect(stockCells[0]).toHaveTextContent('同步中');
    expect(stockCells[0]).toHaveAttribute('data-stock-state', 'pending');
    expect(stockCells[1]).toHaveTextContent('不可用');
    expect(stockCells[1]).toHaveAttribute('data-stock-state', 'unavailable');
    expect(stockCells[1]).not.toHaveTextContent('同步中');
  });
});
