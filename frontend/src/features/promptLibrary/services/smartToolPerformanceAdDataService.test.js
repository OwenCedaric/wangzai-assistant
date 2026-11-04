import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listPerformanceAccounts: vi.fn(),
  readPerformanceOverview: vi.fn(),
  requestLocalApi: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  listPerformanceAccounts: mocks.listPerformanceAccounts,
  readPerformanceOverview: mocks.readPerformanceOverview,
  requestLocalApi: mocks.requestLocalApi,
}));

import {
  canUseSmartToolPerformanceAdData,
  loadPerformanceAdAccounts,
  loadPerformanceAdCampaignOptions,
  PERFORMANCE_AD_USAGE_LABELS,
  resolvePerformanceAdDateRange,
  runSmartToolDraftWithPerformanceAdData,
} from './smartToolPerformanceAdDataService.js';

function createOverview() {
  const capturedAt = new Date().toISOString();
  return {
    ok: true,
    source: 'ozon-performance-realtime',
    provider: 'Ozon Performance API',
    readDepth: 'ai',
    cache: { enabled: false },
    freshness: { live: true, capturedAt },
    aiReadiness: { ready: true, capturedAt, maxAgeMs: 120_000, incompleteDataSets: [] },
    dateRange: { dateFrom: '2026-07-18', dateTo: '2026-07-31' },
    campaigns: [
      {
        id: 'campaign-1',
        title: '夏季连衣裙',
        statusLabel: '运行中',
        statistics: { impressions: 1000, clicks: 50, spent: 500, orders: 5, revenue: 2000 },
      },
      {
        id: 'campaign-2',
        title: '冬季羽绒服',
        statusLabel: '已暂停',
        statistics: { impressions: 500, clicks: 10, spent: 200, orders: 0, revenue: 0 },
      },
    ],
    dailyTrend: [],
    readIssues: [],
  };
}

const modelSelection = {
  id: 'analysis-model',
  accountId: 'model-account',
  model: 'gpt-5.6-sol',
  ready: true,
};

describe('smartToolPerformanceAdDataService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'older-account',
          title: '旧推广账号',
          hasClientId: true,
          hasClientSecret: true,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
        {
          id: 'latest-account',
          title: '主推广账号',
          hasClientId: true,
          hasClientSecret: true,
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      ],
    });
    mocks.readPerformanceOverview.mockResolvedValue(createOverview());
    mocks.requestLocalApi.mockResolvedValue({
      reportText: JSON.stringify({
        title: '广告经营分析',
        executiveSummary: '先处理无订单计划，再观察点击率变化。',
        marketAssessment: '当前应谨慎调整。',
        keyFindings: [{ title: '冬季计划无订单', evidence: '已有花费但没有订单', action: '先降低出价' }],
        opportunities: [],
        risks: [],
        actionPlan: [{ priority: '高', title: '处理浪费计划', evidence: '有花费无订单', action: '降低出价并复核' }],
        dataGaps: [],
      }),
      model: 'gpt-5.6-sol',
      accountId: 'model-account',
    });
  });

  it('只接管 Ozon 广告分析工具', () => {
    expect(canUseSmartToolPerformanceAdData('ozon-ad-analyzer')).toBe(true);
    expect(canUseSmartToolPerformanceAdData('ozon-product-search')).toBe(false);
  });

  it('直接读取小齿轮中凭证完整的账号，并按最近更新时间排序', async () => {
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [
        {
          id: 'missing-secret',
          title: '未配密钥',
          hasClientId: true,
          hasClientSecret: false,
          updatedAt: '2026-07-31T00:00:00.000Z',
        },
        {
          id: 'older-account',
          title: '旧推广账号',
          hasClientId: true,
          hasClientSecret: true,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
        {
          id: 'latest-account',
          title: '主推广账号',
          hasClientId: true,
          hasClientSecret: true,
          updatedAt: '2026-07-30T00:00:00.000Z',
        },
      ],
    });

    const accounts = await loadPerformanceAdAccounts();

    expect(accounts.map((item) => item.id)).toEqual(['latest-account', 'older-account']);
    expect(mocks.listPerformanceAccounts).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 10000 }));
  });

  it('选择店铺后只返回该店绑定的 Performance 账号', async () => {
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [
        { id: 'shop-1-account', title: '一店广告', shopId: 'shop-1', hasClientId: true, hasClientSecret: true },
        { id: 'shop-2-account', title: '二店广告', shopId: 'shop-2', hasClientId: true, hasClientSecret: true },
        { id: 'unbound-account', title: '未绑定账号', hasClientId: true, hasClientSecret: true },
      ],
    });

    const accounts = await loadPerformanceAdAccounts({ shopId: 'shop-2' });

    expect(accounts.map((item) => item.id)).toEqual(['shop-2-account']);
  });

  it('账号选定后用 fast 深度实时读取广告计划下拉，不提前读取完整统计', async () => {
    mocks.readPerformanceOverview.mockResolvedValue({
      ...createOverview(),
      campaigns: [
        { id: 'campaign-1', title: '夏季连衣裙', statusLabel: '运行中' },
        { id: 'campaign-1', title: '重复计划' },
        { id: 'campaign-2', title: '冬季羽绒服', statusLabel: '已暂停' },
      ],
    });

    const campaigns = await loadPerformanceAdCampaignOptions({
      id: 'latest-account',
      title: '主推广账号',
    }, {
      now: new Date('2026-07-31T12:00:00.000Z'),
    });

    expect(mocks.readPerformanceOverview).toHaveBeenCalledWith({
      type: 'ozon-performance',
      values: {
        accountId: 'latest-account',
        shopName: '主推广账号',
        dateFrom: '2026-07-25',
        dateTo: '2026-07-31',
        readDepth: 'fast',
      },
    }, expect.objectContaining({ timeoutMs: 60000 }));
    expect(campaigns).toEqual([
      expect.objectContaining({ id: 'campaign-1', label: '夏季连衣裙 · 运行中' }),
      expect.objectContaining({ id: 'campaign-2', label: '冬季羽绒服 · 已暂停' }),
    ]);
  });

  it('未指定账号时选择最近配置账号，并用 AI 实时完整深度读取真实 API', async () => {
    const draft = await runSmartToolDraftWithPerformanceAdData(
      { id: 'ozon-ad-analyzer', title: 'Ozon 广告分析' },
      { [PERFORMANCE_AD_USAGE_LABELS.dateRange]: '14' },
      { now: new Date('2026-07-31T12:00:00.000Z'), modelSelection },
    );

    expect(mocks.listPerformanceAccounts).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 10000 }));
    expect(mocks.readPerformanceOverview).toHaveBeenCalledWith({
      type: 'ozon-performance',
      values: {
        accountId: 'latest-account',
        shopName: '主推广账号',
        dateFrom: '2026-07-18',
        dateTo: '2026-07-31',
        readDepth: 'ai',
        campaignId: '',
        includeCampaignObjects: false,
      },
    }, expect.objectContaining({ timeoutMs: 300000 }));
    expect(draft.result).toMatchObject({
      status: 'ready',
      source: 'ozon-performance-realtime',
      readDepth: 'ai',
      account: { id: 'latest-account', title: '主推广账号' },
      performanceAdAnalysis: { campaignCount: 2 },
      performanceAdInsight: { status: 'ready', model: 'gpt-5.6-sol' },
    });
    expect(mocks.requestLocalApi).toHaveBeenCalledWith('/api/integrations/analyze', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        accountId: 'model-account',
        model: 'gpt-5.6-sol',
      }),
    }));
  });

  it('支持按账号名称和计划名称筛选', async () => {
    const draft = await runSmartToolDraftWithPerformanceAdData(
      { id: 'ozon-ad-analyzer' },
      {
        [PERFORMANCE_AD_USAGE_LABELS.account]: '旧推广',
        [PERFORMANCE_AD_USAGE_LABELS.campaign]: '羽绒',
        [PERFORMANCE_AD_USAGE_LABELS.dateRange]: '7',
      },
      { now: new Date('2026-07-31T12:00:00.000Z'), modelSelection },
    );

    expect(mocks.readPerformanceOverview.mock.calls[0][0].values.accountId).toBe('older-account');
    expect(mocks.readPerformanceOverview.mock.calls[0][0].values.campaignId).toBe('羽绒');
    expect(draft.result.performanceAdAnalysis).toMatchObject({
      campaignCount: 1,
      campaignQuery: '羽绒',
    });
    expect(draft.result.performanceAdAnalysis.campaignDiagnostics[0].id).toBe('campaign-2');
    expect(draft.inputText).toContain('广告计划名称或 ID（可选）：冬季羽绒服');
  });

  it('无可用 Performance 账号时给出明确错误', async () => {
    mocks.listPerformanceAccounts.mockResolvedValue({
      accounts: [{ id: 'missing-secret', hasClientId: true, hasClientSecret: false }],
    });

    await expect(runSmartToolDraftWithPerformanceAdData(
      { id: 'ozon-ad-analyzer' },
      {},
      { modelSelection },
    )).rejects.toThrow('没有可用的 Ozon Performance API 账号');
    expect(mocks.readPerformanceOverview).not.toHaveBeenCalled();
  });

  it('区分广告数据读取超时和模型分析超时', async () => {
    mocks.readPerformanceOverview.mockRejectedValueOnce(new Error('本地 API 请求超时'));
    await expect(runSmartToolDraftWithPerformanceAdData(
      { id: 'ozon-ad-analyzer' },
      {},
      { modelSelection },
    )).rejects.toThrow('真实广告数据读取时间过长');

    mocks.readPerformanceOverview.mockResolvedValueOnce(createOverview());
    mocks.requestLocalApi.mockRejectedValueOnce(new Error('local-api 请求超时：300000ms'));
    await expect(runSmartToolDraftWithPerformanceAdData(
      { id: 'ozon-ad-analyzer' },
      {},
      { modelSelection },
    )).rejects.toThrow('分析模型响应超时');
  });

  it('实时数据不完整或只是秒开快照时禁止调用分析模型', async () => {
    mocks.readPerformanceOverview.mockResolvedValueOnce({
      ...createOverview(),
      cache: { fallback: true },
      freshness: { live: false, capturedAt: new Date().toISOString() },
    });

    await expect(runSmartToolDraftWithPerformanceAdData(
      { id: 'ozon-ad-analyzer' },
      {},
      { modelSelection },
    )).rejects.toThrow('本地秒开快照');
    expect(mocks.requestLocalApi).not.toHaveBeenCalled();

    mocks.readPerformanceOverview.mockResolvedValueOnce({
      ...createOverview(),
      aiReadiness: {
        ready: false,
        capturedAt: new Date().toISOString(),
        incompleteDataSets: ['expenseStatistics'],
        reason: '推广数据集尚未完整返回。',
      },
    });

    await expect(runSmartToolDraftWithPerformanceAdData(
      { id: 'ozon-ad-analyzer' },
      {},
      { modelSelection },
    )).rejects.toThrow('尚未完整返回');
    expect(mocks.requestLocalApi).not.toHaveBeenCalled();
  });

  it('统计周期始终包含今天并按自然日回退', () => {
    expect(resolvePerformanceAdDateRange('最近 30 天', {
      now: new Date('2026-07-31T12:00:00.000Z'),
    })).toEqual({ days: 30, dateFrom: '2026-07-02', dateTo: '2026-07-31' });
  });
});
