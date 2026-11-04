export function firstMarketingValue(...values) {
  for (const value of values) {
    if (value === 0) return '0';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}
