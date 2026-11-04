import {
  createCollectionAttributeCandidateValue,
} from './collectionAttributeCandidateScorer.js';
import {
  collectionAttributeSemantics,
  rankCollectionSourceFacts,
} from './collectionAttributeSemanticResolver.js';
import {
  findCollectionSourceSku,
  normalizeCollectionProductFacts,
  normalizeCollectionSkuFacts,
  normalizeCollectionFactText,
} from './collectionSourceFactNormalizer.js';
import { validateCollectionAttributeCandidate } from './collectionAttributeSchemaValidator.js';

const MINIMUM_SOURCE_MATCH_SCORE = 0.7;
const HIGH_CONFIDENCE_SOURCE_MATCH_SCORE = 0.92;
const MINIMUM_SOURCE_MATCH_MARGIN = 0.08;
const SKU_CONSENSUS_SEMANTICS = new Set([
  'color', 'material', 'model', 'size', 'quantity', 'weight',
  'length', 'width', 'height', 'depth', 'diameter', 'thickness', 'capacity',
]);

function text(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function definitionId(definition = {}) {
  return text(definition.id ?? definition.attributeId ?? definition.attribute_id, 80);
}

function hasValue(row = {}) {
  return Boolean(
    text(row.value)
    || text(row.dictionaryValueId)
    || (Array.isArray(row.values) && row.values.some((item) => text(item)))
    || (Array.isArray(row.dictionaryValueIds) && row.dictionaryValueIds.some((item) => text(item))),
  );
}

function shouldRefreshFilledSkuValue(definition = {}, currentValue = {}) {
  if (!hasValue(currentValue) || currentValue?.source === 'manual') return false;
  return collectionAttributeSemantics(definition).includes('quantity');
}

function preferredRankScore(item, preferredScope = '') {
  return item.score + (preferredScope && item.sourceFact.scope === preferredScope ? 0.025 : 0);
}

function isAmbiguousTopMatch(ranked = [], preferredScope = '') {
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || !runnerUp) return false;
  const bestScore = preferredRankScore(best, preferredScope);
  const runnerUpScore = preferredRankScore(runnerUp, preferredScope);
  const differentValue = normalizeCollectionFactText(best.sourceFact.value) !== normalizeCollectionFactText(runnerUp.sourceFact.value);
  return differentValue
    && bestScore < HIGH_CONFIDENCE_SOURCE_MATCH_SCORE
    && bestScore - runnerUpScore < MINIMUM_SOURCE_MATCH_MARGIN;
}

function createMappedCandidate(definition, rankedItem, options = [], candidateCache = null) {
  const cacheKey = candidateCache
    ? `${definitionId(definition)}::${rankedItem.sourceFact.id || rankedItem.sourceFact.path || rankedItem.sourceFact.normalizedValue}`
    : '';
  if (cacheKey && candidateCache.has(cacheKey)) return candidateCache.get(cacheKey);
  const candidate = createCollectionAttributeCandidateValue({
    definition,
    sourceFact: rankedItem.sourceFact,
    options,
  });
  if (!candidate) {
    if (cacheKey) candidateCache.set(cacheKey, null);
    return null;
  }
  const confidence = Math.min(
    Number(candidate.confidence) || 0,
    Math.max(0, Math.min(1, rankedItem.score)),
  );
  const validated = validateCollectionAttributeCandidate(definition, {
    ...candidate,
    confidence,
  }, options);
  const value = validated.valid ? validated.value : null;
  if (cacheKey) candidateCache.set(cacheKey, value);
  return value;
}

export function resolveCollectedProductAttributeCandidate({
  definition = {},
  sourceFacts = [],
  options = [],
  preferredScope = '',
  candidateCache = null,
} = {}) {
  const ranked = rankCollectionSourceFacts(definition, sourceFacts, { minimumScore: 0.4 })
    .sort((left, right) => (
      preferredRankScore(right, preferredScope) - preferredRankScore(left, preferredScope)
      || left.sourceFact.path.localeCompare(right.sourceFact.path)
    ));
  if (!ranked.length || preferredRankScore(ranked[0], preferredScope) < MINIMUM_SOURCE_MATCH_SCORE) {
    return { value: null, ranked };
  }
  if (isAmbiguousTopMatch(ranked, preferredScope)) return { value: null, ranked, reason: 'ambiguous-source-facts' };
  for (const item of ranked.slice(0, 8)) {
    if (preferredRankScore(item, preferredScope) < MINIMUM_SOURCE_MATCH_SCORE) break;
    const value = createMappedCandidate(definition, item, options, candidateCache);
    if (value) return { value, sourceFact: item.sourceFact, score: item.score, ranked };
  }
  return { value: null, ranked, reason: definition.isDictionary ? 'dictionary-option-not-resolved' : 'source-value-not-resolved' };
}

function skuFactsForProduct(product = {}) {
  return (Array.isArray(product.skus) ? product.skus : []).map((sourceSku, index) => (
    normalizeCollectionSkuFacts(product, sourceSku, index)
  ));
}

function consensusSourceFact(definition = {}, product = {}, options = []) {
  if (!collectionAttributeSemantics(definition).some((key) => SKU_CONSENSUS_SEMANTICS.has(key))) return null;
  const groups = skuFactsForProduct(product);
  if (!groups.length) return null;
  const matched = groups.map((facts) => resolveCollectedProductAttributeCandidate({
    definition,
    sourceFacts: facts,
    options,
    preferredScope: 'sku',
  })).filter((item) => item.value && item.sourceFact);
  if (matched.length !== groups.length) return null;
  const values = new Set(matched.map((item) => normalizeCollectionFactText(
    item.value.dictionaryValueIds?.length
      ? item.value.dictionaryValueIds.join(',')
      : item.value.dictionaryValueId || item.value.values?.join(',') || item.value.value,
  )));
  if (values.size !== 1) return null;
  const first = matched[0];
  return {
    ...first.sourceFact,
    id: `sku-consensus::${definitionId(definition)}::${[...values][0]}`,
    source: 'source-sku-consensus',
    scope: 'global',
    sourceSkuId: '',
    confidence: Math.min(...matched.map((item) => Number(item.value.confidence) || 0)),
    path: matched.map((item) => item.sourceFact.path).filter(Boolean).join(' | '),
  };
}

function mappingForDefinition({ definition, product, sourceFacts, options }) {
  const direct = resolveCollectedProductAttributeCandidate({
    definition,
    sourceFacts,
    options,
    preferredScope: 'global',
  });
  if (direct.value) return direct;
  const consensus = consensusSourceFact(definition, product, options);
  if (!consensus) return direct;
  return resolveCollectedProductAttributeCandidate({
    definition,
    sourceFacts: [consensus],
    options,
    preferredScope: 'global',
  });
}

export function getCollectedProductAttributeSourceValue(product = {}, definition = {}) {
  const result = mappingForDefinition({
    definition,
    product,
    sourceFacts: normalizeCollectionProductFacts(product),
    options: [],
  });
  if (result.sourceFact?.value) return result.sourceFact.value;
  if (result.reason === 'ambiguous-source-facts') return '';
  const best = result.ranked?.[0];
  return best && best.score >= MINIMUM_SOURCE_MATCH_SCORE ? best.sourceFact.value : '';
}

export function mapCollectedProductAttributeValues({
  product = {}, definitions = [], optionsByAttributeId = {}, currentValues = {},
} = {}) {
  const sourceFacts = normalizeCollectionProductFacts(product);
  const values = { ...(currentValues && typeof currentValues === 'object' ? currentValues : {}) };
  const mapped = [];
  const unresolved = [];
  (Array.isArray(definitions) ? definitions : []).forEach((definition) => {
    const id = definitionId(definition);
    if (!id || hasValue(values[id])) return;
    const result = mappingForDefinition({
      definition,
      product,
      sourceFacts,
      options: optionsByAttributeId[id] || [],
    });
    if (!result.value) {
      if (result.ranked?.length) unresolved.push({
        attributeId: id,
        attributeName: text(definition.name, 300),
        reason: result.reason || 'source-value-not-resolved',
        lookupTerms: result.ranked.slice(0, 3).map((item) => item.sourceFact.value),
      });
      return;
    }
    values[id] = result.value;
    mapped.push({
      attributeId: id,
      attributeName: text(definition.name, 300),
      source: result.value.source,
      status: result.value.status,
      confidence: result.value.confidence,
      evidence: result.value.evidence,
    });
  });
  return { values, mapped, unresolved, mappedCount: mapped.length };
}

export function createCollectedProductSkuAttributeSource(product = {}, sourceSku = {}) {
  return {
    ...product,
    ...sourceSku,
    attributes: [
      ...(Array.isArray(sourceSku.attributes) ? sourceSku.attributes : []),
      ...(Array.isArray(product.attributes) ? product.attributes : []),
    ],
    color: sourceSku.color ?? sourceSku.colour ?? product.color,
    size: sourceSku.size ?? sourceSku.specification ?? product.size,
    material: sourceSku.material ?? product.material,
    model: sourceSku.model ?? sourceSku.skuCode ?? product.model,
    variant: sourceSku.variant ?? product.variant,
  };
}

export function mapCollectedProductSkuAttributeValues({
  product = {}, skus = [], definitions = [], optionsByAttributeId = {},
} = {}) {
  const productFacts = normalizeCollectionProductFacts(product);
  const candidateCache = new Map();
  let mappedCount = 0;
  const mapped = [];
  const unresolved = [];
  const nextSkus = (Array.isArray(skus) ? skus : []).map((sku, index) => {
    const sourceSku = findCollectionSourceSku(product, sku, index);
    const sourceSkuId = text(sku.sourceSkuId ?? sourceSku.id ?? sourceSku.name ?? `sku-${index + 1}`, 160);
    const sourceFacts = [
      ...normalizeCollectionSkuFacts(product, { ...sourceSku, id: sourceSkuId }, index),
      ...productFacts,
    ];
    const nextValues = { ...(sku.attributeValues || {}) };
    (Array.isArray(definitions) ? definitions : []).forEach((definition) => {
      const id = definitionId(definition);
      if (!id) return;
      const currentValue = nextValues[id];
      const refreshFilledValue = shouldRefreshFilledSkuValue(definition, currentValue);
      if (hasValue(currentValue) && !refreshFilledValue) return;
      const result = resolveCollectedProductAttributeCandidate({
        definition,
        sourceFacts,
        options: optionsByAttributeId[id] || [],
        preferredScope: 'sku',
        candidateCache,
      });
      if (refreshFilledValue && result.sourceFact?.source !== 'source-sku-explicit-quantity') return;
      if (!result.value) {
        if (result.ranked?.length) unresolved.push({
          scope: 'sku',
          sourceSkuId,
          attributeId: id,
          attributeName: text(definition.name, 300),
          reason: result.reason || 'source-value-not-resolved',
          lookupTerms: result.ranked.slice(0, 3).map((item) => item.sourceFact.value),
        });
        return;
      }
      nextValues[id] = result.value;
      mappedCount += 1;
      mapped.push({
        scope: 'sku',
        sourceSkuId,
        attributeId: id,
        source: result.value.source,
        status: result.value.status,
        confidence: result.value.confidence,
        evidence: result.value.evidence,
      });
    });
    return { ...sku, sourceSkuId, attributeValues: nextValues };
  });
  return { skus: nextSkus, mapped, unresolved, mappedCount };
}

export function countFilledProductAttributes(values = {}) {
  return Object.values(values && typeof values === 'object' ? values : {}).filter(hasValue).length;
}
