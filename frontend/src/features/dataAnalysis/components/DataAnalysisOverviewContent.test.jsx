import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataAnalysisOverviewContent } from './DataAnalysisOverviewContent.jsx';
import { DataAnalysisOverviewProductRanking } from './DataAnalysisOverviewCommercePanels.jsx';

function metric(id, label, value, unit = 'count', status = 'confirmed') {
  return {
    id,
    label,
    value,
    unit,
    currency: unit === 'money' ? 'CNY' : '',
    status,
    source: { label: '真实测试来源' },
    delta: null,
    breakdown: [],
  };
}

describe('DataAnalysisOverviewContent', () => {
  it('keeps the overview summary-first and removes technical ledger cards from the main canvas', () => {
    const dashboard = {
      overview: {
        metrics: [
          metric('trafficSessionCount', '访问次数', 15804),
          metric('trafficOrderCount', '下单订单', 28),
          metric('trafficOrderConversionRate', '下单转化率', 0.18, 'percent'),
          metric('salesAmount', '订单销售额', 1417.93, 'money'),
          metric('outOfStockCount', '在售缺货', 27),
        ],
        trend: [],
      },
      finance: {
        metrics: [metric('financeNetAmount', '平台流水净额', 1682.61, 'money')],
      },
      sales: { productRanking: [], statusBreakdown: [] },
      traffic: { funnel: [] },
      diagnostics: [],
    };

    render(<DataAnalysisOverviewContent dashboard={dashboard} onOpenModule={() => {}} />);

    const kpiRegion = screen.getByRole('region', { name: '核心经营指标' });
    const cards = within(kpiRegion).getAllByTestId('overview-kpi-card');
    expect(cards).toHaveLength(6);
    expect(cards.map((card) => card.getAttribute('data-metric-id'))).toEqual([
      'trafficSessionCount',
      'trafficOrderCount',
      'trafficOrderConversionRate',
      'salesAmount',
      'financeNetAmount',
      'outOfStockCount',
    ]);
    expect(within(kpiRegion).getByText('15,804')).toBeInTheDocument();
    expect(screen.getByText('销售与订单趋势')).toBeInTheDocument();
    expect(screen.getByText('流量转化漏斗')).toBeInTheDocument();
    expect(screen.getByText('经营提醒')).toBeInTheDocument();
    expect(screen.getByText('店铺数据覆盖')).toBeInTheDocument();
    expect(screen.getByText('热销商品')).toBeInTheDocument();
    expect(screen.queryByText('订单状态结构')).not.toBeInTheDocument();
    expect(screen.queryByText('数据源台账')).not.toBeInTheDocument();
    expect(screen.queryByText(/SQLite已就绪/)).not.toBeInTheDocument();
    expect(screen.queryByText(/个端点/)).not.toBeInTheDocument();
    expect(screen.queryByText('数据规则')).not.toBeInTheDocument();
  });

  it('keeps long product names inside the fixed stats column', () => {
    render(
      <DataAnalysisOverviewProductRanking
        rows={[{
          key: 'long-product',
          name: 'Сайлентблок амортизатора мотоцикла Иж (4шт) d100 мм длинное名称',
          offerId: 'mz-26050813-905658',
          quantity: 19,
          sales: { breakdown: [{ currency: 'CNY', value: 304 }] },
        }]}
      />,
    );

    expect(document.querySelector('.data-analysis-overview-product-main')).toHaveClass('data-analysis-overview-product-main');
    expect(document.querySelector('.data-analysis-overview-product-stats')).toHaveClass('data-analysis-overview-product-stats');
    expect(screen.getByText('19 件')).toBeInTheDocument();
  });
});
