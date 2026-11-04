import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestLocalApi: vi.fn() }));
vi.mock('../../../api/localApiClient.js', () => ({ requestLocalApi: mocks.requestLocalApi }));

import {
  createSmartToolExternalOzonInsightRequest,
  parseSmartToolExternalOzonInsightReport,
  runSmartToolExternalOzonInsight,
} from './smartToolExternalOzonInsightService.js';

const modelSelection = {
  id: 'analysis-account::gpt-5.5',
  accountId: 'analysis-account',
  model: 'gpt-5.5',
  ready: true,
};

describe('smartToolExternalOzonInsightService', () => {
  beforeEach(() => mocks.requestLocalApi.mockReset());

  it('builds the market-keyword Skill analysis request from real structured records', () => {
    const request = createSmartToolExternalOzonInsightRequest(
      {
        id: 'linkfox-seerfar-ozon-market-keyword-search',
        title: 'Seerfar 市场热词',
      },
      {
        result: {
          status: 'ready',
          summary: '已完整读取 2 条真实数据。',
          keywordAnalysis: {
            kind: 'keywords',
            querySummary: '关键词 键盘',
            overview: { totalSearchVolume: 12000 },
            insights: ['搜索量最高：键盘'],
            records: [
              { query: 'клавиатура', queryCn: '键盘', searchVolume: 10000, competingProducts: 100 },
              { query: 'клавиатура игровая', queryCn: '游戏键盘', searchVolume: 2000, competingProducts: 30 },
            ],
          },
        },
      },
      modelSelection
    );

    expect(request).toMatchObject({ accountId: 'analysis-account', model: 'gpt-5.5' });
    expect(request).toMatchObject({
      templateId: 'external-ozon-insight.v1',
      templateInput: { recordCount: 2, querySummary: '关键词 键盘' },
    });
    expect(JSON.stringify(request.templateInput.records)).toContain('клавиатура');
    expect(request).not.toHaveProperty('systemPrompt');
    expect(request).not.toHaveProperty('userPrompt');
  });

  it('keeps large query results inside a stable model-context budget', () => {
    const records = Array.from({ length: 500 }, (_, index) => ({
      query: `keyword-${index}-${'x'.repeat(300)}`,
      queryCn: `关键词-${index}-${'中'.repeat(300)}`,
      searchVolume: 10_000 - index,
      competingProducts: 100 + index,
      categoryInfos: [{ cnTitlePath: `类目/${'分类'.repeat(200)}` }],
      products: [{ sku: `${index}`, title: `商品-${'标题'.repeat(200)}` }],
    }));
    const request = createSmartToolExternalOzonInsightRequest(
      {
        id: 'linkfox-seerfar-ozon-market-keyword-search',
        title: 'Seerfar 市场热词',
      },
      {
        result: {
          summary: '已读取 500 条真实数据。',
          keywordAnalysis: {
            kind: 'keywords',
            overview: { recordCount: 500, totalSearchVolume: 999999 },
            insights: ['已按完整 500 条记录汇总'],
            records,
          },
        },
      },
      modelSelection
    );

    expect(request.templateInput.recordCount).toBe(500);
    expect(request.templateInput.records.length).toBeGreaterThan(0);
    expect(request.templateInput.records.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(request.templateInput).length).toBeLessThan(60_000);
    expect(JSON.stringify(request).length).toBeLessThan(70_000);
  });

  it('uses the selected own-product plan instead of the competitor plan', () => {
    const request = createSmartToolExternalOzonInsightRequest(
      {
        id: 'linkfox-seerfar-ozon-product-detail-search',
        title: 'Seerfar 商品详情',
      },
      {
        result: {
          summary: '已返回 1 条真实数据。',
          externalAnalysis: {
            kind: 'products',
            analysisMode: 'own',
            analysisModeLabel: '自己商品分析',
            records: [{ sku: '175924376', title: '自己的商品', productCardViews: 1200 }],
            overview: { recordCount: 1 },
            insights: ['商品卡浏览 1200'],
          },
        },
      },
      modelSelection
    );

    expect(request.templateInput.analysisMode).toBe('自己商品分析');
    expect(request.templateInput.records[0]).toMatchObject({ '商品 SKU': '175924376', 商品标题: '自己的商品' });
    expect(request.customRules).not.toContain('不给竞对商品输出本店调价');
  });

  it('uses the edited Skill analysis prompts, rules, output structure and sample limits at runtime', () => {
    const records = Array.from({ length: 12 }, (_, index) => ({
      query: `keyword-${index}`,
      searchVolume: 1000 - index,
      competingProducts: 50 + index,
    }));
    const request = createSmartToolExternalOzonInsightRequest(
      {
        id: 'linkfox-seerfar-ozon-market-keyword-search',
        title: 'Seerfar 市场热词',
        promptConfig: {
          externalInsightConfig: {
            analysisGoals: ['自定义目标：只看新品'],
            analysisRules: ['自定义规则：增长必须超过 20%'],
            systemPrompt: '目标\n{{analysisGoals}}\n规则\n{{analysisRules}}\n结构\n{{outputSections}}',
            userPrompt: '自定义输入 {{toolTitle}} / 样本 {{sampleCount}}\n{{recordsJson}}',
            outputSections: ['executiveSummary：只写一句结论'],
            outputRules: ['只返回 JSON'],
            sampleMaxRecords: 5,
            sampleMaxChars: 5000,
          },
        },
      },
      {
        result: {
          summary: '已读取 12 条',
          keywordAnalysis: {
            kind: 'keywords',
            records,
            overview: {},
            insights: [],
          },
        },
      },
      modelSelection
    );

    const customRules = JSON.parse(request.customRules);
    expect(customRules.analysisGoals).toContain('自定义目标：只看新品');
    expect(customRules.analysisRules).toContain('自定义规则：增长必须超过 20%');
    expect(customRules.outputSections).toContain('executiveSummary：只写一句结论');
    expect(customRules.userRules).toContain('{{analysisGoals}}');
    expect(customRules.userInstruction).toContain('自定义输入');
    expect(request.templateInput.records).toHaveLength(5);
    expect(JSON.stringify(request.templateInput.records)).not.toContain('keyword-5');
  });

  it('parses a fenced structured report into stable report cards', () => {
    const report = parseSmartToolExternalOzonInsightReport(`\`\`\`json
      {"title":"键盘市场报告","executiveSummary":"需求稳定","opportunities":[{"priority":"高","title":"游戏键盘","evidence":"增长 25%","action":"小批测试"}],"dataGaps":["佣金"]}
    \`\`\``);

    expect(report).toMatchObject({
      title: '键盘市场报告',
      executiveSummary: '需求稳定',
      opportunities: [{ priority: '高', title: '游戏键盘', evidence: '增长 25%', action: '小批测试' }],
      dataGaps: ['佣金'],
    });
  });

  it('converts internal field names and missing-value jargon into plain Chinese', () => {
    const report = parseSmartToolExternalOzonInsightReport(
      JSON.stringify({
        executiveSummary: 'returnCancelRate 为 null，averageReturnCancelRate 也为 null。',
        keyFindings: [
          {
            title: '字段缺失',
            evidence: '接口未返回 productCardViews 和 data.product.orderConversionRate。',
            action: '补齐 fulfillment_fee 后判断。',
          },
        ],
      })
    );
    const rendered = JSON.stringify(report);
    expect(rendered).toContain('退货取消率');
    expect(rendered).toContain('平均退货取消率');
    expect(rendered).toContain('商品卡浏览量');
    expect(rendered).toContain('下单转化率');
    expect(rendered).toContain('暂无数据');
    expect(rendered).not.toMatch(/returnCancelRate|averageReturnCancelRate|null|接口未返回|字段缺失|fulfillment_fee/u);
  });

  it('sends only Chinese business labels to the model for product analysis', () => {
    const request = createSmartToolExternalOzonInsightRequest(
      {
        id: 'linkfox-seerfar-ozon-product-detail-search',
        title: '商品详情',
      },
      {
        result: {
          summary: '已返回 1 条真实数据。',
          externalAnalysis: {
            kind: 'products',
            analysisMode: 'own',
            records: [
              {
                sku: '1',
                title: '商品',
                price: 1000,
                returnCancelRate: 8,
                manualData: { productCostRub: 400, commissionRate: 15 },
              },
            ],
            overview: { recordCount: 1, averageReturnCancelRate: 8 },
            insights: [],
          },
        },
      },
      modelSelection
    );
    const templateInput = JSON.stringify(request.templateInput);
    expect(templateInput).toContain('"退货取消率":8');
    expect(templateInput).toContain('"商品成本":400');
    expect(templateInput).toContain('"平均退货取消率":8');
    expect(templateInput).not.toMatch(/returnCancelRate|productCostRub|averageReturnCancelRate|null/u);
  });

  it('calls the dedicated local analysis route and returns the parsed report', async () => {
    mocks.requestLocalApi.mockResolvedValue({
      reportText: JSON.stringify({ executiveSummary: '值得小批测试', actionPlan: ['先测试 3 个词'] }),
      model: 'gpt-5.5',
      accountId: 'analysis-account',
    });
    const result = await runSmartToolExternalOzonInsight(
      {
        id: 'linkfox-seerfar-ozon-product-report-search',
        title: 'Seerfar 商品筛选',
      },
      {
        result: {
          summary: '已返回 1 条',
          externalAnalysis: {
            kind: 'products',
            overview: { totalRevenue: 10000 },
            insights: [],
            records: [{ sku: '1', title: '商品', revenue: 10000 }],
          },
        },
      },
      modelSelection
    );

    expect(mocks.requestLocalApi).toHaveBeenCalledWith(
      '/api/integrations/analyze',
      expect.objectContaining({
        method: 'POST',
        timeoutMs: 300000,
      })
    );
    expect(result).toMatchObject({
      status: 'ready',
      report: { executiveSummary: '值得小批测试' },
    });
  });
});
