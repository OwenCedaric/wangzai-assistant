import { requestLocalApi } from '../../../api/localApiClient.js';

const SOURCE_PLAN_TIMEOUT_MS = 180_000;
const MAX_PLAN_PRODUCTS = 24;
const MAX_SEARCHES = 3;
const MAX_MATCH_GROUPS = 4;
const MAX_TERMS_PER_GROUP = 8;

function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanJsonText(value) {
  const raw = text(value)
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  return first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
}

function uniqueTextList(value, limit = 12) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(text)
    .filter(Boolean))]
    .slice(0, limit);
}

function sourcePlanRecords(productAnalysis = {}) {
  const records = [
    ...(Array.isArray(productAnalysis.topProducts) ? productAnalysis.topProducts : []),
    ...(Array.isArray(productAnalysis.records) ? productAnalysis.records : []),
  ];
  const seen = new Set();
  return records
    .filter((record) => {
      const key = text(record?.id || record?.sku || record?.productId || record?.link || record?.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((record, index) => ({
      record,
      index,
      revenue: finite(record?.revenue) ?? -1,
      sales: finite(record?.sales) ?? -1,
    }))
    .sort((left, right) => (
      right.revenue - left.revenue
      || right.sales - left.sales
      || left.index - right.index
    ))
    .map((item) => item.record);
}

function compactPlanProduct(record = {}) {
  return {
    productId: text(record.id || record.sku || record.productId),
    title: text(record.title || record.name),
    category: text(record.category || record.category3 || record.category2),
    sales: finite(record.sales),
    revenue: finite(record.revenue),
    price: finite(record.price),
    hasImage: /^https?:\/\//iu.test(text(record.imageUrl)),
  };
}

function fallbackMatchGroups(query = '') {
  const normalized = text(query);
  const groups = [];
  if (/遥控|无线控制|remote\s*control|radio\s*controlled|\brc\b/iu.test(normalized)) {
    groups.push(['遥控', '无线遥控', 'RC', 'remote control', 'radio controlled']);
  }
  if (/汽车|小汽车|玩具车|越野车|赛车|卡车|攀爬车|漂移车|\bcar\b/iu.test(normalized)) {
    groups.push(['遥控车', '汽车', '玩具车', '越野车', '赛车', '卡车', '攀爬车', '漂移车', '车模']);
  }
  if (!groups.length && normalized) groups.push([normalized]);
  return groups;
}

function fallbackExcludedTerms(query = '') {
  if (!/遥控|汽车|玩具车|越野车|赛车|卡车|攀爬车|漂移车|\bcar\b/iu.test(text(query))) return [];
  return ['童装', '服装', '短袖', 'T恤', '上衣', '裤子', '泳衣', '织带', '腰带', '吊带', '贴纸', '鞋子'];
}

export function createFallbackProductSelectionSourcePlan(productAnalysis = {}, query = '') {
  const cleanQuery = text(query);
  const records = sourcePlanRecords(productAnalysis);
  const representative = records.find((record) => /^https?:\/\//iu.test(text(record?.imageUrl))) || records[0] || null;
  return {
    status: 'fallback',
    normalizedQuery: cleanQuery,
    selectedProductIds: representative
      ? [text(representative.id || representative.sku || representative.productId)].filter(Boolean)
      : [],
    searches: cleanQuery ? [{
      query: cleanQuery,
      titleZh: cleanQuery,
      productId: text(representative?.id || representative?.sku || representative?.productId),
      ozonTitle: text(representative?.title || representative?.name),
      matchGroups: fallbackMatchGroups(cleanQuery),
      excludedTerms: fallbackExcludedTerms(cleanQuery),
    }] : [],
  };
}

function normalizeMatchGroups(value, fallback = []) {
  const groups = (Array.isArray(value) ? value : [])
    .map((group) => uniqueTextList(Array.isArray(group) ? group : [group], MAX_TERMS_PER_GROUP))
    .filter((group) => group.length)
    .slice(0, MAX_MATCH_GROUPS);
  return groups.length ? groups : fallback;
}

function mergeMatchGroups(value, required = []) {
  return normalizeMatchGroups([
    ...(Array.isArray(required) ? required : []),
    ...(Array.isArray(value) ? value : []),
  ]).filter((group, index, rows) => {
    const key = group.map((item) => text(item).toLocaleLowerCase('zh-CN')).sort().join('|');
    return rows.findIndex((row) => (
      row.map((item) => text(item).toLocaleLowerCase('zh-CN')).sort().join('|') === key
    )) === index;
  }).slice(0, MAX_MATCH_GROUPS);
}

export function parseProductSelectionSourcePlan(value, productAnalysis = {}, query = '') {
  let parsed;
  try {
    parsed = JSON.parse(cleanJsonText(value));
  } catch {
    throw new Error('分析模型没有返回可用的中文采购词。');
  }
  const fallback = createFallbackProductSelectionSourcePlan(productAnalysis, query);
  const available = new Map(sourcePlanRecords(productAnalysis).map((record) => [
    text(record.id || record.sku || record.productId),
    record,
  ]));
  const searches = (Array.isArray(parsed.searches) ? parsed.searches : [])
    .map((item) => {
      const productId = text(item?.productId);
      const record = available.get(productId);
      const searchQuery = text(item?.query || item?.keyword || item?.titleZh);
      if (!searchQuery || (productId && !record)) return null;
      const requiredGroups = fallbackMatchGroups(query);
      return {
        query: searchQuery,
        titleZh: text(item?.titleZh || item?.translatedTitle || searchQuery),
        productId,
        ozonTitle: text(record?.title || item?.ozonTitle),
        matchGroups: mergeMatchGroups(item?.matchGroups, requiredGroups),
        excludedTerms: uniqueTextList([
          ...fallbackExcludedTerms(query),
          ...(Array.isArray(item?.excludedTerms) ? item.excludedTerms : []),
        ], 20),
      };
    })
    .filter(Boolean)
    .filter((item, index, rows) => rows.findIndex((entry) => entry.query === item.query) === index)
    .slice(0, MAX_SEARCHES);
  if (!searches.length) return fallback;
  return {
    status: 'ready',
    normalizedQuery: text(parsed.normalizedQuery) || text(query),
    selectedProductIds: uniqueTextList(searches.map((item) => item.productId)),
    searches,
  };
}

export function createProductSelectionSourcePlanRequest(productAnalysis = {}, query = '', modelSelection = {}) {
  if (!modelSelection?.ready || !text(modelSelection.accountId) || !text(modelSelection.model)) {
    throw new Error('没有可用的文本模型。');
  }
  const products = sourcePlanRecords(productAnalysis)
    .slice(0, MAX_PLAN_PRODUCTS)
    .map(compactPlanProduct);
  return {
    accountId: text(modelSelection.accountId),
    model: text(modelSelection.model),
    templateId: 'product-selection-source-plan.v1',
    templateInput: {
      query: text(query),
      products,
      outputContract: {
        normalizedQuery: '',
        searches: [{ productId: '', titleZh: '', query: '', matchGroups: [['']], excludedTerms: [''] }],
      },
    },
  };
}

export async function planProductSelectionSources(productAnalysis = {}, query = '', modelSelection = {}, options = {}) {
  const fallback = createFallbackProductSelectionSourcePlan(productAnalysis, query);
  if (!modelSelection?.ready) return fallback;
  try {
    const request = createProductSelectionSourcePlanRequest(productAnalysis, query, modelSelection);
    const response = await (options.requestAnalysis || requestLocalApi)('/api/integrations/analyze', {
      method: 'POST',
      body: request,
      timeoutMs: options.timeoutMs || SOURCE_PLAN_TIMEOUT_MS,
      signal: options.signal,
    });
    return parseProductSelectionSourcePlan(response?.reportText, productAnalysis, query);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return {
      ...fallback,
      message: '中文采购词自动整理本次没有完成，已按原始商品词继续搜索。',
    };
  }
}
