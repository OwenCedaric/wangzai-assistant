import { normalizeLowerText, normalizeText } from "./performanceApiNormalization.js";
import { getPayloadValues } from "./performanceApiTransport.js";

export function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

export function offsetDateString(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function normalizeDateRange(payload = {}) {
  const values = getPayloadValues(payload);
  return {
    dateFrom:
      normalizeText(values.dateFrom || values.fromDate || values.from) ||
      offsetDateString(-6),
    dateTo:
      normalizeText(values.dateTo || values.toDate || values.to) ||
      todayDateString(),
  };
}

export const PERFORMANCE_MAX_STATISTICS_DAYS = 62;

export function splitPerformanceDateRange(
  dateRange = {},
  maxDays = PERFORMANCE_MAX_STATISTICS_DAYS,
) {
  const dateFrom = normalizeText(dateRange.dateFrom);
  const dateTo = normalizeText(dateRange.dateTo);
  const startTime = Date.parse(`${dateFrom}T12:00:00.000Z`);
  const endTime = Date.parse(`${dateTo}T12:00:00.000Z`);
  const segmentDays = Math.max(1, Math.floor(Number(maxDays) || 1));
  if (
    !dateFrom ||
    !dateTo ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime)
  ) {
    return [{ dateFrom, dateTo }];
  }
  if (startTime > endTime) return [{ dateFrom, dateTo }];

  const segments = [];
  let cursor = dateFrom;
  while (cursor <= dateTo) {
    const candidateEnd = shiftIsoDateString(cursor, segmentDays - 1);
    const segmentEnd =
      candidateEnd && candidateEnd < dateTo ? candidateEnd : dateTo;
    segments.push({ dateFrom: cursor, dateTo: segmentEnd });
    if (segmentEnd === dateTo) break;
    cursor = shiftIsoDateString(segmentEnd, 1);
    if (!cursor) break;
  }
  return segments.length ? segments : [{ dateFrom, dateTo }];
}

export function shouldCoalescePerformanceOverviewRead(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  return (
    options.coalesce === true ||
    (options.coalesce !== false && fetchImpl === globalThis.fetch)
  );
}

export function getPerformanceReadDepth(payload = {}) {
  const values = getPayloadValues(payload);
  const rawDepth = normalizeLowerText(
    values.readDepth || values.readMode || values.mode,
  );
  if (["fast", "lite"].includes(rawDepth)) return "fast";
  if (["dashboard", "summary", "overview"].includes(rawDepth))
    return "dashboard";
  if (["ai", "ai-ready", "decision"].includes(rawDepth)) return "ai";
  if (["detail", "campaign-detail"].includes(rawDepth)) return "detail";
  if (["products", "all-products", "product-catalog"].includes(rawDepth))
    return "products";
  if (["orders", "promotion-orders", "paid-orders"].includes(rawDepth))
    return "orders";
  if (["catalog", "background", "reference"].includes(rawDepth))
    return "catalog";
  return "full";
}

export function getPerformanceReadPlan(payload = {}) {
  const depth = getPerformanceReadDepth(payload);
  return {
    depth,
    includeCampaignDetails:
      depth === "detail" || depth === "products" || depth === "full",
    includeRealtimeStatistics:
      depth === "dashboard" ||
      depth === "ai" ||
      depth === "detail" ||
      depth === "products" ||
      depth === "full",
    includeAsyncStatisticsFallback: depth === "full",
    includeSearchPromoStatistics: depth === "ai" || depth === "full",
    includeReferenceData: depth === "catalog" || depth === "full",
  };
}

export function toTimeZoneDateString(value = new Date(), timeZone = "Europe/Moscow") {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const partMap = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

export function shiftIsoDateString(value, days) {
  const date = new Date(`${normalizeText(value)}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getPerformanceSkuStatisticsDateRange(
  requestedRange = {},
  now = new Date(),
) {
  const today = toTimeZoneDateString(now, "Europe/Moscow");
  const yesterday = shiftIsoDateString(today, -1);
  const requestedFrom = normalizeText(requestedRange.dateFrom);
  const requestedTo = normalizeText(requestedRange.dateTo);
  const dateFrom =
    requestedFrom && requestedFrom > yesterday ? requestedFrom : yesterday;
  const dateTo = requestedTo && requestedTo < today ? requestedTo : today;
  if (!dateFrom || !dateTo || dateFrom > dateTo) {
    return {
      available: false,
      requestedFrom,
      requestedTo,
      allowedFrom: yesterday,
      allowedTo: today,
      dateFrom: "",
      dateTo: "",
    };
  }
  return {
    available: true,
    requestedFrom,
    requestedTo,
    allowedFrom: yesterday,
    allowedTo: today,
    dateFrom,
    dateTo,
  };
}

export function getPerformanceHistoricalProductStatisticsDateRange(
  requestedRange = {},
  realtimeRange = {},
) {
  const requestedFrom = normalizeText(requestedRange.dateFrom);
  const requestedTo = normalizeText(requestedRange.dateTo);
  if (!requestedFrom || !requestedTo || requestedFrom > requestedTo) {
    return { available: false, dateFrom: "", dateTo: "" };
  }

  const realtimeFrom = realtimeRange.available
    ? normalizeText(realtimeRange.dateFrom)
    : "";
  const historicalTo = realtimeFrom
    ? shiftIsoDateString(realtimeFrom, -1)
    : requestedTo;
  const dateTo =
    historicalTo && historicalTo < requestedTo ? historicalTo : requestedTo;
  if (!dateTo || requestedFrom > dateTo) {
    return { available: false, dateFrom: "", dateTo: "" };
  }
  return {
    available: true,
    dateFrom: requestedFrom,
    dateTo,
  };
}

export function getPerformanceCampaignSelectionId(payload = {}) {
  const values = getPayloadValues(payload);
  return normalizeText(
    values.campaignId || values.campaign_id || values.performanceCampaignId,
  );
}

export function shouldReadPerformanceCampaignObjects(payload = {}) {
  const values = getPayloadValues(payload);
  const configured =
    values.includeCampaignObjects ?? values.readCampaignObjects;
  if (configured === false) return false;
  return !["false", "0", "no", "off"].includes(normalizeLowerText(configured));
}

export function shouldReadPerformanceBidInsights(payload = {}) {
  const values = getPayloadValues(payload);
  const configured = values.includeBidInsights ?? values.readBidInsights;
  return (
    configured === true ||
    ["true", "1", "yes", "on"].includes(normalizeLowerText(configured))
  );
}

export function createSkippedPerformanceStage(key, label, reason) {
  return {
    key,
    label,
    status: "skipped",
    count: 0,
    skipped: true,
    reason,
  };
}
