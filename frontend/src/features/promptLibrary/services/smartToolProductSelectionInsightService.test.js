import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestLocalApi: vi.fn() }));

vi.mock('../../../api/localApiClient.js', () => ({
  requestLocalApi: mocks.requestLocalApi,
}));

import {
  compactProductSelectionForModel,
  createProductSelectionInsightRequest,
  runProductSelectionInsight,
} from './smartToolProductSelectionInsightService.js';

const modelSelection = {
  id: 'model-account::gpt-5.6-sol',
  accountId: 'model-account',
  model: 'gpt-5.6-sol',
  ready: true,
};

const tool = {
  id: 'ozon-product-selection',
  title: 'Ozon 选品助手',
  skillProfile: { workflowSteps: ['读取真实 Ozon 数据', '执行固定七维评分', '给出测试顺序'] },
  promptConfig: {
    systemPrompt: '自定义选品 Skill 系统提示词',
    userPrompt: '分析商品：\n{{input}}',
    outputFormat: '输出结论、证据、风险和测试动作。',
    outputRules: ['固定评分不得修改', '缺失数据不得写成 0'],
    safetyRules: ['只读分析'],
  },
};

function createSelection() {
  return {
    query: '遥控汽车',
    productAnalysis: {
      recordCount: 18,
      priceStats: { count: 18, median: 1999, average: 2188 },
      salesStats: { count: 12, total: 6300, median: 290 },
      decision: {
        opportunity: {
          score: 72,
          label: '可小批测试',
          recommendation: '先做 20 件以内测试。',
          evidenceCoveragePercent: 71,
          availableDimensionCount: 5,
          totalDimensionCount: 7,
          confidenceLabel: '中等',
          breakdown: [
            { label: '需求增长', score: 80, weight: 20, detail: '样本增长中位数为 13%' },
            { label: '竞争强度', score: 58, weight: 18, detail: '头部集中度一般' },
          ],
          missingDimensions: [{ label: '履约质量' }],
        },
      },
      records: [{ id: 'sku-1', title: '高速遥控汽车', price: 1999, sales: 520 }],
    },
    seerfar: {
      requested: false,
      status: 'skipped',
      statusLabel: '未使用，不消耗积分',
      records: [],
    },
    sourceProduct: null,
    dataGaps: ['缺少完整物流成本', '未提供 1688 候选货源'],
  };
}

describe('smartToolProductSelectionInsightService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestLocalApi.mockResolvedValue({
      reportText: JSON.stringify({
        title: '遥控汽车选品报告',
        executiveSummary: '程序固定评分 72 分，适合小批测试。',
        marketAssessment: '需求存在，但成本仍需补齐。',
        keyFindings: [{ title: '需求增长', evidence: '固定维度得分 80', action: '验证关键词转化' }],
        opportunities: [],
        risks: [{ priority: '高', title: '成本缺口', evidence: '没有物流成本', action: '补齐货源和物流报价' }],
        actionPlan: [{ priority: '高', title: '小批测试', evidence: '固定评分 72', action: '首批不超过 20 件' }],
        dataGaps: ['物流成本'],
      }),
      model: 'gpt-5.6-sol',
      accountId: 'model-account',
    });
  });

  it('只压缩真实选品事实，并保留程序固定评分和缺失项', () => {
    const compact = compactProductSelectionForModel(createSelection());
    const serialized = JSON.stringify(compact);

    expect(serialized).toContain('"机会分":72');
    expect(serialized).toContain('履约质量');
    expect(serialized).toContain('未使用，不消耗积分');
    expect(serialized).not.toContain('"物流成本":0');
  });

  it('实际使用可编辑 Skill 提示词和当前选择的模型', () => {
    const request = createProductSelectionInsightRequest(tool, createSelection(), modelSelection);
    const customRules = JSON.parse(request.customRules);

    expect(request).toMatchObject({
      accountId: 'model-account',
      model: 'gpt-5.6-sol',
      templateId: 'product-selection.v1',
    });
    expect(customRules.userRules).toContain('自定义选品 Skill 系统提示词');
    expect(customRules.outputRules).toContain('固定评分不得修改');
    expect(customRules.workflowSteps).toContain('执行固定七维评分');
    expect(request.templateInput.query).toBe('遥控汽车');
    expect(JSON.stringify(request.templateInput.facts)).toContain('程序固定结论');
  });

  it('调用文本中转站并解析选品报告', async () => {
    const insight = await runProductSelectionInsight(tool, createSelection(), modelSelection);

    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/integrations/analyze',
      expect.objectContaining({
        method: 'POST',
        timeoutMs: 300000,
        body: expect.objectContaining({ accountId: 'model-account', model: 'gpt-5.6-sol' }),
      })
    );
    expect(insight).toMatchObject({
      status: 'ready',
      model: 'gpt-5.6-sol',
      report: { title: '遥控汽车选品报告' },
    });
  });
});
