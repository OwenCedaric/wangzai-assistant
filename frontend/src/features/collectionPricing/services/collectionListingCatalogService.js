import { getSharedCatalogCategoryTree } from '../../../api/localApiClient.js';
import {
  getOzonCategoryPathByIds,
  hydrateOzonCategoryIndexFromCacheNodes,
} from '../../../data/ozonCategoryIndex.js';
import {
  readProductAttributeOptions,
  readProductAttributeSchema,
  readProductWarehouseOptions,
} from '../../../services/productReadClient.js';

let categoryOptionsPromise = null;
const categoryTemplateCache = new Map();
const CATEGORY_TEMPLATE_DICTIONARY_CONCURRENCY = 5;
const CATEGORY_TEMPLATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const CATEGORY_PATH_SEPARATOR_PATTERN = /\s*(?:>|\/|\\|→|›|»|\||::)+\s*/gu;
const CATEGORY_CONTEXT_SEPARATOR_PATTERN = /[、,，;；]+/gu;
const MIN_CATEGORY_SCORE = 3_000;
const MIN_CATEGORY_MARGIN = 500;
const MIN_CATEGORY_MARGIN_RATIO = 0.12;

function normalizeCategoryEvidence(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u200b\u200c\u200d]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function splitCategoryPath(value) {
  return unique(String(value || '')
    .split(CATEGORY_PATH_SEPARATOR_PATTERN)
    .flatMap((segment) => segment.split(CATEGORY_CONTEXT_SEPARATOR_PATTERN))
    .map(normalizeCategoryEvidence));
}

function ngrams(value, size) {
  if (!value) return new Set();
  if (value.length <= size) return new Set([value]);
  const result = new Set();
  for (let index = 0; index <= value.length - size; index += 1) {
    result.add(value.slice(index, index + size));
  }
  return result;
}

function diceCoefficient(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  smaller.forEach((item) => {
    if (larger.has(item)) shared += 1;
  });
  return (2 * shared) / (left.size + right.size);
}

function createCategoryTextProfile(value) {
  const text = normalizeCategoryEvidence(value);
  return {
    text,
    characters: new Set(text),
    bigrams: ngrams(text, 2),
  };
}

function categoryTextSimilarity(leftProfile, rightProfile) {
  if (!leftProfile?.text || !rightProfile?.text) return 0;
  if (leftProfile.text === rightProfile.text) return 1;
  const characterScore = diceCoefficient(leftProfile.characters, rightProfile.characters);
  const bigramScore = diceCoefficient(leftProfile.bigrams, rightProfile.bigrams);
  return characterScore * 0.55 + bigramScore * 0.45;
}

function maxProfileSimilarity(sourceProfiles, candidateProfiles) {
  let maximum = 0;
  sourceProfiles.forEach((source) => {
    candidateProfiles.forEach((candidate) => {
      maximum = Math.max(maximum, categoryTextSimilarity(source, candidate));
    });
  });
  return maximum;
}

function candidateTitleReliability(length) {
  if (length <= 1) return 0;
  if (length === 2) return 0.25;
  if (length === 3) return 0.65;
  return 1;
}

function bestLocalTitleSimilarity(titleProfile, candidateProfile) {
  const title = titleProfile?.text || '';
  const candidate = candidateProfile?.text || '';
  if (!title || !candidate) return 0;
  if (title.includes(candidate)) return 1;
  const minimumLength = Math.max(2, candidate.length - 1);
  const maximumLength = Math.min(title.length, candidate.length + 1);
  let maximum = categoryTextSimilarity(titleProfile, candidateProfile);
  for (let length = minimumLength; length <= maximumLength; length += 1) {
    for (let index = 0; index <= title.length - length; index += 1) {
      const window = title.slice(index, index + length);
      if (![...window].some((character) => candidateProfile.characters.has(character))) continue;
      maximum = Math.max(maximum, categoryTextSimilarity(createCategoryTextProfile(window), candidateProfile));
      if (maximum === 1) return maximum;
    }
  }
  return maximum;
}

function buildCollectedProductCategoryEvidence(product = {}) {
  const sourcePathSegments = splitCategoryPath(product.sourceCategoryPath);
  const sourceLeafValues = unique([
    normalizeCategoryEvidence(product.sourceCategoryName),
    normalizeCategoryEvidence(product.category),
    sourcePathSegments.at(-1),
  ]);
  const sourceContextValues = unique(sourcePathSegments.slice(0, -1));
  const featureValues = unique((Array.isArray(product.attributes) ? product.attributes : []).flatMap((item) => [
    normalizeCategoryEvidence(item?.name ?? item?.title ?? item?.key),
    normalizeCategoryEvidence(item?.value ?? item?.valueText ?? item?.text),
  ]));
  const skuValues = unique((Array.isArray(product.skus) ? product.skus : []).flatMap((sku) => [
    normalizeCategoryEvidence(sku?.name ?? sku?.variant ?? sku?.title),
    ...(Array.isArray(sku?.attributes) ? sku.attributes.flatMap((item) => [
      normalizeCategoryEvidence(item?.name ?? item?.title ?? item?.key),
      normalizeCategoryEvidence(item?.value ?? item?.valueText ?? item?.text),
    ]) : []),
  ])).slice(0, 200);
  return {
    title: createCategoryTextProfile(product.title),
    sourceLeaf: sourceLeafValues.map(createCategoryTextProfile),
    sourceContext: sourceContextValues.map(createCategoryTextProfile),
    features: featureValues.map(createCategoryTextProfile),
    skus: skuValues.map(createCategoryTextProfile),
    description: createCategoryTextProfile(String(product.description || '').slice(0, 2_000)),
  };
}

function scoreCollectedProductCategoryOption(evidence, option = {}) {
  const candidateName = createCategoryTextProfile(option.name);
  const candidatePathValues = splitCategoryPath(option.pathText);
  const candidateContext = candidatePathValues
    .slice(0, -1)
    .map(createCategoryTextProfile);
  const sourceLeafSimilarity = maxProfileSimilarity(evidence.sourceLeaf, [candidateName]);
  const sourceLeafExact = evidence.sourceLeaf.some((item) => item.text === candidateName.text);
  const sourceContextSimilarity = maxProfileSimilarity(evidence.sourceContext, candidateContext);
  const sourceContextExact = evidence.sourceContext.some((source) => (
    candidateContext.some((candidate) => source.text === candidate.text)
  ));
  const titleLocalSimilarity = bestLocalTitleSimilarity(evidence.title, candidateName);
  const featureSimilarity = maxProfileSimilarity(evidence.features, [candidateName]);
  const skuSimilarity = maxProfileSimilarity(evidence.skus, [candidateName]);
  const descriptionSimilarity = categoryTextSimilarity(evidence.description, candidateName);
  const titleContainsCandidate = Boolean(
    candidateName.text && evidence.title.text.includes(candidateName.text),
  );
  const titleReliability = candidateTitleReliability(candidateName.text.length);
  const score = (
    sourceLeafSimilarity * 6_000
    + (sourceLeafExact ? 2_500 : 0)
    + sourceContextSimilarity * 1_600
    + (sourceContextExact ? 2_000 : 0)
    + titleLocalSimilarity * titleReliability * 1_800
    + (titleContainsCandidate ? titleReliability * 1_600 : 0)
    + featureSimilarity * 900
    + skuSimilarity * 700
    + descriptionSimilarity * 350
  );
  const hasStrongEvidence = (
    sourceLeafExact
    || sourceLeafSimilarity >= 0.62
    || (titleContainsCandidate && candidateName.text.length >= 3)
    || (titleLocalSimilarity >= 0.78 && candidateName.text.length >= 4)
  );
  return {
    ...option,
    score,
    evidence: {
      sourceLeafExact,
      sourceLeafSimilarity,
      sourceContextExact,
      sourceContextSimilarity,
      titleLocalSimilarity,
      titleContainsCandidate,
      featureSimilarity,
      skuSimilarity,
      descriptionSimilarity,
      hasStrongEvidence,
    },
  };
}

/**
 * Ranks real Ozon types using independent evidence instead of concatenating all
 * collected text into one substring query.  A short type name found inside a
 * long product title is deliberately weak evidence; source category and path
 * carry the decision, and close candidates fail closed for manual review.
 */
export function rankCollectedProductCategoryOptions(product = {}, categoryOptions = [], { limit = 8 } = {}) {
  const evidence = buildCollectedProductCategoryEvidence(product);
  if (!evidence.title.text && !evidence.sourceLeaf.length && !evidence.sourceContext.length) return [];
  const ranked = (Array.isArray(categoryOptions) ? categoryOptions : [])
    .filter((option) => option?.typeId && option?.descriptionCategoryId && option?.name)
    .map((option) => scoreCollectedProductCategoryOption(evidence, option))
    .filter((option) => option.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || Number(right.evidence.sourceLeafExact) - Number(left.evidence.sourceLeafExact)
      || String(left.pathText || '').localeCompare(String(right.pathText || ''), 'zh-CN')
    ));
  const best = ranked[0];
  const runnerUp = ranked[1];
  const margin = best ? best.score - (runnerUp?.score || 0) : 0;
  const requiredMargin = best
    ? Math.max(MIN_CATEGORY_MARGIN, best.score * MIN_CATEGORY_MARGIN_RATIO)
    : Number.POSITIVE_INFINITY;
  const confident = Boolean(
    best
    && best.score >= MIN_CATEGORY_SCORE
    && best.evidence.hasStrongEvidence
    && (!runnerUp || margin >= requiredMargin)
  );
  return ranked.slice(0, Math.max(1, Math.min(50, Number(limit) || 8))).map((option, index) => ({
    ...option,
    confidence: index === 0 && confident ? 'high' : 'low',
    ambiguous: index === 0 ? !confident : undefined,
    margin: index === 0 ? margin : undefined,
  }));
}

async function loadCategoryOptions(options = {}) {
  const payload = await getSharedCatalogCategoryTree({
    limit: 10_000,
    timeoutMs: options.timeoutMs || 15_000,
    signal: options.signal,
  });
  hydrateOzonCategoryIndexFromCacheNodes(payload.nodes, {
    ...(payload.catalog || {}),
    locale: payload.catalog?.locale || 'ZH_HANS',
    updatedAt: payload.catalog?.updatedAt,
  });
  return payload.nodes
    .filter((node) => node.nodeKind === 'type' && node.typeId && node.categoryId && !node.isDisabled)
    .map((node) => ({
      typeId: String(node.typeId),
      descriptionCategoryId: String(node.categoryId),
      name: String(node.title || ''),
      pathText: getOzonCategoryPathByIds({
        typeId: node.typeId,
        descriptionCategoryId: node.categoryId,
      }) || String(node.title || ''),
      commissionPercent: node.commissionPercent
        ?? node.commission_percent
        ?? node.categoryCommissionPercent
        ?? node.category_commission_percent
        ?? null,
    }));
}

export function loadCollectionListingCategoryOptions(options = {}) {
  if (options.force === true) return loadCategoryOptions(options);
  categoryOptionsPromise ??= loadCategoryOptions(options).finally(() => {
    categoryOptionsPromise = null;
  });
  return categoryOptionsPromise;
}

export async function resolveCollectedProductCategory(product = {}, options = {}) {
  const categoryOptions = await loadCollectionListingCategoryOptions(options);
  const best = rankCollectedProductCategoryOptions(product, categoryOptions, { limit: 2 })[0];
  return best?.confidence === 'high' ? best : null;
}

export function shouldReplaceAutoCollectedProductCategory({
  currentDraft = {}, recommendation = null, selectionSource = '',
} = {}) {
  if (selectionSource === 'manual' || !recommendation?.typeId || !recommendation?.descriptionCategoryId) {
    return false;
  }
  return (
    String(currentDraft.typeId || '') !== String(recommendation.typeId)
    || String(currentDraft.descriptionCategoryId || '') !== String(recommendation.descriptionCategoryId)
  );
}

export function loadCollectionListingWarehouses(shopId, options = {}) {
  if (!String(shopId || '').trim()) return Promise.resolve([]);
  return readProductWarehouseOptions(shopId, options);
}

export async function loadCollectionListingAttributeSchema({
  shopId = '', descriptionCategoryId = '', typeId = '',
} = {}, options = {}) {
  const categoryId = String(descriptionCategoryId || '').trim();
  const normalizedTypeId = String(typeId || '').trim();
  if (!categoryId || !normalizedTypeId) {
    return { definitions: [], optionsByAttributeId: {}, source: 'missing-scope', warning: '' };
  }
  const normalizedShopId = String(shopId || '').trim();
  const schema = await readProductAttributeSchema({
    shopId: normalizedShopId,
    categoryId,
    typeId: normalizedTypeId,
  }, options);
  const definitions = schema.definitions || [];
  return {
    definitions,
    // Initial rendering must never wait for dozens of dictionary-value requests. Manual
    // dropdown searches and one-click autofill already load exact values on demand.
    optionsByAttributeId: {},
    source: schema.source,
    // Dictionary fields are queried lazily from the user's text. An empty local
    // option cache is therefore a normal initial state, not a user-facing failure.
    warning: schema.warning || '',
    sync: schema.sync,
  };
}

export async function searchCollectionListingAttributeOptions({
  shopId = '', descriptionCategoryId = '', typeId = '', attributeId = '', search = '',
} = {}, options = {}) {
  const normalizedShopId = String(shopId || '').trim();
  const categoryId = String(descriptionCategoryId || '').trim();
  const normalizedTypeId = String(typeId || '').trim();
  const normalizedAttributeId = String(attributeId || '').trim();
  const query = String(search || '').trim();
  if (!normalizedShopId || !categoryId || !normalizedTypeId || !normalizedAttributeId) return [];
  return readProductAttributeOptions({
    shopId: normalizedShopId,
    categoryId,
    typeId: normalizedTypeId,
    attributeId: normalizedAttributeId,
    search: query,
  }, {
    ...options,
    refresh: options.refresh !== false,
    limit: query ? 100 : 200,
  });
}

function categoryTemplateKey({ shopId = '', descriptionCategoryId = '', typeId = '' } = {}) {
  return [shopId, descriptionCategoryId, typeId].map((item) => String(item || '').trim()).join('::');
}

function templateDefinitionId(definition = {}) {
  return String(definition?.id ?? definition?.attributeId ?? definition?.attribute_id ?? '').trim();
}

async function loadCategoryTemplateDictionaries({
  shopId, descriptionCategoryId, typeId, definitions, signal, refresh = false, onProgress,
} = {}) {
  const dictionaryDefinitions = (Array.isArray(definitions) ? definitions : [])
    .filter((definition) => definition?.isDictionary)
    .filter((definition) => {
      const id = templateDefinitionId(definition);
      return id !== '85' && !/^(?:бренд|品牌|brand)$/iu.test(String(definition?.name || '').trim());
    })
    .filter((definition) => templateDefinitionId(definition));
  const optionsByAttributeId = {};
  const dictionaryLoadedIds = [];
  const dictionaryFailedIds = [];
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (cursor < dictionaryDefinitions.length) {
      const definition = dictionaryDefinitions[cursor];
      cursor += 1;
      const attributeId = templateDefinitionId(definition);
      try {
        optionsByAttributeId[attributeId] = await searchCollectionListingAttributeOptions({
          shopId,
          descriptionCategoryId,
          typeId,
          attributeId,
          search: '',
        }, { signal, refresh });
        dictionaryLoadedIds.push(attributeId);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        optionsByAttributeId[attributeId] = [];
        dictionaryFailedIds.push(attributeId);
      }
      completed += 1;
      onProgress?.({ phase: 'dictionary', current: completed, total: dictionaryDefinitions.length, attributeId });
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(CATEGORY_TEMPLATE_DICTIONARY_CONCURRENCY, Math.max(1, dictionaryDefinitions.length)) },
    () => worker(),
  ));
  return { optionsByAttributeId, dictionaryLoadedIds, dictionaryFailedIds };
}

export async function loadCollectionListingCategoryTemplate({
  shopId = '', descriptionCategoryId = '', typeId = '', categoryName = '', categoryPath = '',
} = {}, options = {}) {
  const scope = {
    shopId: String(shopId || '').trim(),
    descriptionCategoryId: String(descriptionCategoryId || '').trim(),
    typeId: String(typeId || '').trim(),
  };
  if (!scope.shopId) throw new Error('请先选择要上架的 Ozon 店铺。');
  if (!scope.descriptionCategoryId || !scope.typeId) throw new Error('请选择一个可上架的 Ozon 叶子类目。');
  const key = categoryTemplateKey(scope);
  if (options.force !== true && categoryTemplateCache.has(key)) {
    const cached = categoryTemplateCache.get(key);
    const loadedAt = Date.parse(cached?.loadedAt || '');
    if (Number.isFinite(loadedAt) && Date.now() - loadedAt < CATEGORY_TEMPLATE_CACHE_TTL_MS) return cached;
    categoryTemplateCache.delete(key);
  }

  const schema = await loadCollectionListingAttributeSchema(scope, {
    signal: options.signal,
    refresh: options.force === true,
  });
  if (!schema.definitions.length) {
    throw new Error(schema.warning || 'Ozon 暂未返回这个类目的字段。');
  }
  const dictionaries = await loadCategoryTemplateDictionaries({
    ...scope,
    definitions: schema.definitions,
    signal: options.signal,
    refresh: options.force === true,
    onProgress: options.onProgress,
  });
  const template = {
    ...scope,
    categoryName: String(categoryName || '').trim(),
    categoryPath: String(categoryPath || '').trim(),
    definitions: schema.definitions,
    optionsByAttributeId: dictionaries.optionsByAttributeId,
    dictionaryLoadedIds: dictionaries.dictionaryLoadedIds,
    dictionaryFailedIds: dictionaries.dictionaryFailedIds,
    source: schema.source,
    warning: [schema.warning, dictionaries.dictionaryFailedIds.length
      ? `${dictionaries.dictionaryFailedIds.length} 个属性选项加载失败，确认后可重新加载。`
      : ''].filter(Boolean).join('；'),
    loadedAt: new Date().toISOString(),
  };
  if (!template.dictionaryFailedIds.length) categoryTemplateCache.set(key, template);
  return template;
}

export function clearCollectionListingCategoryTemplateCache() {
  categoryTemplateCache.clear();
}

export function countCollectionListingCategoryTemplateCacheEntriesForShop(shopId = '') {
  const normalizedShopId = String(shopId || '').trim();
  if (!normalizedShopId) return 0;
  let count = 0;
  for (const key of categoryTemplateCache.keys()) {
    if (String(key).split('::', 1)[0] === normalizedShopId) count += 1;
  }
  return count;
}

export function removeCollectionListingCategoryTemplateCacheForShop(shopId = '') {
  const normalizedShopId = String(shopId || '').trim();
  if (!normalizedShopId) return 0;
  let removed = 0;
  for (const key of [...categoryTemplateCache.keys()]) {
    if (String(key).split('::', 1)[0] !== normalizedShopId) continue;
    categoryTemplateCache.delete(key);
    removed += 1;
  }
  return removed;
}
