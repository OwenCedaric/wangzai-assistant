function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeLowerText(value) {
  return normalizeText(value).toLowerCase();
}

function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = normalizeText(value)
    .replace(/[\u00a0\u202f\s]+/gu, "")
    .replace(/[^\d,+.\-]/gu, "");
  if (!text) return null;
  if (text.includes(",") && text.includes(".")) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
      text = text.replace(/\./gu, "").replace(",", ".");
    } else {
      text = text.replace(/,/gu, "");
    }
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function firstText(source, keys) {
  for (const key of keys) {
    const value = normalizeText(source?.[key]);
    if (value) return value;
  }
  return "";
}

function firstNumber(source, keys) {
  for (const key of keys) {
    const value = toFiniteNumber(source?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstValue(source, keys) {
  for (const key of keys) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (value !== undefined && value !== null && normalizeText(value)) {
        return value;
      }
    }
  }
  return null;
}

function normalizeMetricNumber(value) {
  const number = toFiniteNumber(value);
  return number === null ? null : number;
}

function normalizePerformanceBudgetRubles(value) {
  const micros = toFiniteNumber(value);
  if (micros === null) return null;
  return Number((micros / 1_000_000).toFixed(6));
}

function firstPerformanceBudgetRubles(source, keys) {
  for (const key of keys) {
    if (!source || !Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = normalizePerformanceBudgetRubles(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizePerformanceBidRubles(value) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  return Math.abs(number) >= 100_000
    ? Number((number / 1_000_000).toFixed(6))
    : number;
}

function firstPerformanceBidRubles(source, keys) {
  for (const key of keys) {
    if (!source || !Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = normalizePerformanceBidRubles(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function pickArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.list)) return payload.list;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.campaigns)) return payload.campaigns;
  if (Array.isArray(payload.products)) return payload.products;
  if (Array.isArray(payload.objects)) return payload.objects;
  if (Array.isArray(payload.limits)) return payload.limits;
  if (Array.isArray(payload.skus)) return payload.skus;
  if (Array.isArray(payload.modes)) return payload.modes;
  if (Array.isArray(payload.availableModes)) return payload.availableModes;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePerformanceInspectionRow(row, index = 0) {
  if (isPlainObject(row)) return row;
  return {
    value: row ?? null,
    rowIndex: index + 1,
  };
}

function toPerformanceInspectionRows(rows = [], options = {}) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const raw = isPlainObject(row?.raw) ? row.raw : row;
    const normalized = normalizePerformanceInspectionRow(raw, index);
    const context =
      typeof options.context === "function"
        ? options.context(row, index)
        : null;
    return isPlainObject(context) ? { ...context, ...normalized } : normalized;
  });
}

function collectPerformanceFieldNames(rows = []) {
  const fields = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isPlainObject(row)) continue;
    for (const key of Object.keys(row)) fields.add(key);
  }
  return [...fields].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function toPerformancePayloadRows(payload) {
  const rows = pickArrayPayload(payload);
  if (rows.length) return rows;
  if (isPlainObject(payload) && Object.keys(payload).length) return [payload];
  if (payload !== undefined && payload !== null && normalizeText(payload))
    return [{ value: payload }];
  return [];
}

function createPerformanceDataSet({
  key,
  label,
  endpoint,
  rows = [],
  response = null,
  status,
  note = "",
}) {
  const safeRows = (Array.isArray(rows) ? rows : []).map(
    normalizePerformanceInspectionRow,
  );
  const responseOk = response?.ok !== false;
  const resolvedStatus =
    status ||
    (response?.skipped
      ? "skipped"
      : response?.partial
        ? "partial"
        : responseOk
          ? safeRows.length
            ? "success"
            : "empty"
          : "failed");
  return {
    key,
    label,
    endpoint: normalizeText(endpoint || response?.endpoint),
    status: resolvedStatus,
    count: safeRows.length,
    fields: collectPerformanceFieldNames(safeRows),
    rows: safeRows,
    note: normalizeText(note || response?.error?.message || response?.reason),
  };
}

export {
  normalizeText,
  normalizeLowerText,
  toFiniteNumber,
  firstText,
  firstNumber,
  firstValue,
  normalizeMetricNumber,
  normalizePerformanceBudgetRubles,
  firstPerformanceBudgetRubles,
  normalizePerformanceBidRubles,
  firstPerformanceBidRubles,
  pickArrayPayload,
  isPlainObject,
  normalizePerformanceInspectionRow,
  toPerformanceInspectionRows,
  collectPerformanceFieldNames,
  toPerformancePayloadRows,
  createPerformanceDataSet,
};
