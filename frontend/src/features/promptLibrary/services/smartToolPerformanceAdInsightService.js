import { requestLocalApi } from '../../../api/localApiClient.js';
import { parseSmartToolExternalOzonInsightReport } from './smartToolExternalOzonInsightService.js';

const PERFORMANCE_AD_INSIGHT_TIMEOUT_MS = 300_000;

function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
    .map((item) => text(item))
    .filter(Boolean)
    .map((item) => `- ${item}`)
    .join('\n');
}

function compactMetrics(metrics = {}) {
  return compactDefined([
    ['展示量', finite(metrics.impressions)],
    ['点击量', finite(metrics.clicks)],
    ['广告花费（卢布）', finite(metrics.spent)],
    ['广告订单', finite(metrics.orders)],
    ['广告归因销售额（卢布）', finite(metrics.revenue)],
    ['点击率（%）', finite(metrics.ctr)],
    ['单次点击成本（卢布）', finite(metrics.cpc)],
    ['点击到下单转化率（%）', finite(metrics.cvr)],
    ['单个广告订单成本（卢布）', finite(metrics.cpo)],
    ['广告费用占归因销售额比例（%）', finite(metrics.acos)],
    ['广告投入产出比', finite(metrics.roas)],
  ]);
}

function compactProduct(product = {}) {
  return compactDefined([
    ['商品', text(product.title || product.name)],
    ['商品编号', text(product.sku || product.offerId)],
    ['状态', text(product.statusLabel || product.status)],
    ['指标', compactMetrics(product)],
  ]);
}

function compactCampaign(campaign = {}) {
  const source = campaign.source || {};
  return compactDefined([
    ['计划名称', text(campaign.title)],
    ['计划编号', text(campaign.id)],
    ['状态', text(campaign.statusLabel)],
    ['类型', text(campaign.typeLabel)],
    ['指标', compactMetrics(campaign.metrics)],
    ['程序初步发现', (campaign.signals || []).map((signal) => compactDefined([
      ['重要程度', text(signal.severity)],
      ['发现', text(signal.title)],
      ['数据依据', text(signal.detail)],
      ['建议动作', text(signal.action)],
    ]))],
    ['推广商品', (source.products || []).slice(0, 20).map(compactProduct)],
  ]);
}

export function compactPerformanceAdAnalysisForModel(analysis = {}) {
  return compactDefined([
    ['推广账号', text(analysis.account?.title)],
    ['统计范围', text(analysis.scopeText)],
    ['本次分析计划数量', finite(analysis.campaignCount)],
    ['账号全部计划数量', finite(analysis.totalCampaignCount)],
    ['整体指标', compactMetrics(analysis.metrics)],
    ['趋势判断', compactDefined([
      ['是否有足够趋势数据', analysis.trend?.available === true ? '是' : '否'],
      ['当前结果', text(analysis.trend?.label)],
      ['数据说明', text(analysis.trend?.detail)],
      ['花费变化（%）', finite(analysis.trend?.spendChange)],
      ['订单变化（%）', finite(analysis.trend?.orderChange)],
    ])],
    ['计划明细', (analysis.campaignDiagnostics || []).slice(0, 50).map(compactCampaign)],
    ['暂缺数据', (analysis.missingFields || []).map(text).filter(Boolean)],
    ['读取说明', (analysis.readIssueSummary || []).map(text).filter(Boolean)],
  ]);
}

function modelSelectionReady(modelSelection = {}) {
  return Boolean(modelSelection.ready && text(modelSelection.accountId) && text(modelSelection.model));
}

export function createPerformanceAdInsightRequest(tool = {}, analysis = {}, modelSelection = {}) {
  if (!modelSelectionReady(modelSelection)) {
    throw new Error('没有可用的分析模型，请先在左侧选择已配置的文本模型。');
  }
  if (!analysis || !Array.isArray(analysis.campaignDiagnostics) || !analysis.campaignDiagnostics.length) {
    throw new Error('当前没有可供 Skill 分析的广告计划数据。');
  }
  const promptConfig = tool?.promptConfig || {};
  const skillFacts = compactPerformanceAdAnalysisForModel(analysis);
  const workflowSteps = listLines(promptConfig.workflowSteps || tool?.skillProfile?.workflowSteps);
  const outputRules = listLines(promptConfig.outputRules);
  const safetyRules = listLines(promptConfig.safetyRules || tool?.skillProfile?.safetyNotes);
  return {
    accountId: text(modelSelection.accountId),
    model: text(modelSelection.model),
    templateId: 'performance-ad-insight.v1',
    templateInput: {
      account: analysis.account?.title || '',
      scope: analysis.scopeText || '',
      campaignScope: analysis.campaignQuery ? 'selected' : 'all',
      facts: skillFacts,
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

export async function runPerformanceAdInsight(tool = {}, analysis = {}, modelSelection = {}, options = {}) {
  const request = createPerformanceAdInsightRequest(tool, analysis, modelSelection);
  const response = await requestLocalApi('/api/integrations/analyze', {
    method: 'POST',
    body: request,
    timeoutMs: options.timeoutMs || PERFORMANCE_AD_INSIGHT_TIMEOUT_MS,
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
