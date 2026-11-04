import { requestLocalApi } from '../../../api/localApiClient.js';
import { normalizeExternalOzonInsightConfig } from '../lib/smartToolExternalOzonInsightConfig.js';
import {
  externalProductAnalysisModeLabel,
  normalizeExternalProductAnalysisMode,
} from '../lib/smartToolExternalProductAnalysisMode.js';
import { sanitizeExternalOzonReportText } from '../lib/smartToolExternalOzonReportText.js';

const EXTERNAL_OZON_INSIGHT_REQUEST_TIMEOUT_MS = 300_000;

function text(value) {
  return String(value ?? '').trim();
}

function shortText(value, maxLength = 240) {
  const normalized = text(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function finite(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanJsonText(value) {
  const raw = text(value).replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  return first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
}

function list(value, mapper = (item) => text(item)) {
  return (Array.isArray(value) ? value : []).map(mapper).filter(Boolean);
}

function reportItem(value, index = 0) {
  if (typeof value === 'string') {
    const content = sanitizeExternalOzonReportText(value);
    return content ? { title: content, evidence: '', action: '', priority: index + 1 } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const title = sanitizeExternalOzonReportText(
    value.title || value.finding || value.opportunity || value.risk || value.action
  );
  const evidence = sanitizeExternalOzonReportText(value.evidence || value.basis || value.reason || value.data);
  const action = sanitizeExternalOzonReportText(value.action || value.recommendation || value.nextStep);
  if (!title && !evidence && !action) return null;
  return {
    priority: text(value.priority || value.level) || String(index + 1),
    title: title || action || evidence,
    evidence,
    action,
  };
}

export function parseSmartToolExternalOzonInsightReport(value) {
  let parsed;
  try {
    parsed = JSON.parse(cleanJsonText(value));
  } catch {
    const summary = sanitizeExternalOzonReportText(value);
    if (!summary) throw new Error('分析模型没有返回可用报告。');
    return {
      title: '数据分析报告',
      executiveSummary: summary,
      marketAssessment: '',
      keyFindings: [],
      opportunities: [],
      risks: [],
      actionPlan: [],
      dataGaps: [],
    };
  }
  const normalizedItems = (items) => list(items, reportItem).slice(0, 12);
  return {
    title: sanitizeExternalOzonReportText(parsed.title) || '数据分析报告',
    executiveSummary: sanitizeExternalOzonReportText(parsed.executiveSummary || parsed.summary || parsed.conclusion),
    marketAssessment: sanitizeExternalOzonReportText(parsed.marketAssessment || parsed.marketJudgement || parsed.assessment),
    keyFindings: normalizedItems(parsed.keyFindings || parsed.findings),
    opportunities: normalizedItems(parsed.opportunities),
    risks: normalizedItems(parsed.risks || parsed.riskItems),
    actionPlan: normalizedItems(parsed.actionPlan || parsed.actions),
    dataGaps: list(parsed.dataGaps || parsed.missingData, sanitizeExternalOzonReportText).slice(0, 12),
  };
}

function compactDefined(entries = []) {
  return Object.fromEntries(entries.filter(([, value]) => (
    value !== undefined
    && value !== null
    && value !== ''
    && (!Array.isArray(value) || value.length > 0)
  )));
}

function compactProduct(record = {}) {
  const manualData = record.manualData || {};
  const unitProfit = record.unitProfit || {};
  return compactDefined([
    ['商品 SKU', shortText(record.sku || record.id, 80)],
    ['商品标题', shortText(record.title || record.name)],
    ['销售价格', finite(record.price)],
    ['销量', finite(record.sales)],
    ['销售额', finite(record.revenue)],
    ['销量增长率', finite(record.salesRate)],
    ['销售额增长率', finite(record.revenueRate)],
    ['库存', finite(record.stock)],
    ['评分', finite(record.rating ?? record.reviewRating)],
    ['评价数量', finite(record.reviews ?? record.reviewCount)],
    ['卖家', shortText(record.seller || record.sellerName, 160)],
    ['品牌', shortText(record.brand || record.brandName, 160)],
    ['配送方式', shortText(text(record.fulfillmentModel) || list(record.fulfillment).join(' / '), 120)],
    ['退货取消率', finite(record.returnCancelRate ?? record.returnCancellationRate)],
    ['退货取消率来源', record.returnCancelRateSource === '手动补充' ? '手动补充' : ''],
    ['商品卡浏览量', finite(record.productCardViews ?? record.sessionCount)],
    ['搜索和目录浏览量', finite(record.searchCatalogViews ?? record.sessionCountSearch)],
    ['商品卡加购转化率', finite(record.productCardToCartRate ?? record.convToCartPdp)],
    ['搜索加购转化率', finite(record.searchCatalogToCartRate ?? record.convToCartSearch)],
    ['下单转化率', finite(record.impressionToOrderRate ?? record.orderConversionRate)],
    ['广告费用占比', finite(record.adSpendShare ?? record.drr)],
    ['日均销量', finite(record.averageDailyUnits)],
    ['日均销售额', finite(record.averageDailyRevenue)],
    ['上架天数', finite(record.listingDays ?? record.upDays)],
    ['跟卖数量', finite(record.followSellerCount ?? record.sellers)],
    ['统计开始日期', shortText(record.statisticStartDate, 40)],
    ['统计结束日期', shortText(record.statisticEndDate, 40)],
    ['类目排名', list(record.categoryRanks, (item) => compactDefined([
      ['日期', shortText(item?.date, 40)],
      ['排名', finite(item?.rank)],
      ['同类商品数量', finite(item?.count)],
    ])).slice(-12)],
    ['每日趋势', list(record.trends, (item) => compactDefined([
      ['日期', shortText(item?.date, 40)],
      ['销量', finite(item?.sales)],
      ['销售额', finite(item?.revenue)],
      ['价格', finite(item?.price)],
      ['库存', finite(item?.stock)],
    ])).slice(-30)],
    ['损失销售额', finite(record.missedRevenue)],
    ['商品成本', finite(manualData.productCostRub)],
    ['平台佣金率', finite(manualData.commissionRate)],
    ['履约费用', finite(manualData.fulfillmentFeeRub)],
    ['税费率', finite(manualData.taxRate)],
    ['预估单件基础利润', finite(unitProfit.estimatedUnitProfitRub)],
    ['预估基础利润率', finite(unitProfit.estimatedUnitProfitRate)],
  ]);
}

function compactKeyword(record = {}) {
  return compactDefined([
    ['关键词', shortText(record.query, 180)],
    ['中文含义', shortText(record.queryCn, 180)],
    ['平台', Number(record.platform) === 1 ? 'Wildberries' : 'Ozon'],
    ['搜索量', finite(record.searchVolume)],
    ['近 30 天增长率', finite(record.count30GrowthRate)],
    ['近 90 天增长率', finite(record.count90GrowthRate)],
    ['销量', finite(record.sales)],
    ['销售额', finite(record.revenue)],
    ['竞品数量', finite(record.competingProducts)],
    ['商品数量', finite(record.productCount)],
    ['卖家数量', finite(record.sellers)],
    ['平均价格', finite(record.avgPrice)],
    ['搜索到下单转化率', finite(record.searchUsersToOrdUsers)],
    ['浏览集中度', finite(record.viewSharing)],
    ['转化集中度', finite(record.conversionSharing)],
    ['市场空间', finite(record.marketSpace)],
    ['退货取消率', finite(record.returnCancellationRate)],
    ['自然排名', finite(record.naturalRank)],
    ['广告排名', finite(record.adRank)],
    ['曝光量', finite(record.exposure)],
    ['转化率', finite(record.conversion)],
    ['机会评分', finite(record.opportunityScore)],
    ['相关类目', list(record.categoryInfos, (item) => shortText(item?.cnTitlePath || item?.titlePath, 180)).slice(0, 3)],
    ['代表商品', list(record.products, (item) => compactDefined([
      ['商品 SKU', shortText(item?.sku || item?.ozonId, 80)],
      ['商品标题', shortText(item?.title, 180)],
      ['是否广告位', Number(item?.advert) === 1 ? '是' : '否'],
    ])).slice(0, 3)],
  ]);
}

const OVERVIEW_LABELS = Object.freeze({
  recordCount: '记录数量',
  totalSales: '总销量',
  totalRevenue: '总销售额',
  averagePrice: '平均价格',
  averageRating: '平均评分',
  totalStock: '总库存',
  averageReturnCancelRate: '平均退货取消率',
  totalSearchVolume: '总搜索量',
  averageGrowth: '平均增长率',
  averageCompetition: '平均竞品数量',
  averageSellers: '平均卖家数量',
  averageConversion: '平均转化率',
  estimatedUnitProfitRub: '预估单件基础利润',
  estimatedUnitProfitRate: '预估基础利润率',
});

function compactOverview(overview = {}) {
  return compactDefined(Object.entries(OVERVIEW_LABELS).map(([key, label]) => [
    label,
    finite(overview?.[key]),
  ]));
}

function recordIdentity(record = {}, index = 0) {
  return text(record.sku || record.id || record.query) || `record-${index}`;
}

function representativeRecords(records = [], kind = '', maxRecords = 40) {
  const source = Array.isArray(records) ? records : [];
  const metrics = kind === 'keywords'
    ? ['searchVolume', 'count30GrowthRate', 'opportunityScore', 'searchUsersToOrdUsers']
    : ['revenue', 'sales', 'salesRate', 'stock', 'returnCancelRate'];
  const selected = [];
  const seen = new Set();
  const append = (record, index) => {
    const id = recordIdentity(record, index);
    if (seen.has(id) || selected.length >= maxRecords) return;
    seen.add(id);
    selected.push(record);
  };
  source.slice(0, 20).forEach(append);
  metrics.forEach((field) => {
    [...source]
      .filter((record) => finite(record?.[field]) !== null)
      .sort((left, right) => Number(right?.[field]) - Number(left?.[field]))
      .slice(0, 20)
      .forEach(append);
  });
  return selected;
}

function fitRepresentativeRecords(records = [], maxChars = 42_000) {
  const selected = [];
  let usedChars = 2;
  for (const record of records) {
    const serialized = JSON.stringify(record);
    const nextSize = serialized.length + (selected.length ? 1 : 0);
    if (selected.length && usedChars + nextSize > maxChars) break;
    selected.push(record);
    usedChars += nextSize;
  }
  return selected;
}

export function createSmartToolExternalOzonInsightRequest(tool = {}, draft = {}, modelSelection = {}) {
  if (!modelSelection?.ready || !text(modelSelection.accountId) || !text(modelSelection.model)) {
    throw new Error('没有可用的分析模型，请先在左侧选择已配置的文本模型。');
  }
  const result = draft?.result || {};
  const analysis = result.keywordAnalysis || result.externalAnalysis;
  if (!analysis || !Array.isArray(analysis.records) || !analysis.records.length) {
    throw new Error('当前没有可供模型分析的真实数据。');
  }
  const kind = analysis.kind === 'keywords' ? 'keywords' : 'products';
  const insightConfig = normalizeExternalOzonInsightConfig(
    tool?.promptConfig?.externalInsightConfig,
    { toolId: tool.id }
  );
  const selectedRecords = fitRepresentativeRecords(
    representativeRecords(analysis.records, kind, insightConfig.sampleMaxRecords)
      .map(kind === 'keywords' ? compactKeyword : compactProduct),
    insightConfig.sampleMaxChars
  );
  const analysisMode = normalizeExternalProductAnalysisMode(analysis.analysisMode);
  const hasAnalysisModes = Boolean(insightConfig.analysisModes);
  const analysisModeLabel = hasAnalysisModes
    ? text(analysis.analysisModeLabel) || externalProductAnalysisModeLabel(analysisMode)
    : '当前工具默认分析';
  const modeConfig = hasAnalysisModes ? insightConfig.analysisModes?.[analysisMode] || null : null;
  return {
    accountId: text(modelSelection.accountId),
    model: text(modelSelection.model),
    templateId: 'external-ozon-insight.v1',
    templateInput: {
      toolId: text(tool.id),
      toolTitle: text(tool.title) || text(tool.id),
      analysisMode: analysisModeLabel,
      resultSummary: text(result.summary),
      querySummary: text(analysis.querySummary || result.keywordAnalysis?.querySummary),
      recordCount: analysis.records.length,
      overview: compactOverview(analysis.overview),
      initialInsights: analysis.insights || [],
      records: selectedRecords,
    },
    customRules: JSON.stringify({
      analysisGoals: modeConfig
        ? [...insightConfig.analysisGoals, ...modeConfig.analysisGoals]
        : insightConfig.analysisGoals,
      workflowSteps: modeConfig
        ? [...insightConfig.workflowSteps, ...modeConfig.workflowSteps]
        : insightConfig.workflowSteps,
      analysisRules: modeConfig
        ? [...insightConfig.analysisRules, ...modeConfig.analysisRules]
        : insightConfig.analysisRules,
      reportStyleRules: insightConfig.reportStyleRules,
      outputSections: insightConfig.outputSections,
      outputRules: insightConfig.outputRules,
      userRules: insightConfig.systemPrompt,
      userInstruction: insightConfig.userPrompt,
    }),
  };
}

export async function runSmartToolExternalOzonInsight(tool = {}, draft = {}, modelSelection = {}, options = {}) {
  const request = createSmartToolExternalOzonInsightRequest(tool, draft, modelSelection);
  const response = await requestLocalApi('/api/integrations/analyze', {
    method: 'POST',
    body: request,
    timeoutMs: options.timeoutMs || EXTERNAL_OZON_INSIGHT_REQUEST_TIMEOUT_MS,
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
