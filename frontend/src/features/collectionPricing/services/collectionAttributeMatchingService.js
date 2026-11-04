import {
  mapCollectedProductAttributeValues,
  mapCollectedProductSkuAttributeValues,
} from '../lib/collectionProductAttributeMapper.js';
import { splitListingAttributeDefinitions } from '../lib/collectionProductAttributeSchema.js';
import { resolveCollectionAttributeDictionaryOptions } from './collectionAttributeDictionaryResolver.js';

function unresolvedKey(item = {}) {
  return [item.scope || 'global', item.sourceSkuId || '', item.attributeId || '', item.reason || ''].join('::');
}

function uniqueUnresolved(rows = []) {
  return [...new Map((Array.isArray(rows) ? rows : []).map((item) => [unresolvedKey(item), item])).values()];
}

export async function matchCollectedProductAttributes({
  product = {},
  draft = {},
  definitions = [],
  optionsByAttributeId = {},
  searchAttributeOptions,
  signal,
  dictionaryConcurrency,
  onProgress,
} = {}) {
  const dictionary = await resolveCollectionAttributeDictionaryOptions({
    product,
    draft,
    definitions,
    optionsByAttributeId,
    searchAttributeOptions,
    signal,
    concurrency: dictionaryConcurrency,
    onProgress,
  });
  const scoped = splitListingAttributeDefinitions(definitions);
  const global = mapCollectedProductAttributeValues({
    product,
    definitions: scoped.global,
    optionsByAttributeId: dictionary.optionsByAttributeId,
    currentValues: draft.attributeValues,
  });
  const sku = mapCollectedProductSkuAttributeValues({
    product,
    skus: draft.skus,
    definitions: scoped.sku,
    optionsByAttributeId: dictionary.optionsByAttributeId,
  });
  return {
    attributeValues: global.values,
    skus: sku.skus,
    optionsByAttributeId: dictionary.optionsByAttributeId,
    mapped: [...global.mapped, ...sku.mapped],
    mappedCount: global.mappedCount + sku.mappedCount,
    unresolved: uniqueUnresolved([
      ...global.unresolved.map((item) => ({ scope: 'global', ...item })),
      ...sku.unresolved,
    ]),
    pipeline: {
      strategy: 'live-schema-source-facts-dictionary-verified',
      dictionarySearchCount: dictionary.searchCount,
      dictionaryLookupCount: dictionary.lookupCount,
      dictionaryFailedSearchCount: dictionary.failedSearchCount,
      globalDefinitionCount: scoped.global.length,
      skuDefinitionCount: scoped.sku.length,
    },
  };
}

