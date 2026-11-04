export const DEFAULT_PRINT_SHIPPING_FILTERS = Object.freeze({
  warehouse: '',
  deliveryMethod: '',
  deadlineScope: '',
  trackingState: '',
  carriageState: '',
});

export function normalizePrintShippingFilters(value = {}) {
  return Object.fromEntries(
    Object.keys(DEFAULT_PRINT_SHIPPING_FILTERS).map((key) => [key, String(value?.[key] ?? '').trim()])
  );
}

export function hasActivePrintShippingFilters(value = {}) {
  return Object.values(normalizePrintShippingFilters(value)).some(Boolean);
}

export function normalizePrintShippingFacetOptions(rows = []) {
  if (!Array.isArray(rows)) return [];
  const unique = new Map();
  rows.forEach((row) => {
    const value = String(row?.value ?? '').trim();
    if (!value || unique.has(value)) return;
    unique.set(value, { value, total: Math.max(Number(row?.total) || 0, 0) });
  });
  return [...unique.values()];
}
