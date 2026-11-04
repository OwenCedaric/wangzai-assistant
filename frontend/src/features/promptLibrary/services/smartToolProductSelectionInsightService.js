import { requestLocalApi } from '../../../api/localApiClient.js';
import { parseSmartToolExternalOzonInsightReport } from './smartToolExternalOzonInsightService.js';

const PRODUCT_SELECTION_INSIGHT_TIMEOUT_MS = 300_000;

function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactDefined(entries = []) {
  return Object.fromEntries(entries.filter(([, value]) => (
    value !== undefined
    && value !== null
    && value !== ''
    && (!Array.isArray(value) || value.length > 0)
  )));
}

function listLines(value = []) {
  return (Array.isArray(value) ? value : [])
    .map(text)
    .filter(Boolean)
    .map((item) => `- ${item}`)
    .join('\n');
}

function compactStats(stats = {}) {
  return compactDefined([
    ['有效商品数', finite(stats.count)],
    ['最小值', finite(stats.min)],
    ['中间值', finite(stats.median)],
    ['平均值', finite(stats.average)],
    ['最大值', finite(stats.max)],
    ['合计', finite(stats.total)],
  ]);
}

function compactOzonProduct(record = {}) {
  return compactDefined([
    ['商品', text(record.title || record.name)],
    ['商品编号', text(record.id || record.sku || record.productId)],
    ['类目', text(record.category || record.category3)],
    ['品牌', text(record.brand)],
    ['卖家', text(record.seller)],
    ['价格（卢布）', finite(record.price)],
    ['销量', finite(record.sales)],
    ['订单', finite(record.orders)],
    ['销售额（卢布）', finite(record.revenue)],
    ['增长（%）', finite(record.growth)],
    ['库存', finite(record.stock)],
    ['评分', finite(record.rating)],
    ['评价数', finite(record.reviews)],
    ['广告销售占比（%）', finite(record.adSpendShare)],
    ['浏览后下单率（%）', finite(record.impressionToOrderRate)],
    ['退货取消率（%）', finite(record.returnCancelRate)],
    ['跟卖数量', finite(record.followSellerCount)],
  ]);
}

function compactDimension(item = {}) {
  return compactDefined([
    ['维度', text(item.label)],
    ['程序固定评分', finite(item.score)],
    ['权重', finite(item.weight)],
    ['数据依据', text(item.detail)],
  ]);
}

function compactSeerfarRecord(record = {}) {
  return compactDefined([
    ['商品', text(record.title || record.name || record.productName)],
    ['商品编号', text(record.sku || record.productId || record.id)],
    ['类目', text(record.category || record.categoryName)],
    ['价格（卢布）', finite(record.price || record.avgPrice)],
    ['销量', finite(record.sales || record.totalSales || record.monthlySales)],
    ['销售额（卢布）', finite(record.revenue || record.totalRevenue || record.monthlyRevenue)],
    ['日均销量', finite(record.dailySales || record.averageDailyUnits)],
    ['库存', finite(record.stock)],
    ['评分', finite(record.rating)],
    ['评价数', finite(record.reviewCount || record.reviews)],
  ]);
}

function compactSourceProduct(product = {}) {
  const source = product && typeof product === 'object' ? product : {};
  return compactDefined([
    ['平台', text(source.platform)],
    ['商品', text(source.productTitle)],
    ['商品编号', text(source.sourceProductId)],
    ['采购参考价（人民币）', finite(source.sourceCostCny ?? source.capturedPrice)],
    ['规格', text(source.variant)],
    ['重量（千克）', finite(source.weightKg)],
    ['长宽高', text(source.dimensions || source.packageDimensions)],
    ['Ozon 市场中间售价（卢布）', finite(source.marketMedianPriceRub)],
    ['预估平台费用（卢布）', finite(source.estimatedPlatformFeesRub)],
    ['物流核对状态', text(source.logisticsEstimateStatus)],
  ]);
}

function compactSourceCandidate(candidate = {}) {
  return compactDefined([
    ['商品', text(candidate.title)],
    ['价格与店铺信息', text(candidate.hint)],
  ]);
}

export function compactProductSelectionForModel(selection = {}) {
  const analysis = selection.productAnalysis || {};
  const opportunity = analysis.decision?.opportunity || {};
  const seerfar = selection.seerfar || {};
  const sourceSearch = selection.sourceSearch || {};
  return compactDefined([
    ['查询商品', text(selection.query || analysis.query)],
    ['Ozon 样本数量', finite(analysis.recordCount)],
    ['Ozon 价格', compactStats(analysis.priceStats)],
    ['Ozon 销量', compactStats(analysis.salesStats)],
    ['Ozon 销售额', compactStats(analysis.revenueStats)],
    ['Ozon 增长', compactStats(analysis.growthStats)],
    ['程序固定结论', compactDefined([
      ['机会分', finite(opportunity.score)],
      ['结论', text(opportunity.label)],
      ['建议', text(opportunity.recommendation)],
      ['证据覆盖率（%）', finite(opportunity.evidenceCoveragePercent)],
      ['有效维度数', finite(opportunity.availableDimensionCount)],
      ['总维度数', finite(opportunity.totalDimensionCount)],
      ['可信度', text(opportunity.confidenceLabel)],
    ])],
    ['七维评分', (opportunity.breakdown || []).map(compactDimension)],
    ['程序识别的正向证据', (opportunity.reasons || []).map((item) => compactDefined([
      ['证据', text(item.title)],
      ['说明', text(item.detail)],
      ['评分', finite(item.score)],
    ]))],
    ['程序识别的风险', (opportunity.risks || []).map((item) => compactDefined([
      ['风险', text(item.title)],
      ['说明', text(item.detail)],
      ['评分', finite(item.score)],
    ]))],
    ['缺失维度', (opportunity.missingDimensions || []).map((item) => text(item.label)).filter(Boolean)],
    ['Ozon 代表商品', (analysis.topProducts || analysis.records || []).slice(0, 12).map(compactOzonProduct)],
    ['Seerfar 复核', compactDefined([
      ['用户是否要求使用', seerfar.requested === true ? '是' : '否'],
      ['复核状态', text(seerfar.statusLabel)],
      ['返回商品数', finite(seerfar.recordCount)],
      ['说明', text(seerfar.summary)],
      ['代表商品', (seerfar.records || []).slice(0, 12).map(compactSeerfarRecord)],
    ])],
    ['1688 候选货源', compactSourceProduct(selection.sourceProduct)],
    ['1688 自动搜款', compactDefined([
      ['状态', text(sourceSearch.statusLabel)],
      ['说明', text(sourceSearch.message)],
      ['由 Ozon 热销商品转换的中文采购词', (sourceSearch.searches || []).map((item) => text(item.query)).filter(Boolean)],
      ['已剔除的不相关识图结果', finite(sourceSearch.rejectedCandidateCount)],
      ['候选数量', finite(sourceSearch.candidates?.length)],
      ['候选商品', (sourceSearch.candidates || []).slice(0, 8).map(compactSourceCandidate)],
    ])],
    ['当前数据缺口', (selection.dataGaps || []).map(text).filter(Boolean)],
  ]);
}

function modelSelectionReady(modelSelection = {}) {
  return Boolean(modelSelection.ready && text(modelSelection.accountId) && text(modelSelection.model));
}

export function createProductSelectionInsightRequest(tool = {}, selection = {}, modelSelection = {}) {
  if (!modelSelectionReady(modelSelection)) {
    throw new Error('没有可用的分析模型，请先选择已配置的文本模型。');
  }
  if (!selection.productAnalysis?.recordCount) {
    throw new Error('当前没有可供选品 Skill 分析的 Ozon 商品数据。');
  }
  const promptConfig = tool?.promptConfig || {};
  const facts = compactProductSelectionForModel(selection);
  const workflowSteps = listLines(promptConfig.workflowSteps || tool?.skillProfile?.workflowSteps);
  const outputRules = listLines(promptConfig.outputRules);
  const safetyRules = listLines(promptConfig.safetyRules || tool?.skillProfile?.safetyNotes);
  return {
    accountId: text(modelSelection.accountId),
    model: text(modelSelection.model),
    templateId: 'product-selection.v1',
    templateInput: {
      query: selection.query || '',
      seerfarStatus: selection.seerfar?.requested ? selection.seerfar.statusLabel || 'selected' : 'not-used',
      sourceStatus: selection.sourceProduct
        ? 'user-source-loaded'
        : selection.sourceSearch?.candidates?.length ? 'candidates-loaded' : 'no-candidate',
      facts,
    },
    customRules: JSON.stringify({
      userRules: promptConfig.systemPrompt || '',
      userInstruction: promptConfig.userPrompt || '',
      workflowSteps,
      outputFormat: promptConfig.outputFormat || '',
      outputRules,
      safetyRules,
    }),
  };
}

export async function runProductSelectionInsight(tool = {}, selection = {}, modelSelection = {}, options = {}) {
  const request = createProductSelectionInsightRequest(tool, selection, modelSelection);
  const response = await requestLocalApi('/api/integrations/analyze', {
    method: 'POST',
    body: request,
    timeoutMs: options.timeoutMs || PRODUCT_SELECTION_INSIGHT_TIMEOUT_MS,
    signal: options.signal,
  });
  return {
    status: 'ready',
    report: parseSmartToolExternalOzonInsightReport(response?.reportText),
    model: text(response?.model || request.model),
    accountId: text(response?.accountId || request.accountId),
    usage: response?.usage || null,
    generatedAt: new Date().toISOString(),
  };
}
