const NORTH_BEAR_DICTIONARY_BATCH_SIZE = 5;

function clean(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function definitionId(definition = {}) {
  return clean(definition.id ?? definition.attributeId ?? definition.attribute_id, 80);
}

function normalizeOptions(rows = []) {
  return (Array.isArray(rows) ? rows : []).flatMap((item) => {
    const id = clean(item?.id ?? item?.valueId ?? item?.value_id, 80);
    const label = clean(item?.label ?? item?.value ?? item?.valueText ?? item?.value_text, 500);
    return id && label ? [{ ...item, id, label, value: label }] : [];
  });
}

function mergeOptions(target = {}, attributeId, rows = []) {
  const merged = new Map(normalizeOptions(target[attributeId] || []).map((item) => [item.id, item]));
  normalizeOptions(rows).forEach((item) => merged.set(item.id, item));
  target[attributeId] = [...merged.values()];
}

function chunks(values = [], size = NORTH_BEAR_DICTIONARY_BATCH_SIZE) {
  const rows = Array.isArray(values) ? values : [];
  const output = [];
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size));
  return output;
}

function isModelManagedBrand(definition = {}) {
  const attributeId = definitionId(definition);
  return attributeId === '85' || /^(?:бренд|品牌|brand)$/iu.test(clean(definition.name, 200));
}

/**
 * North Bear-compatible dictionary resolver.
 *
 * Every dictionary is loaded as one complete Ozon value table and kept in the
 * category cache. Source terms are matched locally by the attribute mappers;
 * they must never create one Ozon request per spelling or SKU value.
 */
export async function resolveCollectionAttributeDictionaryOptions({
  definitions = [],
  optionsByAttributeId = {},
  searchAttributeOptions,
  signal,
  onProgress,
} = {}) {
  const nextOptions = Object.fromEntries(Object.entries(optionsByAttributeId || {}).map(([attributeId, rows]) => [
    attributeId,
    normalizeOptions(rows),
  ]));
  const dictionaryDefinitions = (Array.isArray(definitions) ? definitions : [])
    .filter((definition) => definition?.isDictionary && !isModelManagedBrand(definition));
  const missingAttributeIds = [...new Set(dictionaryDefinitions
    .map(definitionId)
    .filter((attributeId) => attributeId && !(nextOptions[attributeId] || []).length))];
  let completed = 0;
  let failedSearchCount = 0;
  let requestCount = 0;

  if (typeof searchAttributeOptions === 'function') {
    for (const batch of chunks(missingAttributeIds)) {
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      const settled = await Promise.allSettled(batch.map(async (attributeId) => {
        requestCount += 1;
        const rows = await searchAttributeOptions(attributeId, '', {
          signal,
          bulk: true,
          preferCache: true,
        });
        return { attributeId, rows };
      }));
      settled.forEach((result, index) => {
        const attributeId = batch[index];
        if (result.status === 'fulfilled') mergeOptions(nextOptions, attributeId, result.value.rows);
        else if (result.reason?.name === 'AbortError') throw result.reason;
        else failedSearchCount += 1;
        completed += 1;
        onProgress?.({
          phase: 'dictionary-source',
          current: completed,
          total: missingAttributeIds.length,
          attributeId,
        });
      });
    }
  }

  return {
    optionsByAttributeId: nextOptions,
    searchCount: requestCount,
    failedSearchCount,
    lookupCount: dictionaryDefinitions.length,
  };
}
