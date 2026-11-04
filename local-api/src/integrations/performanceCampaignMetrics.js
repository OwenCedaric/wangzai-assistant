import { normalizeLowerText, normalizeMetricNumber, normalizeText } from "./performanceApiNormalization.js";
import { shiftIsoDateString, toTimeZoneDateString } from "./performanceReadPlanning.js";

export function sumMetric(rows = [], key) {
  return rows.reduce((result, row) => {
    const value = normalizeMetricNumber(row?.[key]);
    return value === null ? result : (result ?? 0) + value;
  }, null);
}

export const PERFORMANCE_CAMPAIGN_STATISTIC_METRICS = Object.freeze([
  "impressions",
  "clicks",
  "spent",
  "orders",
  "revenue",
  "toCart",
  "bonusSpent",
  "prepaymentSpent",
  "avgCpm",
  "postViewOrders",
  "postViewRevenue",
  "modelOrders",
  "modelSales",
  "budget",
  "weeklyBudget",
  "dailyBudget",
  "clickPrice",
]);

export function groupPerformanceStatisticsByCampaign(rows = []) {
  const result = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const campaignId = normalizeText(row?.campaignId);
    if (!campaignId) continue;
    const current = result.get(campaignId) || [];
    current.push(row);
    result.set(campaignId, current);
  }
  return result;
}

export function readCampaignMetricFromSources(sources = [], key, fallback = null) {
  for (const source of sources) {
    const value = sumMetric(source?.rows || [], key);
    if (value !== null) {
      return {
        value,
        source: normalizeText(source?.key),
      };
    }
  }
  return {
    value: normalizeMetricNumber(fallback),
    source: normalizeMetricNumber(fallback) === null ? "" : "campaign",
  };
}

export function readSingleProductCampaignMetric(
  metricResults = {},
  key,
  fallback = null,
) {
  const result = metricResults?.[key];
  const source = normalizeText(result?.source);
  // A returned campaign statistic is also the exact product statistic when
  // that campaign contains one and only one promoted product. Do not use the
  // campaign-list fallback here because it is not guaranteed to cover the
  // selected date range.
  if (source && source !== "campaign")
    return normalizeMetricNumber(result?.value);
  return normalizeMetricNumber(fallback);
}

export function buildCampaignStatisticsAvailability({
  sources = [],
  sourceResponses = {},
} = {}) {
  const returnedSources = sources
    .filter((source) => Array.isArray(source?.rows) && source.rows.length > 0)
    .map((source) => normalizeText(source.key))
    .filter(Boolean);
  const successfulSources = Object.entries(sourceResponses)
    .filter(([, response]) => response?.ok === true && !response?.skipped)
    .map(([key]) => key);
  const failedSources = Object.entries(sourceResponses)
    .filter(([, response]) => response?.ok === false && !response?.skipped)
    .map(([key]) => key);
  const skippedSources = Object.entries(sourceResponses)
    .filter(([, response]) => response?.skipped)
    .map(([key]) => key);
  const status = returnedSources.length
    ? "returned"
    : successfulSources.length
      ? "empty"
      : failedSources.length
        ? "failed"
        : "skipped";
  return {
    status,
    returnedSources,
    successfulSources,
    failedSources,
    skippedSources,
    message:
      status === "returned"
        ? "Ozon 已返回当前计划的统计记录。"
        : status === "empty"
          ? "Ozon 接口读取成功，但当前统计期没有这条计划的记录。"
          : status === "failed"
            ? "当前计划的统计接口读取失败。"
            : "当前读取深度未请求计划统计。",
  };
}

export function buildCampaignStatisticResponses(campaign, sourceResponses = {}) {
  const searchPromo =
    normalizeLowerText(campaign?.paymentType) === "cpo" ||
    normalizeLowerText(campaign?.typeCode).includes("search_promo");
  if (!searchPromo) {
    const { searchPromo: _searchPromoResponse, ...standardResponses } =
      sourceResponses;
    return standardResponses;
  }
  return {
    searchPromo: sourceResponses.searchPromo,
  };
}

export function calculateCtr(impressions, clicks) {
  return Number.isFinite(impressions) &&
    impressions > 0 &&
    Number.isFinite(clicks)
    ? Number(((clicks / impressions) * 100).toFixed(2))
    : null;
}

export function calculateCpc(spent, clicks) {
  return Number.isFinite(clicks) && clicks > 0 && Number.isFinite(spent)
    ? Number((spent / clicks).toFixed(2))
    : null;
}

export function getIsoWeekStart(dateText = "") {
  const normalizedDate = normalizeText(dateText);
  const timestamp = Date.parse(`${normalizedDate}T12:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return "";
  const day = new Date(timestamp).getUTCDay();
  return shiftIsoDateString(normalizedDate, -((day + 6) % 7));
}

export function resolvePerformanceBudgetPeriod(campaign = {}, now = new Date()) {
  const today = toTimeZoneDateString(now, "Europe/Moscow");
  const budgetType = normalizeLowerText(
    campaign.budgetType || campaign.budgetKind,
  );
  const dailyBudget = normalizeMetricNumber(campaign.dailyBudget);
  const weeklyBudget = normalizeMetricNumber(campaign.weeklyBudget);
  const totalBudget = normalizeMetricNumber(campaign.totalBudget);
  let kind = "";
  let budget = null;
  let periodFrom = "";
  let periodTo = today;

  if (budgetType.includes("week") && weeklyBudget > 0) {
    kind = "weekly";
    budget = weeklyBudget;
  } else if (budgetType.includes("day") && dailyBudget > 0) {
    kind = "daily";
    budget = dailyBudget;
  } else if (
    (budgetType.includes("total") || budgetType.includes("overall")) &&
    totalBudget > 0
  ) {
    kind = "total";
    budget = totalBudget;
  } else {
    const candidates = [
      weeklyBudget > 0 ? { kind: "weekly", budget: weeklyBudget } : null,
      dailyBudget > 0 ? { kind: "daily", budget: dailyBudget } : null,
      totalBudget > 0 ? { kind: "total", budget: totalBudget } : null,
    ].filter(Boolean);
    if (candidates.length !== 1) return null;
    ({ kind, budget } = candidates[0]);
  }

  if (kind === "daily") periodFrom = today;
  if (kind === "weekly") periodFrom = getIsoWeekStart(today);
  if (kind === "total") periodFrom = normalizeText(campaign.fromDate);
  if (!periodFrom || !periodTo) return null;

  const campaignStart = normalizeText(campaign.fromDate);
  const campaignEnd = normalizeText(campaign.toDate);
  if (campaignStart && campaignStart > periodFrom) periodFrom = campaignStart;
  if (campaignEnd && campaignEnd < periodTo) periodTo = campaignEnd;
  if (periodFrom > periodTo) return null;
  return { kind, budget, periodFrom, periodTo };
}

export function resolvePerformanceBudgetRemaining({
  campaign = {},
  dailyRows = [],
  dailyResponse = null,
  dateRange = {},
  now = new Date(),
} = {}) {
  const returnedRemaining = normalizeMetricNumber(campaign.budgetRemaining);
  if (returnedRemaining !== null && returnedRemaining >= 0) {
    return {
      value: returnedRemaining,
      source: "ozon",
      kind: "returned",
      periodFrom: "",
      periodTo: "",
    };
  }
  if (campaign.alerts?.budgetExhausted) {
    return {
      value: 0,
      source: "ozon-status",
      kind: "returned",
      periodFrom: "",
      periodTo: "",
    };
  }
  if (dailyResponse?.ok !== true || dailyResponse?.skipped) return null;

  const period = resolvePerformanceBudgetPeriod(campaign, now);
  if (!period) return null;
  const queryFrom = normalizeText(dateRange.dateFrom);
  const queryTo = normalizeText(dateRange.dateTo);
  if (!queryFrom || !queryTo || queryFrom > period.periodFrom || queryTo < period.periodTo) {
    return null;
  }

  let spent = 0;
  for (const row of Array.isArray(dailyRows) ? dailyRows : []) {
    const date = normalizeText(row?.date);
    if (!date || date < period.periodFrom || date > period.periodTo) continue;
    const value = normalizeMetricNumber(row?.spent);
    if (value !== null && value >= 0) spent += value;
  }
  return {
    value: Number(Math.max(0, period.budget - spent).toFixed(6)),
    source: "calculated",
    kind: period.kind,
    periodFrom: period.periodFrom,
    periodTo: period.periodTo,
    budget: period.budget,
    spent: Number(spent.toFixed(6)),
  };
}

export function resolvePerformanceBudgetStatus(campaign = {}, budgetRemaining = null) {
  if (campaign.alerts?.budgetExhausted) return "预算花完";
  const remaining = normalizeMetricNumber(budgetRemaining?.value);
  if (remaining !== null) return remaining > 0 ? "预算正常" : "预算花完";
  const returnedStatus = normalizeText(campaign.budgetStatus);
  return returnedStatus && returnedStatus !== "预算正常或未返回"
    ? returnedStatus
    : "未返回";
}

export function buildDailyTrend(rows = []) {
  const dailyMap = new Map();
  for (const row of rows) {
    const date = normalizeText(row.date) || "未返回日期";
    const current = dailyMap.get(date) || {
      date,
      impressions: null,
      clicks: null,
      spent: null,
      orders: null,
      revenue: null,
    };
    for (const key of ["impressions", "clicks", "spent", "orders", "revenue"]) {
      const value = normalizeMetricNumber(row[key]);
      if (value !== null) current[key] = (current[key] ?? 0) + value;
    }
    dailyMap.set(date, current);
  }
  return [...dailyMap.values()]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((row) => ({
      ...row,
      acos:
        Number.isFinite(row.spent) &&
        Number.isFinite(row.revenue) &&
        row.revenue > 0
          ? Number(((row.spent / row.revenue) * 100).toFixed(2))
          : null,
      roas:
        Number.isFinite(row.spent) &&
        row.spent > 0 &&
        Number.isFinite(row.revenue)
          ? Number((row.revenue / row.spent).toFixed(2))
          : null,
      ctr: calculateCtr(row.impressions, row.clicks),
      cpc: calculateCpc(row.spent, row.clicks),
    }));
}

export function mergePerformanceTrendRows(primaryRows = [], ...fallbackGroups) {
  const metricKeys = [
    "impressions",
    "clicks",
    "spent",
    "orders",
    "revenue",
    "bonusSpent",
    "prepaymentSpent",
  ];
  const rowsByKey = new Map();
  const appendOrFill = (row, source) => {
    const campaignId = normalizeText(row?.campaignId);
    const date = normalizeText(row?.date);
    if (!campaignId && !date) return;
    const key = `${campaignId}:${date}`;
    const current = rowsByKey.get(key);
    if (!current) {
      rowsByKey.set(key, {
        ...row,
        trendSources: [source],
      });
      return;
    }
    const next = { ...current };
    for (const metricKey of metricKeys) {
      if (normalizeMetricNumber(next[metricKey]) !== null) continue;
      const fallbackValue = normalizeMetricNumber(row?.[metricKey]);
      if (fallbackValue !== null) next[metricKey] = fallbackValue;
    }
    next.trendSources = [...new Set([...(current.trendSources || []), source])];
    rowsByKey.set(key, next);
  };
  for (const row of primaryRows) appendOrFill(row, "daily");
  fallbackGroups.forEach((rows, index) => {
    const source = index === 0 ? "expense" : "async";
    for (const row of Array.isArray(rows) ? rows : [])
      appendOrFill(row, source);
  });
  return [...rowsByKey.values()];
}
