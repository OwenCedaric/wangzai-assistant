import { describe, expect, it, vi } from 'vitest';
import {
  canUseSmartToolOperationalWorkflow,
  createOperationalReportRange,
  normalize1688ProductReference,
  runSmartToolOperationalWorkflow,
  SMART_TOOL_1688_DETAIL_ID,
  SMART_TOOL_REPORT_READ_ID,
} from './smartToolOperationalWorkflowService.js';

function tool(id, title) {
  return {
    id,
    title,
    goal: title,
    skillProfile: { usageInputs: [], workflowSteps: ['读取真实数据'], safetyNotes: ['缺失不补造'] },
    promptConfig: { systemPrompt: '只解释真实数据', outputFormat: '结论 / 依据' },
  };
}

describe('smartToolOperationalWorkflowService', () => {
  it('识别两个正式业务运行器并把 1688 商品 ID 规范成商品链接', () => {
    expect(canUseSmartToolOperationalWorkflow({ id: SMART_TOOL_1688_DETAIL_ID })).toBe(true);
    expect(canUseSmartToolOperationalWorkflow({ id: SMART_TOOL_REPORT_READ_ID })).toBe(true);
    expect(canUseSmartToolOperationalWorkflow({ id: 'custom' })).toBe(false);
    expect(normalize1688ProductReference(' 123456789 ')).toBe('https://detail.1688.com/offer/123456789.html');
  });

  it('通过独立商品读取器返回 1688 页面真实字段和缺项', async () => {
    const productLinkParser = vi.fn().mockResolvedValue({
      platform: '1688',
      sourceUrl: 'https://detail.1688.com/offer/123456789.html',
      sourceProductId: '123456789',
      productTitle: '遥控汽车',
      price: 28.5,
      currency: 'CNY',
      variant: '红色',
      imageUrl: 'https://img.example/item.jpg',
      lengthCm: 20,
      widthCm: 10,
      heightCm: 8,
      weightKg: 0.6,
    });
    const result = await runSmartToolOperationalWorkflow(
      tool(SMART_TOOL_1688_DETAIL_ID, '1688 商品读取'),
      { '1688 商品链接或商品 ID': '123456789' },
      { productLinkParser },
    );
    expect(productLinkParser).toHaveBeenCalledWith('https://detail.1688.com/offer/123456789.html', {});
    expect(result.result.status).toBe('ready');
    expect(result.result.productCapture.productTitle).toBe('遥控汽车');
    expect(result.result.sections.flatMap((item) => item.rows).join('\n')).toContain('20 × 10 × 8 cm');
  });

  it('按店铺和日期读取完整经营快照，而不是浏览器插件快照', async () => {
    const insightRunner = vi.fn().mockResolvedValue({
      status: 'ready',
      model: 'gpt-5.6-sol',
      report: {
        title: '店铺经营分析报告',
        executiveSummary: '库存候选较多，应优先核对待销售商品。',
      },
    });
    const cacheReader = vi.fn().mockResolvedValue({
      ok: true,
      source: 'data-analysis-read-model',
      updatedAt: '2026-08-01T08:00:00.000Z',
      dashboard: {
        shopId: 'shop-1',
        range: { startDate: '2026-07-03', endDate: '2026-08-01' },
        overview: { metrics: [{ id: 'orders', label: '订单数', value: 8, unit: 'count', status: 'confirmed' }] },
        sales: {
          metrics: [{ id: 'sales', label: '销售额', value: 100, unit: 'money', currency: 'CNY', status: 'confirmed' }],
          statusBreakdown: [{ label: '已送达', count: 6 }],
          productRanking: [{ name: '商品甲', quantity: 5, sales: { value: 80, currency: 'CNY' } }],
        },
        products: {
          metrics: [],
          visibilityBreakdown: [{ key: 'TO_SUPPLY', count: 27 }],
          stockRiskRows: [{ offerId: 'offer-1', sku: 'sku-1', name: '商品甲', stock: 0, visibility: 'TO_SUPPLY' }],
          replenishmentRanking: [],
        },
        finance: {
          metrics: [],
          currencyConversionRows: [
            { operationId: 'fee-income', operationType: 'OperationAgentDeliveredToCustomer', operationDate: '2026-07-15', amount: 2192.47, currency: 'CNY' },
            { operationId: 'fee-1', postingNumber: 'posting-1', operationType: 'ClientReturnAgentOperation', operationDate: '2026-07-15', amount: -88, currency: 'CNY' },
          ],
          comparisonCurrencyConversionRows: [],
        },
        afterSales: {
          metrics: [],
          statusBreakdown: [{ key: '已退款', count: 1 }],
          reasonCodeBreakdown: [{ reasonId: '578', reasonLabel: '买家未取件', count: 1, isDefect: false }],
          recentRows: [{ returnId: 'return-1', postingNumber: 'posting-1', statusLabel: '已退款', productName: '商品甲', amount: 37, currency: 'CNY' }],
        },
        marketing: {
          metrics: [],
          activityTypeBreakdown: [{ key: 'ELASTIC_BOOSTING', count: 1 }],
          activityRows: [{ activityId: 'activity-1', title: '夏季促销', active: true, joinedCount: 5 }],
          productRows: [{ activityId: 'activity-1', productId: 'product-1', name: '商品甲', price: 100, activityPrice: 80, currency: 'CNY' }],
        },
      },
    });
    const result = await runSmartToolOperationalWorkflow(
      tool(SMART_TOOL_REPORT_READ_ID, 'Ozon 报表读取'),
      { '报告内容': 'all', '统计范围': '30' },
      {
        shopScope: { shopId: 'shop-1', shopName: '测试店' },
        cacheReader,
        insightRunner,
        modelSelection: { ready: true, accountId: 'model-account', model: 'gpt-5.6-sol' },
      },
    );
    expect(result.result.status).toBe('ready');
    expect(cacheReader).toHaveBeenCalledWith(expect.objectContaining({ shopId: 'shop-1', analysisType: 'all' }), expect.any(Object));
    const rows = result.result.sections.flatMap((item) => item.rows).join('\n');
    expect(rows).toContain('商品甲');
    expect(rows).toContain('商品送达结算');
    expect(rows).toContain('订单 posting-1');
    expect(rows).toContain('买家未取件');
    expect(rows).toContain('夏季促销');
    expect(rows).toContain('人民币');
    expect(rows).not.toContain('插件');
    expect(rows).not.toMatch(/第 \d+ 项/u);
    expect(insightRunner).toHaveBeenCalledWith(
      expect.objectContaining({ id: SMART_TOOL_REPORT_READ_ID }),
      expect.objectContaining({ shopId: 'shop-1', sections: expect.any(Array) }),
      expect.objectContaining({ accountId: 'model-account', model: 'gpt-5.6-sol' }),
      expect.objectContaining({ signal: undefined }),
    );
    expect(result.result).toMatchObject({
      status: 'ready',
      statusLabel: 'Ozon 报表读取与分析完成',
      viewType: 'operational-report',
      summary: '库存候选较多，应优先核对待销售商品。',
      operationalReportInsight: { status: 'ready', model: 'gpt-5.6-sol' },
    });
  });

  it('模型分析失败时保留已经读取的真实报表', async () => {
    const result = await runSmartToolOperationalWorkflow(
      tool(SMART_TOOL_REPORT_READ_ID, 'Ozon 报表读取与分析'),
      { '报告内容': 'all', '统计范围': '7' },
      {
        shopScope: { shopId: 'shop-1', shopName: '测试店' },
        cacheReader: vi.fn().mockResolvedValue({
          ok: true,
          updatedAt: '2026-08-03T08:00:00.000Z',
          dashboard: {
            overview: { metrics: [{ label: '订单数', value: 3, unit: 'count', status: 'confirmed' }] },
            sales: { metrics: [], trend: [], statusBreakdown: [], productRanking: [] },
            products: { metrics: [], visibilityBreakdown: [], stockRiskRows: [], replenishmentRanking: [] },
            finance: { metrics: [], currencyConversionRows: [], comparisonCurrencyConversionRows: [] },
            afterSales: { metrics: [], statusBreakdown: [], reasonCodeBreakdown: [], recentRows: [] },
            marketing: { metrics: [], activityRows: [], productRows: [] },
          },
        }),
        insightRunner: vi.fn().mockRejectedValue(new Error('分析模型响应超时')),
        modelSelection: { ready: true, accountId: 'model-account', model: 'gpt-5.6-sol' },
      },
    );

    expect(result.result).toMatchObject({
      status: 'partial_ready',
      statusLabel: '报表已读取，经营分析待重试',
      viewType: 'operational-report',
      operationalReportInsight: { status: 'error', message: '分析模型响应超时' },
    });
    expect(result.result.sections.flatMap((item) => item.rows).join('\n')).toContain('订单数：3');
  });

  it('生成 7/30/90 天可复现日期范围', () => {
    expect(createOperationalReportRange(7, new Date('2026-08-01T12:00:00.000Z'))).toEqual({
      startDate: '2026-07-26', endDate: '2026-08-01', days: 7,
    });
  });
});
