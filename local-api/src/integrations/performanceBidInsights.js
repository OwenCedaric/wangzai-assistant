import {
  firstNumber,
  firstText,
  isPlainObject,
  normalizePerformanceBidRubles,
  normalizeText,
  pickArrayPayload,
  toFiniteNumber,
} from "./performanceApiNormalization.js";
import { getRemoteMessage } from "./performanceApiTransport.js";

export function getRecommendedBidMap(payload = {}) {
  const result = new Map();
  const source =
    payload.recommendedBids || payload.bids || payload.result || payload.items;
  if (source && !Array.isArray(source) && typeof source === "object") {
    for (const [sku, bid] of Object.entries(source)) {
      const normalizedSku = normalizeText(sku);
      if (normalizedSku) result.set(normalizedSku, normalizeText(bid));
    }
    return result;
  }
  for (const row of Array.isArray(source) ? source : []) {
    const sku = firstText(row, ["sku", "SKU", "ozonSku", "productSku"]);
    if (sku)
      result.set(
        sku,
        firstNumber(row, ["bid", "recommendedBid"]) ?? normalizeText(row.bid),
      );
  }
  return result;
}

export function getCompetitiveBidMap(payload = {}) {
  const result = new Map();
  const rows = pickArrayPayload(payload);
  for (const row of rows) {
    const sku = firstText(row, ["sku", "SKU", "ozonSku", "productSku"]);
    if (sku)
      result.set(
        sku,
        firstNumber(row, ["bid", "competitiveBid"]) ?? normalizeText(row.bid),
      );
  }
  if (!rows.length && payload.bids && typeof payload.bids === "object") {
    for (const [sku, bid] of Object.entries(payload.bids)) {
      const normalizedSku = normalizeText(sku);
      if (normalizedSku) result.set(normalizedSku, normalizeText(bid));
    }
  }
  return result;
}

export function getMinCpoBidMap(payload = {}) {
  const result = new Map();
  const source = pickArrayPayload(payload);
  for (const row of source) {
    const sku = firstText(row, ["sku", "SKU", "ozonSku", "productSku"]);
    if (sku) {
      result.set(
        sku,
        firstNumber(row, [
          "minBid",
          "min_bid",
          "cpoMinBid",
          "cpo_min_bid",
          "bid",
        ]) ?? normalizeText(row.minBid || row.bid),
      );
    }
  }
  const objectSource =
    payload.minBids || payload.min_bids || payload.bids || payload.result;
  if (!source.length && objectSource && typeof objectSource === "object") {
    for (const [sku, bid] of Object.entries(objectSource)) {
      const normalizedSku = normalizeText(sku);
      if (normalizedSku) result.set(normalizedSku, normalizeText(bid));
    }
  }
  return result;
}

export function getMinimumSkuBidMap(payload = {}) {
  const result = new Map();
  const source = Array.isArray(payload?.minBids)
    ? payload.minBids
    : pickArrayPayload(payload);
  for (const row of source) {
    const sku = firstText(row, ["sku", "SKU", "ozonSku", "productSku"]);
    const bid = firstNumber(row, ["bid", "minBid", "min_bid"]);
    if (sku && bid !== null) result.set(sku, bid);
  }
  return result;
}

export function getBidInsightSourceAvailability(
  response = {},
  valueReturned = false,
  sku = "",
) {
  if (response.unavailable) {
    return {
      status: "unavailable",
      message:
        response.reason || "当前 Ozon Performance 版本不提供这项出价数据。",
    };
  }
  if (response.skipped) {
    return {
      status: "skipped",
      message: "当前推广类型不适用这项出价数据。",
    };
  }
  if (
    response.ok === false &&
    !valueReturned &&
    !response.successfulRequestedSkus?.has(normalizeText(sku))
  ) {
    return {
      status: "failed",
      message: response.error?.message || "Ozon 出价接口读取失败。",
    };
  }
  if (valueReturned) {
    return {
      status: "returned",
      message: "Ozon 已返回这项出价数据。",
    };
  }
  return {
    status: "empty",
    message: "Ozon 出价接口读取成功，但没有返回该商品的数值。",
  };
}

export function toPerformanceBidInsightRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    campaignId: normalizeText(row?.campaignId),
    campaignTitle: normalizeText(row?.campaignTitle),
    sku: normalizeText(row?.sku),
    offerId: normalizeText(row?.offerId),
    title: normalizeText(row?.title),
    recommendedBid: normalizePerformanceBidRubles(row?.recommendedBid),
    competitiveBid: normalizePerformanceBidRubles(row?.competitiveBid),
    minCpoBid: normalizePerformanceBidRubles(row?.minCpoBid),
    minimumCpcBid: toFiniteNumber(row?.minimumCpcBid),
    bidAvailability: isPlainObject(row?.bidAvailability)
      ? row.bidAvailability
      : {},
  }));
}

export function combineOptionalBidResponses(responses = [], getMap) {
  const successful = responses.filter((response) => response?.ok);
  const failed = responses.filter((response) => !response?.ok);
  const rows = successful.flatMap((response) =>
    pickArrayPayload(response.payload),
  );
  const map = new Map();
  const successfulRequestedSkus = new Set();
  const failedRequestedSkus = new Set();
  for (const response of successful) {
    for (const [key, value] of getMap(response.payload).entries())
      map.set(key, value);
    for (const sku of response.requestedSkus || [])
      successfulRequestedSkus.add(normalizeText(sku));
  }
  for (const response of failed) {
    for (const sku of response.requestedSkus || [])
      failedRequestedSkus.add(normalizeText(sku));
  }
  const firstFailure = failed[0];
  const firstSuccess = successful[0];
  return {
    ok: failed.length === 0,
    partial: successful.length > 0 && failed.length > 0,
    status: firstFailure?.status || firstSuccess?.status || 200,
    rows,
    map,
    batchCount: responses.length,
    successfulBatchCount: successful.length,
    failedBatchCount: failed.length,
    successfulRequestedSkus,
    failedRequestedSkus,
    error: firstFailure
      ? { message: getRemoteMessage(firstFailure.payload) }
      : null,
  };
}
