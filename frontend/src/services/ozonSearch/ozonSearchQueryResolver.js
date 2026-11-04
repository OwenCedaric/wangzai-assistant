import { getCatalogCategoryTreeCache } from '../../api/localApiClient.js';
import {
  findOzonCategoryMatchesByTitle,
  hydrateOzonCategoryIndexFromCacheNodes,
  isOzonCategoryIndexHydrated,
  ozonCategoryTreeMeta,
} from '../../data/ozonCategoryIndex.js';

export const OZON_ACTIVE_PRODUCT_QUERY_MODES = Object.freeze(['product', 'sku', 'category']);

const QUERY_ALIASES = Object.freeze({
  遥控汽车: ['машинки радиоуправляемые', 'радиоуправляемая машина', 'машинка на радиоуправлении', 'радиоуправляемая машинка'],
  遥控车: ['машинки радиоуправляемые', 'радиоуправляемая машина', 'машинка на радиоуправлении', 'радиоуправляемая машинка'],
  汽车: ['автомобиль', 'машина'],
  连衣裙: ['платье', 'платья'],
  女装: ['женская одежда', 'женское'],
  男装: ['мужская одежда', 'мужское'],
  运动鞋: ['кроссовки', 'спортивная обувь'],
  鞋: ['обувь', 'кроссовки'],
  玩具: ['игрушка', 'игрушки'],
  娃娃: ['кукла', 'куклы'],
  书包: ['рюкзак', 'школьный рюкзак'],
  背包: ['рюкзак'],
  水杯: ['бутылка для воды', 'стакан'],
  保温杯: ['термос', 'термокружка'],
  耳机: ['наушники'],
  手机壳: ['чехол для телефона', 'чехол'],
  充电器: ['зарядное устройство', 'зарядка'],
  数据线: ['кабель', 'кабель для зарядки'],
  灯: ['светильник', 'лампа'],
  家居: ['товары для дома'],
  厨房: ['кухня', 'товары для кухни'],
  美妆: ['косметика'],
  母婴: ['товары для детей'],
  宠物: ['товары для животных'],
  手表: ['часы'],
});

// These are taxonomy synonyms, not fixed ids.  The actual Ozon type id is
// always resolved from the shared 7k+ node catalog so catalog upgrades do not
// require another per-keyword code patch.
const QUERY_CATEGORY_HINTS = Object.freeze({
  遥控汽车: ['遥控玩具', '无线电遥控玩具'],
  遥控车: ['遥控玩具', '无线电遥控玩具'],
});

const QUERY_STOP_WORDS = new Set([
  'на', 'в', 'с', 'и', 'для', 'по', 'из', 'к', 'от', 'до', 'под', 'над', 'при', 'без', 'у',
  'a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with',
]);

let categoryCatalogLoadPromise = null;

function text(value) {
  return String(value ?? '').trim();
}

function hasHanText(value) {
  return /\p{Script=Han}/u.test(text(value));
}

function inputValue(values = {}) {
  if (typeof values === 'string' || typeof values === 'number') return text(values);
  return Object.values(values && typeof values === 'object' ? values : {})
    .map(text)
    .find(Boolean) || '';
}

export function normalizeOzonQueryText(value) {
  return text(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b\u200c\u200d]/gu, '')
    .replace(/[\s,，;；/|]+/gu, ' ')
    .trim();
}

function addToken(tokens, value) {
  const normalized = normalizeOzonQueryText(value);
  if (!normalized) return;
  const parts = normalized.split(' ').filter((part) => (
    (part.length >= 2 || /^\d+$/u.test(part)) && !QUERY_STOP_WORDS.has(part)
  ));
  parts.forEach((part) => tokens.add(part));
  if (normalized.length >= 2) tokens.add(normalized);
}

function matchedAliasSources(normalizedInput) {
  return Object.keys(QUERY_ALIASES)
    .filter((source) => normalizedInput.includes(source))
    .filter((source, index, sources) => !sources.some((candidate, candidateIndex) => (
      candidateIndex !== index
      && candidate.length > source.length
      && candidate.includes(source)
    )));
}

export function expandOzonQueryValue(value) {
  const normalized = normalizeOzonQueryText(value);
  const tokens = new Set();
  const aliases = new Set();
  if (!normalized) return { tokens: [], aliases: [] };

  addToken(tokens, normalized);
  for (const source of matchedAliasSources(normalized)) {
    QUERY_ALIASES[source].forEach((target) => {
      addToken(tokens, target);
      aliases.add(target);
    });
  }

  return { tokens: [...tokens], aliases: [...aliases] };
}

export function buildOzonQueryTokens(values = {}) {
  const tokens = new Set();
  const aliases = new Set();
  const sourceValues = typeof values === 'object' && values !== null
    ? Object.values(values)
    : [values];
  sourceValues.map(text).filter(Boolean).forEach((value) => {
    const expanded = expandOzonQueryValue(value);
    expanded.tokens.forEach((token) => tokens.add(token));
    expanded.aliases.forEach((alias) => aliases.add(alias));
  });
  return { tokens: [...tokens].slice(0, 40), aliases: [...aliases].slice(0, 20) };
}

export function extractOzonSku(value) {
  const normalized = text(value).normalize('NFKC');
  if (!normalized) return '';
  const matches = normalized.match(/(?<!\d)\d{5,}(?!\d)/gu) || [];
  return matches.at(-1) || '';
}

function categoryLeafInput(value) {
  const parts = text(value)
    .split(/(?:\s*[>＞]\s*|\s+\/\s+|\s+\\\s+)/gu)
    .map(text)
    .filter(Boolean);
  return parts.at(-1) || text(value);
}

function collectCategoryHints(normalizedInput, input) {
  const hints = new Set([input]);
  for (const source of matchedAliasSources(normalizedInput)) {
    hints.add(source);
    (QUERY_CATEGORY_HINTS[source] || []).forEach((hint) => hints.add(hint));
  }
  return [...hints].filter(Boolean);
}

function resolveCategoryMatch(categoryHints, aliasSources = []) {
  const candidates = [];
  categoryHints.forEach((hint, hintIndex) => {
    findOzonCategoryMatchesByTitle(hint, { limit: 8 }).forEach((match) => {
      candidates.push({ ...match, hint, hintIndex, score: match.score - hintIndex * 120 });
    });
  });
  candidates.sort((left, right) => (
    right.score - left.score
    || Number(right.nodeKind === 'type') - Number(left.nodeKind === 'type')
    || right.name.length - left.name.length
  ));
  const first = candidates[0] || null;
  const categoryConstraint = candidates.find((candidate) => (
    candidate.nodeKind === 'category'
    && aliasSources.includes(candidate.hint)
  ));
  if (
    first?.nodeKind === 'type'
    && first.matchKind !== 'exact'
    && categoryConstraint
    && !normalizeOzonQueryText(first.pathText).includes(normalizeOzonQueryText(categoryConstraint.name))
  ) {
    return { best: categoryConstraint, candidates };
  }
  if (!first || first.nodeKind !== 'type' || first.matchKind !== 'title-contains-query') {
    return { best: first, candidates };
  }
  const similarlyMatchedTypes = candidates.filter((candidate) => (
    candidate.nodeKind === 'type'
    && candidate.hintIndex === first.hintIndex
    && candidate.matchKind === first.matchKind
    && candidate.score >= first.score - 80
  ));
  const best = similarlyMatchedTypes.length <= 1
    ? first
    : candidates.find((candidate) => candidate.nodeKind === 'category') || null;
  return { best, candidates };
}

export function isActiveOzonProductQueryMode(queryMode = '') {
  return OZON_ACTIVE_PRODUCT_QUERY_MODES.includes(text(queryMode));
}

export function resolveOzonSearchQueryPlanSync(values = {}, options = {}) {
  const queryMode = isActiveOzonProductQueryMode(options.queryMode) ? options.queryMode : 'product';
  const input = inputValue(values);
  const normalizedInput = normalizeOzonQueryText(input);
  const expanded = expandOzonQueryValue(input);
  const aliasSources = matchedAliasSources(normalizedInput);
  const sku = extractOzonSku(input);
  const categoryInput = queryMode === 'category' ? categoryLeafInput(input) : input;
  const categoryHints = collectCategoryHints(normalizedInput, categoryInput);
  const { best: categoryMatch } = resolveCategoryMatch(categoryHints, aliasSources);
  const categoryIds = categoryMatch?.typeId ? [categoryMatch.typeId] : [];
  const exactSkuQuery = Boolean(sku) && (
    queryMode === 'sku'
    || /^\d{5,}$/u.test(normalizedInput)
    || /(?:\bozon\.|\bsku\b|货号|商品\s*id)/iu.test(input)
  );
  const query = exactSkuQuery && sku
    ? sku
    : expanded.aliases[0] || normalizeOzonQueryText(categoryInput);
  const usedAlias = expanded.aliases.length > 0;
  const matchSource = categoryMatch
    ? usedAlias ? 'alias+shared-catalog' : 'shared-catalog'
    : usedAlias ? 'alias' : sku ? 'sku' : 'input';
  const confidence = categoryMatch
    ? categoryMatch.score >= 10_000 ? 'exact' : 'related'
    : usedAlias || sku ? 'mapped' : 'unresolved';

  return {
    input,
    query,
    queryMode,
    sku,
    aliases: expanded.aliases,
    categoryHints: [...new Set([
      ...categoryHints,
      categoryMatch?.name,
      categoryMatch?.pathText,
      ...expanded.aliases,
    ].map(text).filter(Boolean))],
    categoryIds,
    categoryMatch: categoryMatch ? {
      nodeKind: categoryMatch.nodeKind,
      descriptionCategoryId: categoryMatch.descriptionCategoryId,
      typeId: categoryMatch.typeId,
      name: categoryMatch.name,
      pathText: categoryMatch.pathText,
      score: categoryMatch.score,
    } : null,
    matchSource,
    confidence,
    catalogHydrated: isOzonCategoryIndexHydrated(),
  };
}

export async function ensureOzonSearchCategoryCatalog(options = {}) {
  if (isOzonCategoryIndexHydrated() && options.force !== true) return true;
  const loader = options.categoryTreeLoader || getCatalogCategoryTreeCache;
  const load = async () => {
    const payload = await loader({
      limit: 10_000,
      timeoutMs: options.timeoutMs ?? 10_000,
      signal: options.signal,
    });
    hydrateOzonCategoryIndexFromCacheNodes(payload?.nodes, {
      ...(payload?.catalog || {}),
      locale: payload?.catalog?.locale || 'ZH_HANS',
      updatedAt: payload?.catalog?.updatedAt,
    });
    return isOzonCategoryIndexHydrated();
  };
  if (options.categoryTreeLoader) return load();
  categoryCatalogLoadPromise ??= load().finally(() => {
    categoryCatalogLoadPromise = null;
  });
  return categoryCatalogLoadPromise;
}

export async function resolveOzonSearchQueryPlan(values = {}, options = {}) {
  let plan = resolveOzonSearchQueryPlanSync(values, options);
  const shouldLoadCatalog = options.loadCategoryCatalog !== false
    && !plan.categoryIds.length
    && hasHanText(plan.input)
    && !isOzonCategoryIndexHydrated();
  if (shouldLoadCatalog) {
    try {
      await ensureOzonSearchCategoryCatalog(options);
      plan = resolveOzonSearchQueryPlanSync(values, options);
    } catch {
      // Russian aliases and SKU lookup remain usable while the local catalog
      // service is starting.  No external translation or fabricated id is used.
    }
  }
  return {
    ...plan,
    catalogSource: ozonCategoryTreeMeta.source,
  };
}

export function resolveOzonProductSearchQuery(values = {}) {
  return resolveOzonSearchQueryPlanSync(values, { queryMode: 'product' });
}

export function listOzonQueryAliases() {
  return Object.keys(QUERY_ALIASES);
}
