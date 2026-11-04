import { describe, expect, it } from 'vitest';
import {
  analyzeSmartToolPerformanceAds,
  calculatePerformanceAdMetrics,
  filterPerformanceAdCampaigns,
} from './smartToolPerformanceAdAnalysis.js';

function createCampaign(overrides = {}) {
  return {
    id: 'campaign-1',
    title: '夏季连衣裙',
    statusLabel: '运行中',
    statistics: {
      impressions: 10000,
      clicks: 200,
      spent: 1000,
      orders: 10,
      revenue: 4000,
    },
    alerts: {},
    ...overrides,
  };
}

function createOverview(campaigns) {
  return {
    ok: true,
    source: 'ozon-performance-realtime',
    provider: 'Ozon Performance API',
    readDepth: 'full',
    cache: { enabled: false, fallback: false },
    dateRange: { dateFrom: '2026-07-25', dateTo: '2026-07-31' },
    campaigns,
    dailyTrend: [
      { date: '2026-07-25', impressions: 1000, clicks: 20, spent: 100, orders: 1, revenue: 400 },
      { date: '2026-07-31', impressions: 2000, clicks: 50, spent: 200, orders: 3, revenue: 900 },
    ],
    readIssues: [],
  };
}

describe('smartToolPerformanceAdAnalysis', () => {
  it('统一计算 CTR、CPC、CVR、CPO、ACOS 和 ROAS', () => {
    expect(calculatePerformanceAdMetrics({
      impressions: 1000,
      clicks: 50,
      spent: 500,
      orders: 5,
      revenue: 2000,
    })).toEqual({
      impressions: 1000,
      clicks: 50,
      spent: 500,
      orders: 5,
      revenue: 2000,
      ctr: 5,
      cpc: 10,
      cvr: 10,
      cpo: 100,
      acos: 25,
      roas: 4,
    });
  });

  it('把未返回指标保留为暂无数据，不再误判为真实的 0', () => {
    expect(calculatePerformanceAdMetrics({})).toEqual({
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
    });

    const analysis = analyzeSmartToolPerformanceAds({
      overview: createOverview([createCampaign({ statistics: {} })]),
    });

    expect(analysis.metrics).toMatchObject({ impressions: null, clicks: null, spent: null, orders: null });
    expect(analysis.campaignDiagnostics[0].signals).toEqual([
      expect.objectContaining({ code: 'insufficient-statistics', severity: 'info' }),
    ]);
    expect(analysis.riskSignals).toHaveLength(0);
    expect(analysis.sections.find((section) => section.title === '整体表现').rows.join('\n'))
      .toContain('展示 未返回');
  });

  it('把底层读取错误汇总成人话，不向报告暴露接口路径和英文错误', () => {
    const overview = createOverview([createCampaign()]);
    overview.readIssues = [{
      campaignId: 'campaign-1',
      endpoint: '/api/client/campaign/campaign-1/objects',
      message: 'campaign not found',
    }];

    const analysis = analyzeSmartToolPerformanceAds({ overview });
    const dataRows = analysis.sections.find((section) => section.title === '数据完整性').rows.join('\n');

    expect(dataRows).toContain('扩展明细暂未返回');
    expect(dataRows).not.toContain('/api/client');
    expect(dataRows).not.toContain('campaign not found');
  });

  it('识别有花费无订单、低 CTR、低 CVR、高 ACOS 和低 ROAS', () => {
    const campaign = createCampaign({
      statistics: {
        impressions: 10000,
        clicks: 50,
        spent: 1000,
        orders: 0,
        revenue: 1000,
      },
    });
    const analysis = analyzeSmartToolPerformanceAds({ overview: createOverview([campaign]) });
    const codes = analysis.campaignDiagnostics[0].signals.map((signal) => signal.code);

    expect(codes).toEqual(expect.arrayContaining([
      'spent-without-orders',
      'low-ctr',
      'low-cvr',
      'high-acos',
      'low-roas',
    ]));
    expect(JSON.stringify(analysis.sections)).not.toContain('广告一定亏损');
  });

  it('预算耗尽且 ACOS 健康时给出谨慎放量建议', () => {
    const campaign = createCampaign({ alerts: { budgetExhausted: true } });
    const analysis = analyzeSmartToolPerformanceAds({ overview: createOverview([campaign]) });

    expect(analysis.campaignDiagnostics[0].signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'healthy-budget-exhausted', severity: 'positive' }),
    ]));
    expect(analysis.nextActions.join('\n')).toContain('可分次小幅增加预算');
  });

  it('审核失败作为最高优先级问题单独输出', () => {
    const campaign = createCampaign({
      statusLabel: '审核失败',
      reviewReason: '图片不符合要求',
      alerts: { moderationRejected: true },
    });
    const analysis = analyzeSmartToolPerformanceAds({ overview: createOverview([campaign]) });

    expect(analysis.campaignDiagnostics[0].primarySignal).toMatchObject({
      code: 'moderation-rejected',
      severity: 'critical',
    });
    expect(analysis.sections.find((section) => section.title === '主要问题').rows.join('\n'))
      .toContain('图片不符合要求');
  });

  it('按计划 ID 精确匹配，按名称模糊匹配', () => {
    const campaigns = [
      createCampaign(),
      createCampaign({ id: 'campaign-2', title: '冬季羽绒服' }),
    ];
    expect(filterPerformanceAdCampaigns(campaigns, 'campaign-2').map((item) => item.id))
      .toEqual(['campaign-2']);
    expect(filterPerformanceAdCampaigns(campaigns, '连衣').map((item) => item.id))
      .toEqual(['campaign-1']);
  });

  it('汇总整体表现并比较前后周期趋势', () => {
    const analysis = analyzeSmartToolPerformanceAds({ overview: createOverview([createCampaign()]) });

    expect(analysis.metrics).toMatchObject({ spent: 1000, orders: 10, revenue: 4000, acos: 25, roas: 4 });
    expect(analysis.trend).toMatchObject({ available: true, label: '订单趋势上升' });
    expect(analysis.sections.map((section) => section.title)).toEqual([
      '分析范围',
      '整体表现',
      '主要问题',
      '计划诊断',
      '趋势变化',
      '调整建议',
      '数据完整性',
    ]);
  });
});
