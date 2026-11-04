import { firstNumber, firstText, normalizeText } from "./performanceApiNormalization.js";
import { splitPerformanceDateRange } from "./performanceReadPlanning.js";

export function normalizePerformancePromotionOrder(row = {}, index = 0) {
  const orderId = firstText(row, [
    "orderId",
    "order_id",
    "orderNumber",
    "order_number",
    "postingNumber",
    "posting_number",
    "postingNo",
    "posting_no",
  ]);
  const sku = firstText(row, [
    "sku",
    "ozonSku",
    "ozon_sku",
    "productSku",
    "product_sku",
  ]);
  const offerId = firstText(row, [
    "offerId",
    "offer_id",
    "vendorCode",
    "vendor_code",
    "article",
  ]);
  const campaignId = firstText(row, [
    "campaignId",
    "campaign_id",
    "advCampaignId",
    "adv_campaign_id",
  ]);
  const orderDate = firstText(row, [
    "orderDate",
    "order_date",
    "createdAt",
    "created_at",
    "date",
    "day",
  ]);
  const quantity = firstNumber(row, [
    "quantity",
    "count",
    "itemsCount",
    "items_count",
    "orders",
    "ordersCount",
    "orders_count",
  ]);
  const revenue = firstNumber(row, [
    "ordersMoney",
    "orders_money",
    "revenue",
    "sales",
    "money",
    "orderAmount",
    "order_amount",
    "price",
  ]);
  const spent = firstNumber(row, [
    "moneySpent",
    "money_spent",
    "spent",
    "expense",
    "expenses",
    "cost",
  ]);
  return {
    id:
      firstText(row, ["uuid", "id"]) ||
      `${orderId || "order"}:${sku || offerId || "product"}:${campaignId || "campaign"}:${index + 1}`,
    orderId,
    orderDate,
    campaignId,
    campaignTitle: firstText(row, [
      "campaignTitle",
      "campaign_title",
      "campaignName",
      "campaign_name",
    ]),
    sku,
    offerId,
    productId: firstText(row, ["productId", "product_id"]),
    productTitle: firstText(row, [
      "productTitle",
      "product_title",
      "productName",
      "product_name",
      "title",
      "name",
    ]),
    quantity,
    revenue,
    spent,
    status: firstText(row, ["status", "state", "orderStatus", "order_status"]),
    paymentType: firstText(row, ["paymentType", "payment_type", "PaymentType"]),
    source: firstText(row, ["ordersSource", "orders_source", "source"]),
    bidRate: firstNumber(row, ["bid", "bidRate", "bid_rate"]),
    orderNumber: firstText(row, ["orderNumber", "order_number"]),
    raw: row,
  };
}

export function dedupeSegmentedPerformanceRows(rows = [], dedupeKey) {
  const seen = new Set();
  const result = [];
  for (const item of rows) {
    const key = normalizeText(
      typeof dedupeKey === "function"
        ? dedupeKey(item.row, item.segment, item.rowIndex)
        : "",
    );
    const stableKey =
      key || `segment:${item.segment.index}:row:${item.rowIndex}`;
    if (seen.has(stableKey)) continue;
    seen.add(stableKey);
    result.push(item.row);
  }
  return result;
}

export function splitPerformanceValues(values = [], maxBatchSize = 200) {
  const normalized = [...new Set(values.map(normalizeText).filter(Boolean))];
  const batchSize = Math.max(1, Math.floor(Number(maxBatchSize) || 1));
  const batches = [];
  for (let index = 0; index < normalized.length; index += batchSize) {
    batches.push(normalized.slice(index, index + batchSize));
  }
  return batches;
}

export function createSegmentedPerformanceDedupeKey(parts = [], options = {}) {
  const normalizedParts = parts.map((part) => normalizeText(part));
  const requiredIndexes = Array.isArray(options.requiredIndexes)
    ? options.requiredIndexes
    : normalizedParts.map((_, index) => index);
  if (requiredIndexes.some((index) => !normalizedParts[index])) return "";
  return normalizedParts.join("|");
}

export function getPerformanceStatisticCampaignId(row = {}) {
  return firstText(row, ["campaignId", "campaign_id", "id", "campaign_id_num"]);
}

export function getPerformanceStatisticDate(row = {}) {
  return firstText(row, [
    "date",
    "day",
    "dateFrom",
    "date_from",
    "orderDate",
    "order_date",
  ]);
}

export function getPerformanceStatisticSku(row = {}) {
  return firstText(row, [
    "sku",
    "ozonSku",
    "ozon_sku",
    "productSku",
    "product_sku",
  ]);
}

export function getPerformanceStatisticProductIdentity(row = {}) {
  return firstText(row, [
    "sku",
    "ozonSku",
    "ozon_sku",
    "productSku",
    "product_sku",
    "sourceSku",
    "source_sku",
    "productId",
    "product_id",
    "ozonProductId",
    "ozon_product_id",
    "offerId",
    "offer_id",
    "vendorCode",
    "vendor_code",
    "article",
  ]);
}

export function getPerformanceStatisticOfferId(row = {}) {
  return firstText(row, [
    "offerId",
    "offer_id",
    "vendorCode",
    "vendor_code",
    "article",
  ]);
}

export function getPerformanceStatisticMediaType(row = {}) {
  return firstText(row, ["mediaType", "media_type", "format", "placement"]);
}

export function getPerformanceStatisticOrderId(row = {}) {
  return firstText(row, [
    "orderId",
    "order_id",
    "orderNumber",
    "order_number",
    "postingNumber",
    "posting_number",
    "postingNo",
    "posting_no",
  ]);
}

export function dailyStatisticDedupeKey(row = {}) {
  return createSegmentedPerformanceDedupeKey(
    [
      getPerformanceStatisticCampaignId(row),
      getPerformanceStatisticDate(row),
      getPerformanceStatisticSku(row),
    ],
    { requiredIndexes: [0, 1] },
  );
}

export function productStatisticDedupeKey(row = {}) {
  return createSegmentedPerformanceDedupeKey([
    getPerformanceStatisticCampaignId(row),
    getPerformanceStatisticProductIdentity(row),
    getPerformanceStatisticDate(row),
  ]);
}

export function mergePerformanceProductStatistics(...rowGroups) {
  const rows = [];
  const rowIndexByKey = new Map();
  for (const group of rowGroups) {
    for (const row of Array.isArray(group) ? group : []) {
      const key = productStatisticDedupeKey(row);
      if (!key) {
        rows.push(row);
        continue;
      }
      const existingIndex = rowIndexByKey.get(key);
      if (existingIndex === undefined) {
        rowIndexByKey.set(key, rows.length);
        rows.push(row);
      } else {
        // Later sources are fresher/more specific (the realtime two-day SKU
        // endpoint follows the historical report), so replace instead of sum.
        rows[existingIndex] = row;
      }
    }
  }
  return rows;
}

export function expenseStatisticDedupeKey(row = {}) {
  return createSegmentedPerformanceDedupeKey([
    getPerformanceStatisticCampaignId(row),
    getPerformanceStatisticDate(row),
  ]);
}

export function mediaStatisticDedupeKey(row = {}) {
  return createSegmentedPerformanceDedupeKey([
    getPerformanceStatisticCampaignId(row),
    getPerformanceStatisticMediaType(row),
    getPerformanceStatisticDate(row),
  ]);
}

export function promotionOrderDedupeKey(row = {}) {
  return createSegmentedPerformanceDedupeKey(
    [
      getPerformanceStatisticOrderId(row),
      getPerformanceStatisticSku(row),
      getPerformanceStatisticOfferId(row),
      getPerformanceStatisticDate(row),
    ],
    { requiredIndexes: [0] },
  );
}

export async function readSegmentedPerformanceRows({
  dateRange,
  readSegment,
  dedupeKey,
  label,
}) {
  const dateSegments = splitPerformanceDateRange(dateRange);
  const segmentResults = [];
  const rowItems = [];
  for (let index = 0; index < dateSegments.length; index += 1) {
    const segmentRange = dateSegments[index];
    const response = await readSegment(segmentRange, index);
    const segment = {
      index,
      dateFrom: segmentRange.dateFrom,
      dateTo: segmentRange.dateTo,
      ok: Boolean(response?.ok),
      endpoint: normalizeText(response?.endpoint),
      status: response?.status || (response?.ok ? 200 : 0),
      rowCount: Array.isArray(response?.rows) ? response.rows.length : 0,
      attempts: Array.isArray(response?.attempts) ? response.attempts : [],
      task: response?.task || null,
      error: response?.error || null,
    };
    segmentResults.push(segment);
    for (const [rowIndex, row] of (response?.rows || []).entries()) {
      rowItems.push({ row, rowIndex, segment });
    }
  }

  const successfulSegmentCount = segmentResults.filter(
    (segment) => segment.ok,
  ).length;
  const failedSegments = segmentResults.filter((segment) => !segment.ok);
  const partial = successfulSegmentCount > 0 && failedSegments.length > 0;
  const firstFailure = failedSegments[0] || null;
  const firstSuccess = segmentResults.find((segment) => segment.ok) || null;
  const endpoint = firstSuccess?.endpoint || firstFailure?.endpoint || "";
  const error = firstFailure
    ? {
        code: firstFailure.error?.code || "SEGMENT_READ_FAILED",
        message: `${label || "统计数据"}有 ${failedSegments.length}/${segmentResults.length} 个日期分段读取失败；首个失败范围 ${firstFailure.dateFrom} 至 ${firstFailure.dateTo}：${firstFailure.error?.message || "读取失败"}`,
      }
    : null;
  return {
    ok: failedSegments.length === 0,
    complete: failedSegments.length === 0,
    partial,
    endpoint,
    label,
    status: firstFailure?.status || firstSuccess?.status || 200,
    rows: dedupeSegmentedPerformanceRows(rowItems, dedupeKey),
    segmentCount: segmentResults.length,
    successfulSegmentCount,
    failedSegmentCount: failedSegments.length,
    segments: segmentResults,
    error,
  };
}

export function createPerformanceSegmentIssues(response = {}, issue = {}) {
  if (!Array.isArray(response.segments) || response.failedSegmentCount <= 0)
    return [];
  return response.segments
    .filter((segment) => !segment.ok)
    .map((segment) => ({
      ...issue,
      endpoint: segment.endpoint || response.endpoint,
      status: segment.status || response.status,
      dateFrom: segment.dateFrom,
      dateTo: segment.dateTo,
      message: `${issue.label || response.label || "统计数据"}在 ${segment.dateFrom} 至 ${segment.dateTo} 读取失败：${segment.error?.message || "读取失败"}`,
      attempts: segment.attempts,
    }));
}
