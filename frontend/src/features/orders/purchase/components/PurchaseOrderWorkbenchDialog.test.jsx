import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PurchaseOrderWorkbenchDialog } from './PurchaseOrderWorkbenchDialog.jsx';

const dialog = {
  open: true,
  requestKey: 'workbench-test-1',
  url: 'https://mobile.yangkeduo.com/',
  browserTabId: 'tab-workbench-test-1',
  status: 'ready',
  presentation: {
    kind: 'purchase-order',
    displayMode: 'embedded',
    title: '订单操作台',
    order: {
      orderNo: 'WORKBENCH-TEST-20260723-1',
      ozonOrderId: 'OZON-ORDER-1',
      shop: '测试店铺',
      status: '待拍单',
      goodsNo: 'WB-DEMO-001',
      paymentTime: '2026/07/23 10:30:00',
      salesAmount: '¥99.00',
    },
    product: { title: '订单操作台测试商品', sku: 'WB-SKU-001', quantity: 'x1' },
    source: { platform: 'PDD', amount: '¥18.80' },
    logistics: { weight: '0.35 kg', size: '20 x 12 x 8 cm', route: '测试路线' },
    profitItems: [{ label: '利润', value: '+ ¥8.20', tone: 'profit' }],
  },
};

describe('PurchaseOrderWorkbenchDialog', () => {
  it('renders fixed order information and browser controls inside one Wangzai dialog', () => {
    const onClose = vi.fn();
    const onMinimize = vi.fn();
    const onNavigate = vi.fn();
    const onReadPaymentInfo = vi.fn();
    const onRefreshOrderStatus = vi.fn();
    const onSavePurchaseInfo = vi.fn();
    render(
      <PurchaseOrderWorkbenchDialog
        dialog={{ ...dialog, pendingSave: true }}
        onClose={onClose}
        onMinimize={onMinimize}
        onNavigate={onNavigate}
        onReadPaymentInfo={onReadPaymentInfo}
        onRefreshOrderStatus={onRefreshOrderStatus}
        onSavePurchaseInfo={onSavePurchaseInfo}
      />
    );
    expect(screen.getByText('WORKBENCH-TEST-20260723-1')).toBeInTheDocument();
    expect(screen.getByText('订单操作台测试商品')).toBeInTheDocument();
    expect(screen.getByTestId('purchase-order-browser-viewport')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新网页' }));
    expect(onNavigate).toHaveBeenCalledWith('reload');
    fireEvent.click(screen.getByRole('button', { name: '读取付款信息' }));
    expect(onReadPaymentInfo).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '刷新订单状态' }));
    expect(onRefreshOrderStatus).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '保存信息' }));
    expect(onSavePurchaseInfo).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '最小化订单操作台' }));
    expect(onMinimize).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '关闭订单操作台' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows platform shortcuts in the title and reuses one toolbar command path', async () => {
    const onToolbarAction = vi.fn(async (action) => {
      if (action === 'capture-purchase') {
        return {
          toolbar: {
            dialog: {
              title: '采购信息捕捉预览',
              result: { purchaseOrderNumber: 'PDD-ORDER-1', conflicts: [] },
              confirmationToken: 'confirmation-1',
            },
          },
        };
      }
      if (action === 'capture-confirm') {
        return { toolbar: { dialog: { title: '采购信息已回填', result: { readbackVerified: true } } } };
      }
      return { ok: true };
    });
    render(<PurchaseOrderWorkbenchDialog dialog={dialog} onToolbarAction={onToolbarAction} />);

    fireEvent.click(screen.getByRole('button', { name: '我的订单' }));
    await waitFor(() => expect(onToolbarAction).toHaveBeenCalledWith('pinduoduo-orders', {}));
    fireEvent.click(screen.getByRole('button', { name: '捕捉采购信息' }));
    expect(await screen.findByText('采购信息捕捉预览')).toBeInTheDocument();
    expect(screen.getByText('PDD-ORDER-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认回填' }));
    await waitFor(() => expect(onToolbarAction).toHaveBeenLastCalledWith('capture-confirm', {
      confirmationToken: 'confirmation-1',
      acceptConflicts: false,
    }));
  });

  it('hides Pinduoduo-only shortcuts on other purchase platforms', () => {
    render(<PurchaseOrderWorkbenchDialog dialog={{ ...dialog, url: 'https://detail.1688.com/' }} />);
    expect(screen.queryByRole('button', { name: '我的订单' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '捕捉采购信息' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '浏览器插件' })).toBeInTheDocument();
  });

  it('unmounts the React modal and stops viewport publishing while minimized', async () => {
    const onViewportReady = vi.fn();
    render(
      <PurchaseOrderWorkbenchDialog
        dialog={{ ...dialog, minimized: true }}
        onViewportReady={onViewportReady}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onViewportReady).not.toHaveBeenCalled();
  });

  it('keeps exact-order status refresh available when only page loading reports an error', () => {
    const onReadPaymentInfo = vi.fn();
    const onRefreshOrderStatus = vi.fn();
    const onSavePurchaseInfo = vi.fn();
    render(
      <PurchaseOrderWorkbenchDialog
        dialog={{ ...dialog, status: 'error', error: '页面加载失败' }}
        onReadPaymentInfo={onReadPaymentInfo}
        onRefreshOrderStatus={onRefreshOrderStatus}
        onSavePurchaseInfo={onSavePurchaseInfo}
      />
    );

    expect(screen.getByRole('button', { name: '读取付款信息' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '刷新订单状态' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '保存信息' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '刷新订单状态' }));
    expect(onRefreshOrderStatus).toHaveBeenCalledOnce();
  });

  it('publishes the initial embedded viewport immediately without waiting for animation frame', async () => {
    const onViewportReady = vi.fn();
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.dataset?.testid === 'purchase-order-browser-viewport') {
        return { x: 463, y: 135, left: 463, top: 135, width: 921, height: 701, right: 1384, bottom: 836 };
      }
      return original.call(this);
    };
    try {
      render(
        <PurchaseOrderWorkbenchDialog
          dialog={{ ...dialog, status: 'loading' }}
          onViewportReady={onViewportReady}
        />
      );
      await waitFor(() => {
        expect(onViewportReady).toHaveBeenCalledWith(expect.objectContaining({
          requestKey: 'workbench-test-1',
          url: 'https://mobile.yangkeduo.com/',
          bounds: { x: 463, y: 135, width: 921, height: 701, visible: true },
        }));
      });
      onViewportReady.mockClear();
      fireEvent(document, new Event('visibilitychange'));
      await waitFor(() => {
        expect(onViewportReady).toHaveBeenCalledWith(expect.objectContaining({
          bounds: { x: 463, y: 135, width: 921, height: 701, visible: true },
        }));
      });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it('stops publishing viewport bounds while native close readback is pending', async () => {
    const onViewportReady = vi.fn();
    render(
      <PurchaseOrderWorkbenchDialog
        dialog={{ ...dialog, status: 'closing' }}
        onViewportReady={onViewportReady}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onViewportReady).not.toHaveBeenCalled();
    expect(screen.getByText('正在关闭')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭订单操作台' })).toBeDisabled();
  });

  it('reuses the same dialog chrome for an Ozon product workbench', () => {
    render(
      <PurchaseOrderWorkbenchDialog
        dialog={{
          ...dialog,
          status: 'loading',
          presentation: {
            ...dialog.presentation,
            title: '商品订单操作台',
            subtitle: '左侧商品订单信息固定，右侧 Ozon 商品页面独立操作',
            browserLabel: 'Ozon 商品页面',
          },
        }}
      />
    );

    expect(screen.getByText('商品订单操作台')).toBeInTheDocument();
    expect(screen.getByText('左侧商品订单信息固定，右侧 Ozon 商品页面独立操作')).toBeInTheDocument();
    expect(screen.getByText('正在打开 Ozon 商品页面')).toBeInTheDocument();
  });

  it('switches only the fixed sidebar to the profit-calculation card', () => {
    render(
      <PurchaseOrderWorkbenchDialog
        dialog={{
          ...dialog,
          presentation: {
            ...dialog.presentation,
            sidebarKind: 'profit',
            title: '利润核算操作台',
            profit: {
              realStatus: '成功订单',
              resultStatus: '盈利',
              actualProfit: '+￥18.00',
              actualProfitTone: 'profit',
              estimateItems: [{ label: '预估利润', value: '+￥20.00', tone: 'profit' }],
              actualFeeItems: [{ label: '物流扣费', value: '￥4.00' }],
            },
          },
        }}
      />
    );

    expect(screen.getByText('利润核算操作台')).toBeInTheDocument();
    expect(screen.getAllByText('预估利润')).toHaveLength(2);
    expect(screen.getByText('+￥18.00')).toBeInTheDocument();
    expect(screen.getByText('物流扣费')).toBeInTheDocument();
    expect(screen.queryByText('物流信息')).not.toBeInTheDocument();
  });

  it('switches only the fixed sidebar to the after-sales card', () => {
    render(
      <PurchaseOrderWorkbenchDialog
        dialog={{
          ...dialog,
          presentation: {
            ...dialog.presentation,
            sidebarKind: 'after-sales',
            title: '售后订单操作台',
            afterSales: {
              originalOrderNo: 'ORDER-1',
              afterSalesId: 'AFTER-1',
              type: '退货申请',
              status: '已退款',
              refundAmount: '￥16.00',
              refundStatus: '已退款给买家',
              responsibilityParty: '买家',
              reason: '买家拒收',
              purchasePlatform: 'PDD',
              purchaseOrderNo: 'PDD-1',
            },
          },
        }}
      />
    );

    expect(screen.getByText('售后订单操作台')).toBeInTheDocument();
    expect(screen.getByText('AFTER-1')).toBeInTheDocument();
    expect(screen.getByText('已退款给买家')).toBeInTheDocument();
    expect(screen.getByText('买家拒收')).toBeInTheDocument();
    expect(screen.queryByText('金额概览')).not.toBeInTheDocument();
  });

  it('switches the reused workbench sidebar to current Ozon product metrics', () => {
    render(
      <PurchaseOrderWorkbenchDialog
        dialog={{
          ...dialog,
          presentation: {
            ...dialog.presentation,
            sidebarKind: 'product-analysis',
            title: 'Ozon 商品分析操作台',
            subtitle: '左侧固定当前商品数据，右侧查看对应 Ozon 商品页面',
            product: { title: '遥控汽车', sku: '3568698657' },
            productAnalysis: {
              price: '1 999 ₽',
              cardPrice: '1 799 ₽',
              sales: '120 件',
              orders: '98',
              revenue: '239 880 ₽',
              stock: '44 件',
              brand: 'RC Pro',
              seller: '测试卖家',
              category: '儿童用品 / 遥控玩具',
              averageDailyRevenue: '7 996 ₽',
              averageDailyUnits: '4 件',
              rating: '4.8 分',
              reviews: '120 条',
              adSpendShare: '4.7%',
              productCardViews: '1,000',
              productCardToCartRate: '8.8%',
              searchCatalogViews: '4,500',
              searchCatalogToCartRate: '3.2%',
              impressionToOrderRate: '2.1%',
              fulfillmentModel: 'FBO',
              redemptionRate: '96%',
              returnCancelRate: '4%',
              packageDimensions: '100 × 200 × 300 mm',
              packageWeight: '850 g',
              listingDays: '59 天',
              followSellerCount: '2',
              followPriceRange: '1 200 ₽–1 500 ₽',
            },
          },
        }}
      />
    );

    expect(screen.getByText('Ozon 商品分析操作台')).toBeInTheDocument();
    expect(screen.getByText('遥控汽车')).toBeInTheDocument();
    expect(screen.getByText(/SKU：3568698657/u)).toBeInTheDocument();
    expect(screen.getByText('商品市场数据')).toBeInTheDocument();
    expect(screen.getByText('1 999 ₽')).toBeInTheDocument();
    expect(screen.getByText('120 件')).toBeInTheDocument();
    expect(screen.getByText('239 880 ₽')).toBeInTheDocument();
    expect(screen.getByText('44 件')).toBeInTheDocument();
    expect(screen.getByText('履约与竞争')).toBeInTheDocument();
    expect(screen.queryByText('订单信息')).not.toBeInTheDocument();
  });

  it('hides unavailable SF fields instead of filling the workbench with empty cards', () => {
    render(
      <PurchaseOrderWorkbenchDialog
        dialog={{
          ...dialog,
          presentation: {
            ...dialog.presentation,
            sidebarKind: 'product-analysis',
            title: 'Ozon 商品分析操作台',
            product: { title: '测试商品', sku: '2962820304' },
            productAnalysis: {
              visibleFields: ['price', 'sales', 'revenue', 'stock'],
              price: '163 ₽',
              sales: '2,046 件',
              revenue: '357,642 ₽',
              stock: '2,533 件',
              cardPrice: '暂无',
              orders: '暂无',
            },
          },
        }}
      />
    );

    expect(screen.getByText('163 ₽')).toBeInTheDocument();
    expect(screen.getByText('2,046 件')).toBeInTheDocument();
    expect(screen.queryByText('Ozon Card')).not.toBeInTheDocument();
    expect(screen.queryByText('订单量')).not.toBeInTheDocument();
  });
});
