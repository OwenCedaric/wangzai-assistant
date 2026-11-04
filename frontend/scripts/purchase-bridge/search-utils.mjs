import { createHash } from 'node:crypto';

export function normalizeImageUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function build1688ImageSearchUrl(imageUrl) {
  return `https://s.1688.com/selloffer/offer_search.html?imageAddress=${encodeURIComponent(imageUrl)}`;
}

export function buildPddSearchUrl(title) {
  return `https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(title)}`;
}

export function buildTaobaoImageSearchUrl(imageUrl, platform = 'taobao') {
  const isTmall = /tmall|天猫/i.test(String(platform || ''));
  const endpoint = new URL('https://s.taobao.com/search');
  endpoint.searchParams.set('imgSearchUrl', imageUrl);
  endpoint.searchParams.set('tab', isTmall ? 'mall' : 'all');
  endpoint.searchParams.set('ie', 'utf8');
  endpoint.searchParams.set('search_type', 'item');
  endpoint.searchParams.set('imgFrom', 'otherPage');
  return endpoint.toString();
}

export function md5(value = '') {
  return createHash('md5').update(String(value)).digest('hex');
}

export function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

export function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? '';
}

export function cleanUrl(value = '') {
  const text = decodeHtmlEntities(decodeJsonString(value))
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .trim();
  if (!text) return '';
  if (text.startsWith('//')) return `https:${text}`;
  return text;
}

export function decodeJsonString(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    return JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
  } catch {
    return text;
  }
}

export function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

export function normalizeTitle(value = '') {
  const title = decodeHtmlEntities(decodeJsonString(value))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length < 4 || title.length > 160) return '';
  if (/^(1688|阿里巴巴|找货神器|图片搜索|搜同款|登录|注册)$/i.test(title)) return '';
  if (/^[\d\s.,;:|/_-]+$/.test(title)) return '';
  return title;
}

export function stripHtml(value = '') {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function collectUnique(items, limit = 12) {
  const seen = new Set();
  const result = [];
  items.forEach((item) => {
    const title = normalizeTitle(item.title || item);
    if (!title || seen.has(title)) return;
    seen.add(title);
    result.push({ ...item, title });
  });
  return result.slice(0, limit);
}

export function normalizeSearchResultTitle(value = '') {
  const title = normalizeTitle(value);
  if (!title || title === '未命名商品') return '';
  return title;
}

// PURCHASE_PDD_1688_TITLE_SELECTION_FREEZE:BEGIN
function comparableTitleTokens(value = '') {
  const normalized = normalizeSearchResultTitle(value)
    .toLowerCase()
    .replace(/(?:跨境|热卖|爆款|新款|厂家|直销|批发|同款|网红|高端|轻奢|高级感)/gu, '')
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
  const tokens = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    tokens.add(normalized.slice(index, index + 2));
  }
  return tokens;
}

function titleSimilarity(left = '', right = '') {
  const leftTokens = comparableTitleTokens(left);
  const rightTokens = comparableTitleTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) intersection += 1;
  });
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

export function selectTitleCandidate(results = []) {
  const candidates = asArray(results).filter((item) => normalizeSearchResultTitle(item?.title));
  const first = candidates[0] || null;
  if (!first || first.isAd !== true) return first;

  // 1688 may inject an unrelated paid placement ahead of the actual visual
  // matches. Keep a first-ranked ad only when several organic results support
  // the same product vocabulary; otherwise use the first organic image match.
  const organicCandidates = candidates.filter((item) => item.isAd !== true);
  if (!organicCandidates.length) return first;
  const supportingOrganicMatches = organicCandidates
    .slice(0, 12)
    .filter((item) => titleSimilarity(first.title, item.title) >= 0.24);
  return supportingOrganicMatches.length >= 2 ? first : organicCandidates[0];
}
// PURCHASE_PDD_1688_TITLE_SELECTION_FREEZE:END
