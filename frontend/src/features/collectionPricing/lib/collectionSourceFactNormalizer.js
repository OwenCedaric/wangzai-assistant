const MAX_FACT_NAME_LENGTH = 240;
const MAX_FACT_VALUE_LENGTH = 2_000;

function clean(value, maximum = MAX_FACT_VALUE_LENGTH) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

export function normalizeCollectionFactText(value) {
  return clean(value, 600)
    .toLocaleLowerCase()
    .replace(/[\u200b\u200c\u200d]/gu, '')
    .replace(/[^\p{L}\p{N}%+.-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function scalarValue(value) {
  if (Array.isArray(value)) return value.map((item) => clean(item, 500)).filter(Boolean).join('、');
  if (value && typeof value === 'object') {
    return clean(value.value ?? value.text ?? value.label ?? value.name ?? value.amount, MAX_FACT_VALUE_LENGTH);
  }
  return clean(value, MAX_FACT_VALUE_LENGTH);
}

function fact({
  name,
  value,
  source,
  path,
  scope = 'global',
  sourceSkuId = '',
  confidence = 1,
  kind = 'attribute',
  unit = '',
} = {}) {
  const normalizedName = clean(name, MAX_FACT_NAME_LENGTH);
  const normalizedValue = scalarValue(value);
  if (!normalizedName || !normalizedValue) return null;
  return {
    id: [scope, sourceSkuId, path || normalizedName, normalizedValue].map(normalizeCollectionFactText).join('::'),
    name: normalizedName,
    normalizedName: normalizeCollectionFactText(normalizedName),
    value: normalizedValue,
    normalizedValue: normalizeCollectionFactText(normalizedValue),
    source: clean(source, 80) || 'source-attribute',
    path: clean(path, 500),
    scope: scope === 'sku' ? 'sku' : 'global',
    sourceSkuId: clean(sourceSkuId, 160),
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    kind,
    unit: clean(unit, 80),
  };
}

function sourceAttributeFacts(attributes = [], context = {}) {
  return (Array.isArray(attributes) ? attributes : []).flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const name = item.name ?? item.title ?? item.key ?? item.label ?? item.property;
    const value = item.value ?? item.values ?? item.valueText ?? item.value_text ?? item.text ?? item.nameValue;
    const row = fact({
      ...context,
      name,
      value,
      source: context.scope === 'sku' ? 'source-sku-attribute' : 'source-attribute',
      path: `${context.scope === 'sku' ? 'sku.attributes' : 'product.attributes'}[${index}]`,
      confidence: 1,
    });
    return row ? [row] : [];
  });
}

const DIRECT_PRODUCT_FIELDS = Object.freeze([
  ['品牌', ['brand']],
  ['型号', ['model', 'variant']],
  ['颜色', ['color', 'colour']],
  ['材质', ['material']],
  ['原产国', ['countryOfOrigin', 'originCountry']],
  ['适用性别', ['gender']],
  ['适用对象', ['audience', 'ageGroup']],
  ['尺码', ['size']],
  ['包装数量', ['packageQuantity']],
  ['商品重量', ['productWeightG', 'netWeightG']],
  ['包装重量', ['packageWeightG', 'grossWeightG', 'weightG']],
  ['包装长度', ['packageLengthCm']],
  ['包装宽度', ['packageWidthCm']],
  ['包装高度', ['packageHeightCm']],
  ['最小起订量', ['minimumOrderQuantity']],
]);

const DIRECT_SKU_FIELDS = Object.freeze([
  ['型号', ['model', 'skuCode', 'offerId']],
  ['颜色', ['color', 'colour']],
  ['材质', ['material']],
  ['尺码', ['size', 'specification']],
  ['商品重量', ['productWeightG', 'netWeightG']],
  ['包装重量', ['packageWeightG', 'grossWeightG', 'weightG']],
  ['包装长度', ['packageLengthCm']],
  ['包装宽度', ['packageWidthCm']],
  ['包装高度', ['packageHeightCm']],
]);

function firstPresent(source = {}, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== null && value !== undefined && value !== '') return { key, value };
  }
  return null;
}

function directFacts(source = {}, definitions = [], context = {}) {
  return definitions.flatMap(([name, keys]) => {
    const selected = firstPresent(source, keys);
    if (!selected) return [];
    const unit = /(?:重量|weight)/iu.test(name) ? 'g' : /(?:长度|宽度|高度)/u.test(name) ? 'cm' : '';
    const row = fact({
      ...context,
      name,
      value: selected.value,
      source: context.scope === 'sku' ? 'source-sku-field' : 'source-field',
      path: `${context.scope === 'sku' ? 'sku' : 'product'}.${selected.key}`,
      confidence: 1,
      unit,
    });
    return row ? [row] : [];
  });
}

function structuredDescriptionFacts(description = '') {
  const source = clean(description, 8_000);
  if (!source) return [];
  const rows = [];
  const pattern = /(?:^|[\n;；。])\s*([^\n:：;；。]{1,40})\s*[:：]\s*([^\n;；。]{1,240})/gu;
  let match;
  while ((match = pattern.exec(source)) && rows.length < 40) {
    const row = fact({
      name: match[1],
      value: match[2],
      source: 'source-description-structured',
      path: `product.description.segment[${rows.length}]`,
      confidence: 0.82,
    });
    if (row) rows.push(row);
  }
  return rows;
}

function contextFacts(product = {}) {
  return [
    fact({ name: '商品标题', value: product.title ?? product.name, source: 'source-title-context', path: 'product.title', confidence: 0.62, kind: 'context' }),
    fact({ name: '来源类目', value: product.sourceCategoryPath ?? product.categoryPath ?? product.sourceCategoryName ?? product.category, source: 'source-category-context', path: 'product.sourceCategoryPath', confidence: 0.78, kind: 'context' }),
    fact({ name: '商品描述', value: product.description, source: 'source-description-context', path: 'product.description', confidence: 0.5, kind: 'context' }),
  ].filter(Boolean);
}

const SKU_QUANTITY_ATTRIBUTE_NAME_PATTERN = /(?:数量|件数|个数|支数|套数|包装|规格|quantity|count|package|pack)/iu;
const SKU_QUANTITY_VALUE_PATTERN = /(?:^|[^\p{N}])([1-9]\d{0,5})\s*(?:个|件|只|支|套|枚|片|双|包|盒|组|pcs?|pieces?|packs?|шт)(?=$|[^\p{L}])/giu;

function explicitSkuQuantity(value) {
  const source = clean(value, 1_000);
  if (!source) return '';
  const values = new Set();
  let match;
  SKU_QUANTITY_VALUE_PATTERN.lastIndex = 0;
  while ((match = SKU_QUANTITY_VALUE_PATTERN.exec(source)) && values.size < 2) {
    values.add(String(Number(match[1])));
  }
  return values.size === 1 ? [...values][0] : '';
}

function skuQuantityFact(sourceSku = {}, context = {}) {
  const attributes = Array.isArray(sourceSku.attributes) ? sourceSku.attributes : [];
  const candidates = [
    ...attributes.filter((item) => SKU_QUANTITY_ATTRIBUTE_NAME_PATTERN.test(clean(
      item?.name ?? item?.title ?? item?.key ?? item?.label ?? item?.property,
      MAX_FACT_NAME_LENGTH,
    ))).map((item, index) => ({
      value: item?.value ?? item?.values ?? item?.valueText ?? item?.value_text ?? item?.text ?? item?.nameValue,
      path: `sku.attributes[${index}]`,
    })),
    { value: sourceSku.name ?? sourceSku.variant, path: 'sku.name' },
  ];
  for (const candidate of candidates) {
    const value = explicitSkuQuantity(scalarValue(candidate.value));
    if (!value) continue;
    return fact({
      ...context,
      name: '数量',
      value,
      source: 'source-sku-explicit-quantity',
      path: candidate.path,
      confidence: 0.99,
    });
  }
  return null;
}

const TITLE_VALUE_RULES = Object.freeze([
  ['适用性别', [
    [/(?:男女|男士|男性|男款|\bmen\b|\bmale\b|мужск)/iu, '男'],
    [/(?:男女|女士|女性|女款|\bwomen\b|\bfemale\b|женск)/iu, '女'],
  ]],
  ['适用对象', [
    [/(?:成人|成年人|\badult\b|взросл)/iu, '成人'],
    [/(?:儿童|婴儿|宝宝|孩子|\bchild\b|\bkids?\b|детск)/iu, '儿童'],
  ]],
  ['颜色', [
    [/(?:黑色|\bblack\b|черн)/iu, '黑色'],
    [/(?:白色|\bwhite\b|бел)/iu, '白色'],
    [/(?:红色|\bred\b|красн)/iu, '红色'],
    [/(?:蓝色|\bblue\b|син)/iu, '蓝色'],
    [/(?:绿色|\bgreen\b|зел[её]н)/iu, '绿色'],
    [/(?:粉色|\bpink\b|розов)/iu, '粉色'],
    [/(?:紫色|\bpurple\b|фиолет)/iu, '紫色'],
    [/(?:灰色|\bgr[ae]y\b|сер)/iu, '灰色'],
    [/(?:棕色|茶色|\bbrown\b|корич)/iu, '棕色'],
    [/(?:金色|\bgold(?:en)?\b|золот)/iu, '金色'],
    [/(?:银色|\bsilver\b|серебр)/iu, '银色'],
  ]],
  ['材质', [
    [/(?:不锈钢|stainless steel|нержавеющ)/iu, '不锈钢'],
    [/(?:铝合金|aluminium alloy|aluminum alloy|алюминиев)/iu, '铝合金'],
    [/(?:硅胶|silicone|силикон)/iu, '硅胶'],
    [/(?:纯棉|cotton|хлопок)/iu, '棉'],
    [/(?:聚酯纤维|polyester|полиэстер)/iu, '聚酯纤维'],
  ]],
  ['季节', [
    [/(?:春季|夏季|春夏|spring|summer|весна|лето)/iu, '春夏'],
    [/(?:秋季|冬季|秋冬|autumn|winter|осень|зима)/iu, '秋冬'],
  ]],
  ['形状', [
    [/(?:方形|方框|square|квадрат)/iu, '方形'],
    [/(?:圆形|圆框|round|кругл)/iu, '圆形'],
  ]],
  ['功能', [
    [/(?:防蓝光|blue\s*block|синего света)/iu, '防蓝光'],
    [/(?:感光变色|光致变色|photochrom|фотохром)/iu, '变色'],
  ]],
]);

function explicitTitleFacts(product = {}) {
  const title = clean(product.title ?? product.name, 2_000);
  if (!title) return [];
  return TITLE_VALUE_RULES.flatMap(([name, rules]) => {
    const values = rules.flatMap(([pattern, value]) => (pattern.test(title) ? [value] : []));
    const row = fact({
      name,
      value: [...new Set(values)].join('、'),
      source: 'source-title-explicit',
      path: 'product.title',
      confidence: 0.94,
    });
    return row ? [row] : [];
  });
}

function uniqueFacts(rows = []) {
  const result = new Map();
  rows.forEach((row) => {
    if (!row?.normalizedName || !row?.normalizedValue) return;
    const key = `${row.scope}:${row.sourceSkuId}:${row.normalizedName}:${row.normalizedValue}`;
    const previous = result.get(key);
    if (!previous || row.confidence > previous.confidence) result.set(key, row);
  });
  return [...result.values()];
}

export function findCollectionSourceSku(product = {}, draftSku = {}, index = 0) {
  const rows = Array.isArray(product.skus) ? product.skus : [];
  const sourceSkuId = clean(draftSku?.sourceSkuId ?? draftSku?.id, 160);
  return rows.find((item) => clean(item?.id ?? item?.skuId ?? item?.name, 160) === sourceSkuId)
    || rows[index]
    || {};
}

export function normalizeCollectionProductFacts(product = {}) {
  return uniqueFacts([
    ...sourceAttributeFacts(product.attributes, { scope: 'global' }),
    ...directFacts(product, DIRECT_PRODUCT_FIELDS, { scope: 'global' }),
    ...structuredDescriptionFacts(product.description),
    ...explicitTitleFacts(product),
    ...contextFacts(product),
  ]);
}

export function normalizeCollectionSkuFacts(product = {}, sourceSku = {}, index = 0) {
  const sourceSkuId = clean(sourceSku.id ?? sourceSku.skuId ?? sourceSku.name ?? `sku-${index + 1}`, 160);
  const skuContext = { scope: 'sku', sourceSkuId };
  const nameFact = fact({
    ...skuContext,
    name: '规格',
    value: sourceSku.name ?? sourceSku.variant,
    source: 'source-sku-name',
    path: 'sku.name',
    confidence: 0.94,
  });
  const quantityFact = skuQuantityFact(sourceSku, skuContext);
  return uniqueFacts([
    ...sourceAttributeFacts(sourceSku.attributes, skuContext),
    ...directFacts(sourceSku, DIRECT_SKU_FIELDS, skuContext),
    ...(quantityFact ? [quantityFact] : []),
    ...(nameFact ? [nameFact] : []),
  ]);
}

export function buildCollectionSourceFactIndex(product = {}, draftSkus = []) {
  const productFacts = normalizeCollectionProductFacts(product);
  const skuFactsById = new Map();
  (Array.isArray(draftSkus) ? draftSkus : []).forEach((draftSku, index) => {
    const sourceSku = findCollectionSourceSku(product, draftSku, index);
    const sourceSkuId = clean(draftSku?.sourceSkuId ?? sourceSku?.id ?? sourceSku?.name ?? `sku-${index + 1}`, 160);
    skuFactsById.set(sourceSkuId, normalizeCollectionSkuFacts(product, { ...sourceSku, id: sourceSkuId }, index));
  });
  return { productFacts, skuFactsById };
}
