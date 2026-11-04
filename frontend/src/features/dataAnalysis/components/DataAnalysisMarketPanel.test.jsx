import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataAnalysisMarketPanel } from './DataAnalysisMarketPanel.jsx';

describe('DataAnalysisMarketPanel market browser data', () => {
  it('keeps the market page available while the first cache read has not returned data', () => {
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{ status: 'idle', data: null }}
      />,
    );

    expect(screen.getByText(/暂无.*可用数据/u)).toBeVisible();
    expect(screen.queryByText('页面显示异常')).not.toBeInTheDocument();
  });

  it('does not lock search or manual refresh while cached data is refreshing in the background', () => {
    const onReadMarketData = vi.fn();
    const onSearchMarketData = vi.fn();
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        onReadMarketData={onReadMarketData}
        onSearchMarketData={onSearchMarketData}
        marketState={{
          status: 'cache-ready',
          activeAction: '',
          query: '遥控汽车',
          setQuery: vi.fn(),
          data: {
            status: 'ready',
            refreshTrigger: 'view',
            refreshInProgress: true,
            datasetViews: [],
          },
        }}
      />,
    );

    const searchButton = screen.getByRole('button', { name: '搜索 Ozon' });
    const refreshButton = screen.getByRole('button', { name: '刷新数据' });
    expect(searchButton).toBeEnabled();
    expect(refreshButton).toBeEnabled();
    fireEvent.click(searchButton);
    fireEvent.click(refreshButton);
    expect(onSearchMarketData).toHaveBeenCalledWith('遥控汽车');
    expect(onReadMarketData).toHaveBeenCalledTimes(1);
  });

  it('keeps foreground controls available while the first passive view read is still loading', () => {
    const onReadMarketData = vi.fn();
    const onSearchMarketData = vi.fn();
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        onReadMarketData={onReadMarketData}
        onSearchMarketData={onSearchMarketData}
        marketState={{
          status: 'loading',
          activeAction: '',
          query: '遥控汽车',
          setQuery: vi.fn(),
          data: null,
        }}
      />,
    );

    const searchButton = screen.getByRole('button', { name: '搜索 Ozon' });
    const refreshButton = screen.getByRole('button', { name: '刷新数据' });
    expect(searchButton).toBeEnabled();
    expect(refreshButton).toBeEnabled();
    fireEvent.click(searchButton);
    fireEvent.click(refreshButton);
    expect(onSearchMarketData).toHaveBeenCalledWith('遥控汽车');
    expect(onReadMarketData).toHaveBeenCalledTimes(1);
  });

  it('allows only one explicit foreground market action at a time', () => {
    const { rerender } = render(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{ status: 'refreshing', activeAction: 'manual', query: '遥控汽车', data: null }}
      />,
    );
    expect(screen.getByRole('button', { name: '搜索 Ozon' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '正在刷新' })).toBeDisabled();

    rerender(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{ status: 'searching', activeAction: 'search', query: '遥控汽车', data: null }}
      />,
    );
    expect(screen.getByRole('button', { name: '正在搜索' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '刷新数据' })).toBeDisabled();
  });

  it('shows an empty opportunity state when the cache only contains hidden datasets', () => {
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{
          status: 'ready',
          data: {
            datasetViews: [{
              id: 'products',
              dataset: 'products',
              recordCount: 1,
              records: [{ id: 'sku-1', title: '店铺商品' }],
            }],
          },
        }}
      />,
    );

    expect(screen.getByText('暂未返回可用机会数据')).toBeVisible();
    expect(screen.queryByRole('tab', { name: /商品明细/u })).not.toBeInTheDocument();
    expect(screen.queryByText('页面显示异常')).not.toBeInTheDocument();
  });

  it('renders normalized Ozon rows without exposing original fields', () => {
    const onReadMarketData = vi.fn();
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        onReadMarketData={onReadMarketData}
        marketState={{
          status: 'ready',
          data: {
            status: 'ready',
            statusLabel: '已接入 2 个真实数据集',
            observerVersion: '2.4.0',
            endpointCount: 12,
            confirmedDatasetCount: 3,
            updatedAt: '2026-07-22T03:00:00.000Z',
            datasetViews: [
              {
                id: 'market-products', dataset: 'market-products', title: '市场商品', status: 'ready', recordCount: 1,
                newestCapturedAt: '2026-07-22T03:00:00.000Z', metrics: [{ label: '市场商品', value: 1, unit: '个' }],
                records: [{ dataset: 'market-products', id: '3568698657', title: '旧版列表数据' }],
              },
              {
                id: 'comparison', dataset: 'comparison', title: '竞品对比', status: 'ready', recordCount: 1,
                newestCapturedAt: '2026-07-22T03:00:00.000Z', metrics: [{ label: '竞品记录', value: 1, unit: '条' }],
                records: [{ dataset: 'comparison', id: '3568698657', title: '遥控汽车', category: '玩具', brand: '测试品牌', sales: 42 }],
              },
            ],
          },
        }}
      />
    );

    expect(screen.getByText(/最近获取/u)).toBeVisible();
    expect(screen.queryByText(/热缓存|已自动翻取/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /市场商品/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /竞品对比/u }));
    const table = screen.getByRole('table', { name: '竞品对比真实数据' });
    expect(within(table).getByText('遥控汽车')).toBeVisible();
    expect(within(table).getByText(/3568698657/u)).toBeVisible();
    expect(within(table).queryByText('Ozon 原始字段')).not.toBeInTheDocument();
    expect(screen.queryByText(/sourceFields/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新数据' }));
    expect(onReadMarketData).toHaveBeenCalledTimes(1);
  });

  it('renders only confirmed non-empty dynamic datasets and submits the Ozon keyword', () => {
    const onSearchMarketData = vi.fn();
    const setQuery = vi.fn();
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        onSearchMarketData={onSearchMarketData}
        marketState={{
          status: 'ready',
          query: '遥控汽车',
          setQuery,
          data: {
            status: 'ready',
            statusLabel: '已接入 1 个真实数据集',
            observerVersion: '2.4.0',
            endpointCount: 12,
            confirmedDatasetCount: 1,
            updatedAt: '2026-07-22T03:00:00.000Z',
            datasetViews: [{
              id: 'keywords', dataset: 'keywords', title: '关键词数据', status: 'ready', recordCount: 1,
              newestCapturedAt: '2026-07-22T03:00:00.000Z', metrics: [],
              records: [{ dataset: 'keywords', id: 'kw-1', title: '遥控汽车', views: 1200 }],
            }],
            sections: {
              opportunity: { title: '市场机会', status: 'access-denied', statusLabel: '无权限', recordCount: 0, records: [] },
            },
          },
        }}
      />
    );

    expect(screen.getAllByText('关键词机会').length).toBeGreaterThan(0);
    expect(screen.queryByText('市场机会')).not.toBeInTheDocument();
    expect(screen.queryByText('无权限')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /关键词机会/u }));
    const table = screen.getByRole('table', { name: '关键词机会真实数据' });
    expect(within(table).queryByText('keywords')).not.toBeInTheDocument();
    expect(within(table).getByText('商品浏览').closest('th')).toHaveClass('MuiTableCell-alignRight');
    expect(within(table).getByText('1,200').closest('td')).toHaveClass('MuiTableCell-alignRight');
    fireEvent.click(screen.getByRole('button', { name: '搜索 Ozon' }));
    expect(onSearchMarketData).toHaveBeenCalledWith('遥控汽车');
  });

  it('removes columns that are absent from every returned market row', () => {
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{
          status: 'ready',
          data: {
            status: 'ready',
            datasetViews: [{
              id: 'comparison',
              dataset: 'comparison',
              title: '竞品对比',
              recordCount: 1,
              records: [{
                dataset: 'comparison',
                id: 'sku-1',
                title: '遥控汽车',
                category: '玩具',
              }],
            }],
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /竞品对比/u }));
    const table = screen.getByRole('table', { name: '竞品对比真实数据' });
    expect(within(table).getByText('类目')).toBeVisible();
    expect(within(table).getByText('遥控汽车')).toBeVisible();
    expect(within(table).queryByText('品牌')).not.toBeInTheDocument();
    expect(within(table).queryByText('平均价格')).not.toBeInTheDocument();
    expect(within(table).queryByText('销量')).not.toBeInTheDocument();
    expect(within(table).queryByText('GMV')).not.toBeInTheDocument();
    expect(within(table).queryByText('库存')).not.toBeInTheDocument();
  });

  it('paginates the complete dataset instead of truncating it to 50 rows', () => {
    const records = Array.from({ length: 120 }, (_, index) => ({
      dataset: 'keywords',
      id: `kw-${index + 1}`,
      title: `搜索词-${index + 1}`,
      searches: 1_000 - index,
    }));
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{
          status: 'ready',
          data: {
            status: 'ready',
            datasetViews: [{
              id: 'keywords',
              dataset: 'keywords',
              title: '搜索词',
              recordCount: records.length,
              records,
            }],
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /关键词机会/u }));
    const table = screen.getByRole('table', { name: '关键词机会真实数据' });
    expect(within(table).getByText('搜索词-1')).toBeVisible();
    expect(within(table).queryByText('搜索词-101')).not.toBeInTheDocument();
    expect(screen.getByText('1-100 / 共 120 条')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(within(table).queryByText('搜索词-1')).not.toBeInTheDocument();
    expect(within(table).getByText('搜索词-101')).toBeVisible();
    expect(screen.getByText('101-120 / 共 120 条')).toBeVisible();
  });

  it('hides keyword directory rows that have no returned metrics', () => {
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{
          status: 'ready',
          data: {
            status: 'ready',
            datasetViews: [{
              id: 'keywords',
              dataset: 'keywords',
              recordCount: 3,
              records: [
                { id: 'directory-1', title: 'Бытовая техника' },
                { id: 'directory-2', title: 'Детские товары' },
                { id: 'keyword-1', title: 'радиоуправляемая машина', searches: 1200, orders: 32, revenue: 64000 },
              ],
            }],
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /关键词机会/u }));
    const table = screen.getByRole('table', { name: '关键词机会真实数据' });
    expect(within(table).getByText('радиоуправляемая машина')).toBeVisible();
    expect(within(table).queryByText('Бытовая техника')).not.toBeInTheDocument();
    expect(within(table).queryByText('Детские товары')).not.toBeInTheDocument();
    expect(screen.getByText(/已隐藏 2 条只有名称、没有指标的目录行/u)).toBeVisible();
    expect(screen.getByText('1-1 / 共 1 条')).toBeVisible();
  });

  it('uses actionable datasets in a stable order and hides legacy list, price and trend datasets', () => {
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{
          status: 'ready',
          data: {
            status: 'ready',
            datasetViews: [
              { id: 'trends', dataset: 'trends', recordCount: 1, records: [{ id: 'trend-1', date: '2026-07-22', revenue: 1 }] },
              { id: 'price-segments', dataset: 'price-segments', recordCount: 1, records: [{ id: 'price-1', title: '0–500 ₽' }] },
              { id: 'market-products', dataset: 'market-products', recordCount: 1, records: [{ id: 'product-1', title: '旧版商品' }] },
              { id: 'reports', dataset: 'reports', recordCount: 1, records: [{ id: 'report-1', title: '报表' }] },
              { id: 'product-performance', dataset: 'product-performance', recordCount: 1, records: [{ id: 'performance-1', title: '商品表现' }] },
              { id: 'products', dataset: 'products', recordCount: 1, records: [{ id: 'product-detail-1', title: '商品明细' }] },
              { id: 'brands', dataset: 'brands', recordCount: 1, records: [{ id: 'brand-1', title: '品牌' }] },
              { id: 'categories', dataset: 'categories', recordCount: 1, records: [{ id: 'category-1', title: '类目' }] },
              { id: 'comparison', dataset: 'comparison', recordCount: 1, records: [{ id: 'comparison-1', title: '竞品' }] },
              { id: 'keywords', dataset: 'keywords', recordCount: 1, records: [{ id: 'keyword-1', title: '关键词' }] },
              { id: 'missing-items', dataset: 'missing-items', recordCount: 1, records: [{ id: 'missing-1', title: '缺货' }] },
              { id: 'traffic-conversion', dataset: 'traffic-conversion', recordCount: 1, records: [{ id: 'traffic-1', title: '流量' }] },
            ],
          },
        }}
      />,
    );

    expect(screen.getByRole('tab', { name: /关键词机会/u })).toBeVisible();
    expect(screen.getByRole('tab', { name: /商品表现/u })).toBeVisible();
    expect(screen.queryByRole('tab', { name: /市场概览/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /商品明细/u })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /竞品对比/u })).toBeVisible();
    expect(screen.getByRole('tab', { name: /类目机会/u })).toBeVisible();
    expect(screen.getByRole('tab', { name: /品牌机会/u })).toBeVisible();
    expect(screen.getByRole('tab', { name: /缺货机会/u })).toBeVisible();
    expect(screen.getByRole('tab', { name: /流量转化/u })).toBeVisible();
    expect(screen.getByRole('tab', { name: /报表数据/u })).toBeVisible();
    expect(screen.queryByRole('tab', { name: /市场商品/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /价格带/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /市场趋势/u })).not.toBeInTheDocument();
  });

  it('shows category and brand opportunity tabs derived from real missing-item rows', () => {
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{
          status: 'ready',
          data: {
            status: 'ready',
            datasetViews: [{
              id: 'missing-items',
              dataset: 'missing-items',
              recordCount: 2,
              records: [
                { id: '1', title: '运动鞋 A', category: '运动鞋', brand: '品牌 A', sales: 10, averagePrice: 100, revenue: 1_000, growth: 10 },
                { id: '2', title: '运动鞋 B', category: '运动鞋', brand: '品牌 B', sales: 20, averagePrice: 200, revenue: 2_000, growth: 20 },
              ],
            }],
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /类目机会/u }));
    const table = screen.getByRole('table', { name: '类目机会真实数据' });
    expect(within(table).getByText('运动鞋')).toBeVisible();
    expect(within(table).getByText('30')).toBeVisible();
    expect(screen.queryByText('真实汇总')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /品牌机会/u })).toBeVisible();
  });

  it('renders the mapped Ozon product-performance fields and leaves missing row values as dashes', () => {
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{
          status: 'ready',
          data: {
            status: 'ready',
            datasetViews: [{
              id: 'product-performance',
              dataset: 'product-performance',
              recordCount: 2,
              records: [
                {
                  id: 'sku-1',
                  title: '遥控汽车',
                  brand: 'RC Pro',
                  seller: 'Test Seller',
                  article: 'RC-001',
                  category: '遥控玩具',
                  feature: '销售领导者',
                  searchPosition: 8,
                  orderAmount: 24500,
                  dynamics: 12.4,
                  orderedProducts: 17,
                  averagePurchasePrice: 1441.18,
                  averageDailyRevenue: 6200.25,
                  averageDailyUnits: 4.5,
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
                },
                { id: 'sku-2', title: '遥控越野车', brand: 'RC Pro' },
              ],
            }],
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /商品表现/u }));
    const table = screen.getByRole('table', { name: '商品表现真实数据' });
    expect(within(table).getByText('销售表现')).toBeVisible();
    expect(within(table).getByText('广告 / 促销')).toBeVisible();
    expect(within(table).getByText('商品卡 / 搜索')).toBeVisible();
    expect(within(table).getByText('履约 / 包裹')).toBeVisible();
    expect(within(table).getByText('上架 / 跟卖')).toBeVisible();
    expect(within(table).getByTitle('销售领导者')).toBeVisible();
    expect(within(table).getByTitle('金额 ￥24,500')).toBeVisible();
    expect(within(table).getByTitle('广告 4.7%')).toBeVisible();
    expect(within(table).getByTitle('商品卡 1,000 / 加购 8.8%')).toBeVisible();
    expect(within(table).getByTitle('模式 FBO')).toBeVisible();
    expect(within(table).getByTitle('尺寸 100 × 200 × 300 mm')).toBeVisible();
    expect(within(table).getByTitle('跟卖 2')).toBeVisible();
    const secondRow = within(table).getByText('遥控越野车').closest('tr');
    expect(within(secondRow).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows weighted-average caliber and exposes Ozon zero-amount conflicts without inventing money', () => {
    render(
      <DataAnalysisMarketPanel
        sources={[]}
        marketState={{
          status: 'ready',
          data: {
            status: 'ready',
            datasetViews: [{
              id: 'product-performance',
              dataset: 'product-performance',
              recordCount: 1,
              metrics: [
                { label: '商品', value: 1, unit: '个' },
                {
                  label: '订购金额',
                  value: 0,
                  kind: 'money',
                  status: 'partial',
                  detail: '1 条记录由 Ozon 返回零金额，保留原值且未自行推算',
                },
                {
                  label: '成交加权均价',
                  value: 100,
                  kind: 'money',
                  status: 'confirmed',
                  aggregation: 'weighted-average',
                  detail: '按 1 件已返回销量加权',
                },
              ],
              records: [{
                id: 'sku-zero',
                title: 'Ozon 零金额样本',
                currency: 'CNY',
                orderedProducts: 1,
                orderAmount: 0,
                averagePurchasePrice: 100,
              }],
            }],
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /商品表现/u }));
    expect(screen.getByText('1 条记录由 Ozon 返回零金额，保留原值且未自行推算')).toBeVisible();
    expect(screen.getByText('按 1 件已返回销量加权')).toBeVisible();
    const table = screen.getByRole('table', { name: '商品表现真实数据' });
    expect(within(table).getByTitle('金额 ￥0 · Ozon原值')).toBeVisible();
  });
});
