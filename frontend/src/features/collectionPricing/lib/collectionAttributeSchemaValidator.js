import { getCollectionAttributeValueKind } from './collectionAttributeSemanticResolver.js';

function clean(value, maximum = 2_000) {
  return String(value ?? '').normalize('NFKC').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

function definitionId(definition = {}) {
  return clean(definition.id ?? definition.attributeId ?? definition.attribute_id, 80);
}

function maxValueCount(definition = {}) {
  return Math.max(0, Number(definition.maxValueCount ?? definition.max_value_count ?? 0) || 0);
}

function normalizedOptions(rows = []) {
  return new Map((Array.isArray(rows) ? rows : []).flatMap((item) => {
    const id = clean(item?.id ?? item?.valueId ?? item?.value_id, 80);
    const label = clean(item?.label ?? item?.value ?? item?.valueText ?? item?.value_text, 500);
    return id && label ? [[id, { id, label }]] : [];
  }));
}

function valueEvidence(value = {}) {
  return (Array.isArray(value.evidence) ? value.evidence : []).slice(0, 20).map((item) => ({
    source: clean(item?.source, 80),
    path: clean(item?.path, 500),
    value: clean(item?.value, 500),
  })).filter((item) => item.source || item.path || item.value);
}

export function validateCollectionAttributeCandidate(definition = {}, input = {}, options = []) {
  const id = definitionId(definition);
  if (!id) return { valid: false, reason: 'missing-attribute-id' };
  const kind = getCollectionAttributeValueKind(definition);
  const common = {
    source: clean(input.source, 80),
    status: ['verified', 'mapped', 'inferred', 'unresolved'].includes(input.status) ? input.status : 'mapped',
    confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0)),
    evidence: valueEvidence(input),
  };
  if (kind === 'dictionary') {
    const allowed = normalizedOptions(options);
    const requestedIds = [
      ...(Array.isArray(input.dictionaryValueIds) ? input.dictionaryValueIds : []),
      input.dictionaryValueId,
    ].map((item) => clean(item, 80)).filter(Boolean);
    const selected = [...new Map(requestedIds.flatMap((optionId) => (
      allowed.has(optionId) ? [[optionId, allowed.get(optionId)]] : []
    ))).values()];
    const limit = maxValueCount(definition) || (definition.isCollection ? 100 : 1);
    const limited = selected.slice(0, definition.isCollection ? limit : 1);
    if (!limited.length) return { valid: false, reason: 'dictionary-value-not-in-live-schema' };
    return {
      valid: true,
      value: definition.isCollection
        ? {
            value: limited.map((item) => item.label).join(', '),
            values: limited.map((item) => item.label),
            dictionaryValueId: '',
            dictionaryValueIds: limited.map((item) => item.id),
            ...common,
          }
        : {
            value: limited[0].label,
            values: [],
            dictionaryValueId: limited[0].id,
            dictionaryValueIds: [],
            ...common,
          },
    };
  }
  if (kind === 'numeric') {
    const number = Number(clean(input.value, 160).replace(',', '.'));
    if (!Number.isFinite(number)) return { valid: false, reason: 'invalid-numeric-value' };
    return {
      valid: true,
      value: {
        value: String(number),
        values: [],
        dictionaryValueId: '',
        dictionaryValueIds: [],
        ...common,
      },
    };
  }
  const value = clean(input.value, 2_000);
  if (!value) return { valid: false, reason: 'empty-text-value' };
  return {
    valid: true,
    value: {
      value,
      values: [],
      dictionaryValueId: '',
      dictionaryValueIds: [],
      ...common,
    },
  };
}

export function validateCollectionAttributeValueMap(values = {}, definitions = [], optionsByAttributeId = {}) {
  const definitionById = new Map((Array.isArray(definitions) ? definitions : []).map((definition) => [definitionId(definition), definition]));
  const validValues = {};
  const rejected = [];
  Object.entries(values && typeof values === 'object' ? values : {}).forEach(([attributeId, input]) => {
    const definition = definitionById.get(clean(attributeId, 80));
    if (!definition) {
      rejected.push({ attributeId, reason: 'attribute-not-in-live-schema' });
      return;
    }
    const result = validateCollectionAttributeCandidate(definition, input, optionsByAttributeId[attributeId] || []);
    if (!result.valid) {
      rejected.push({ attributeId, reason: result.reason });
      return;
    }
    validValues[attributeId] = result.value;
  });
  return { values: validValues, rejected };
}

