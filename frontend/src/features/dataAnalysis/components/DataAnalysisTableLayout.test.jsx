import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataAnalysisAdvertisingPanel } from './DataAnalysisAdvertisingPanel.jsx';
import { DataAnalysisRecentReturnsTable, DataAnalysisReturnReasonTable } from './DataAnalysisAfterSalesTables.jsx';
import { DataAnalysisFinanceOperationTable, DataAnalysisLargestDeductionsTable } from './DataAnalysisFinanceTables.jsx';
import { DataAnalysisActivityProductTable, DataAnalysisActivityTable } from './DataAnalysisMarketingTables.jsx';
import { DataAnalysisMarketRecordTable } from './DataAnalysisMarketRecordTable.jsx';
import { DataAnalysisStockRiskTable } from './DataAnalysisRankingTable.jsx';

function expectFixedTableWithoutHorizontalScroll(table) {
  expect(table).toHaveStyle({ tableLayout: 'fixed', width: '100%' });
  expect(table.parentElement).toHaveStyle({ overflowX: 'hidden' });
}

describe('data analysis table layout', () => {
  it('keeps deduction date, operation and order on one line and removes the conversion column', () => {
    render(
      <DataAnalysisLargestDeductionsTable
        rows={[{
          operationId: 'operation-1',
          operationDate: '2026-07-15T10:00:00Z',
          operationType: 'return',
          postingNumber: '56439103-0025-1',
          amount: -39.42,
          currency: 'CNY',
        }]}
      />,
    );

    expect(screen.queryByText('换算依据')).not.toBeInTheDocument();
    expect(screen.getByText('日期')).toBeInTheDocument();
    expect(screen.getByText('操作类型')).toBeInTheDocument();
    expect(screen.getByText('订单')).toBeInTheDocument();
    expect(screen.getByText('2026-07-15')).toHaveStyle({ whiteSpace: 'nowrap' });
    expect(screen.getByText('56439103-0025-1')).toHaveStyle({ whiteSpace: 'nowrap' });
  });

  it('fits activity products inside the card without a horizontal scroll container', () => {
    render(
      <DataAnalysisActivityProductTable
        rows={[{
          activityId: '1977747',
          productId: '123456789',
          name: '测试商品',
          offerId: 'offer-1',
          sku: '123456789',
          rowStatus: 'active',
          price: 226.12,
          activityPrice: 113.06,
          stock: 2,
          currentStock: 3,
        }]}
      />,
    );

    const table = screen.getByRole('table');
    expectFixedTableWithoutHorizontalScroll(table);
  });

  it('fits stock-risk products inside the card without a horizontal scroll container', () => {
    render(
      <DataAnalysisStockRiskTable
        rows={[{
          productId: '123456789',
          name: '长标题测试商品',
          offerId: 'offer-1',
          sku: '123456789',
          stock: 0,
          visibility: 'IN_SALE',
        }]}
      />,
    );

    const table = screen.getByRole('table');
    expectFixedTableWithoutHorizontalScroll(table);
  });

  it.each([
    ['费用结构', () => (
      <DataAnalysisFinanceOperationTable rows={[{ code: 'services', count: 2, amount: { breakdown: [{ currency: 'CNY', value: -12.3 }] } }]} />
    )],
    ['促销活动', () => (
      <DataAnalysisActivityTable rows={[{ activityId: 'activity-1', title: '测试活动', active: true }]} />
    )],
    ['售后原因', () => (
      <DataAnalysisReturnReasonTable rows={[{ reasonId: 'reason-1', reasonLabel: '商品损坏', count: 2, isDefect: true }]} />
    )],
    ['售后明细', () => (
      <DataAnalysisRecentReturnsTable rows={[{ returnId: 'return-1', productName: '测试商品', statusLabel: '处理中' }]} />
    )],
  ])('fits the %s table inside the card', (_label, renderTable) => {
    render(renderTable());
    expectFixedTableWithoutHorizontalScroll(screen.getByRole('table'));
  });

  it('fits the advertising campaign table inside the card', () => {
    render(
      <DataAnalysisAdvertisingPanel
        state={{
          status: 'ready',
          refresh: () => {},
          data: {
            finishedAt: '2026-07-29T10:00:00Z',
            statisticsRead: true,
            statisticsCoverage: { returnedCampaignCount: 1, campaignCount: 1 },
            metrics: [],
            campaigns: [{ id: 'campaign-1', title: '测试广告计划', statusLabel: '运行中' }],
          },
        }}
      />,
    );

    expectFixedTableWithoutHorizontalScroll(screen.getByRole('table'));
  });

  it('fits market records and pagination without horizontal scrolling', () => {
    render(
      <DataAnalysisMarketRecordTable
        dataset={{
          dataset: 'product-performance',
          label: '商品表现',
          records: [{
            id: '123456789',
            title: '测试市场商品',
            brand: '测试品牌',
            seller: '测试卖家',
            article: 'article-1',
            category: '遥控汽车',
            feature: '机会商品',
            searchPosition: 12,
            orderAmount: 1200,
            dynamics: 0.12,
            orderedProducts: 20,
            averagePurchasePrice: 60,
            averageDailyRevenue: 40,
            averageDailyUnits: 2,
            adSpendShare: 4.7,
            promoDays: 8,
            promoDiscount: 12.5,
            promoRevenueShare: 27.1,
            paidPromotionDays: 4,
            productCardViews: 1000,
            productCardToCartRate: 8.8,
            searchCatalogViews: 4500,
            searchCatalogToCartRate: 3.2,
            impressionToOrderRate: 1.9,
            clickThroughRate: 20,
            returnCancelRate: 5.8,
            fulfillmentModel: 'FBO',
            packageDimensions: '100 × 200 × 300 mm',
            packageWeight: '1500 g',
            listedAt: '2026-06-30T00:00:00.000Z',
            listingDays: 22,
            followSellerCount: 2,
            followMinPrice: 1200,
            followMaxPrice: 1500,
          }],
        }}
      />,
    );

    expectFixedTableWithoutHorizontalScroll(screen.getByRole('table', { name: /真实数据/ }));
    expect(screen.getByText(/共 1 条/).closest('.MuiTablePagination-root')).toHaveStyle({ overflowX: 'hidden' });
  });
});
