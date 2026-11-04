import { normalizeLowerText, normalizeText, pickArrayPayload } from "./performanceApiNormalization.js";

export const PERFORMANCE_API_BASE_URL = "https://api-performance.ozon.ru";

export const PERFORMANCE_BUSY_RETRY_DELAYS_MS = [1200, 2500, 5000, 8000];

export const PERFORMANCE_TRANSPORT_RETRY_DELAYS_MS = [1000, 2500];

export function trimTrailingSlash(value) {
  return normalizeText(value).replace(/\/+$/u, "");
}

export function getPayloadBaseUrl(payload = {}) {
  const values = getPayloadValues(payload);
  return normalizeText(
    payload.baseUrl ||
      values.baseUrl ||
      payload.apiBaseUrl ||
      values.apiBaseUrl,
  );
}

export function resolvePerformanceBaseUrl(payload = {}, options = {}) {
  const payloadBaseUrl = getPayloadBaseUrl(payload);
  if (payloadBaseUrl && options.allowPayloadBaseUrl !== true) {
    throw createIntegrationError(
      "PERFORMANCE_BASE_URL_FORBIDDEN",
      "不允许通过请求体指定 Performance API 地址。",
      400,
    );
  }
  return trimTrailingSlash(options.baseUrl || PERFORMANCE_API_BASE_URL);
}

export function assertPerformanceUrlAllowed(url, baseUrl = PERFORMANCE_API_BASE_URL) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  const allowed = new URL(
    trimTrailingSlash(baseUrl || PERFORMANCE_API_BASE_URL),
  );
  if (parsed.origin !== allowed.origin) {
    throw createIntegrationError(
      "PERFORMANCE_REMOTE_URL_BLOCKED",
      "Performance API 返回了非白名单地址，已阻止携带 token 访问。",
      502,
      { blockedOrigin: parsed.origin },
    );
  }
  return parsed;
}

export function buildPerformanceUrl(baseUrl, endpoint, query) {
  const endpointText = normalizeText(endpoint);
  const base = trimTrailingSlash(baseUrl || PERFORMANCE_API_BASE_URL);
  const url = /^https?:\/\//iu.test(endpointText)
    ? new URL(endpointText)
    : new URL(
        endpointText.startsWith("/") ? endpointText : `/${endpointText}`,
        `${base}/`,
      );
  assertPerformanceUrlAllowed(url, base);
  const params = new URLSearchParams(url.search);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === "") continue;
        params.append(key, String(item));
      }
    } else {
      params.set(key, String(value));
    }
  }
  url.search = params.toString();
  return url.toString();
}

export function createIntegrationError(code, message, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

export function getNestedValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (normalizeText(value)) return normalizeText(value);
  }
  return "";
}

export function getPayloadValues(payload = {}) {
  return {
    ...(payload.values ?? {}),
    ...(payload.credentials ?? {}),
    ...payload,
  };
}

export function normalizeIntegrationType(payload = {}) {
  const values = getPayloadValues(payload);
  return normalizeText(
    values.integrationType ||
      values.type ||
      values.platformType ||
      values.apiType ||
      values.platform,
  );
}

export function normalizePerformanceCredentials(payload = {}) {
  const values = getPayloadValues(payload);
  return {
    clientId: getNestedValue(values, [
      "performanceClientId",
      "clientId",
      "client_id",
      "id",
    ]),
    clientSecret: getNestedValue(values, [
      "performanceClientSecret",
      "clientSecret",
      "client_secret",
      "secret",
    ]),
  };
}

export async function resolvePerformanceCredentials(payload = {}, options = {}) {
  if (typeof options.credentialResolver === "function") {
    const credentials = await options.credentialResolver(payload);
    return {
      clientId: normalizeText(credentials?.clientId),
      clientSecret: normalizeText(credentials?.clientSecret),
      accountId: normalizeText(credentials?.accountId),
    };
  }
  return normalizePerformanceCredentials(payload);
}

export async function readRemoteJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export function parsePerformanceDelimitedRows(text) {
  const source = String(text || "").replace(/^\uFEFF/u, "");
  if (!source.trim()) return [];
  const delimiterSample = source.split(/\r?\n/u).slice(0, 12);
  const delimiterCandidates = [";", "\t", ","];
  const delimiter = delimiterCandidates
    .map((value) => ({
      value,
      count: Math.max(
        0,
        ...delimiterSample.map((line) => line.split(value).length - 1),
      ),
    }))
    .sort((left, right) => right.count - left.count)[0]?.value || ",";
  const parsedRows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && character === delimiter) {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) parsedRows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += character;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) parsedRows.push(row);
  if (!parsedRows.length) return [];

  const headerSearchRows = parsedRows.slice(0, 12);
  let headerIndex = 0;
  let headerWidth = 0;
  for (const [index, candidate] of headerSearchRows.entries()) {
    const width = candidate.filter(Boolean).length;
    if (width > headerWidth) {
      headerIndex = index;
      headerWidth = width;
    }
  }
  const seenHeaders = new Map();
  const headers = parsedRows[headerIndex].map((value, index) => {
    const base = normalizeText(value) || `column_${index + 1}`;
    const count = (seenHeaders.get(base) || 0) + 1;
    seenHeaders.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
  return parsedRows.slice(headerIndex + 1).flatMap((values) => {
    if (!values.some(Boolean)) return [];
    const item = {};
    for (let index = 0; index < headers.length; index += 1) {
      item[headers[index]] = values[index] ?? "";
    }
    return [item];
  });
}

export async function readRemotePerformanceReport(response) {
  const text = await response.text();
  if (!text) return { rows: [], format: "empty" };
  try {
    const payload = JSON.parse(text);
    return {
      payload,
      rows: pickArrayPayload(payload),
      format: "json",
    };
  } catch {
    return {
      rows: parsePerformanceDelimitedRows(text),
      format: "csv",
    };
  }
}

export function getRemoteMessage(payload) {
  return (
    normalizeText(payload?.error?.message) ||
    normalizeText(payload?.message) ||
    normalizeText(payload?.error) ||
    normalizeText(payload?.raw) ||
    "远程接口返回异常。"
  );
}

export function getPerformanceReportErrorMessage(payload, fallback = "推广报表读取失败。") {
  const message = getRemoteMessage(payload);
  const lower = normalizeLowerText(message);
  if (
    lower.includes("превышен лимит активных запросов") ||
    lower.includes("максимум 1") ||
    lower.includes("maximum 1") ||
    lower.includes("active requests")
  ) {
    return "Ozon 当前已有一个报表任务占用生成通道，请稍后再次刷新本报表。";
  }
  if (lower.includes("некорректный период") || lower.includes("incorrect period")) {
    return "Ozon 不接受当前报表日期范围，请缩短统计日期后重试。";
  }
  if (lower.includes("maximum 10") || lower.includes("максимум 10")) {
    return "Ozon 单次最多读取 10 个推广计划，系统拆分请求未完成，请重试。";
  }
  if (message === "远程接口返回异常。") return fallback;
  return message || fallback;
}

export function isPerformanceBusyLimit(payload, status) {
  const message = normalizeLowerText(getRemoteMessage(payload));
  return (
    status === 429 ||
    message.includes("превышен лимит активных запросов") ||
    message.includes("максимум 1") ||
    message.includes("maximum 1") ||
    message.includes("active requests") ||
    message.includes("too many") ||
    message.includes("rate limit")
  );
}

export function getTransportErrorCode(error) {
  return normalizeText(
    error?.code ||
      error?.cause?.code ||
      error?.cause?.name ||
      error?.name ||
      "",
  );
}

export function getTransportErrorMessage(error) {
  return normalizeText(
    error?.message ||
      error?.cause?.message ||
      error?.cause?.code ||
      "网络请求失败",
  );
}

export function isPerformanceTransportRetryable(error) {
  const text = normalizeLowerText(
    `${getTransportErrorCode(error)} ${getTransportErrorMessage(error)}`,
  );
  return (
    text.includes("fetch failed") ||
    text.includes("network") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("abort") ||
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("eai_again") ||
    text.includes("und_err")
  );
}

export function createPerformanceTransportError(error) {
  return createIntegrationError(
    "PERFORMANCE_REMOTE_NETWORK_FAILED",
    `Performance API 实时读取网络异常：${getTransportErrorMessage(error)}`,
    502,
    {
      causeCode: getTransportErrorCode(error) || undefined,
    },
  );
}

export function isPerformanceSecurityError(error) {
  return [
    "PERFORMANCE_BASE_URL_FORBIDDEN",
    "PERFORMANCE_REMOTE_URL_BLOCKED",
  ].includes(error?.code);
}

export function getRetryAfterMs(headers, attempt) {
  const retryAfter = normalizeText(headers?.get?.("retry-after"));
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return PERFORMANCE_BUSY_RETRY_DELAYS_MS[
    Math.min(attempt, PERFORMANCE_BUSY_RETRY_DELAYS_MS.length - 1)
  ];
}

export function getTransportRetryDelayMs(attempt) {
  return PERFORMANCE_TRANSPORT_RETRY_DELAYS_MS[
    Math.min(attempt, PERFORMANCE_TRANSPORT_RETRY_DELAYS_MS.length - 1)
  ];
}
