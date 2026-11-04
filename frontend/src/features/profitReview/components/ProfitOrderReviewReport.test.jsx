import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProfitOrderReviewReport } from './ProfitOrderReviewReport.jsx';

function resultFixture() {
  return {
    status: 'ready',
    statusLabel: '订单利润与投入评估完成',
    analysis: {
      order: { orderNumber: '0123640791-0163-1' },
      product: { title: '遥控汽车' },
      profit: {
        mode: 'actual',
        modeLabel: '实际利润',
        revenue: 16,
        profit: 3.7873841617523145,
        margin: 23.67,
        formula: 'actualIncome-source-commission-penalty-acquiring-delivery-logistics-bus',
        complete: true,
        expenses: [
          { key: 'cost', label: '采购成本', value: 2.9 },
          { key: 'logistics', label: '实际物流费', value: 4.650031700813799 },
        ],
        biggestDrag: { label: '实际物流费', value: 4.650031700813799 },
      },
      ownProduct: {
        orderCount: 22,
        readyProfitCount: 22,
        lossOrderCount: 1,
        averageProfit: 4.68,
        margin: 33.88,
        totalProfit: 103,
      },
      market: {
        status: 'ready',
        statisticStartDate: '2026-07-01',
        statisticEndDate: '2026-07-30',
        metrics: { sales30d: 1, revenue30d: 3000, averageDailyUnits: 0.03, rating: 4.7 },
      },
      decision: { label: '减少投入并继续观察', reasons: ['当前订单利润偏低。'] },
      actions: ['优先核查物流费。'],
      dataGaps: [],
    },
    ai: {
      status: 'ready',
      model: 'gpt-5.6-sol',
      report: {
        executiveSummary: '实际利润 3.7873841617523145，先控制补货。',
        profitDiagnosis: [{ title: '实际物流费偏高', evidence: '物流费 4.650031700813799。' }],
        marketAssessment: '近30天销量有限。',
        optimizationActions: [{ title: '复核物流费用' }],
        dataGaps: [],
      },
    },
  };
}

describe('ProfitOrderReviewReport', () => {
  it('renders one continuous report, rounds long decimals and hides raw formula tokens', () => {
    const { container } = render(<ProfitOrderReviewReport result={resultFixture()} />);
    expect(screen.getByRole('heading', { name: '减少投入并继续观察' })).toBeVisible();
    expect(screen.getByText(/实际利润 3\.79/u)).toBeVisible();
    expect(screen.getByText('¥3.79')).toBeVisible();
    expect(screen.getByText(/实际收入－采购成本－佣金/u)).toBeVisible();
    expect(container).not.toHaveTextContent('3.7873841617523145');
    expect(container).not.toHaveTextContent('actualIncome-source');
    expect(container.querySelectorAll('.profit-order-review-report')).toHaveLength(1);
    expect(container.querySelector('.profit-order-review-report')).toHaveClass('is-paragraph-indented');
  });

  it('applies the editable report presentation switches', () => {
    const { container } = render(
      <ProfitOrderReviewReport
        result={resultFixture()}
        presentation={{
          assistantName: '自定义助手',
          paragraphIndent: false,
          showAssistantBrand: false,
          showMarketSignal: false,
          showModel: false,
          showMetricNotes: false,
          showSectionIcons: false,
        }}
      />
    );
    expect(container.querySelector('.profit-order-review-report')).not.toHaveClass('is-paragraph-indented');
    expect(container.querySelector('.profit-order-review-report-brand')).not.toBeInTheDocument();
    expect(container.querySelector('.profit-order-review-market-signal')).not.toBeInTheDocument();
    expect(screen.queryByText('Chat-GPT-5.6-Sol')).not.toBeInTheDocument();
  });
});
