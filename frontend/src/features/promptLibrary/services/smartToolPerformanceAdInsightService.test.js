import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestLocalApi: vi.fn() }));

vi.mock('../../../api/localApiClient.js', () => ({
  requestLocalApi: mocks.requestLocalApi,
}));

import {
  compactPerformanceAdAnalysisForModel,
  createPerformanceAdInsightRequest,
  runPerformanceAdInsight,
} from './smartToolPerformanceAdInsightService.js';

const modelSelection = {
  id: 'model-option',
  accountId: 'model-account',
  model: 'gpt-5.6-sol',
  ready: true,
};

function createAnalysis() {
  return {
    account: { id: 'performance-account', title: '主推广账号' },
    scopeText: '2026-07-25 至 2026-07-31',
    campaignQuery: '33870329',
    campaignCount: 1,
    totalCampaignCount: 13,
    metrics: {
      impressions: null,
      clicks: null,
      spent: null,
      orders: null,
      revenue: null,
      ctr: null,
      cpc: null,
      cvr: null,
      cpo: null,
      acos: null,
      roas: null,
    },
    trend: { available: false, label: '趋势数据不足', detail: '有效日统计少于 2 天。' },
    campaignDiagnostics: [
      {
        id: '33870329',
        title: '奔驰碎钻 中控部位',
        statusLabel: '运行中',
        typeLabel: '商品推广',
        metrics: { impressions: null, clicks: null, spent: null, orders: null, revenue: null },
        signals: [
          {
            severity: 'info',
            title: '统计数据暂时不足',
            detail: '展示、点击和花费没有返回。',
            action: '暂不调整预算和出价。',
          },
        ],
        source: { products: [] },
      },
    ],
    missingFields: ['展示量', '点击量', '广告花费'],
    readIssueSummary: ['1 项统计数据暂未返回，相关指标会显示为“暂无数据”，不会按 0 计算。'],
    readIssues: [{ endpoint: '/api/client/private', message: 'campaign not found' }],
  };
}

const tool = {
  id: 'ozon-ad-analyzer',
  title: 'Ozon 广告分析',
  goal: '按真实广告数据判断调整顺序',
  body: '严格执行广告 Skill。',
  skillProfile: { workflowSteps: ['读取真实数据', '检查完整度', '输出建议'] },
  promptConfig: {
    systemPrompt: '自定义广告 Skill 系统提示词',
    userPrompt: '请分析以下数据：\n{{input}}',
    workflowSteps: ['先检查数据完整度', '再判断计划效率'],
    outputFormat: '输出经营结论、证据和动作。',
    outputRules: ['禁止补造数据'],
    safetyRules: ['只读分析'],
  },
};

describe('smartToolPerformanceAdInsightService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestLocalApi.mockResolvedValue({
      reportText: JSON.stringify({
        title: '广告诊断报告',
        executiveSummary: '统计不足，暂不调整预算。',
        marketAssessment: '先补齐数据。',
        keyFindings: [{ title: '统计不足', evidence: '展示和点击暂无数据', action: '重新读取' }],
        opportunities: [],
        risks: [],
        actionPlan: [{ priority: '高', title: '重新读取统计', evidence: '关键指标缺失', action: '稍后重试' }],
        dataGaps: ['展示量', '点击量'],
      }),
      model: 'gpt-5.6-sol',
      accountId: 'model-account',
    });
  });

  it('只把真实可用数据和中文读取说明交给模型，缺失值不会变成 0', () => {
    const compact = compactPerformanceAdAnalysisForModel(createAnalysis());
    const serialized = JSON.stringify(compact);

    expect(serialized).toContain('暂缺数据');
    expect(serialized).not.toContain('"展示量":0');
    expect(serialized).not.toContain('/api/client/private');
    expect(serialized).not.toContain('campaign not found');
  });

  it('实际使用当前 Skill 的可编辑提示词、流程和所选模型', () => {
    const request = createPerformanceAdInsightRequest(tool, createAnalysis(), modelSelection);
    const customRules = JSON.parse(request.customRules);

    expect(request).toMatchObject({
      accountId: 'model-account',
      model: 'gpt-5.6-sol',
      templateId: 'performance-ad-insight.v1',
    });
    expect(customRules.userRules).toContain('自定义广告 Skill 系统提示词');
    expect(customRules.workflowSteps).toContain('先检查数据完整度');
    expect(customRules.outputRules).toContain('禁止补造数据');
    expect(JSON.stringify(request.templateInput.facts)).toContain('奔驰碎钻 中控部位');
  });

  it('调用文本中转站并解析为广告经营报告', async () => {
    const insight = await runPerformanceAdInsight(tool, createAnalysis(), modelSelection);

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
      report: { title: '广告诊断报告', executiveSummary: '统计不足，暂不调整预算。' },
    });
  });
});
