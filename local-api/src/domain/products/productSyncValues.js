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

export function uniqueIds(values = []) {
  return [...new Set(values.map(normalizeId).filter(Boolean))];
}

export function normalizeVisibility(value) {
  return normalizeText(value || "ALL").toUpperCase() || "ALL";
}
