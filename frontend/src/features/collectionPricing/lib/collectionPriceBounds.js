function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function ceilCollectionCurrencyCents(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Number((Math.ceil((number * 100) - 1e-9) / 100).toFixed(2));
}

export function getCollectionMinimumAllowedPrice(salePrice) {
  const price = finiteNumber(salePrice);
  if (price === null || price <= 0) return null;
  return ceilCollectionCurrencyCents(price * 0.5);
}

export function repairLegacyCollectionMinimumPrice(salePrice, minimumPrice) {
  const price = finiteNumber(salePrice);
  const current = finiteNumber(minimumPrice);
  if (price === null || price <= 0 || current === null || current <= 0) return current;
  const required = getCollectionMinimumAllowedPrice(price);
  if (required === null || current >= required) return current;

  // Older drafts used toFixed(2) on a half-cent boundary. For example,
  // 38.79 × 50% became 19.39 although the valid cent boundary is 19.40.
  const legacyRoundedHalf = Number((price * 0.5).toFixed(2));
  return Math.abs(current - legacyRoundedHalf) < 1e-9 ? required : current;
}
