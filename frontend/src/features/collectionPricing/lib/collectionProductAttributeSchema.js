const ATTRIBUTE_VALUE_SOURCES = new Set([
  'manual',
  'source-attribute',
  'source-field',
  'source-sku-attribute',
  'source-sku-field',
  'ai',
  'visual',
  'system',
  'managed-default',
]);

const LISTING_URL_ATTRIBUTE_IDS = new Set(['8790', '21841', '21845']);
const PDF_DEPENDENT_ATTRIBUTE_IDS = new Set(['8789']);
const VIDEO_DEPENDENT_ATTRIBUTE_IDS = new Set(['21837', '21845', '22273']);
const UNSUPPORTED_COLLECTION_VIDEO_ATTRIBUTE_IDS = new Set(['21837', '21841', '21845', '22273']);
const RICH_CONTENT_ATTRIBUTE_ID = '11254';
const RICH_CONTENT_MEDIA_WIDGET_PATTERN = /(?:video|image|showcase|gallery|media|cover)/iu;
// Ozon has returned these fields with `is_aspect=true` in live category
// snapshots, but some later category responses omit the flag completely.  A
// missing flag must not turn a per-SKU variation into one shared product value:
// that produces `double_without_merger_offer` after Ozon accepts the import.
// Keep this catalog-evidence fallback independent from any source product/link.
export const KNOWN_OZON_SKU_ASPECT_ATTRIBUTE_IDS = new Set([
  '8414', // height variant (category dependent)
  '8416', // width variant (category dependent)
  '10096', // product colour (dictionary)
  '10097', // seller colour/variant name
]);
const BOOLEAN_ATTRIBUTE_TYPE_PATTERN = /(?:^|[^a-z])(boolean|bool)(?:$|[^a-z])/iu;
const BOOLEAN_TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on', '是', '真', '是的', 'да']);
const BOOLEAN_FALSE_VALUES = new Set(['0', 'false', 'no', 'n', 'off', '否', '假', '不是', 'нет']);

function clean(value, maximum = 2_000) {
  return String(value ?? '').replace(/\p{Cc}/gu, '').trim().slice(0, maximum);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function normalizedHttpUrl(value) {
  try {
    const url = new URL(clean(value, 3_000));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizedRichContent(value) {
  const source = clean(value, 60_000);
  if (!source) return '';
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    if (!Array.isArray(parsed.content) || !Number.isFinite(Number(parsed.version))) return '';
    // Supplier video/image URLs (1688/Taobao and similar) are not Ozon media
    // assets.  Ozon may accept the import task and then reject the whole card
    // asynchronously with video_RCE_is_not_downloaded/cover_unprocessed.  The
    // collection image contract also says that only generated images and
    // explicitly selected originals may leave the editor.  Keep Rich Content
    // text/layout widgets, but remove every media widget at the final command
    // boundary so old saved drafts are repaired without another AI run.
    const content = parsed.content.filter((widget) => {
      const name = clean(widget?.widgetName ?? widget?.widget_name ?? widget?.type, 200);
      return !RICH_CONTENT_MEDIA_WIDGET_PATTERN.test(name);
    });
    if (!content.length) return '';
    return JSON.stringify({ ...parsed, content });
  } catch {
    return '';
  }
}

function sanitizeSpecialAttributeValue(attributeId, value) {
  const id = String(attributeId || '');
  if (LISTING_URL_ATTRIBUTE_IDS.has(id)) return normalizedHttpUrl(value);
  if (id === RICH_CONTENT_ATTRIBUTE_ID) return normalizedRichContent(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return clean(value, 60_000);
}

export function sanitizeBuiltListingAttributeList(attributes = []) {
  const sanitized = (Array.isArray(attributes) ? attributes : []).flatMap((attribute) => {
    const id = positiveInteger(attribute?.id ?? attribute?.attributeId ?? attribute?.attribute_id);
    if (!id || !Array.isArray(attribute?.values)) return [];
    if (UNSUPPORTED_COLLECTION_VIDEO_ATTRIBUTE_IDS.has(String(id))) return [];
    const values = attribute.values.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = sanitizeSpecialAttributeValue(String(id), entry.value);
      if ((LISTING_URL_ATTRIBUTE_IDS.has(String(id)) || String(id) === RICH_CONTENT_ATTRIBUTE_ID) && !value) return [];
      const hasValue = Boolean(value);
      return [{ ...entry, ...(hasValue ? { value } : {}) }];
    });
    return values.length ? [{ ...attribute, id, values }] : [];
  });
  const ids = new Set(sanitized.map((attribute) => String(attribute.id)));
  return sanitized.filter((attribute) => {
    const id = String(attribute.id);
    if (PDF_DEPENDENT_ATTRIBUTE_IDS.has(id) && !ids.has('8790')) return false;
    if (VIDEO_DEPENDENT_ATTRIBUTE_IDS.has(id) && !ids.has('21841')) return false;
    return true;
  });
}

function booleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  return Boolean(normalized) && !['0', 'false', 'no', 'off', 'null', 'undefined'].includes(normalized);
}

export function normalizeListingAttributeValue(value = {}, fallbackSource = '') {
  const source = value && typeof value === 'object' ? value : { value };
  const sourceName = clean(source.source || fallbackSource, 80);
  const normalizedSourceName = ATTRIBUTE_VALUE_SOURCES.has(sourceName) || /^source-/u.test(sourceName)
    ? sourceName
    : '';
  const status = ['verified', 'mapped', 'inferred', 'unresolved'].includes(source.status)
    ? source.status
    : '';
  const confidence = source.confidence === '' || source.confidence === undefined || source.confidence === null
    ? null
    : Math.max(0, Math.min(1, Number(source.confidence) || 0));
  return {
    value: clean(source.value, 60_000),
    dictionaryValueId: clean(source.dictionaryValueId ?? source.dictionary_value_id, 80),
    values: (Array.isArray(source.values) ? source.values : []).map((item) => clean(item, 60_000)).filter(Boolean),
    dictionaryValueIds: (Array.isArray(source.dictionaryValueIds) ? source.dictionaryValueIds : [])
      .map((item) => clean(item, 80)).filter(Boolean),
    source: normalizedSourceName,
    status,
    confidence,
    evidence: (Array.isArray(source.evidence) ? source.evidence : []).slice(0, 20).map((item) => ({
      source: clean(item?.source, 80),
      path: clean(item?.path, 500),
      value: clean(item?.value, 500),
    })).filter((item) => item.source || item.path || item.value),
  };
}

export function normalizeListingAttributeValues(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  const normalized = Object.fromEntries(Object.entries(values).flatMap(([attributeId, value]) => {
    const id = clean(attributeId, 80);
    return id ? [[id, normalizeListingAttributeValue(value)]] : [];
  }));
  LISTING_URL_ATTRIBUTE_IDS.forEach((id) => {
    const row = normalized[id];
    if (!row) return;
    const urls = [...new Set([row.value, ...(row.values || [])].map(normalizedHttpUrl).filter(Boolean))];
    if (!urls.length) {
      delete normalized[id];
      return;
    }
    normalized[id] = { ...row, value: urls[0], values: [] };
  });
  if (normalized[RICH_CONTENT_ATTRIBUTE_ID]) {
    const value = normalizedRichContent(normalized[RICH_CONTENT_ATTRIBUTE_ID].value);
    if (value) normalized[RICH_CONTENT_ATTRIBUTE_ID].value = value;
    else delete normalized[RICH_CONTENT_ATTRIBUTE_ID];
  }
  UNSUPPORTED_COLLECTION_VIDEO_ATTRIBUTE_IDS.forEach((id) => delete normalized[id]);
  if (!normalized['8790']) PDF_DEPENDENT_ATTRIBUTE_IDS.forEach((id) => delete normalized[id]);
  if (!normalized['21841']) VIDEO_DEPENDENT_ATTRIBUTE_IDS.forEach((id) => delete normalized[id]);
  return normalized;
}

export function getListingAttributeComplexId(definition = {}) {
  return Math.max(0, Number(
    definition.complexId
      ?? definition.complex_id
      ?? definition.attributeComplexId
      ?? definition.attribute_complex_id
      ?? 0,
  ) || 0);
}

export function getListingAttributeMaxValueCount(definition = {}) {
  return positiveInteger(
    definition.maxValueCount
      ?? definition.max_value_count
      ?? definition.maxValuesCount
      ?? definition.max_values_count,
  );
}

export function isSkuScopedListingAttribute(definition = {}) {
  const attributeId = clean(
    definition.id ?? definition.attributeId ?? definition.attribute_id,
    80,
  );
  return KNOWN_OZON_SKU_ASPECT_ATTRIBUTE_IDS.has(attributeId) || booleanFlag(
    definition.isAspect
      ?? definition.is_aspect
      ?? definition.aspect
      ?? definition.skuScoped
      ?? definition.sku_scoped,
  );
}

export function isBooleanListingAttribute(definition = {}) {
  const valueType = clean(
    definition.valueType
      ?? definition.value_type
      ?? definition.attributeType
      ?? definition.attribute_type
      ?? definition.type,
    120,
  ).toLowerCase();
  return BOOLEAN_ATTRIBUTE_TYPE_PATTERN.test(valueType);
}

export function parseListingBooleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  const normalized = clean(value, 80).normalize('NFKC').toLocaleLowerCase();
  if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
  if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
  return null;
}

export function splitListingAttributeDefinitions(definitions = []) {
  const global = [];
  const sku = [];
  (Array.isArray(definitions) ? definitions : []).forEach((definition) => {
    (isSkuScopedListingAttribute(definition) ? sku : global).push(definition);
  });
  return { global, sku };
}

export function isListingAttributeValueFilled(value = {}) {
  const row = normalizeListingAttributeValue(value);
  return Boolean(
    row.value
      || row.dictionaryValueId
      || row.values.some(Boolean)
      || row.dictionaryValueIds.some(Boolean),
  );
}

function textValuesOf(row, definition) {
  const source = definition.isCollection
    ? (row.values.length ? row.values : String(row.value || '').split(/[,，、;；\n]/u))
    : [row.value];
  return source.map((value) => clean(value, 60_000)).filter(Boolean);
}

function dictionaryIdsOf(row, definition) {
  const source = definition.isCollection ? row.dictionaryValueIds : [row.dictionaryValueId];
  return source.map(positiveInteger).filter(Boolean);
}

export function buildListingAttribute(definition = {}, inputValue = {}) {
  const id = positiveInteger(definition.id ?? definition.attributeId ?? definition.attribute_id);
  if (!id) return null;
  const row = normalizeListingAttributeValue(inputValue);
  const textValues = textValuesOf(row, definition);
  const dictionaryIds = dictionaryIdsOf(row, definition);
  let values = definition.isDictionary
    ? dictionaryIds.map((dictionaryValueId, index) => ({
      dictionary_value_id: dictionaryValueId,
      ...(textValues[index] ? { value: textValues[index] } : {}),
    }))
    : isBooleanListingAttribute(definition)
      ? textValues.map(parseListingBooleanValue)
        .filter((value) => typeof value === 'boolean')
        .map((value) => ({ value: value ? 'true' : 'false' }))
      : textValues.map((value) => ({ value }));
  const maxValueCount = getListingAttributeMaxValueCount(definition);
  if (maxValueCount) values = values.slice(0, maxValueCount);
  if (!values.length) return null;
  return {
    complex_id: getListingAttributeComplexId(definition),
    id,
    values,
  };
}

export function buildListingAttributeList(values = {}, definitions = []) {
  return sanitizeBuiltListingAttributeList((Array.isArray(definitions) ? definitions : [])
    .map((definition) => buildListingAttribute(definition, values?.[String(definition.id)]))
    .filter(Boolean));
}

export function validateListingAttributeValues(values = {}, definitions = [], { label = '类目属性' } = {}) {
  const missing = [];
  const invalid = [];
  (Array.isArray(definitions) ? definitions : []).forEach((definition) => {
    const row = normalizeListingAttributeValue(values?.[String(definition.id)]);
    const displayName = clean(definition.name || definition.title || `属性 ${definition.id}`, 300);
    if (booleanFlag(definition.is_required ?? definition.isRequired) && !isListingAttributeValueFilled(row)) {
      missing.push(displayName);
      return;
    }
    if (!isListingAttributeValueFilled(row)) return;
    const sanitizedAttribute = sanitizeBuiltListingAttributeList([
      buildListingAttribute(definition, row),
    ].filter(Boolean));
    if (!sanitizedAttribute.length
      && (LISTING_URL_ATTRIBUTE_IDS.has(String(definition.id))
        || String(definition.id) === RICH_CONTENT_ATTRIBUTE_ID)) {
      if (booleanFlag(definition.is_required ?? definition.isRequired)) missing.push(displayName);
      return;
    }
    if (definition.isDictionary && dictionaryIdsOf(row, definition).length === 0) {
      invalid.push(`${displayName}必须从 Ozon 标准选项中选择`);
      return;
    }
    if (isBooleanListingAttribute(definition)
      && textValuesOf(row, definition).some((value) => parseListingBooleanValue(value) === null)) {
      invalid.push(`${displayName}必须填写“是”或“否”`);
      return;
    }
    const valueCount = definition.isDictionary
      ? dictionaryIdsOf(row, definition).length
      : textValuesOf(row, definition).length;
    const maxValueCount = getListingAttributeMaxValueCount(definition);
    if (maxValueCount && valueCount > maxValueCount) {
      invalid.push(`${displayName}最多填写 ${maxValueCount} 个值`);
    }
  });
  const errors = [];
  if (missing.length) errors.push(`${label}还有 ${missing.length} 个必填项没有填写。`);
  if (invalid.length) errors.push(`${label}：${invalid[0]}。`);
  return { ok: errors.length === 0, errors, missing, invalid };
}
