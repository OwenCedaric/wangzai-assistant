export function normalizeProductListPriceCurrencyCode(currencyCode) {
  const normalized = String(currencyCode || '')
    .trim()
    .toUpperCase();
  if (!normalized || normalized === 'RUB' || normalized === 'RUR' || normalized === 'RMB') return 'CNY';
  return normalized;
}

export function formatOzonPrice(price, currencyCode) {
  if (price === undefined || price === null || price === '') return '-';
  const value = Number(price);
  if (!Number.isFinite(value)) return String(price);
  if (currencyCode === 'CNY') return `¥${value.toFixed(2)}`;
  return `${value.toFixed(2)} ${currencyCode || ''}`.trim();
}
