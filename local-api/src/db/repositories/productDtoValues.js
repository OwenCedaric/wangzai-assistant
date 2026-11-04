export function nowIso() {
  return new Date().toISOString();
}

export function normalizeText(value) {
  return typeof value === "string"
    ? value.trim()
    : value == null
      ? ""
      : String(value).trim();
}

export function normalizeId(value) {
  const text = normalizeText(value);
  return text && text !== "0" ? text : "";
}

export function firstFilled(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return value;
  }
  return "";
}

export function toFiniteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

export function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = toFiniteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

export function toInteger(value) {
  const number = toFiniteNumber(value);
  return number === null ? null : Math.trunc(number);
}

export function normalizeVisibility(value, fallback = "ALL") {
  return normalizeText(value || fallback).toUpperCase() || "ALL";
}

export function normalizeVisibilityToken(value) {
  return normalizeText(value).toUpperCase();
}

export function normalizeProductCurrencyCode(value, fallback = "CNY") {
  const text = normalizeText(value).toUpperCase();
  if (!text) return fallback;
  if (text === "RMB") return "CNY";
  // 商品列表在三代目里按 Ozon 店铺当前人民币价格展示；原始币种仍保留在 priceJson。
  if (text === "RUB" || text === "RUR") return "CNY";
  return text;
}

export function booleanFromValue(value) {
  if (value === true || value === false) return value;
  const text = normalizeText(value).toLowerCase();
  if (!text) return null;
  if (["true", "1", "yes", "y"].includes(text)) return true;
  if (["false", "0", "no", "n"].includes(text)) return false;
  return null;
}

export function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}
