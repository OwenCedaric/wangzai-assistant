import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataAnalysisInsightDialog } from './DataAnalysisInsightDialog.jsx';

describe('DataAnalysisInsightDialog', () => {
  it('renders the generated insight as a structured operating report', () => {
    const onAnalyze = vi.fn();
    render(
      <DataAnalysisInsightDialog
        open
        onClose={vi.fn()}
        dashboard={{
          generatedAt: '2026-07-21T10:00:00.000Z',
          overview: {
            metrics: [
              { id: 'salesAmount', label: '订单销售额', value: 1417.93, unit: 'money', currency: 'CNY', status: 'confirmed' },
              { id: 'trafficOrderConversionRate', label: '下单转化率', value: 0.18, unit: 'percent', status: 'confirmed' },
            ],
          },
        }}
        filters={{ shopId: 'shop-1', startDate: '2026-07-01', endDate: '2026-07-21' }}
        state={{
          status: 'success',
          insight: '**一、总体结论**\n店铺销量下降，需要优先检查库存。\n## 二、行动建议\n先补齐缺货商品。',
          model: 'gpt-5.6-sol',
          meta: {},
        }}
        modelOptions={[{ id: 'model-1', model: 'gpt-5.6-sol', label: '配置 1', statusLabel: '已配置', ready: true }]}
        selectedModelId="model-1"
        modelSelection={{ ready: true }}
        onModelChange={vi.fn()}
        onAnalyze={onAnalyze}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('.data-analysis-report-sheet')).toHaveAttribute(
      'data-freeze-version',
      'data-analysis-insight-v2-server-template-20260828',
    );
    expect(within(dialog).getByText('店铺经营分析报告')).toBeInTheDocument();
    expect(within(dialog).getByText('经营结论与行动报告')).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: '报告核心经营指标' })).toBeInTheDocument();
    expect(within(dialog).getByText('￥1,417.93')).toBeInTheDocument();
    expect(within(dialog).getByRole('navigation', { name: '报告目录' })).toBeInTheDocument();
    expect(within(dialog).getByText('总体结论')).toBeInTheDocument();
    expect(within(dialog).getByText('行动建议')).toBeInTheDocument();
    expect(within(dialog).getByText('📌')).toBeInTheDocument();
    expect(within(dialog).queryByText('销售与订单趋势')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('库存风险分布')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '最小化店铺经营分析报告' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: '关闭店铺经营分析报告' })).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: '重新分析' })).toBeInTheDocument();
    expect(dialog.querySelector('.data-analysis-insight-dialog-actions')).toBeInTheDocument();

    fireEvent.click(within(dialog).getAllByRole('button', { name: '调整本节' })[0]);
    fireEvent.change(within(dialog).getByLabelText('补充本节分析要求'), {
      target: { value: '重点看缺货商品原因' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '按此要求重新分析' }));
    expect(onAnalyze).toHaveBeenCalledWith(expect.objectContaining({ userPromptOverride: expect.stringContaining('重点看缺货商品原因') }));
  });

  it('shows a readable retry message when the local request reaches its timeout', () => {
    render(
      <DataAnalysisInsightDialog
        open
        onClose={vi.fn()}
        dashboard={{}}
        state={{ status: 'error', error: new Error('local-api 请求超时：300000ms') }}
        modelOptions={[]}
        modelSelection={{ ready: true }}
        onModelChange={vi.fn()}
        onAnalyze={vi.fn()}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('分析响应时间较长，本次数据已经保留，请点击“重新分析”。'))
      .toBeInTheDocument();
    expect(within(dialog).queryByText(/local-api|300000ms/u)).not.toBeInTheDocument();
  });
});
