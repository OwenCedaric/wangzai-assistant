import { describe, expect, it, vi } from 'vitest';
import {
  createOperationalReportInsightRequest,
  runSmartToolOperationalReportInsight,
} from './smartToolOperationalReportInsightService.js';

const tool = {
  id: 'ozon-skill-1688-channel-shopdata-get',
  title: 'Ozon 报表读取与分析',
  skillProfile: {
    workflowSteps: ['读取报表', '交叉分析销售、库存和费用'],
    safetyNotes: ['只使用真实数据', '缺失不补造'],
  },
  promptConfig: {
    systemPrompt: '你是店铺经营分析师。',
    outputFormat: '输出总体结论、风险和行动建议。',
    outputRules: ['引用具体数字'],
  },
};

const modelSelection = {
  ready: true,
  accountId: 'model-account',
  model: 'gpt-5.6-sol',
};

describe('smartToolOperationalReportInsightService', () => {
  it('把可编辑 Skill 规则和真实报表明细组装成直接分析请求', () => {
    const request = createOperationalReportInsightRequest(
      tool,
      {
        shopName: '测试店',
        range: { startDate: '2026-07-05', endDate: '2026-08-03' },
        reportTypeLabel: '全部经营数据',
        sections: [
          { title: '经营概览', rows: ['有效订单金额：￥1,200.00'] },
          { title: '费用构成', rows: ['配送与物流服务费｜发生 20笔｜合计 ￥-300.00'] },
        ],
      },
      modelSelection
    );
    const customRules = JSON.parse(request.customRules);

    expect(request).toMatchObject({
      accountId: 'model-account',
      model: 'gpt-5.6-sol',
      templateId: 'operational-report.v1',
    });
    expect(customRules.workflowSteps).toContain('交叉分析销售、库存和费用');
    expect(customRules.safetyNotes).toContain('缺失不补造');
    expect(customRules.outputRules).toContain('引用具体数字');
    expect(JSON.stringify(request.templateInput.sections)).toContain('有效订单金额：￥1,200.00');
    expect(JSON.stringify(request.templateInput.sections)).toContain('配送与物流服务费');
  });

  it('调用统一模型中转并返回可直接展示的经营分析报告', async () => {
    const requester = vi.fn().mockResolvedValue({
      model: 'gpt-5.6-sol',
      accountId: 'model-account',
      usage: { total_tokens: 900 },
      reportText: JSON.stringify({
        title: '店铺经营分析报告',
        executiveSummary: '费用压力高于当前销售贡献。',
        marketAssessment: '销售额为 1200 元，物流费为 300 元。',
        keyFindings: [{ priority: '1', title: '物流费偏高', evidence: '物流费 300 元', action: '核对高额订单' }],
        opportunities: [],
        risks: [],
        actionPlan: [{ priority: '今天', title: '核对费用流水', evidence: '费用占比较高', action: '查看前十笔扣费' }],
        dataGaps: [],
      }),
    });

    const result = await runSmartToolOperationalReportInsight(
      tool,
      {
        shopName: '测试店',
        range: { startDate: '2026-07-05', endDate: '2026-08-03' },
        sections: [{ title: '经营概览', rows: ['销售额：￥1,200.00'] }],
      },
      modelSelection,
      { requester }
    );

    expect(requester).toHaveBeenCalledWith(
      '/api/integrations/analyze',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ accountId: 'model-account', model: 'gpt-5.6-sol' }),
      })
    );
    expect(result).toMatchObject({
      status: 'ready',
      model: 'gpt-5.6-sol',
      report: {
        title: '店铺经营分析报告',
        executiveSummary: '费用压力高于当前销售贡献。',
      },
      usage: { total_tokens: 900 },
    });
  });

  it('没有可用文本模型时不伪造分析结果', () => {
    expect(() =>
      createOperationalReportInsightRequest(
        tool,
        {
          sections: [{ title: '经营概览', rows: ['订单：10'] }],
        },
        { ready: false }
      )
    ).toThrow('没有可用的分析模型');
  });
});
