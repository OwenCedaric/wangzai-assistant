const MONEY_SYMBOLS = Object.freeze({
  CNY: '￥',
  RUB: '₽',
  USD: '$',
  EUR: '€',
});

const CHINESE_EXACT_TEXT = Object.freeze({
  ALL: '全部商品',
  ARCHIVED: '已归档',
  VALIDATION_STATE_FAIL: '校验失败',
  VALIDATION_STATE_PENDING: '等待校验',
  TO_SUPPLY: '待销售',
  READY_TO_SUPPLY: '待销售',
  IN_SALE: '出售中',
  CANDIDATE: '可经营候选',
  VALIDATION_ERROR: '校验失败',
  FBO: '平台仓配',
  FBS: '商家仓发',
  RFBS: '商家自发货',
  Utilizing: '处理中',
  UtilizingByOzon: '平台处理中',
  official: '官方活动',
  seller: '卖家活动',
  not_returned: '官方未返回',
  'finance.currency_code': '财务流水币种',
  'orders.products.currency_code': '关联订单商品币种',
});

const FINANCE_OPERATION_LABELS = Object.freeze({
  OperationAgentDeliveredToCustomer: '商品送达结算',
  OperationMarketplaceAgencyFeeAggregator3PLGlobal: '跨境物流服务费',
  OperationMarketplaceServicePartialCompensationToClient: '售后部分补偿',
});

const CHINESE_TEXT_REPLACEMENTS = Object.freeze([
  [/UtilizingByOzon/giu, '平台处理中'],
  [/\bUtilizing\b/gu, '处理中'],
  [/status\s*=\s*delivered/giu, '状态为已送达'],
  [/status\s*=\s*cancelled/giu, '状态为已取消'],
  [/status\s*=\s*awaiting_packaging/giu, '状态为等待备货'],
  [/status\s*=\s*awaiting_deliver/giu, '状态为等待发货'],
  [/status\s*=\s*delivering/giu, '状态为配送中'],
  [/Ozon Performance API/giu, '平台广告接口'],
  [/Performance API/giu, '广告接口'],
  [/Ozon/giu, '平台'],
  [/local-api/giu, '本地数据服务'],
  [/SQLite/giu, '本地数据库'],
  [/\bSKU\b/gu, '商品编码'],
  [/\bID\b/gu, '编号'],
  [/\bAPI\b/gu, '接口'],
  [/\bfrom\b/giu, '来自'],
  [/operation_type/giu, '费用类型'],
  [/operation_key/giu, '流水编号'],
  [/return_reason/giu, '售后原因'],
  [/return_id/giu, '售后编号'],
  [/visibility/giu, '商品状态'],
  [/currency_code/giu, '币种'],
  [/joined_count/giu, '已参与数量'],
  [/available_count/giu, '可加入数量'],
  [/activity_id/giu, '活动编号'],
  [/product_id/giu, '商品编号'],
  [/is_defect\s*=\s*true/giu, '存在质量异常'],
  [/is_defect/giu, '质量异常标记'],
  [/\bposting\b/giu, '平台订单'],
  [/\bquantity\b/giu, '商品数量'],
  [/\bprice\b/giu, '商品金额'],
  [/\bamount\b/giu, '金额'],
  [/\bARCHIVED\b/gu, '已归档'],
  [/\bFAIL\b/gu, '失败'],
  [/\bERROR\b/gu, '异常'],
  [/date_start\s*\/\s*date_end/giu, '开始时间和结束时间'],
]);

export function formatDataAnalysisChineseText(value, fallback = '') {
  let text = String(value ?? '').trim();
  if (!text) return fallback;
  if (CHINESE_EXACT_TEXT[text]) return CHINESE_EXACT_TEXT[text];
  CHINESE_TEXT_REPLACEMENTS.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });
  return text;
}

export function formatDataAnalysisOperationType(value, fallback = '费用类型未返回') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (FINANCE_OPERATION_LABELS[text]) return FINANCE_OPERATION_LABELS[text];
  const normalized = text.toLowerCase();
  if (/(commission|agencyfee|sale)/u.test(normalized)) return '销售佣金与服务费';
  if (/(delivery|logistic|3pl|freight|transport)/u.test(normalized)) return '配送与物流服务费';
  if (/(return|reverse)/u.test(normalized)) return '退货与逆向物流费';
  if (/(compensation|reimburse)/u.test(normalized)) return '补偿款';
  if (/(penalty|fine|defect|sellerfault)/u.test(normalized)) return '罚款与异常扣费';
  if (/(storage|warehouse)/u.test(normalized)) return '仓储服务费';
  if (/(acquiring|payment)/u.test(normalized)) return '支付服务费';
  if (/(advert|promotion|marketing)/u.test(normalized)) return '广告与推广费';
  if (/(client|customer|agent)/u.test(normalized)) return '订单结算';
  return '其他平台费用';
}

export function formatDataAnalysisUserMessage(value, fallback = '数据暂时不可用，请稍后重试。') {
  const text = formatDataAnalysisChineseText(value, fallback);
  return /[A-Za-z]{3,}/u.test(text) ? fallback : text;
}

export function toFiniteDataAnalysisNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatDataAnalysisTime(value, fallback = '暂无同步') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间异常';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatDataAnalysisCount(value, unit = '') {
  const number = toFiniteDataAnalysisNumber(value);
  if (number === null) return '—';
  const text = Math.round(number).toLocaleString('zh-CN');
  return unit ? `${text}${unit}` : text;
}

export function formatDataAnalysisMoney(value, currency = '', options = {}) {
  const number = toFiniteDataAnalysisNumber(value);
  if (number === null) return options.fallback || '—';
  const code = String(currency || '').toUpperCase();
  const symbol = MONEY_SYMBOLS[code] || '';
  const maximumFractionDigits = Math.max(0, Number(options.maximumFractionDigits ?? 2));
  const minimumFractionDigits = Math.min(
    maximumFractionDigits,
    Math.max(0, Number(options.minimumFractionDigits ?? Math.min(2, maximumFractionDigits)))
  );
  const formatted = number.toLocaleString('zh-CN', {
    minimumFractionDigits,
    maximumFractionDigits,
  });
  return `${symbol}${formatted}${symbol ? '' : code && code !== 'UNKNOWN' ? ` ${code}` : ''}`;
}

export function formatMoneyBreakdown(breakdown = []) {
  const rows = Array.isArray(breakdown) ? breakdown : [];
  if (!rows.length) return '—';
  return rows
    .map((item) => {
      if (String(item.currency).toUpperCase() === 'UNKNOWN') {
        const value = toFiniteDataAnalysisNumber(item.value);
        return value === null
          ? '币种未确认'
          : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}（币种未确认）`;
      }
      return formatDataAnalysisMoney(item.value, item.currency);
    })
    .join(' + ');
}

export function getMetricUnavailableText(metric = {}) {
  const status = String(metric.status || '');
  if (status === 'insufficient_sources') return '待补齐来源';
  if (status === 'not_returned') return '官方未返回';
  if (status === 'currency_unconfirmed') {
    if (String(metric.currency || '').toUpperCase() === 'CNY' && !metric.breakdown?.length) {
      return '汇率未确认';
    }
    return formatMoneyBreakdown(metric.breakdown);
  }
  if (status === 'mixed_currency') return formatMoneyBreakdown(metric.breakdown);
  if (status === 'empty') return metric.unit === 'count' ? '0' : '暂无数据';
  if (status === 'unavailable') return '不可计算';
  return '—';
}

export function formatDataAnalysisMetric(metric = {}) {
  if (['insufficient_sources', 'not_returned', 'unavailable'].includes(String(metric.status || ''))) {
    return getMetricUnavailableText(metric);
  }
  const value = toFiniteDataAnalysisNumber(metric.value);
  if (
    metric.unit === 'money' &&
    ['currency_unconfirmed', 'mixed_currency'].includes(String(metric.status || ''))
  ) {
    if (metric.breakdown?.length) return formatMoneyBreakdown(metric.breakdown);
    return value === null
      ? getMetricUnavailableText(metric)
      : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}（币种未确认）`;
  }
  if (value === null) {
    if (metric.unit === 'money' && metric.breakdown?.length) return formatMoneyBreakdown(metric.breakdown);
    return getMetricUnavailableText(metric);
  }
  if (metric.unit === 'money') return formatDataAnalysisMoney(value, metric.currency);
  if (metric.unit === 'percent') return `${value.toFixed(1)}%`;
  if (metric.unit === 'decimal') return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return formatDataAnalysisCount(value);
}

export function formatDataAnalysisDelta(metric = {}) {
  if (String(metric.status || 'confirmed') !== 'confirmed') {
    return { text: '数据覆盖不完整，暂不比较', tone: 'neutral', direction: 'flat', value: null };
  }
  const percent = toFiniteDataAnalysisNumber(metric.delta?.percent);
  if (percent === null) return { text: '暂无可比基期', tone: 'neutral', direction: 'flat', value: null };
  const negativeDirectionIds = new Set([
    'cancelledCount',
    'cancellationRate',
    'outOfStockCount',
    'inSaleOutOfStockCount',
    'lowStockCount',
    'returnCount',
    'returnOrderCount',
    'processingReturnCount',
    'defectReturnCount',
    'returnProductAmount',
    'financeDeductionAmount',
    'negativeTransactionCount',
    'adSpend',
    'adAcos',
    'adCpc',
  ]);
  if (percent > 0) {
    return {
      text: `较上期 +${percent.toFixed(1)}%`,
      tone: negativeDirectionIds.has(metric.id) ? 'negative' : 'positive',
      direction: 'up',
      value: percent,
    };
  }
  if (percent < 0) {
    return {
      text: `较上期 ${percent.toFixed(1)}%`,
      tone: negativeDirectionIds.has(metric.id) ? 'positive' : 'negative',
      direction: 'down',
      value: percent,
    };
  }
  return { text: '较上期持平', tone: 'neutral', direction: 'flat', value: 0 };
}

export function getMetricTone(metric = {}) {
  const id = String(metric.id || '');
  const value = toFiniteDataAnalysisNumber(metric.value);
  if (metric.status && !['confirmed', 'empty'].includes(metric.status)) return 'muted';
  if (['cancelledCount', 'cancellationRate', 'outOfStockCount', 'returnCount', 'returnOrderCount'].includes(id)) {
    return value && value > 0 ? 'warning' : 'success';
  }
  if (id === 'financeNetAmount') return value !== null && value < 0 ? 'danger' : 'success';
  return 'primary';
}

export function normalizeDataAnalysisCachePayload(payload = {}) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const stats = payload.stats && typeof payload.stats === 'object' ? payload.stats : {};
  const syncState = payload.syncState && typeof payload.syncState === 'object' ? payload.syncState : { status: 'idle' };
  const dashboard = payload.dashboard && typeof payload.dashboard === 'object' ? payload.dashboard : null;
  return {
    ok: payload.ok !== false,
    rows,
    total: Number(payload.total ?? rows.length) || 0,
    limit: Number(payload.limit) || 50,
    offset: Number(payload.offset) || 0,
    rowCount: Number(stats.rowCount) || rows.reduce((sum, row) => sum + (Number(row.rowCount) || 0), 0),
    updatedAt:
      dashboard?.sourceUpdatedAt ||
      payload.updatedAt ||
      stats.latestUpdatedAt ||
      syncState.updatedAt ||
      dashboard?.generatedAt ||
      null,
    dashboard,
    stats: {
      total: Number(stats.total) || rows.length,
      rowCount: Number(stats.rowCount) || 0,
      latestUpdatedAt: stats.latestUpdatedAt || null,
      byAnalysisType: Array.isArray(stats.byAnalysisType) ? stats.byAnalysisType : [],
      bySourceType: Array.isArray(stats.bySourceType) ? stats.bySourceType : [],
    },
    syncState,
    cache: payload.cache && typeof payload.cache === 'object' ? payload.cache : { enabled: false },
    source: payload.source || '',
  };
}

export function normalizePerformanceAnalysis(payload = {}) {
  const campaigns = Array.isArray(payload.campaigns) ? payload.campaigns : [];
  const statisticKeys = ['spent', 'revenue', 'impressions', 'clicks', 'orders'];
  const hasStatisticValue = (row = {}) =>
    statisticKeys.some((key) => toFiniteDataAnalysisNumber(row?.[key]) !== null);
  const normalizeStatisticRows = (rows = []) =>
    (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object' && hasStatisticValue(row));
  const campaignStatisticRows = campaigns.flatMap((campaign) => {
    const rows = normalizeStatisticRows(campaign?.statistics?.rows);
    return rows.map((row) => ({
      ...row,
      campaignId: String(row.campaignId || row.campaign_id || campaign.id || '').trim(),
    }));
  });
  const dailyStatisticRows = normalizeStatisticRows(payload.dailyStats);
  const productStatisticRows = normalizeStatisticRows(payload.productStats);
  // 后端的 summary 可能把缺失字段聚合成 0，计划对象顶层金额也可能是
  // 生命周期累计值。数据分析只使用本次统计接口真实返回的明细行。
  const statisticRows = dailyStatisticRows.length
    ? dailyStatisticRows
    : campaignStatisticRows.length
      ? campaignStatisticRows
      : productStatisticRows;
  const campaignIdOf = (row = {}) => String(row.campaignId || row.campaign_id || '').trim();
  const returnedCampaignIds = new Set(statisticRows.map(campaignIdOf).filter(Boolean));
  const statisticsCampaignCount = returnedCampaignIds.size;
  const statisticsRead = statisticRows.length > 0;
  const statisticsStatus = !statisticsRead
    ? 'not_returned'
    : campaigns.length && statisticsCampaignCount < campaigns.length
      ? 'partial'
      : statisticsCampaignCount || !campaigns.length
        ? 'confirmed'
        : 'partial';
  const aggregate = (key) => {
    const values = statisticRows
      .map((row) => toFiniteDataAnalysisNumber(row?.[key]))
      .filter((value) => value !== null);
    return {
      value: values.length ? values.reduce((total, value) => total + value, 0) : null,
      returnedRows: values.length,
      totalRows: statisticRows.length,
    };
  };
  const aggregates = Object.fromEntries(statisticKeys.map((key) => [key, aggregate(key)]));
  const ratio = (numerator, denominator, multiplier = 1) => {
    const left = toFiniteDataAnalysisNumber(numerator);
    const right = toFiniteDataAnalysisNumber(denominator);
    if (left === null || right === null || right <= 0) return null;
    return (left / right) * multiplier;
  };
  const derived = {
    acos: ratio(aggregates.spent.value, aggregates.revenue.value, 100),
    roas: ratio(aggregates.revenue.value, aggregates.spent.value),
    ctr: ratio(aggregates.clicks.value, aggregates.impressions.value, 100),
    cpc: ratio(aggregates.spent.value, aggregates.clicks.value),
  };
  const buildTrend = () => {
    const groups = new Map();
    statisticRows.forEach((row) => {
      const date = String(row.date || row.reportDate || row.report_date || '').slice(0, 10);
      if (!date) return;
      const current = groups.get(date) || { date, sourceRowCount: 0, values: {} };
      current.sourceRowCount += 1;
      statisticKeys.forEach((key) => {
        const value = toFiniteDataAnalysisNumber(row?.[key]);
        if (value === null) return;
        const field = current.values[key] || { value: 0, returnedRows: 0 };
        field.value += value;
        field.returnedRows += 1;
        current.values[key] = field;
      });
      groups.set(date, current);
    });
    return [...groups.values()]
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((group) => {
        const value = (key) => group.values[key]?.value ?? null;
        const spent = value('spent');
        const revenue = value('revenue');
        const impressions = value('impressions');
        const clicks = value('clicks');
        return {
          date: group.date,
          sourceRowCount: group.sourceRowCount,
          returnedFields: Object.fromEntries(
            statisticKeys.map((key) => [key, group.values[key]?.returnedRows || 0])
          ),
          spent,
          revenue,
          impressions,
          clicks,
          orders: value('orders'),
          acos: ratio(spent, revenue, 100),
          roas: ratio(revenue, spent),
          ctr: ratio(clicks, impressions, 100),
          cpc: ratio(spent, clicks),
        };
      });
  };
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  const metric = (id, label, key, unit = 'count', currency = '', valueOverride, dependencyKeys = [key]) => {
    const aggregateResult = aggregates[key] || { value: null, returnedRows: 0, totalRows: statisticRows.length };
    const dependencyResults = dependencyKeys.map(
      (dependencyKey) => aggregates[dependencyKey] || { returnedRows: 0, totalRows: statisticRows.length }
    );
    const normalizedValue = valueOverride === undefined ? aggregateResult.value : toFiniteDataAnalysisNumber(valueOverride);
    const fieldStatus =
      normalizedValue === null
        ? 'not_returned'
        : statisticsStatus === 'partial' ||
            dependencyResults.some((result) => result.returnedRows < result.totalRows)
          ? 'partial'
          : 'confirmed';
    return {
      id,
      label,
      value: normalizedValue,
      unit,
      currency,
      status: fieldStatus,
      source: {
        id: 'performance',
        label: '平台广告接口实时读取',
        type: 'official-live',
        syncedAt: payload.finishedAt || null,
      },
      comparisonValue: null,
      delta: null,
      detail:
        normalizedValue === null
          ? '本次统计明细未返回该字段，不能把缺失值显示为0。'
          : `来自本次平台广告统计明细；字段返回 ${aggregateResult.returnedRows}/${aggregateResult.totalRows} 行，计划归属 ${statisticsCampaignCount}/${campaigns.length}。`,
      breakdown: [],
      isEstimated: false,
    };
  };
  const normalizedCampaigns = campaigns.map((campaign) => {
    const campaignId = String(campaign.id || '').trim();
    const rows = statisticRows.filter((row) => campaignId && campaignIdOf(row) === campaignId);
    const sumField = (key) => {
      const values = rows.map((row) => toFiniteDataAnalysisNumber(row?.[key])).filter((value) => value !== null);
      return values.length ? values.reduce((total, value) => total + value, 0) : null;
    };
    const spent = sumField('spent');
    const revenue = sumField('revenue');
    const impressions = sumField('impressions');
    const clicks = sumField('clicks');
    return {
      ...campaign,
      impressions,
      clicks,
      spent,
      orders: sumField('orders'),
      revenue,
      acos: ratio(spent, revenue, 100),
      roas: ratio(revenue, spent),
      ctr: ratio(clicks, impressions, 100),
      cpc: ratio(spent, clicks),
      statisticsRows: rows,
      statisticsStatus: rows.length ? (statisticsStatus === 'confirmed' ? 'confirmed' : 'partial') : 'not_returned',
    };
  });
  return {
    ok: payload.ok === true,
    source: payload.source || 'ozon-performance-realtime',
    readDepth: payload.readDepth || '',
    finishedAt: payload.finishedAt || null,
    statisticsRead,
    statisticsStatus,
    statisticsCoverage: {
      campaignCount: campaigns.length,
      returnedCampaignCount: statisticsCampaignCount,
      percent: campaigns.length ? (statisticsCampaignCount / campaigns.length) * 100 : null,
      returnedRowCount: statisticRows.length,
    },
    summary,
    metrics: [
      metric('adSpend', '广告花费', 'spent', 'money', 'RUB'),
      metric('adRevenue', '广告销售额', 'revenue', 'money', 'RUB'),
      metric('adImpressions', '广告曝光', 'impressions'),
      metric('adClicks', '广告点击', 'clicks'),
      metric('adOrders', '广告订单', 'orders'),
      metric('adAcos', '广告成本销售比', 'spent', 'percent', '', derived.acos, ['spent', 'revenue']),
      metric('adRoas', '广告投入产出比', 'spent', 'decimal', '', derived.roas, ['spent', 'revenue']),
      metric('adCtr', '广告点击率', 'clicks', 'percent', '', derived.ctr, ['clicks', 'impressions']),
      metric('adCpc', '单次点击成本', 'spent', 'money', 'RUB', derived.cpc, ['spent', 'clicks']),
    ],
    campaigns: normalizedCampaigns,
    dailyTrend: buildTrend(),
    productStats: Array.isArray(payload.productStats) ? payload.productStats : [],
    stages: Array.isArray(payload.stages) ? payload.stages : [],
    issues: Array.isArray(payload.readIssues) ? payload.readIssues : [],
    cache: payload.cache || { enabled: false },
  };
}
