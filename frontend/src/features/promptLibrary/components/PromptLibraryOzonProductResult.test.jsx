import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { analyzeOzonProductRecords } from '../lib/smartToolOzonProductAnalysis.js';
import { PromptLibraryOzonProductResult } from './PromptLibraryOzonProductResult.jsx';

function buildResult(count = 45) {
  const records = Array.from({ length: count }, (_, index) => ({
    id: `sku-${index + 1}`,
    title: `商品 ${index + 1}`,
    brand: `品牌 ${index % 4}`,
    seller: `卖家 ${index % 3}`,
    price: 1000 + index,
    cardPrice: 900 + index,
    sales: index + 1,
    revenue: (index + 1) * 1000,
    growth: index,
    stock: 100 - index,
    rating: 4.5,
    reviews: index * 2,
    adSpendShare: 4.7,
    promoDays: 8,
    promoDiscount: 12.5,
    promoRevenueShare: 27.1,
    paidPromotionDays: 4,
    productCardViews: 1000 + index,
    productCardToCartRate: 8.8,
    searchCatalogViews: 4500 + index,
    searchCatalogToCartRate: 3.2,
    impressionToOrderRate: 2.1,
    clickThroughRate: 7.4,
    fulfillmentModel: 'FBO',
    redemptionRate: 96,
    returnCancelRate: 4,
    packageDimensions: '100 × 200 × 300 mm',
    packageWeight: '850 g',
    listedAt: '2026-06-01T00:00:00.000Z',
    listingDays: 59,
    followSellerCount: 2,
    followMinPrice: 1200,
    followMaxPrice: 1500,
    rfbsRate: '12.5%',
    fbpRate: '87.5%',
  }));
  return {
    status: 'browser_data_ready',
    productAnalysis: analyzeOzonProductRecords(records, {
      query: 'платье',
      capturedAt: '2026-07-29T06:00:00.000Z',
    }),
  };
}

describe('PromptLibraryOzonProductResult', () => {
  it('renders structured analysis and paginates product rows twenty at a time', () => {
    const { container } = render(<PromptLibraryOzonProductResult result={buildResult()} />);

    expect(screen.getByText('商品市场分析')).toBeInTheDocument();
    expect(screen.queryByText(/真实数据/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/跟卖字段/u)).not.toBeInTheDocument();
    expect(screen.queryByText('仅分析真实返回字段')).not.toBeInTheDocument();
    expect(screen.getByText('有跟卖的商品')).toBeInTheDocument();
    expect(screen.getByText('市场情况')).toBeInTheDocument();
    expect(screen.getByText('商品价格分布')).toBeInTheDocument();
    expect(screen.getByText('选品决策')).toBeInTheDocument();
    expect(screen.getByText('选品参考分')).toBeInTheDocument();
    expect(screen.getByText('值得关注')).toBeInTheDocument();
    expect(screen.getByText('需要注意')).toBeInTheDocument();
    expect(screen.getByText('接下来怎么做')).toBeInTheDocument();
    expect(screen.queryByText(/当前评分不包含利润/u)).not.toBeInTheDocument();
    expect(screen.getByText('商品明细')).toBeInTheDocument();
    expect(screen.queryByText('字段完整度')).not.toBeInTheDocument();
    expect(screen.getAllByText('广告与促销').length).toBeGreaterThan(0);
    expect(screen.getAllByText('浏览与下单').length).toBeGreaterThan(0);
    expect(screen.getAllByText('退货与包裹').length).toBeGreaterThan(0);
    expect(screen.getAllByText('上架与跟卖').length).toBeGreaterThan(0);
    expect(container.querySelector('.prompt-library-ozon-summary-grid')?.children).toHaveLength(7);
    expect(container.querySelectorAll('.prompt-library-ozon-decision-dimension')).toHaveLength(7);
    expect(container.querySelectorAll('.prompt-library-ozon-product-row')).toHaveLength(20);
    expect(container.querySelectorAll('.prompt-library-ozon-expanded-row')).toHaveLength(20);
    const firstProductRow = container.querySelector('.prompt-library-ozon-product-row');
    expect(within(firstProductRow).getByText('当前售价')).toBeInTheDocument();
    expect(within(firstProductRow).getByText('销量')).toBeInTheDocument();
    expect(within(firstProductRow).getByText('销售额')).toBeInTheDocument();
    expect(within(firstProductRow).getByText('可售库存')).toBeInTheDocument();
    expect(within(firstProductRow).getByText('跟卖数量')).toBeInTheDocument();
    const firstExpandedRow = container.querySelector('.prompt-library-ozon-expanded-row');
    expect(within(firstExpandedRow).getByText('广告占比')).toBeInTheDocument();
    expect(within(firstExpandedRow).getByText('商品卡浏览量')).toBeInTheDocument();
    expect(within(firstExpandedRow).getByText('发货模式')).toBeInTheDocument();
    expect(within(firstExpandedRow).getByText('跟卖最低价')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go to page 2' }));
    expect(container.querySelectorAll('.prompt-library-ozon-product-row')).toHaveLength(20);
    expect(container.querySelectorAll('.prompt-library-ozon-expanded-row')).toHaveLength(20);
    expect(within(container.querySelector('.prompt-library-ozon-table-wrap tbody')).getByText('SKU sku-21')).toBeInTheDocument();
  }, 15000);

  it('sorts numeric columns without turning missing values into zero', () => {
    const result = buildResult(3);
    result.productAnalysis.records[0].revenue = null;
    const { container } = render(<PromptLibraryOzonProductResult result={result} />);

    fireEvent.click(screen.getByRole('button', { name: /销售额/ }));
    const rows = container.querySelectorAll('.prompt-library-ozon-product-row');
    expect(rows[0]).toHaveTextContent('SKU sku-2');
    expect(rows[2]).toHaveTextContent('SKU sku-1');
  });

  it('shows the Card price in the currency actually returned by Ozon', () => {
    const result = buildResult(1);
    result.productAnalysis.records[0].cardPrice = 2022.35;
    result.productAnalysis.records[0].cardPriceCurrency = 'CNY';
    const { container } = render(<PromptLibraryOzonProductResult result={result} />);

    const row = container.querySelector('.prompt-library-ozon-product-row');
    expect(within(row).getByText('¥2,022.35')).toBeInTheDocument();
  });

  it('opens a clickable product title through the caller-provided shared workbench action', () => {
    const onOpenProduct = vi.fn();
    render(<PromptLibraryOzonProductResult result={buildResult(3)} onOpenProduct={onOpenProduct} />);

    fireEvent.click(screen.getByRole('button', { name: '打开商品操作台：商品 3' }));
    expect(onOpenProduct).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sku-3',
      title: '商品 3',
      price: 1002,
      sales: 3,
      revenue: 3000,
      stock: 98,
    }));
  });

  it('shows the parsed source product and fee comparison above the market result', () => {
    const result = buildResult(3);
    result.targetProduct = {
      platform: '1688',
      productTitle: '采购端测试连衣裙',
      sourceProductId: 'offer-123',
      capturedPrice: 26.8,
      currency: 'CNY',
      priceKind: '采购参考价',
      suggestedSalePriceRub: 2400,
      dimensions: '30 × 20 × 8 cm',
      weightKg: 0.45,
      estimatedCommissionRub: 384,
      commissionPercent: 16,
      estimatedPlatformFeesRub: 447,
      logisticsEstimateStatus: '已取得计费尺寸，等待匹配物流线路价格',
    };
    const { container } = render(<PromptLibraryOzonProductResult result={result} />);
    const card = container.querySelector('.prompt-library-ozon-target-product');
    expect(card).toBeTruthy();
    expect(within(card).getByText('目标商品')).toBeInTheDocument();
    expect(within(card).getByText('采购端测试连衣裙')).toBeInTheDocument();
    expect(within(card).getByText('采购参考价')).toBeInTheDocument();
    expect(within(card).getByText('预估佣金')).toBeInTheDocument();
    expect(within(card).getByText('30 × 20 × 8 cm')).toBeInTheDocument();
  });

  it('shows the parsed source product even when no market rows were returned', () => {
    const result = {
      status: 'browser_data_empty',
      summary: 'Ozon 没有返回匹配市场数据。',
      productLinkStatus: { status: 'ready', message: '商品资料已解析。' },
      targetProduct: {
        platform: 'Ozon',
        productTitle: '目标测试商品',
        sourceProductId: '3876911440',
        capturedPrice: 1999,
        currency: 'RUB',
        priceKind: '销售价',
        suggestedSalePriceRub: 1999,
        dimensions: '25 × 15 × 8 cm',
        weightKg: 0.6,
        logisticsEstimateStatus: '已取得计费尺寸，等待匹配物流线路价格',
      },
    };

    const { container } = render(<PromptLibraryOzonProductResult result={result} />);
    expect(screen.getByText('商品链接分析')).toBeInTheDocument();
    expect(screen.getByText('目标测试商品')).toBeInTheDocument();
    expect(screen.getByText('商品 ID 3876911440 · 已取得计费尺寸，等待匹配物流线路价格')).toBeInTheDocument();
    expect(container.querySelector('.prompt-library-ozon-result.is-target-only')).toBeTruthy();
    expect(screen.getByText(/暂时没有找到可对比的 Ozon 市场商品/)).toBeInTheDocument();
  });

  it.each(['遥控汽车', '连衣裙', '运动鞋', '手机壳', 'кофемашина'])(
    'renders the expanded product table for keyword %s',
    (query) => {
      const result = buildResult(3);
      result.productAnalysis.query = query;
      const { container } = render(<PromptLibraryOzonProductResult result={result} />);

      expect(container.querySelector('.prompt-library-ozon-result-head')).toHaveTextContent(`查询：${query}`);
      expect(screen.getByRole('table', { name: 'Ozon 商品市场结果' })).toBeInTheDocument();
      expect(screen.getAllByText('广告与促销').length).toBeGreaterThan(0);
      expect(screen.getAllByText('退货与包裹').length).toBeGreaterThan(0);
      expect(container.querySelectorAll('.prompt-library-ozon-product-row')).toHaveLength(3);
      expect(container.querySelectorAll('.prompt-library-ozon-expanded-row')).toHaveLength(3);
    },
  );
});
