export const SMART_TOOL_PERFORMANCE_AD_ANALYZER_ID = 'ozon-ad-analyzer';

const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, info: 3, positive: 4 });

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMetric(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function ratioPercent(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? roundMetric((numerator / denominator) * 100)
    : null;
}

function ratio(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? roundMetric(numerator / denominator)
    : null;
}

function metricFrom(source = {}, key) {
  return normalizeMetric(source?.[key]);
}

function getCampaignMetricSource(campaign = {}) {
  return campaign?.statistics && typeof campaign.statistics === 'object'
    ? campaign.statistics
    : campaign;
}

export function calculatePerformanceAdMetrics(source = {}) {
  const impressions = metricFrom(source, 'impressions');
  const clicks = metricFrom(source, 'clicks');
  const spent = metricFrom(source, 'spent');
  const orders = metricFrom(source, 'orders');
  const revenue = metricFrom(source, 'revenue');

  return {
    impressions,
    clicks,
    spent,
    orders,
    revenue,
    ctr: ratioPercent(clicks, impressions) ?? metricFrom(source, 'ctr'),
    cpc: ratio(spent, clicks) ?? metricFrom(source, 'cpc'),
    cvr: ratioPercent(orders, clicks) ?? metricFrom(source, 'cvr'),
    cpo: ratio(spent, orders) ?? metricFrom(source, 'cpo'),
    acos: ratioPercent(spent, revenue) ?? metricFrom(source, 'acos'),
    roas: ratio(revenue, spent) ?? metricFrom(source, 'roas'),
  };
}

function median(values = []) {
  const numbers = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function isModerationRejected(campaign = {}) {
  const status = `${campaign.statusLabel || ''} ${campaign.statusText || ''} ${campaign.reviewReason || ''}`;
  return campaign.alerts?.moderationRejected === true || /审核失败|拒绝|驳回|rejected|declined/iu.test(status);
}

function isBudgetExhausted(campaign = {}) {
  const status = `${campaign.budgetStatus || ''} ${campaign.statusText || ''}`;
  return campaign.alerts?.budgetExhausted === true || /预算花完|预算耗尽|budget[^\n]*exhaust/iu.test(status);
}

function createSignal(code, severity, title, detail, action) {
  return { code, severity, title, detail, action };
}

function diagnoseCampaign(campaign, cpcMedian) {
  const metrics = calculatePerformanceAdMetrics(getCampaignMetricSource(campaign));
  const signals = [];
  const rejected = isModerationRejected(campaign);
  const budgetExhausted = isBudgetExhausted(campaign);

  if (rejected) {
    signals.push(createSignal(
      'moderation-rejected',
      'critical',
      '审核失败',
      campaign.reviewReason || campaign.statusText || '计划未通过审核，当前无法正常投放。',
      '先处理审核原因并重新提交，不要先调预算。',
    ));
  }
  if (metrics.spent > 0 && Number.isFinite(metrics.orders) && metrics.orders <= 0) {
    signals.push(createSignal(
      'spent-without-orders',
      'critical',
      '有花费无订单',
      `已花费 ${formatRub(metrics.spent)}，当前统计范围内没有广告订单。`,
      '核对搜索词、商品价格、主图和详情页；继续投放前先压低出价或暂停浪费流量。',
    ));
  }
  if (metrics.ctr !== null && metrics.impressions > 0 && metrics.ctr < 1) {
    signals.push(createSignal(
      'low-ctr',
      'high',
      '点击率偏低',
      `CTR ${formatPercent(metrics.ctr)}，展示没有有效转成点击。`,
      '优先调整主图、标题、价格力和投放对象，再观察同等展示量下的点击变化。',
    ));
  }
  if (metrics.cvr !== null && metrics.clicks >= 20 && metrics.cvr < 2) {
    signals.push(createSignal(
      'low-cvr',
      'high',
      '点击后转化偏低',
      `已有 ${formatInteger(metrics.clicks)} 次点击，CVR 仅 ${formatPercent(metrics.cvr)}。`,
      '检查商品承接页、价格、评价、库存和配送时效，避免只靠加价抢流量。',
    ));
  }
  if (metrics.acos !== null && metrics.acos > 50) {
    signals.push(createSignal(
      'high-acos',
      'high',
      'ACOS 过高',
      `ACOS ${formatPercent(metrics.acos)}，每 100 卢布广告归因销售额消耗超过 50 卢布。`,
      '下调高消耗低转化对象的出价，并结合商品真实毛利率决定暂停线。',
    ));
  } else if (metrics.acos !== null && metrics.acos >= 30) {
    signals.push(createSignal(
      'watch-acos',
      'medium',
      'ACOS 需要观察',
      `ACOS ${formatPercent(metrics.acos)}，是否可接受取决于商品真实毛利率。`,
      '补充毛利率后再设目标 ACOS，先处理无订单或低转化对象。',
    ));
  }
  if (metrics.roas !== null && metrics.spent > 0 && metrics.roas < 2) {
    signals.push(createSignal(
      'low-roas',
      'medium',
      '广告产出偏低',
      `ROAS ${formatNumber(metrics.roas)}，每 1 卢布广告花费带来的归因销售额不足 2 卢布。`,
      '拆分计划或商品查看消耗集中点，把预算从低产出对象移到有效对象。',
    ));
  }
  if (
    metrics.cpc !== null
    && cpcMedian !== null
    && metrics.clicks >= 5
    && metrics.cpc > cpcMedian * 1.5
  ) {
    signals.push(createSignal(
      'high-relative-cpc',
      'medium',
      '单次点击成本高于同批计划',
      `CPC ${formatRub(metrics.cpc)}，比同批计划中位数 ${formatRub(cpcMedian)} 高 50% 以上。`,
      '检查出价和投放对象，避免在相近转化水平下为点击支付过高成本。',
    ));
  }
  if (budgetExhausted) {
    if (metrics.orders > 0 && metrics.acos !== null && metrics.acos <= 30) {
      signals.push(createSignal(
        'healthy-budget-exhausted',
        'positive',
        '预算耗尽但效率健康',
        `计划预算已耗尽，ACOS ${formatPercent(metrics.acos)}，当前有 ${formatInteger(metrics.orders)} 个订单。`,
        '确认毛利能够覆盖当前 ACOS 后，可分次小幅增加预算并持续观察。',
      ));
    } else {
      signals.push(createSignal(
        'budget-exhausted',
        'medium',
        '预算已耗尽',
        '计划预算已经花完，但当前效率不足以直接判断应放量。',
        '先修复转化或高 ACOS 问题，再决定是否补预算。',
      ));
    }
  }
  if (!signals.length && metrics.spent > 0 && metrics.orders > 0) {
    signals.push(createSignal(
      'stable',
      'positive',
      '当前未发现明显异常',
      '计划已有花费和订单，核心效率指标没有命中当前风险规则。',
      '保持预算稳定，继续观察更长周期并结合毛利率设定目标 ACOS。',
    ));
  } else if (!signals.length && [metrics.impressions, metrics.clicks, metrics.spent, metrics.orders]
    .every((value) => value === null)) {
    signals.push(createSignal(
      'insufficient-statistics',
      'info',
      '统计数据暂时不足',
      '当前计划基础信息已读取，但展示、点击、花费和订单统计没有返回。',
      '暂不调整预算和出价，先重新读取统计或扩大统计时间范围。',
    ));
  }

  signals.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]);
  return {
    id: normalizeText(campaign.id),
    title: normalizeText(campaign.title) || `广告计划 ${normalizeText(campaign.id) || '未命名'}`,
    statusLabel: normalizeText(campaign.statusLabel) || '状态未返回',
    typeLabel: normalizeText(campaign.typeLabel || campaign.type) || '类型未返回',
    budgetExhausted,
    moderationRejected: rejected,
    metrics,
    signals,
    primarySignal: signals[0] || null,
    source: campaign,
  };
}

function sumCampaignMetrics(campaigns = []) {
  const keys = ['impressions', 'clicks', 'spent', 'orders', 'revenue'];
  const total = campaigns.reduce((result, campaign) => {
    const metrics = calculatePerformanceAdMetrics(getCampaignMetricSource(campaign));
    keys.forEach((key) => {
      if (!Number.isFinite(metrics[key])) return;
      result[key] = (result[key] ?? 0) + metrics[key];
    });
    return result;
  }, { impressions: null, clicks: null, spent: null, orders: null, revenue: null });
  return calculatePerformanceAdMetrics(total);
}

function sumTrendMetrics(rows = []) {
  const keys = ['impressions', 'clicks', 'spent', 'orders', 'revenue'];
  return calculatePerformanceAdMetrics(rows.reduce((total, row) => {
    keys.forEach((key) => {
      const value = normalizeMetric(row?.[key]);
      if (!Number.isFinite(value)) return;
      total[key] = (total[key] ?? 0) + value;
    });
    return total;
  }, { impressions: null, clicks: null, spent: null, orders: null, revenue: null }));
}

export function filterPerformanceAdCampaigns(campaigns = [], query = '') {
  const rows = Array.isArray(campaigns) ? campaigns : [];
  const keyword = normalizeText(query).toLocaleLowerCase();
  if (!keyword) return rows;
  const exactId = rows.filter((campaign) => normalizeText(campaign?.id).toLocaleLowerCase() === keyword);
  if (exactId.length) return exactId;
  const exactTitle = rows.filter((campaign) => normalizeText(campaign?.title).toLocaleLowerCase() === keyword);
  if (exactTitle.length) return exactTitle;
  return rows.filter((campaign) => [campaign?.id, campaign?.title]
    .some((value) => normalizeText(value).toLocaleLowerCase().includes(keyword)));
}

function summarizeTrend(dailyTrend = []) {
  const rows = (Array.isArray(dailyTrend) ? dailyTrend : [])
    .filter((row) => normalizeText(row?.date))
    .sort((left, right) => normalizeText(left.date).localeCompare(normalizeText(right.date)));
  if (rows.length < 2) {
    return {
      available: false,
      label: '趋势数据不足',
      detail: '当前返回的有效日统计少于 2 天，暂不判断上升或下降趋势。',
    };
  }
  const middle = Math.floor(rows.length / 2);
  const previous = sumTrendMetrics(rows.slice(0, middle));
  const recentRows = rows.slice(middle);
  const recent = sumTrendMetrics(recentRows);
  const spendChange = previous.spent > 0 ? ((recent.spent / recentRows.length) / (previous.spent / middle) - 1) * 100 : null;
  const orderChange = previous.orders > 0 ? ((recent.orders / recentRows.length) / (previous.orders / middle) - 1) * 100 : null;
  const direction = orderChange !== null && orderChange >= 10
    ? '订单趋势上升'
    : orderChange !== null && orderChange <= -10
      ? '订单趋势下降'
      : '订单趋势基本稳定';
  return {
    available: true,
    label: direction,
    previous,
    recent,
    spendChange: roundMetric(spendChange),
    orderChange: roundMetric(orderChange),
    detail: `前半段日均花费 ${formatRub(Number.isFinite(previous.spent) ? previous.spent / middle : null)}、日均订单 ${formatNumber(Number.isFinite(previous.orders) ? previous.orders / middle : null)}；后半段日均花费 ${formatRub(Number.isFinite(recent.spent) ? recent.spent / recentRows.length : null)}、日均订单 ${formatNumber(Number.isFinite(recent.orders) ? recent.orders / recentRows.length : null)}。`,
  };
}

function collectDailyTrend(overview = {}, campaignIds = []) {
  const idSet = new Set(campaignIds.map(normalizeText).filter(Boolean));
  const dailyStats = Array.isArray(overview.dailyStats) ? overview.dailyStats : [];
  if (idSet.size && dailyStats.length) {
    const matched = dailyStats.filter((row) => idSet.has(normalizeText(row?.campaignId)));
    if (matched.length) return matched;
  }
  return Array.isArray(overview.dailyTrend) ? overview.dailyTrend : [];
}

function formatCampaignLine(campaign) {
  const metrics = campaign.metrics;
  const signal = campaign.primarySignal;
  return [
    `${campaign.title}（${campaign.statusLabel}）`,
    `花费 ${formatRub(metrics.spent)} / 销售额 ${formatRub(metrics.revenue)} / 订单 ${formatInteger(metrics.orders)}`,
    `CTR ${formatPercent(metrics.ctr)} / CPC ${formatRub(metrics.cpc)} / CVR ${formatPercent(metrics.cvr)} / CPO ${formatRub(metrics.cpo)} / ACOS ${formatPercent(metrics.acos)} / ROAS ${formatNumber(metrics.roas)}`,
    signal ? `判断：${signal.title}；${signal.action}` : '',
  ].filter(Boolean).join('；');
}

function summarizeReadIssues(readIssues = []) {
  const rows = Array.isArray(readIssues) ? readIssues : [];
  if (!rows.length) return [];
  const planIssues = rows.filter((issue) => normalizeText(issue?.campaignId));
  const statisticIssues = rows.length - planIssues.length;
  return [
    planIssues.length ? `${planIssues.length} 个计划的扩展明细暂未返回，计划基础信息和已成功读取的统计仍然有效。` : '',
    statisticIssues ? `${statisticIssues} 项统计数据暂未返回，相关指标会显示为“暂无数据”，不会按 0 计算。` : '',
  ].filter(Boolean);
}

export function formatRub(value) {
  const number = normalizeMetric(value);
  if (number === null) return '未返回';
  return `₽${number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value) {
  const number = normalizeMetric(value);
  return number === null ? '未返回' : `${formatNumber(number)}%`;
}

export function formatNumber(value) {
  const number = normalizeMetric(value);
  return number === null
    ? '未返回'
    : number.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function formatInteger(value) {
  const number = normalizeMetric(value);
  return number === null ? '未返回' : Math.round(number).toLocaleString('zh-CN');
}

export function analyzeSmartToolPerformanceAds({
  overview = {},
  campaigns = overview?.campaigns,
  campaignQuery = '',
  account = null,
} = {}) {
  const allCampaigns = Array.isArray(campaigns) ? campaigns : [];
  const selectedCampaigns = filterPerformanceAdCampaigns(allCampaigns, campaignQuery);
  const cpcMedian = median(selectedCampaigns
    .map((campaign) => calculatePerformanceAdMetrics(getCampaignMetricSource(campaign)).cpc)
    .filter(Number.isFinite));
  const campaignDiagnostics = selectedCampaigns.map((campaign) => diagnoseCampaign(campaign, cpcMedian));
  const metrics = sumCampaignMetrics(selectedCampaigns);
  const signals = campaignDiagnostics.flatMap((campaign) => campaign.signals.map((signal) => ({
    ...signal,
    campaignId: campaign.id,
    campaignTitle: campaign.title,
  })));
  const riskSignals = signals
    .filter((signal) => ['critical', 'high', 'medium'].includes(signal.severity))
    .sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]);
  const actionSignals = [...new Map(signals.map((signal) => [signal.action, signal])).values()];
  const readIssues = Array.isArray(overview?.readIssues) ? overview.readIssues : [];
  const readIssueSummary = summarizeReadIssues(readIssues);
  const trend = summarizeTrend(collectDailyTrend(overview, selectedCampaigns.map((campaign) => campaign.id)));
  const dateRange = overview?.dateRange || {};
  const queryText = normalizeText(campaignQuery);
  const scopeText = `${dateRange.dateFrom || '未返回'} 至 ${dateRange.dateTo || '未返回'}`;
  const missingFields = [];
  if (!selectedCampaigns.length) missingFields.push(queryText ? '没有匹配到广告计划' : '没有返回广告计划');
  if (metrics.impressions === null) missingFields.push('展示量');
  if (metrics.clicks === null) missingFields.push('点击量');
  if (metrics.spent === null) missingFields.push('广告花费');
  if (metrics.revenue === null) missingFields.push('广告归因销售额');
  if (readIssues.length) missingFields.push(`${readIssues.length} 项扩展数据`);

  const summary = selectedCampaigns.length
    ? `已分析 ${selectedCampaigns.length} 个广告计划：花费 ${formatRub(metrics.spent)}，归因销售额 ${formatRub(metrics.revenue)}，订单 ${formatInteger(metrics.orders)}，ACOS ${formatPercent(metrics.acos)}，ROAS ${formatNumber(metrics.roas)}；发现 ${riskSignals.length} 个需处理问题。`
    : queryText
      ? `没有找到名称或 ID 包含“${queryText}”的广告计划。`
      : 'Performance API 没有返回可分析的广告计划。';

  return {
    kind: 'performance-ad-analysis',
    source: overview?.source || '',
    provider: overview?.provider || '',
    account: account ? { id: account.id, title: account.title } : null,
    campaignQuery: queryText,
    dateRange,
    scopeText,
    campaignCount: selectedCampaigns.length,
    totalCampaignCount: Number(overview?.campaignScope?.totalCount) || allCampaigns.length,
    metrics,
    cpcMedian: roundMetric(cpcMedian),
    campaignDiagnostics,
    signals,
    riskSignals,
    trend,
    readIssues,
    readIssueSummary,
    missingFields,
    summary,
    sections: [
      {
        title: '分析范围',
        rows: [
          `推广账号：${account?.title || account?.id || '未返回'}`,
          `统计范围：${scopeText}`,
          `计划范围：${queryText ? '当前选择的广告计划' : '全部广告计划'}（本次分析 ${selectedCampaigns.length} 个）`,
          `数据源：${overview?.provider || 'Ozon Performance API'}；本次数据为实时读取。`,
        ],
      },
      {
        title: '整体表现',
        rows: [
          `展示 ${formatInteger(metrics.impressions)} / 点击 ${formatInteger(metrics.clicks)} / CTR ${formatPercent(metrics.ctr)} / CPC ${formatRub(metrics.cpc)}`,
          `花费 ${formatRub(metrics.spent)} / 订单 ${formatInteger(metrics.orders)} / CVR ${formatPercent(metrics.cvr)} / CPO ${formatRub(metrics.cpo)}`,
          `归因销售额 ${formatRub(metrics.revenue)} / ACOS ${formatPercent(metrics.acos)} / ROAS ${formatNumber(metrics.roas)}`,
          'ACOS 需要与商品真实毛利率一起判断；当前报告没有毛利数据，盈亏结论需在补充毛利率后判断。',
        ],
      },
      {
        title: '主要问题',
        rows: riskSignals.length
          ? riskSignals.map((signal) => `${signal.campaignTitle}：${signal.title}。${signal.detail}`)
          : ['当前数据没有命中高优先级广告风险规则；仍需结合毛利、自然单和更长周期复核。'],
      },
      {
        title: '计划诊断',
        rows: campaignDiagnostics.length ? campaignDiagnostics.map(formatCampaignLine) : ['没有可展示的广告计划诊断。'],
      },
      {
        title: '趋势变化',
        rows: [trend.label, trend.detail],
      },
      {
        title: '调整建议',
        rows: actionSignals.length
          ? actionSignals.slice(0, 12).map((signal) => `${signal.campaignTitle}：${signal.action}`)
          : ['保持现有设置并继续积累数据；补充毛利率后再建立目标 ACOS。'],
      },
      {
        title: '数据完整性',
        rows: [
          missingFields.length ? `待补或异常：${missingFields.join('、')}` : '核心广告指标已返回。',
          ...(readIssueSummary.length
            ? readIssueSummary
            : ['本次读取没有发现数据异常。']),
        ],
      },
    ],
    nextActions: actionSignals.slice(0, 5).map((signal) => `${signal.campaignTitle}：${signal.action}`),
  };
}
