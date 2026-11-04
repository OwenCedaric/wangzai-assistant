import {
  listPerformanceAccounts,
  readPerformanceOverview,
} from '../../../api/localApiClient.js';
import {
  analyzeSmartToolPerformanceAds,
  SMART_TOOL_PERFORMANCE_AD_ANALYZER_ID,
} from '../lib/smartToolPerformanceAdAnalysis.js';
import { requirePaidPromotionAiSnapshot } from '../../paidPromotion/lib/paidPromotionAiSnapshot.js';
import { runPerformanceAdInsight } from './smartToolPerformanceAdInsightService.js';

const PERFORMANCE_AD_OVERVIEW_TIMEOUT_MS = 300_000;

export const PERFORMANCE_AD_USAGE_LABELS = Object.freeze({
  account: '推广账号（可选）',
  campaign: '广告计划名称或 ID（可选）',
  dateRange: '统计范围',
});

function normalizeText(value) {
  return String(value ?? '').trim();
}

function isLocalApiTimeout(error) {
  return error?.code === 'LOCAL_API_TIMEOUT'
    || /本地\s*API\s*请求超时|local-api\s*请求超时|timeout/iu.test(normalizeText(error?.message));
}

function normalizePerformanceAccount(record = {}, index = 0) {
  const values = record.values && typeof record.values === 'object' ? record.values : {};
  const clientId = normalizeText(
    record.clientId || record.clientIdMasked || values.performanceClientId || values.clientId || values.client_id,
  );
  const hasClientId = Boolean(record.hasClientId ?? clientId);
  const hasClientSecret = Boolean(
    record.hasClientSecret
    ?? record.clientSecretHint
    ?? values.hasClientSecret,
  );
  return {
    ...record,
    id: normalizeText(record.id || record.accountId) || `performance-${index + 1}`,
    shopId: normalizeText(record.shopId || record.shop_id || values.shopId || values.shop_id),
    title: normalizeText(record.title || record.name || values.platformName) || `Ozon Performance API ${index + 1}`,
    clientId,
    hasClientId,
    hasClientSecret,
    configured: hasClientId && hasClientSecret,
    updatedAt: normalizeText(record.updatedAt || record.updated_at || record.createdAt || record.created_at),
  };
}

export function listConfiguredPerformanceAdAccounts(payload = {}, { shopId = '' } = {}) {
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.accounts)
      ? payload.accounts
      : Array.isArray(payload?.rows)
        ? payload.rows
        : [];
  return records
    .map(normalizePerformanceAccount)
    .filter((account) => account.configured)
    .filter((account) => !shopId || account.shopId === normalizeText(shopId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function selectPerformanceAdAccount(accounts = [], query = '') {
  const rows = Array.isArray(accounts) ? accounts : [];
  const keyword = normalizeText(query).toLocaleLowerCase();
  if (!keyword) return rows[0] || null;
  return rows.find((account) => account.id.toLocaleLowerCase() === keyword)
    || rows.find((account) => account.title.toLocaleLowerCase() === keyword)
    || rows.find((account) => account.title.toLocaleLowerCase().includes(keyword))
    || null;
}

export async function loadPerformanceAdAccounts(options = {}) {
  const payload = await listPerformanceAccounts({
    timeoutMs: options.timeoutMs || 10000,
    signal: options.signal,
  });
  return listConfiguredPerformanceAdAccounts(payload, { shopId: options.shopId });
}

export function normalizePerformanceCampaignOption(record = {}, index = 0) {
  const id = normalizeText(record.id || record.campaignId || record.campaign_id);
  if (!id) return null;
  const title = normalizeText(record.title || record.name) || `未命名计划 ${index + 1}`;
  const statusLabel = normalizeText(record.statusLabel || record.statusText || record.status);
  const typeLabel = normalizeText(record.typeLabel || record.type);
  return {
    id,
    value: id,
    title,
    statusLabel,
    typeLabel,
    label: statusLabel ? `${title} · ${statusLabel}` : title,
  };
}

export function listPerformanceAdCampaignOptions(payload = {}) {
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.campaigns)
      ? payload.campaigns
      : [];
  const seenIds = new Set();
  return records
    .map(normalizePerformanceCampaignOption)
    .filter((campaign) => {
      if (!campaign || seenIds.has(campaign.id)) return false;
      seenIds.add(campaign.id);
      return true;
    });
}

export function selectPerformanceAdCampaign(campaigns = [], query = '') {
  const rows = Array.isArray(campaigns) ? campaigns : [];
  const keyword = normalizeText(query).toLocaleLowerCase();
  if (!keyword) return null;
  return rows.find((campaign) => campaign.id.toLocaleLowerCase() === keyword)
    || rows.find((campaign) => campaign.title.toLocaleLowerCase() === keyword)
    || rows.find((campaign) => campaign.title.toLocaleLowerCase().includes(keyword))
    || null;
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

export function resolvePerformanceAdDateRange(value = '7', { now = new Date() } = {}) {
  const normalized = normalizeText(value);
  const dayMatch = normalized.match(/(7|14|30)/u);
  const days = Number(dayMatch?.[1] || 7);
  const dateTo = new Date(now);
  const dateFrom = new Date(dateTo);
  dateFrom.setUTCDate(dateFrom.getUTCDate() - (days - 1));
  return {
    days,
    dateFrom: toDateString(dateFrom),
    dateTo: toDateString(dateTo),
  };
}

export async function loadPerformanceAdCampaignOptions(accountOrId = '', options = {}) {
  const accountId = normalizeText(
    typeof accountOrId === 'string' ? accountOrId : accountOrId?.id,
  );
  if (!accountId) return [];
  const accountTitle = typeof accountOrId === 'string'
    ? ''
    : normalizeText(accountOrId?.title);
  const dateRange = resolvePerformanceAdDateRange('7', {
    now: options.now || new Date(),
  });
  const overview = await readPerformanceOverview({
    type: 'ozon-performance',
    values: {
      accountId,
      shopName: accountTitle,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
      readDepth: 'fast',
    },
  }, {
    timeoutMs: options.timeoutMs || 60000,
    signal: options.signal,
  });
  if (!overview || overview.ok === false) {
    throw new Error(normalizeText(overview?.error?.message || overview?.message) || '广告计划读取失败。');
  }
  return listPerformanceAdCampaignOptions(overview);
}

export function canUseSmartToolPerformanceAdData(toolOrId = '') {
  const toolId = typeof toolOrId === 'string' ? toolOrId : toolOrId?.id;
  return normalizeText(toolId) === SMART_TOOL_PERFORMANCE_AD_ANALYZER_ID;
}

function formatCreatedAt(date = new Date()) {
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function createNoAccountError() {
  return new Error('没有可用的 Ozon Performance API 账号。请先在「设置 → 平台接口」填写 client_id 和 client_secret。');
}

export async function runSmartToolDraftWithPerformanceAdData(tool = {}, values = {}, options = {}) {
  if (!canUseSmartToolPerformanceAdData(tool)) {
    throw new Error('当前智能工具没有配置 Ozon Performance API 广告数据源。');
  }

  const accounts = await loadPerformanceAdAccounts({
    timeoutMs: options.accountTimeoutMs || 10000,
    signal: options.signal,
    shopId: options.shopId,
  });
  if (!accounts.length) throw createNoAccountError();

  const accountQuery = normalizeText(values[PERFORMANCE_AD_USAGE_LABELS.account]);
  const account = selectPerformanceAdAccount(accounts, accountQuery);
  if (!account) {
    throw new Error(`没有找到推广账号“${accountQuery}”。可用账号：${accounts.map((item) => item.title).join('、')}。`);
  }

  const dateRange = resolvePerformanceAdDateRange(values[PERFORMANCE_AD_USAGE_LABELS.dateRange], {
    now: options.now || new Date(),
  });
  const campaignQuery = normalizeText(values[PERFORMANCE_AD_USAGE_LABELS.campaign]);
  options.onStage?.({
    statusLabel: '正在读取真实广告数据',
    summary: campaignQuery
      ? '正在读取当前选择计划的商品和统计数据…'
      : '正在读取全部广告计划的商品和统计数据…',
  });
  let overview;
  try {
    overview = await readPerformanceOverview({
      type: 'ozon-performance',
      values: {
        accountId: account.id,
        shopName: account.title,
        dateFrom: dateRange.dateFrom,
        dateTo: dateRange.dateTo,
        readDepth: 'ai',
        campaignId: campaignQuery,
        includeCampaignObjects: false,
      },
    }, {
      timeoutMs: options.timeoutMs || PERFORMANCE_AD_OVERVIEW_TIMEOUT_MS,
      signal: options.signal,
    });
  } catch (error) {
    if (isLocalApiTimeout(error)) {
      throw new Error('真实广告数据读取时间过长，请重新运行；系统没有把缺失数据按 0 处理。', { cause: error });
    }
    throw error;
  }
  if (!overview || overview.ok === false) {
    throw new Error(normalizeText(overview?.error?.message || overview?.message) || 'Ozon Performance API 没有返回有效广告数据。');
  }
  requirePaidPromotionAiSnapshot(
    overview,
    options.now instanceof Date ? options.now.getTime() : Date.now(),
  );

  const analysis = analyzeSmartToolPerformanceAds({
    overview,
    campaignQuery: values[PERFORMANCE_AD_USAGE_LABELS.campaign],
    account,
  });
  options.onStage?.({
    statusLabel: '真实广告数据已读取，正在执行 Skill 分析',
    summary: `已读取 ${analysis.campaignCount} 个计划，正在调用 ${options.modelSelection?.model || '分析模型'}生成最终报告…`,
  });
  let performanceAdInsight;
  try {
    performanceAdInsight = await runPerformanceAdInsight(
      tool,
      analysis,
      options.modelSelection,
      { signal: options.signal, timeoutMs: options.modelTimeoutMs },
    );
  } catch (error) {
    if (isLocalApiTimeout(error)) {
      throw new Error('真实广告数据已读取，但分析模型响应超时。请重新运行或切换文本模型。', { cause: error });
    }
    throw error;
  }
  const campaignLabel = campaignQuery
    ? analysis.campaignDiagnostics?.[0]?.title || campaignQuery
    : '全部计划';

  return {
    toolId: normalizeText(tool.id) || SMART_TOOL_PERFORMANCE_AD_ANALYZER_ID,
    toolTitle: normalizeText(tool.title) || 'Ozon 广告分析',
    createdAt: formatCreatedAt(options.now || new Date()),
    inputText: [
      `${PERFORMANCE_AD_USAGE_LABELS.account}：${account.title}`,
      `${PERFORMANCE_AD_USAGE_LABELS.campaign}：${campaignLabel}`,
      `${PERFORMANCE_AD_USAGE_LABELS.dateRange}：最近 ${dateRange.days} 天`,
    ].join('\n'),
    result: {
      status: 'ready',
      statusLabel: 'Ozon 广告 Skill 分析完成',
      summary: performanceAdInsight.report?.executiveSummary || analysis.summary,
      viewType: 'performance-ads',
      source: overview.source || 'ozon-performance-realtime',
      provider: overview.provider || 'Ozon Performance API',
      readDepth: overview.readDepth || 'full',
      account: analysis.account,
      dateRange: analysis.dateRange,
      performanceAdAnalysis: analysis,
      performanceAdInsight,
      analysisModel: performanceAdInsight.model,
      sections: analysis.sections,
      nextActions: analysis.nextActions,
    },
  };
}
