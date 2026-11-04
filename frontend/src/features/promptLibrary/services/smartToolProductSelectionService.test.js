import { describe, expect, it, vi } from 'vitest';
import {
  canUseSmartToolProductSelection,
  PRODUCT_SELECTION_INPUT_LABELS,
  runSmartToolProductSelection,
} from './smartToolProductSelectionService.js';

function createProductAnalysis() {
  return {
    recordCount: 8,
    priceStats: { count: 8, median: 1999 },
    decision: {
      opportunity: {
        score: 72,
        label: '可小批测试',
        recommendation: '先验证转化和履约成本。',
        evidenceCoveragePercent: 71,
        availableDimensionCount: 5,
        totalDimensionCount: 7,
        breakdown: [{ label: '需求增长', score: 80, weight: 20, detail: '需求上升' }],
        missingDimensions: [{ label: '履约质量' }],
        actions: ['首批不超过 20 件'],
      },
    },
    records: [{ id: 'sku-1', title: '遥控汽车', price: 1999, sales: 320 }],
  };
}

function ozonDraft() {
  return {
    toolId: 'ozon-product-selection',
    result: {
      status: 'browser_data_ready',
      productAnalysis: createProductAnalysis(),
      nextActions: [],
    },
  };
}

const tool = { id: 'ozon-product-selection', title: 'Ozon 选品助手' };
const modelSelection = { accountId: 'model-account', model: 'gpt-5.6-sol', ready: true };
const sourceSearchResult = {
  status: 'ready',
  statusLabel: '已找到 1 个候选货源',
  message: '已完成 1688 以图搜款。',
  searchUrl: 'https://s.1688.com/youyuan/index.htm?imageId=1',
  keywordSearchUrl: 'https://s.1688.com/selloffer/offer_search.htm?keywords=test',
  candidates: [{ id: 'source-1', title: '1688 遥控车货源', link: 'https://detail.1688.com/offer/1.html' }],
};
const sourcePlanResult = {
  status: 'ready',
  normalizedQuery: '遥控汽车',
  selectedProductIds: ['sku-1'],
  searches: [{
    query: '儿童遥控汽车玩具',
    titleZh: '遥控汽车玩具',
    productId: 'sku-1',
    matchGroups: [['遥控'], ['汽车']],
    excludedTerms: ['童装'],
  }],
};

describe('smartToolProductSelectionService', () => {
  it('只接管 Ozon 选品助手', () => {
    expect(canUseSmartToolProductSelection(tool)).toBe(true);
    expect(canUseSmartToolProductSelection('ozon-product-search')).toBe(false);
  });

  it('默认只读取 Ozon，不调用 Seerfar，并把固定评分交给所选模型解释', async () => {
    const ozonRunner = vi.fn().mockResolvedValue(ozonDraft());
    const seerfarRunner = vi.fn();
    const sourceSearchRunner = vi.fn().mockResolvedValue(sourceSearchResult);
    const sourcePlanRunner = vi.fn().mockResolvedValue(sourcePlanResult);
    const insightRunner = vi.fn().mockResolvedValue({
      status: 'ready',
      model: 'gpt-5.6-sol',
      report: { executiveSummary: '72 分，可小批测试。' },
    });

    const draft = await runSmartToolProductSelection(tool, {
      [PRODUCT_SELECTION_INPUT_LABELS.query]: '遥控汽车',
      [PRODUCT_SELECTION_INPUT_LABELS.seerfar]: 'skip',
    }, { ozonRunner, seerfarRunner, sourcePlanRunner, sourceSearchRunner, insightRunner, modelSelection });

    expect(ozonRunner).toHaveBeenCalledWith(tool, { '关键词或 SKU': '遥控汽车' }, expect.any(Object));
    expect(seerfarRunner).not.toHaveBeenCalled();
    expect(sourceSearchRunner).toHaveBeenCalledWith(
      expect.objectContaining({ recordCount: 8 }),
      '遥控汽车',
      expect.objectContaining({ sourcePlan: sourcePlanResult }),
    );
    expect(insightRunner).toHaveBeenCalledWith(
      tool,
      expect.objectContaining({
        productAnalysis: expect.objectContaining({
          decision: { opportunity: expect.objectContaining({ score: 72 }) },
        }),
        seerfar: expect.objectContaining({ status: 'skipped' }),
      }),
      modelSelection,
      expect.any(Object),
    );
    expect(draft.result).toMatchObject({
      status: 'browser_data_ready',
      statusLabel: '选品分析完成',
      viewType: 'product-selection',
      productSelectionInsight: { status: 'ready', model: 'gpt-5.6-sol' },
      sourceSearch: { status: 'ready', candidates: [{ id: 'source-1' }] },
      seerfarReview: { status: 'skipped', recordCount: 0 },
    });
  });

  it('用户选择后只执行一次 Seerfar 复核，并读取 1688 候选货源', async () => {
    const seerfarRunner = vi.fn().mockResolvedValue({
      result: {
        status: 'ready',
        externalAnalysis: { records: [{ productId: 'seerfar-1', title: '遥控汽车竞品', sales: 500 }] },
      },
    });
    const sourceLinkParser = vi.fn().mockResolvedValue({
      platform: '1688',
      platformKey: '1688',
      productTitle: '高速遥控汽车货源',
      productId: '1688-1',
      sourceProductId: '1688-1',
      price: 35,
      currency: 'CNY',
      weightKg: 0.8,
      packageDimensions: '30 × 20 × 12 cm',
    });

    const draft = await runSmartToolProductSelection(tool, {
      [PRODUCT_SELECTION_INPUT_LABELS.query]: '遥控汽车',
      [PRODUCT_SELECTION_INPUT_LABELS.seerfar]: 'use',
      [PRODUCT_SELECTION_INPUT_LABELS.sourceLink]: 'https://detail.1688.com/offer/123.html',
    }, {
      ozonRunner: vi.fn().mockResolvedValue(ozonDraft()),
      seerfarRunner,
      sourceLinkParser,
      sourceSearchRunner: vi.fn().mockResolvedValue(sourceSearchResult),
      sourcePlanRunner: vi.fn().mockResolvedValue(sourcePlanResult),
      insightRunner: vi.fn().mockResolvedValue({ status: 'ready', report: {} }),
      modelSelection,
    });

    expect(seerfarRunner).toHaveBeenCalledTimes(1);
    expect(seerfarRunner).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'linkfox-seerfar-ozon-product-report-search' }),
      { '商品关键词、SKU 或链接（可多个）': '遥控汽车' },
      expect.objectContaining({ maxPages: 1 }),
    );
    expect(sourceLinkParser).toHaveBeenCalledTimes(1);
    expect(draft.result).toMatchObject({
      sourceProduct: {
        platform: '1688',
        capturedPrice: 35,
        sourceCostCny: 35,
        marketMedianPriceRub: 1999,
      },
      seerfarReview: { status: 'ready', recordCount: 1 },
    });
  });

  it('模型失败时保留真实数据和固定评分，不把整次选品判成失败', async () => {
    const draft = await runSmartToolProductSelection(tool, {
      [PRODUCT_SELECTION_INPUT_LABELS.query]: '遥控汽车',
    }, {
      ozonRunner: vi.fn().mockResolvedValue(ozonDraft()),
      sourceSearchRunner: vi.fn().mockResolvedValue(sourceSearchResult),
      sourcePlanRunner: vi.fn().mockResolvedValue(sourcePlanResult),
      insightRunner: vi.fn().mockRejectedValue(new Error('模型超时')),
      modelSelection,
    });

    expect(draft.result.status).toBe('browser_data_ready');
    expect(draft.result.productAnalysis.decision.opportunity.score).toBe(72);
    expect(draft.result.productSelectionInsight).toMatchObject({ status: 'error', model: 'gpt-5.6-sol' });
  });
});
