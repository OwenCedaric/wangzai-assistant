import { normalizeOzonId } from '../order/orderIdentityRules.jsx';

export function getProfitPostingBaseKey(value) {
  const text = normalizeOzonId(value).trim();
  if (!text || text === '未返回') return '';
  const match = text.match(/^(\d{6,}-\d{3,})-\d+$/);
  return match ? match[1] : '';
}

export function getProfitPostingLookupKeys(...values) {
  const keys = new Set();
  values.flat().forEach((value) => {
    const text = normalizeOzonId(value).trim();
    if (!text || text === '未返回') return;
    keys.add(text);
    const baseKey = getProfitPostingBaseKey(text);
    if (baseKey) keys.add(baseKey);
  });
  return [...keys];
}
