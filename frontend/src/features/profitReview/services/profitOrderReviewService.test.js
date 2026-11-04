import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProfitOrderReview: vi.fn(),
  requestLocalApi: vi.fn(),
  runExternal: vi.fn(),
}));

vi.mock('../../../api/localApiClient.js', () => ({
  getProfitOrderReview: mocks.getProfitOrderReview,
  requestLocalApi: mocks.requestLocalApi,
}));

vi.mock('../../promptLibrary/services/smartToolExternalOzonDataService.js', () => ({
  runSmartToolDraftWithExternalOzonData: mocks.runExternal,
}));

import {
  createProfitOrderReviewAiRequest,
  parseProfitOrderReviewReport,
  runProfitOrderReview,
} from './profitOrderReviewService.js';

function ledgerRow() {
  return {
    ledgerKey: 'shop-a:ORDER-1',
    shopId: 'shop-a',
    orderSnapshot: { posting: 'ORDER-1', shopId: 'shop-a', sku: '998877', product: '遥控汽车' },
    amounts: {
      salesAmountCny: { status: 'ready', value: 100 },
      actualSalesAmountCny: { status: 'ready', value: 100 },
      sourcePurchaseCostCny: { status: 'ready', value: 50 },
      actualCommissionFeeCny: { status: 'ready', value: 10 },
      actualPenaltyFeeCny: { status: 'ready', value: 0 },
      actualAcquiringFeeCny: { status: 'ready', value: 2 },
      actualDeliveryServiceFeeCny: { status: 'ready', value: 5 },
      actualLogisticsFeeCny: { status: 'ready', value: 5 },
      actualCrossBorderBusFeeCny: { status: 'ready', value: 3 },
    },
    results: {
      actualProfitCny: { status: 'ready', value: 25, formula: '账本公式' },
      estimatedProfitCny: { status: 'ready', value: 24 },
    },
  };
}

describe('profitOrderReviewService', () => {
  beforeEach(() => {
    mocks.getProfitOrderReview.mockReset();
    mocks.requestLocalApi.mockReset();
    mocks.runExternal.mockReset();
    mocks.getProfitOrderReview.mockResolvedValue({
      found: true,
      ledgerRow: ledgerRow(),
      relatedLedgerRows: [ledgerRow()],
      product: { name: '遥控汽车', sku: '998877' },
      source: { type: 'profit-ledger-sqlite' },
    });
    mocks.runExternal.mockResolvedValue({
      result: {
        externalAnalysis: {
          records: [{ sku: '998877', title: '遥控汽车', sales: 80, revenue: 160000, rating: 4.6 }],
        },
      },
    });
    mocks.requestLocalApi.mockResolvedValue({
      model: 'gpt-5.5',
      reportText: JSON.stringify({
        executiveSummary: '利润和市场表现均可继续观察。',
        investmentDecision: '继续投入',
        profitDiagnosis: [],
        optimizationActions: [{ title: '保持小批量补货' }],
        dataGaps: [],
      }),
    });
  });

  it('runs ledger, Seerfar and text model from one order number', async () => {
    const stages = [];
    const result = await runProfitOrderReview({
      orderNumber: 'ORDER-1',
      shops: [{ id: 'shop-a', clientId: 'client-a' }],
      tool: { id: 'profit-risk-review', promptConfig: {} },
      modelSelection: { id: 'm1', accountId: 'account-a', model: 'gpt-5.5', ready: true },
    }, { onProgress: ({ stage }) => stages.push(stage) });

    expect(mocks.getProfitOrderReview).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'ORDER-1', shopIds: 'shop-a,client-a' }),
      expect.any(Object),
    );
    expect(mocks.runExternal).toHaveBeenCalledOnce();
    expect(mocks.requestLocalApi).toHaveBeenCalledWith('/api/integrations/analyze', expect.any(Object));
    expect(stages).toEqual(['ledger', 'market', 'model']);
    expect(result.analysis.profit.profit).toBe(25);
    expect(result.analysis.market.status).toBe('ready');
    expect(result.ai.report.investmentDecision).toBe('继续投入');
  });

  it('keeps profit review usable when market and model are unavailable', async () => {
    mocks.runExternal.mockRejectedValue(new Error('未配置 Seerfar'));
    const result = await runProfitOrderReview({
      orderNumber: 'ORDER-1',
      shops: [{ id: 'shop-a' }],
      modelSelection: { ready: false },
    });
    expect(result.status).toBe('ready');
    expect(result.analysis.profit.profit).toBe(25);
    expect(result.analysis.market.status).toBe('unavailable');
    expect(result.ai.status).toBe('skipped');
  });

  it('skips Seerfar completely when the user selects not to use it', async () => {
    const stages = [];
    const result = await runProfitOrderReview({
      orderNumber: 'ORDER-1',
      shops: [{ id: 'shop-a' }],
      tool: { id: 'profit-risk-review', promptConfig: {} },
      modelSelection: { id: 'm1', accountId: 'account-a', model: 'gpt-5.5', ready: true },
      useSeerfar: false,
    }, { onProgress: ({ stage }) => stages.push(stage) });

    expect(mocks.runExternal).not.toHaveBeenCalled();
    expect(mocks.requestLocalApi).toHaveBeenCalledOnce();
    expect(stages).toEqual(['ledger', 'model']);
    expect(result.analysis.market.status).toBe('skipped');
    expect(result.analysis.market.message).toContain('仅根据订单和店内历史生成');
  });

  it('sends Chinese business labels to the model and sanitizes returned field paths', () => {
    const request = createProfitOrderReviewAiRequest({
      promptConfig: {
        workflowSteps: ['先检查利润账本'],
        outputRules: ['先写大白话结论'],
        safetyRules: ['缺失数据不能猜测'],
      },
    }, {
      order: { orderNumber: 'ORDER-1' },
      product: { sku: '998877', category: '', imageUrl: '' },
      profit: { expenses: [], formula: 'actualIncome-source-commission-penalty-acquiring-delivery-logistics-bus' },
      ownProduct: {},
      market: { status: 'ready', metrics: { stock: null, followSellerCount: null }, record: { category: '玩具' } },
      decision: { label: '继续观察', marketSignal: 'neutral', reasons: [] },
      actions: [],
      dataGaps: [],
    }, { ready: true, accountId: 'a', model: 'gpt-5.6-sol' });
    const templateInput = JSON.stringify(request.templateInput);
    const customRules = JSON.parse(request.customRules);
    expect(request.templateId).toBe('profit-order-review.v1');
    expect(templateInput).toContain('市场库存');
    expect(templateInput).toContain('跟卖卖家数量');
    expect(templateInput).not.toContain('market.metrics');
    expect(templateInput).not.toContain('actualIncome-source');
    expect(customRules.workflowSteps).toContain('先检查利润账本');
    expect(customRules.outputRules).toContain('先写大白话结论');
    expect(customRules.safetyRules).toContain('缺失数据不能猜测');
    expect(request).not.toHaveProperty('systemPrompt');
    expect(request).not.toHaveProperty('userPrompt');

    const report = parseProfitOrderReviewReport(JSON.stringify({
      dataGaps: ['market.metrics.stock 为未知', 'product.imageUrl 为空'],
    }));
    expect(report.dataGaps).toEqual(['市场库存 为未知', '商品主图 为空']);
  });
});
