import { getProfitOrderReview, requestLocalApi } from '../../../api/localApiClient.js';
import { runSmartToolDraftWithExternalOzonData } from '../../promptLibrary/services/smartToolExternalOzonDataService.js';
import { PROFIT_ORDER_REVIEW_AI_ENDPOINT } from '../constants/profitOrderReviewContract.js';
import {
  analyzeProfitOrderReview,
  resolveProfitOrderReviewProductIdentity,
} from '../lib/profitOrderReviewAnalysis.js';
import { formatProfitOrderReviewUserText } from '../lib/profitOrderReviewText.js';

const PROFIT_REVIEW_MODEL_TIMEOUT_MS = 300_000;

function text(value) {
  return String(value ?? '').trim();
}

function cleanJsonText(value) {
  const raw = text(value).replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  return first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
}

function normalizeReportList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      if (typeof item === 'string') {
        return { title: formatProfitOrderReviewUserText(item), evidence: '', action: '' };
      }
      if (!item || typeof item !== 'object') return null;
      return {
        title: formatProfitOrderReviewUserText(item.title || item.finding || item.action),
        evidence: formatProfitOrderReviewUserText(item.evidence || item.reason || item.basis),
        action: formatProfitOrderReviewUserText(item.action || item.recommendation),
      };
    })
    .filter((item) => item?.title || item?.evidence || item?.action)
    .slice(0, 10);
}

export function parseProfitOrderReviewReport(value) {
  let parsed;
  try {
    parsed = JSON.parse(cleanJsonText(value));
  } catch {
    return {
      executiveSummary: formatProfitOrderReviewUserText(value),
      profitDiagnosis: [],
      marketAssessment: '',
      investmentDecision: '',
      optimizationActions: [],
      dataGaps: [],
    };
  }
  return {
    executiveSummary: formatProfitOrderReviewUserText(parsed.executiveSummary || parsed.summary || parsed.conclusion),
    profitDiagnosis: normalizeReportList(parsed.profitDiagnosis || parsed.findings),
    marketAssessment: formatProfitOrderReviewUserText(parsed.marketAssessment || parsed.marketJudgement),
    investmentDecision: formatProfitOrderReviewUserText(parsed.investmentDecision || parsed.decision),
    optimizationActions: normalizeReportList(parsed.optimizationActions || parsed.actions),
    dataGaps: (Array.isArray(parsed.dataGaps) ? parsed.dataGaps : [])
      .map(formatProfitOrderReviewUserText)
      .filter(Boolean)
      .slice(0, 10),
  };
}

function shopScopeIds(shops = []) {
  return [...new Set((Array.isArray(shops) ? shops : []).flatMap((shop) => [
    shop?.id,
    shop?.shopId,
    shop?.clientId,
    shop?.shopClientId,
  ]).map(text).filter(Boolean))];
}

function ledgerSourceLabel(value) {
  const source = text(value).toLowerCase();
  if (!source) return '利润账本';
  if (source.includes('ozon-finance')) return 'Ozon财务流水';
  if (source.includes('purchase') || source.includes('source-cost')) return '采购成本记录';
  if (source.includes('logistics') || source.includes('bus')) return '物流费用记录';
  if (source.includes('estimated') || source.includes('commission')) return 'Ozon费用记录';
  return '利润账本';
}

function marketSignalLabel(value) {
  if (value === 'strong') return '较强';
  if (value === 'weak') return '较弱';
  if (value === 'neutral') return '一般';
  return '数据不足';
}

function compactAnalysis(analysis = {}) {
  return {
    订单信息: {
      订单号: analysis.order?.orderNumber,
      店铺: analysis.order?.shop,
      订单状态: analysis.order?.status,
      付款日期: analysis.order?.paymentDate,
    },
    商品信息: {
      商品名称: analysis.product?.title,
      'Ozon SKU': analysis.product?.sku,
      商品货号: analysis.product?.offerId,
      Ozon商品ID: analysis.product?.productId,
      店内商品类目: analysis.product?.category,
      是否有商品主图: Boolean(analysis.product?.imageUrl),
    },
    当前订单利润: {
      利润口径: analysis.profit?.modeLabel,
      订单收入: analysis.profit?.revenue,
      订单利润: analysis.profit?.profit,
      利润率百分比: analysis.profit?.margin,
      利润计算方式: formatProfitOrderReviewUserText(analysis.profit?.formula),
      费用明细: analysis.profit?.expenses?.map((item) => ({
        费用名称: item.label,
        金额: item.value,
        数据状态: item.value === null ? '待确认' : '已读取',
        数据来源: ledgerSourceLabel(item.source),
      })),
      待确认费用: analysis.profit?.missing,
    },
    同SKU店内历史: {
      历史订单数: analysis.ownProduct?.orderCount,
      可核算订单数: analysis.ownProduct?.readyProfitCount,
      已形成实际利润订单数: analysis.ownProduct?.actualProfitCount,
      亏损订单数: analysis.ownProduct?.lossOrderCount,
      盈利订单数: analysis.ownProduct?.profitableOrderCount,
      累计收入: analysis.ownProduct?.totalRevenue,
      累计利润: analysis.ownProduct?.totalProfit,
      平均利润: analysis.ownProduct?.averageProfit,
      历史利润率百分比: analysis.ownProduct?.margin,
    },
    外部市场表现: {
      数据状态: analysis.market?.status === 'ready'
        ? '已返回'
        : (analysis.market?.status === 'skipped' ? '本次未使用' : '暂未返回'),
      数据来源: analysis.market?.sourceLabel,
      统计周期: [analysis.market?.statisticStartDate, analysis.market?.statisticEndDate].filter(Boolean).join(' 至 '),
      市场售价: analysis.market?.metrics?.priceRub,
      近30天销量: analysis.market?.metrics?.sales30d,
      近30天销售额: analysis.market?.metrics?.revenue30d,
      日均销量: analysis.market?.metrics?.averageDailyUnits,
      市场库存: analysis.market?.metrics?.stock,
      商品评分: analysis.market?.metrics?.rating,
      评价数量: analysis.market?.metrics?.reviews,
      退货取消率: analysis.market?.metrics?.returnCancelRate,
      上架天数: analysis.market?.metrics?.listingDays,
      跟卖卖家数量: analysis.market?.metrics?.followSellerCount,
      近期销量变化百分比: analysis.market?.metrics?.recentSalesChange,
      外部市场类目: analysis.market?.record?.category,
      外部分析提示: analysis.market?.insights,
      说明: analysis.market?.message,
    },
    系统初步判断: {
      判断结果: analysis.decision?.label,
      市场信号: marketSignalLabel(analysis.decision?.marketSignal),
      判断依据: analysis.decision?.reasons,
    },
    系统建议动作: analysis.actions,
    待确认数据: analysis.dataGaps,
  };
}

export function createProfitOrderReviewAiRequest(tool = {}, analysis = {}, modelSelection = {}) {
  if (!modelSelection?.ready || !text(modelSelection.accountId) || !text(modelSelection.model)) return null;
  const promptConfig = tool?.promptConfig || {};
  const customSystemPrompt = text(promptConfig.systemPrompt).slice(0, 8000);
  const customUserPrompt = text(promptConfig.userPrompt).slice(0, 4000);
  return {
    accountId: text(modelSelection.accountId),
    model: text(modelSelection.model),
    templateId: 'profit-order-review.v1',
    templateInput: {
      analysis: compactAnalysis(analysis),
      outputContract: {
        executiveSummary: '',
        profitDiagnosis: [{ title: '', evidence: '', action: '' }],
        marketAssessment: '',
        investmentDecision: '',
        optimizationActions: [{ title: '', evidence: '', action: '' }],
        dataGaps: [''],
      },
    },
    customRules: JSON.stringify({
      modelPurpose: promptConfig.modelPurpose || '',
      workflowSteps: promptConfig.workflowSteps || [],
      outputFormat: promptConfig.outputFormat || '',
      outputRules: promptConfig.outputRules || [],
      safetyRules: promptConfig.safetyRules || [],
      userRules: customSystemPrompt,
    }),
    userInstruction: customUserPrompt,
  };
}

async function readMarketBySku(sku, options = {}) {
  if (!/^\d+$/u.test(text(sku))) {
    return { draft: null, error: '当前订单没有可用于市场查询的数字 Ozon SKU。' };
  }
  try {
    const draft = await runSmartToolDraftWithExternalOzonData({
      id: 'linkfox-seerfar-ozon-product-detail-search',
      title: 'Seerfar 商品详情',
    }, {
      分析对象: '自己商品',
      '商品 SKU 或链接': text(sku),
    }, { signal: options.signal });
    return { draft, error: '' };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return { draft: null, error: error instanceof Error ? error.message : String(error || '市场数据查询失败') };
  }
}

export async function runProfitOrderReview({
  orderNumber,
  shops = [],
  tool = {},
  modelSelection = null,
  useSeerfar = true,
} = {}, options = {}) {
  const normalizedOrderNumber = text(orderNumber);
  if (!normalizedOrderNumber) throw new Error('请输入订单号。');
  options.onProgress?.({ stage: 'ledger', label: '正在读取利润账本' });
  const ledgerPayload = await getProfitOrderReview({
    orderNumber: normalizedOrderNumber,
    shopIds: shopScopeIds(shops).join(','),
  }, { signal: options.signal, timeoutMs: 30000 });
  if (!ledgerPayload?.found || !ledgerPayload?.ledgerRow) {
    const error = new Error(ledgerPayload?.message || '利润账本中没有找到这个订单。');
    error.code = 'PROFIT_REVIEW_ORDER_NOT_FOUND';
    throw error;
  }

  const productIdentity = resolveProfitOrderReviewProductIdentity(
    ledgerPayload.ledgerRow,
    ledgerPayload.product,
  );
  let market = {
    draft: null,
    error: '本次未选择 Seerfar，已跳过外部市场查询。',
  };
  if (useSeerfar) {
    options.onProgress?.({ stage: 'market', label: '正在查询商品市场表现' });
    market = await readMarketBySku(productIdentity.sku, options);
  }
  const analysis = analyzeProfitOrderReview({
    ledgerRow: ledgerPayload.ledgerRow,
    relatedLedgerRows: ledgerPayload.relatedLedgerRows,
    product: ledgerPayload.product,
    marketDraft: market.draft,
    marketError: market.error,
    marketSkipped: !useSeerfar,
  });

  let ai = { status: 'skipped', report: null, message: '未配置可用文本模型，已保留确定性核算结果。' };
  const aiRequest = createProfitOrderReviewAiRequest(tool, analysis, modelSelection);
  if (aiRequest) {
    options.onProgress?.({ stage: 'model', label: `正在使用 ${aiRequest.model} 生成综合建议` });
    try {
      const response = await requestLocalApi(PROFIT_ORDER_REVIEW_AI_ENDPOINT, {
        method: 'POST',
        body: aiRequest,
        timeoutMs: options.modelTimeoutMs || PROFIT_REVIEW_MODEL_TIMEOUT_MS,
        signal: options.signal,
      });
      ai = {
        status: 'ready',
        report: parseProfitOrderReviewReport(response?.reportText),
        message: '综合分析已完成。',
        model: text(response?.model || aiRequest.model),
        usage: response?.usage || null,
      };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      ai = {
        status: 'error',
        report: null,
        message: `模型分析暂时失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    status: analysis.profit.profit === null ? 'partial_ready' : 'ready',
    statusLabel: analysis.profit.profit === null ? '订单已定位，利润数据待补充' : '订单利润与投入评估完成',
    analysis,
    ai,
    source: ledgerPayload.source || null,
  };
}
