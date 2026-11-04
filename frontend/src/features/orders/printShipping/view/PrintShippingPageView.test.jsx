import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PrintShippingPageView } from './PrintShippingPageView.jsx';

function createModel() {
  return {
    viewTitle: '打单发货',
    viewDescription: '集中查看待打单订单',
    readableShops: [],
    orderSync: {
      data: {
        rows: [],
        total: 0,
        printShippingFacets: {
          warehouses: [{ value: '莫斯科仓', total: 2 }],
          deliveryMethods: [{ value: 'CDEK', total: 1 }],
        },
      },
      loading: false,
      refreshing: false,
      error: null,
    },
    salesOrderRefreshProgress: {},
    shop: 'all',
    setShop: vi.fn(),
    fulfillment: 'all',
    setFulfillment: vi.fn(),
    status: '等待发货',
    setStatus: vi.fn(),
    keyword: '',
    setKeyword: vi.fn(),
    printShippingFilters: {
      warehouse: '',
      deliveryMethod: '',
      deadlineScope: '',
      trackingState: '',
      carriageState: '',
    },
    setPrintShippingFilters: vi.fn(),
    salesOrderPageSize: 20,
    setSalesOrderPageSize: vi.fn(),
    setSalesOrderPage: vi.fn(),
    selectedSalesOrderKeys: new Set(),
    salesNotice: { open: false, severity: 'success', message: '' },
    setSalesNotice: vi.fn(),
    filteredOrderTotal: 0,
    salesOrderTotalPages: 1,
    currentSalesOrderPage: 1,
    visibleOrders: [],
    salesOrderRangeStart: 0,
    salesOrderRangeEnd: 0,
    visibleSalesOrderKeys: [],
    selectedSalesOrderCount: 0,
    allSalesOrderPageSelected: false,
    salesOrderPageSelectionIndeterminate: false,
    handleRefreshSalesOrders: vi.fn(),
    logisticsSync: { running: false, errors: [] },
    handleSyncLogistics: vi.fn(),
    refreshPurchaseShippingInfo: vi.fn(),
    resetSalesOrderListState: vi.fn(),
    toggleSalesOrderSelection: vi.fn(),
    toggleSalesOrderPageSelection: vi.fn(),
    clearSalesOrderSelection: vi.fn(),
    getOrderPurchaseShippingInfo: vi.fn(),
    openSalesOzonProductPage: vi.fn(),
  };
}

describe('PrintShippingPageView filters', () => {
  it('renders every server-backed print-shipping filter in the list header', () => {
    render(<PrintShippingPageView model={createModel()} />);

    expect(screen.getByRole('combobox', { name: '订单状态筛选' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '仓库筛选' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '物流方式筛选' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '发货时限筛选' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Ozon物流单号筛选' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '交接批次筛选' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重置筛选' })).toBeDisabled();
  });

  it('keeps logistics progress on the button and never renders the cross-page progress card', () => {
    const model = createModel();
    model.logisticsSync = {
      running: true,
      message: '正在核对跨境巴士登录状态',
      completed: 0,
      total: 1,
      errors: 0,
    };
    render(<PrintShippingPageView model={model} />);

    expect(screen.getByRole('button', { name: '同步中' })).toBeDisabled();
    expect(screen.queryByText('正在核对跨境巴士登录状态')).not.toBeInTheDocument();
  });
});
