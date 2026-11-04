import { requestPurchasePluginBridge } from '../../../entities/product/productLocalMirror.jsx';
import {
  getPurchaseSourceSearchErrorMessage,
  normalizePurchaseSourceSearchResult,
} from '../../orders/purchase/lib/purchaseImageRules.jsx';

const MAX_SOURCE_CANDIDATES = 8;
const MAX_RAW_SOURCE_CANDIDATES = 60;

let gbkCharacterMap = null;

function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceProductRecords(productAnalysis = {}) {
  const records = [
    ...(Array.isArray(productAnalysis.topProducts) ? productAnalysis.topProducts : []),
    ...(Array.isArray(productAnalysis.records) ? productAnalysis.records : []),
  ];
  const seen = new Set();
  return records.filter((record) => {
    const key = text(record?.id || record?.sku || record?.link || record?.imageUrl || record?.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildGbkCharacterMap() {
  if (gbkCharacterMap) return gbkCharacterMap;
  const map = new Map();
  const decoder = new TextDecoder('gbk', { fatal: true });
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      try {
        const character = decoder.decode(Uint8Array.from([lead, trail]));
        if (Array.from(character).length === 1 && !map.has(character)) map.set(character, [lead, trail]);
      } catch {
        // Invalid GBK byte pairs are intentionally skipped.
      }
    }
  }
  gbkCharacterMap = map;
  return map;
}

export function encodeProductSelection1688Keyword(query = '') {
  const map = buildGbkCharacterMap();
  return Array.from(text(query)).map((character) => {
    if ((character.codePointAt(0) || 0) <= 0x7f) return encodeURIComponent(character);
    const bytes = map.get(character);
    if (!bytes) return encodeURIComponent(character);
    return bytes.map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  }).join('');
}

export function buildProductSelection1688KeywordSearchUrl(query = '') {
  const cleanQuery = text(query);
  if (!cleanQuery) return 'https://s.1688.com/selloffer/offer_search.htm';
  return `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeProductSelection1688Keyword(cleanQuery)}`;
}

export function selectProductSelectionSourceImage(productAnalysis = {}, sourcePlan = null) {
  const preferredIds = new Set((Array.isArray(sourcePlan?.selectedProductIds) ? sourcePlan.selectedProductIds : []).map(text));
  const candidates = sourceProductRecords(productAnalysis)
    .filter((record) => /^https?:\/\//iu.test(text(record?.imageUrl)))
    .map((record, index) => ({
      record,
      index,
      preferred: preferredIds.has(text(record?.id || record?.sku || record?.productId)) ? 1 : 0,
      revenue: finite(record?.revenue) ?? -1,
      sales: finite(record?.sales) ?? -1,
    }))
    .sort((left, right) => (
      right.preferred - left.preferred
      || right.revenue - left.revenue
      || right.sales - left.sales
      || left.index - right.index
    ));
  const selected = candidates[0]?.record;
  if (!selected) return null;
  return {
    productId: text(selected.id || selected.sku || selected.productId),
    title: text(selected.title || selected.name),
    imageUrl: text(selected.imageUrl),
    ozonUrl: text(selected.link),
  };
}

function normalizeCandidates(payload = {}) {
  const records = Array.isArray(payload.results)
    ? payload.results
    : Array.isArray(payload.sourceSearch?.results)
      ? payload.sourceSearch.results
      : [];
  const seen = new Set();
  return records
    .map(normalizePurchaseSourceSearchResult)
    .filter((item) => {
      const key = text(item.link || item.id);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return /^https?:\/\//iu.test(text(item.link));
    });
}

function normalizeComparableText(value = '') {
  return text(value).toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function searchRows(sourcePlan = null, fallbackQuery = '') {
  const rows = Array.isArray(sourcePlan?.searches) ? sourcePlan.searches : [];
  if (rows.length) return rows;
  const query = text(fallbackQuery);
  return query ? [{ query, titleZh: query, matchGroups: [[query]], excludedTerms: [] }] : [];
}

function candidateMatchesSearch(candidate = {}, search = {}) {
  const haystack = normalizeComparableText(`${candidate.title || ''} ${candidate.hint || ''}`);
  if (!haystack) return false;
  const excluded = (Array.isArray(search.excludedTerms) ? search.excludedTerms : [])
    .map(normalizeComparableText)
    .filter(Boolean);
  if (excluded.some((term) => haystack.includes(term))) return false;
  const groups = (Array.isArray(search.matchGroups) ? search.matchGroups : [])
    .map((group) => (Array.isArray(group) ? group : [group])
      .map(normalizeComparableText)
      .filter(Boolean))
    .filter((group) => group.length);
  if (groups.length) return groups.every((group) => group.some((term) => haystack.includes(term)));
  const query = normalizeComparableText(search.query);
  return Boolean(query && haystack.includes(query));
}

export function filterProductSelectionSourceCandidates(candidates = [], sourcePlan = null, query = '') {
  const searches = searchRows(sourcePlan, query);
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => searches.some((search) => candidateMatchesSearch(candidate, search)))
    .slice(0, MAX_SOURCE_CANDIDATES);
}

function buildKeywordSearches(sourcePlan = null, query = '') {
  return searchRows(sourcePlan, query).map((item) => ({
    query: text(item.query),
    titleZh: text(item.titleZh || item.query),
    productId: text(item.productId),
    ozonTitle: text(item.ozonTitle),
    url: buildProductSelection1688KeywordSearchUrl(item.query),
  }));
}

export async function searchProductSelectionSources(productAnalysis = {}, query = '', options = {}) {
  const sourcePlan = options.sourcePlan || null;
  const searches = buildKeywordSearches(sourcePlan, query);
  const keywordSearchUrl = searches[0]?.url || buildProductSelection1688KeywordSearchUrl(query);
  const sourceImage = selectProductSelectionSourceImage(productAnalysis, sourcePlan);
  if (!sourceImage) {
    return {
      status: 'keyword-only',
      statusLabel: '未取得可识图的商品图片',
      message: 'Ozon 本次数据没有返回可用主图，可直接按关键词打开 1688 继续找货源。',
      query: text(query),
      sourceImage: null,
      searchUrl: keywordSearchUrl,
      keywordSearchUrl,
      searches,
      sourcePlan,
      candidates: [],
    };
  }

  try {
    const payload = await (options.requestBridge || requestPurchasePluginBridge)(
      '/api/purchase/image-search',
      {
        method: 'POST',
        force: true,
        data: {
          platform: '1688',
          launchMode: 'background',
          imageUrl: sourceImage.imageUrl,
          maxItems: MAX_RAW_SOURCE_CANDIDATES,
          order: {
            key: `product-selection:${text(query) || sourceImage.productId}`,
            productName: sourceImage.title || text(query),
            offerId: sourceImage.productId,
            sku: sourceImage.productId,
          },
        },
      },
    );
    const rawCandidates = normalizeCandidates(payload);
    const candidates = filterProductSelectionSourceCandidates(rawCandidates, sourcePlan, query);
    const rejectedCandidateCount = rawCandidates.length - candidates.length;
    const imageSearchUrl = text(payload?.searchUrl || payload?.sourceSearch?.searchUrl);
    return {
      status: candidates.length ? 'ready' : 'keyword-ready',
      statusLabel: candidates.length
        ? `已找到 ${candidates.length} 个候选货源`
        : rejectedCandidateCount
          ? `已剔除 ${rejectedCandidateCount} 个不相关结果`
          : '中文搜款词已准备好',
      message: candidates.length
        ? '候选货源已通过商品名称一致性校验，价格、规格和起订量仍需人工核对。'
        : rejectedCandidateCount
          ? 'Ozon 主图中的人物或背景干扰了以图搜款，错误类目已全部过滤；请使用下方中文采购词继续搜索。'
          : '识图没有返回可核对的同类商品，请使用下方中文采购词继续搜索。',
      query: text(query),
      sourceImage,
      searchUrl: candidates.length ? imageSearchUrl || keywordSearchUrl : keywordSearchUrl,
      imageSearchUrl: candidates.length ? imageSearchUrl : '',
      keywordSearchUrl,
      searches,
      sourcePlan,
      rejectedCandidateCount,
      candidates,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      statusLabel: '本次没有读到 1688 候选商品',
      message: `${getPurchaseSourceSearchErrorMessage(error, error?.status)} 可先按关键词打开 1688 搜索。`,
      query: text(query),
      sourceImage,
      searchUrl: keywordSearchUrl,
      keywordSearchUrl,
      searches,
      sourcePlan,
      candidates: [],
    };
  }
}
