import { normalizeLowerText, normalizeText, pickArrayPayload } from "./performanceApiNormalization.js";

export function getStatisticsTaskUuid(payload = {}) {
  return (
    normalizeText(payload.UUID) ||
    normalizeText(payload.uuid) ||
    normalizeText(payload.id) ||
    normalizeText(payload.requestId) ||
    normalizeText(payload.request_id)
  );
}

export function getStatisticsTaskState(payload = {}) {
  return normalizeText(payload.state || payload.status || payload.taskStatus);
}

export function isStatisticsTaskReady(payload = {}) {
  const state = normalizeLowerText(getStatisticsTaskState(payload));
  return (
    state === "ok" ||
    state === "done" ||
    state === "success" ||
    state === "completed"
  );
}

export function isStatisticsTaskFailed(payload = {}) {
  const state = normalizeLowerText(getStatisticsTaskState(payload));
  return ["error", "failed", "failure", "timeout", "cancel", "cancelled", "canceled"].includes(state);
}

export function getStatisticsReportLink(payload = {}) {
  return normalizeText(
    payload.link || payload.url || payload.reportUrl || payload.report_url,
  );
}

export function normalizeStatisticsReportEndpoint(link) {
  const text = normalizeText(link);
  if (!text) return "";
  if (/^https?:\/\//iu.test(text)) return text;
  return text.startsWith("/") ? text : `/${text}`;
}

export function normalizeStatisticsReportDate(value) {
  const text = normalizeText(value);
  const match = text.match(/^\d{4}-\d{2}-\d{2}/u);
  return match?.[0] || "";
}

export function hasSameStatisticsReportCampaigns(left = [], right = []) {
  const normalize = (values) =>
    [
      ...new Set(
        (Array.isArray(values) ? values : [])
          .map(normalizeText)
          .filter(Boolean),
      ),
    ].sort();
  const leftValues = normalize(left);
  const rightValues = normalize(right);
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

export function findReusableStatisticsReport(
  payload,
  { campaignIds, dateRange } = {},
) {
  const reports = pickArrayPayload(payload)
    .map((item) => item?.meta || item)
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime =
        Date.parse(left?.updatedAt || left?.createdAt || "") || 0;
      const rightTime =
        Date.parse(right?.updatedAt || right?.createdAt || "") || 0;
      return rightTime - leftTime;
    });
  return (
    reports.find((report) => {
      const request = report?.request || {};
      const state = normalizeLowerText(getStatisticsTaskState(report));
      const groupBy = normalizeLowerText(request.groupBy);
      return (
        getStatisticsTaskUuid(report) &&
        [
          "not_started",
          "in_progress",
          "ok",
          "done",
          "success",
          "completed",
        ].includes(state) &&
        (!groupBy || groupBy === "date") &&
        hasSameStatisticsReportCampaigns(request.campaigns, campaignIds) &&
        normalizeStatisticsReportDate(request.dateFrom || request.from) ===
          dateRange.dateFrom &&
        normalizeStatisticsReportDate(request.dateTo || request.to) ===
          dateRange.dateTo
      );
    }) || null
  );
}
