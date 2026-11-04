import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PromptLibraryExternalInsightReport } from './PromptLibraryExternalInsightReport.jsx';

describe('PromptLibraryExternalInsightReport', () => {
  it('renders a GPT-style reading report and hides internal data gaps', () => {
    const { container } = render(
      <PromptLibraryExternalInsightReport insight={{
        status: 'ready',
        model: 'gpt-5.6-sol',
        generatedAt: '2026-07-31T10:00:00.000Z',
        report: {
          title: '市场热词分析',
          executiveSummary: '需求增长，但竞争也在提高。',
          marketAssessment: '先小批验证，不直接放量。',
          keyFindings: [{ title: '搜索量增长', evidence: '近 30 天增长 22%', action: '复核转化' }],
          opportunities: [{ priority: '高', title: '长尾词机会', evidence: '竞争商品较少', action: '小预算测试' }],
          risks: [],
          actionPlan: [{ priority: '1', title: '建立测试组', evidence: '有增长信号', action: '运行 7 天' }],
          dataGaps: ['佣金和采购成本'],
        },
      }} />
    );

    expect(screen.getByRole('heading', { level: 1, name: '市场热词分析' })).toBeInTheDocument();
    expect(screen.getByText('市场判断')).toBeInTheDocument();
    expect(screen.getAllByText('数据依据：')).toHaveLength(3);
    expect(screen.getAllByText('建议动作：')).toHaveLength(3);
    expect(screen.queryByText('还需要的数据')).not.toBeInTheDocument();
    expect(screen.queryByText('佣金和采购成本')).not.toBeInTheDocument();
    expect(container.querySelector('.MuiChip-root')).toBeNull();
    expect(container.querySelector('.prompt-library-external-insight-index')).toBeNull();
    expect(container.querySelectorAll('.prompt-library-external-insight-section')).toHaveLength(4);
  });

  it('keeps raw model jargon out of the visible report as a final UI safeguard', () => {
    render(<PromptLibraryExternalInsightReport insight={{
      status: 'ready',
      report: {
        title: 'returnCancelRate 报告',
        executiveSummary: '接口未返回 averageReturnCancelRate，当前为 null。',
        keyFindings: [{ title: '字段缺失', evidence: 'productCardViews 为 null', action: '补齐数据' }],
      },
    }} />);
    expect(document.body).toHaveTextContent('退货取消率');
    expect(document.body).toHaveTextContent('平均退货取消率');
    expect(document.body).toHaveTextContent('商品卡浏览量');
    expect(document.body).not.toHaveTextContent(/returnCancelRate|averageReturnCancelRate|null|接口未返回|字段缺失/u);
  });

  it('uses the editable Skill presentation instead of hard-coding the report layout', () => {
    const { container } = render(<PromptLibraryExternalInsightReport
      insight={{
        status: 'ready',
        model: 'gpt-5.5',
        generatedAt: '2026-07-31T10:00:00.000Z',
        report: {
          title: '自定义报告',
          executiveSummary: '先处理库存。',
          marketAssessment: '保持观察。',
          keyFindings: [{ title: '库存偏低' }],
          actionPlan: [{ title: '准备补货' }],
        },
      }}
      presentation={{
        eyebrow: '我的经营助手',
        logo: 'none',
        accent: 'green',
        showSectionIcons: false,
        showModel: false,
        showGeneratedAt: false,
        sections: [
          { id: 'actionPlan', title: '现在就做', icon: 'action', visible: true },
          { id: 'marketAssessment', title: '我的判断', icon: 'assessment', visible: false },
          { id: 'keyFindings', title: '我看到的问题', icon: 'finding', visible: true },
        ],
      }}
    />);

    expect(screen.getByText('我的经营助手')).toBeInTheDocument();
    expect(screen.getByText('现在就做')).toBeInTheDocument();
    expect(screen.getByText('我看到的问题')).toBeInTheDocument();
    expect(screen.queryByText('我的判断')).not.toBeInTheDocument();
    expect(screen.queryByText(/模型 gpt-5.5/u)).not.toBeInTheDocument();
    expect(container.querySelector('.prompt-library-external-insight-logo')).toBeNull();
    expect(container.querySelector('.prompt-library-external-insight-section-icon')).toBeNull();
    expect(container.querySelector('.prompt-library-external-insight-report')).toHaveAttribute('data-accent', 'green');
  });

  it('renders the operational report as a neutral brief with emoji navigation', () => {
    const { container } = render(<PromptLibraryExternalInsightReport
      insight={{
        status: 'ready',
        report: {
          title: '店铺经营分析报告',
          executiveSummary: '先处理转化率，再检查异常扣费。',
          marketAssessment: '当前流量充足，但成交效率偏低。',
          keyFindings: [{ title: '转化率偏低' }],
          opportunities: [{ title: '优化高访问商品' }],
          risks: [{ title: '平台扣费异常' }],
          actionPlan: [{ title: '核对账单' }],
        },
      }}
      visualStyle="operations-brief"
      presentation={{
        eyebrow: '经营数据简报',
        logo: 'chart',
        showSectionIcons: true,
      }}
    />);

    expect(container.querySelector('.prompt-library-external-insight-report'))
      .toHaveAttribute('data-visual-style', 'operations-brief');
    expect(screen.getByText('📋')).toBeInTheDocument();
    expect(screen.getByText('🎯 核心结论')).toBeInTheDocument();
    expect(screen.getByText('🧭')).toBeInTheDocument();
    expect(screen.getByText('🔎')).toBeInTheDocument();
    expect(screen.getByText('🌱')).toBeInTheDocument();
    expect(screen.getByText('⚠️')).toBeInTheDocument();
    expect(screen.getByText('✅')).toBeInTheDocument();
    expect(container.querySelector('.prompt-library-external-insight-logo')).toBeNull();
    expect(container.querySelector('.prompt-library-external-insight-section-icon')).toBeNull();
  });
});
