import { validateCollectedProduct } from './collectionProductValidation.js';
import {
  normalizeCollectionProductListingDraft,
  normalizeCollectionProductListingDrafts,
} from './collectionProductListingWorkflow.js';
import { normalizeCollectionProductPublication } from './collectionProductPublication.js';

const IMAGE_LIMITS = Object.freeze({ main: 60, sku: 800, detail: 300, all: 1200 });

const IMAGE_NOISE_PATTERN = /(?:^|[\W_])(?:logo|favicon|icon|iconfont|sprite|avatar|badge|qrcode|qr-code|toolbar|service|payment|pay-logo|shipping|delivery|guarantee|coupon|chat|loading|spinner|placeholder|transparent|blank|pixel|tracker|analytics)(?:[\W_]|$)/iu;
const TRACKING_QUERY_PATTERN = /^(?:spm|scm|trace_log|traceid|pvid|uuid|utm_.+|abbizdatatype|hotSaleSkuld|pageId|sortType)$/iu;

function text(value, maximum = 1200) {
  return String(value ?? '')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function numberOrEmpty(value, multiplier = 1) {
  if (value === null || value === undefined || value === '') return '';
  const direct = Number(value);
  if (!Number.isFinite(direct)) return '';
  return String(Number((direct * multiplier).toFixed(3)));
}

function positiveNumberOrEmpty(value, multiplier = 1) {
  const normalized = numberOrEmpty(value, multiplier);
  return Number(normalized) > 0 ? normalized : '';
}

function nonNegativeNumberOrEmpty(value, multiplier = 1) {
  const normalized = numberOrEmpty(value, multiplier);
  return Number(normalized) >= 0 ? normalized : '';
}

function numericValues(values) {
  const rows = Array.isArray(values) ? values.flat(Infinity) : [values];
  return rows.flatMap((value) => {
    if (value === null || value === undefined || value === '') return [];
    const raw = value && typeof value === 'object'
      ? value.price ?? value.value ?? value.amount ?? value.current ?? value.minPrice ?? value.maxPrice ?? value.priceText
      : value;
    if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? [raw] : [];
    return (String(raw ?? '').replace(/\s/gu, '').replace(/,/gu, '.').match(/\d+(?:\.\d+)?/gu) || [])
      .map(Number)
      .filter((number) => Number.isFinite(number) && number > 0);
  });
}

function normalizedPositiveRange(values) {
  const numbers = numericValues(values);
  return {
    minimum: numbers.length ? positiveNumberOrEmpty(Math.min(...numbers)) : '',
    maximum: numbers.length ? positiveNumberOrEmpty(Math.max(...numbers)) : '',
  };
}

const DIMENSION_AXES = Object.freeze(['lengthCm', 'widthCm', 'heightCm']);

const DIMENSION_ALIASES = Object.freeze({
  lengthCm: Object.freeze(['packageLengthCm', 'lengthCm', 'packageLengthMm', 'lengthMm', 'packageLengthM', 'lengthM', 'packageLength', 'length']),
  widthCm: Object.freeze(['packageWidthCm', 'widthCm', 'packageWidthMm', 'widthMm', 'packageWidthM', 'widthM', 'packageWidth', 'width']),
  heightCm: Object.freeze(['packageHeightCm', 'heightCm', 'packageHeightMm', 'heightMm', 'packageHeightM', 'heightM', 'packageHeight', 'height', 'depthCm', 'depthMm', 'depth']),
});

function isPresent(value) {
  return value !== null && value !== undefined && value !== '';
}

function dimensionMultiplier(key = '', unitHint = '') {
  if (/mm$/iu.test(key)) return 0.1;
  if (/cm$/iu.test(key)) return 1;
  if (/m$/iu.test(key)) return 100;
  const evidence = `${key} ${unitHint}`.toLowerCase();
  if (/(?:毫米|\bmm\b|mm$)/u.test(evidence)) return 0.1;
  if (/(?:厘米|\bcm\b|cm$)/u.test(evidence)) return 1;
  if (/(?:米|\bmet(?:er|re)s?\b|\bm\b|m$)/u.test(evidence)) return 100;
  return 1;
}

function dimensionNumber(value, key = '', unitHint = '') {
  const source = value && typeof value === 'object'
    ? value.value ?? value.amount ?? value.number ?? value.size ?? value.text
    : value;
  if (!isPresent(source)) return '';
  const match = String(source).replace(/,/gu, '.').match(/\d+(?:\.\d+)?/u);
  if (!match) return '';
  const inlineUnit = String(source).match(/(?:毫米|mm|厘米|cm|米|m)\b/iu)?.[0] || '';
  return positiveNumberOrEmpty(match[0], dimensionMultiplier(key, inlineUnit || unitHint));
}

function readDimensions(source = {}) {
  const object = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const unitHint = object.dimensionUnit || object.sizeUnit || object.packageUnit || object.packUnit || object.unit || '';
  return Object.fromEntries(DIMENSION_AXES.map((axis) => {
    for (const key of DIMENSION_ALIASES[axis]) {
      if (!isPresent(object[key])) continue;
      const value = dimensionNumber(object[key], key, unitHint);
      if (value) return [axis, value];
    }
    return [axis, ''];
  }));
}

function dimensionValue(dimensions = {}, axis) {
  const packageKey = `package${axis[0].toUpperCase()}${axis.slice(1)}`;
  return isPresent(dimensions[axis]) ? dimensions[axis] : dimensions[packageKey];
}

function hasAnyDimension(dimensions = {}) {
  return DIMENSION_AXES.some((axis) => Number(dimensionValue(dimensions, axis)) > 0);
}

function hasCompleteDimensions(dimensions = {}) {
  return DIMENSION_AXES.every((axis) => Number(dimensionValue(dimensions, axis)) > 0);
}

function dimensionsEqual(left = {}, right = {}) {
  if (!hasCompleteDimensions(left) || !hasCompleteDimensions(right)) return false;
  return DIMENSION_AXES.every((axis) => (
    Math.abs(Number(dimensionValue(left, axis)) - Number(dimensionValue(right, axis))) < 0.001
  ));
}

function mergeDimensions(primary = {}, fallback = {}) {
  return Object.fromEntries(DIMENSION_AXES.map((axis) => [axis, primary[axis] || fallback[axis] || '']));
}

function dimensionSnapshot(dimensions = {}) {
  return {
    lengthCm: positiveNumberOrEmpty(dimensionValue(dimensions, 'lengthCm')),
    widthCm: positiveNumberOrEmpty(dimensionValue(dimensions, 'widthCm')),
    heightCm: positiveNumberOrEmpty(dimensionValue(dimensions, 'heightCm')),
  };
}

function dimensionVolumeCm3(dimensions = {}) {
  if (!hasCompleteDimensions(dimensions)) return '';
  return positiveNumberOrEmpty(
    Number(dimensions.lengthCm) * Number(dimensions.widthCm) * Number(dimensions.heightCm)
  );
}

function reportedSkuVolumeCm3(option = {}, platformCode = '') {
  const direct = option?.volumeCm3 ?? option?.packageVolumeCm3 ?? option?.packingVolumeCm3;
  if (isPresent(direct)) return positiveNumberOrEmpty(direct);
  if (platformCode === '1688' && isPresent(option?.volume)) return positiveNumberOrEmpty(option.volume);
  return '';
}

function comparisonResult(left = {}, right = {}) {
  return hasCompleteDimensions(left) && hasCompleteDimensions(right)
    ? dimensionsEqual(left, right)
    : null;
}

function preservedFieldSource(evidence, axis, value, fallback) {
  const previousValue = evidence?.normalizedCm?.[axis];
  const previousSource = evidence?.fieldSources?.[axis];
  if (previousSource && Number(previousValue) > 0 && Math.abs(Number(previousValue) - Number(value)) < 0.001) {
    return previousSource;
  }
  return fallback;
}

function safeUrl(value) {
  try {
    const url = new URL(text(value, 2400));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|credential|session|auth)/iu.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return '';
  }
}

function canonicalSourceUrl(value) {
  const normalized = safeUrl(value);
  if (!normalized) return '';
  const url = new URL(normalized);
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_QUERY_PATTERN.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function isProductImageUrl(value) {
  const normalized = safeUrl(value);
  if (!normalized) return false;
  const url = new URL(normalized);
  const evidence = `${url.hostname}${decodeURIComponent(url.pathname)}`.toLowerCase();
  if (IMAGE_NOISE_PATTERN.test(evidence)) return false;
  if (/\.(?:svg|ico)(?:$|\?)/iu.test(url.pathname)) return false;
  return true;
}

function uniqueImageUrls(values, maximum) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => safeUrl(typeof value === 'object' ? value?.imageUrl || value?.url || value?.src : value))
    .filter((value) => value && isProductImageUrl(value)))]
    .slice(0, maximum);
}

function weightMultiplier(key = '', unitHint = '') {
  const evidence = `${key} ${unitHint}`.toLowerCase();
  if (/(?:毫克|\bmg\b|mg$)/u.test(evidence)) return 0.001;
  if (/(?:千克|公斤|\bkg\b|kg$)/u.test(evidence)) return 1000;
  if (/(?:市斤|斤|jin$)/u.test(evidence)) return 500;
  if (/(?:磅|\blbs?\b|pounds?)/u.test(evidence)) return 453.592;
  if (/(?:盎司|\boz\b|ounces?)/u.test(evidence)) return 28.3495;
  return 1;
}

function weightNumber(value, key = '', unitHint = '') {
  const source = value && typeof value === 'object'
    ? value.value ?? value.amount ?? value.number ?? value.weight ?? value.text
    : value;
  if (!isPresent(source)) return '';
  const match = String(source).replace(/,/gu, '.').match(/\d+(?:\.\d+)?/u);
  if (!match) return '';
  const inlineUnit = String(source).match(/(?:毫克|千克|公斤|市斤|盎司|mg|kg|jin|lbs?|oz|克|斤|磅|g)/iu)?.[0] || '';
  return positiveNumberOrEmpty(match[0], weightMultiplier(key, inlineUnit || unitHint));
}

function skuWeightG(value = {}, option = {}) {
  const unitHint = value.weightUnit || value.unit || option.weightUnit || option.unit || '';
  if (isPresent(value.weightG)) return weightNumber(value.weightG, 'weightG', unitHint);
  if (isPresent(value.weightKg)) return weightNumber(value.weightKg, 'weightKg', 'kg');
  if (isPresent(value.weight)) return weightNumber(value.weight, 'weight', unitHint);
  if (isPresent(option.weightG)) return weightNumber(option.weightG, 'weightG', unitHint);
  if (isPresent(option.weight)) return weightNumber(option.weight, 'weight', unitHint);
  if (isPresent(option.unitWeight)) return weightNumber(option.unitWeight, 'unitWeightKg', option.unitWeightUnit || 'kg');
  if (isPresent(option.weightKg)) return weightNumber(option.weightKg, 'weightKg', 'kg');
  return '';
}

function productWeightG(capture = {}) {
  const unitHint = capture.weightUnit || capture.unit || '';
  if (isPresent(capture.weightG)) return weightNumber(capture.weightG, 'weightG', unitHint);
  if (isPresent(capture.weightKg)) return weightNumber(capture.weightKg, 'weightKg', 'kg');
  if (isPresent(capture.weight)) return weightNumber(capture.weight, 'weight', unitHint);
  return '';
}

function skuWeightRange(skus = []) {
  const numbers = skus.map((sku) => Number(sku.weightG)).filter((value) => Number.isFinite(value) && value > 0);
  return {
    minimum: numbers.length ? positiveNumberOrEmpty(Math.min(...numbers)) : '',
    maximum: numbers.length ? positiveNumberOrEmpty(Math.max(...numbers)) : '',
    measuredSkuCount: numbers.length,
  };
}

function normalizedStatus(value, allowed, fallback = 'unknown') {
  const status = text(value, 40).toLowerCase();
  return allowed.includes(status) ? status : fallback;
}

function dimensionEvidence({ dimensions, structuredDimensions, optionDimensions, fieldSources, option, platformCode }) {
  const calculatedVolumeCm3 = dimensionVolumeCm3(dimensions);
  const reportedVolumeCm3 = reportedSkuVolumeCm3(option, platformCode);
  const volumeMatches = calculatedVolumeCm3 && reportedVolumeCm3
    ? Math.abs(Number(calculatedVolumeCm3) - Number(reportedVolumeCm3)) <= Math.max(0.001, Number(calculatedVolumeCm3) * 0.01)
    : null;
  const sources = [...new Set(Object.values(fieldSources).filter((source) => source !== 'missing'))];
  return {
    source: sources.length ? sources.join('+') : 'missing',
    inherited: Object.values(fieldSources).includes('product-inherited'),
    fieldSources: { ...fieldSources },
    normalizedCm: dimensionSnapshot(dimensions),
    structuredCm: dimensionSnapshot(structuredDimensions),
    sourceOptionCm: dimensionSnapshot(optionDimensions),
    matchesSourceOption: comparisonResult(dimensions, optionDimensions),
    reportedVolumeCm3,
    calculatedVolumeCm3,
    volumeMatches,
  };
}

function normalizedSkuAttributes(value = {}) {
  const rows = Array.isArray(value.attributes)
    ? value.attributes
    : text(value.variant || value.name, 500).split(/\s*[/|]\s*/u).filter(Boolean);
  return rows.flatMap((item) => {
    if (item && typeof item === 'object') {
      const name = text(item.name ?? item.title ?? item.key ?? item.label ?? item.property, 180);
      const rawValue = item.value ?? item.values ?? item.valueText ?? item.value_text ?? item.text;
      const normalizedValue = Array.isArray(rawValue)
        ? rawValue.map((entry) => text(entry, 240)).filter(Boolean).join('、')
        : text(rawValue, 500);
      return name && normalizedValue ? [{ name, value: normalizedValue }] : [];
    }
    const normalizedValue = text(item, 500);
    return normalizedValue ? [{ name: '规格', value: normalizedValue }] : [];
  }).slice(0, 30);
}

function skuAttributeSummary(attributes = []) {
  return (Array.isArray(attributes) ? attributes : []).map((item) => (
    item && typeof item === 'object'
      ? [text(item.name, 120), text(item.value, 240)].filter(Boolean).join(': ')
      : text(item, 240)
  )).filter(Boolean).join(' / ');
}

function normalizeSku(value = {}, index = 0, { platformCode = '' } = {}) {
  const attributes = normalizedSkuAttributes(value);
  const imageUrl = safeUrl(value.imageUrl || value.image);
  const option = value.option && typeof value.option === 'object' ? { ...value.option } : {};
  const structuredDimensions = readDimensions(value);
  const optionDimensions = readDimensions(option);
  const dimensions = mergeDimensions(structuredDimensions, optionDimensions);
  const fieldSources = Object.fromEntries(DIMENSION_AXES.map((axis) => [
    axis,
    preservedFieldSource(
      value.packageDimensionEvidence,
      axis,
      dimensions[axis],
      structuredDimensions[axis] ? 'sku-structured' : optionDimensions[axis] ? 'sku-option' : 'missing'
    ),
  ]));
  return {
    id: text(value.id || value.skuId || value.offerId || `sku-${index + 1}`, 260),
    name: text(value.name || value.variant || skuAttributeSummary(attributes), 500),
    attributes,
    price: numberOrEmpty(value.price ?? value.purchasePrice),
    imageUrl: isProductImageUrl(imageUrl) ? imageUrl : '',
    enabled: value.enabled !== false,
    weightG: skuWeightG(value, option),
    packageLengthCm: dimensions.lengthCm,
    packageWidthCm: dimensions.widthCm,
    packageHeightCm: dimensions.heightCm,
    option: Object.keys(option).length ? option : null,
    packageDimensionEvidence: dimensionEvidence({
      dimensions,
      structuredDimensions,
      optionDimensions,
      fieldSources,
      option,
      platformCode,
    }),
  };
}

function skuDimensionConsensus(skus = []) {
  if (!skus.length || skus.some((sku) => !hasCompleteDimensions(sku))) return null;
  const first = dimensionSnapshot(skus[0]);
  return skus.every((sku) => dimensionsEqual(first, sku)) ? first : null;
}

function inheritProductDimensions(sku, productDimensions, platformCode) {
  if (!hasAnyDimension(productDimensions)) return sku;
  const ownDimensions = dimensionSnapshot(sku);
  const dimensions = mergeDimensions(ownDimensions, productDimensions);
  const inherited = DIMENSION_AXES.some((axis) => !ownDimensions[axis] && productDimensions[axis]);
  if (!inherited) return sku;
  const currentEvidence = sku.packageDimensionEvidence || {};
  const fieldSources = Object.fromEntries(DIMENSION_AXES.map((axis) => [
    axis,
    ownDimensions[axis] ? currentEvidence.fieldSources?.[axis] || 'sku-structured' : productDimensions[axis] ? 'product-inherited' : 'missing',
  ]));
  return {
    ...sku,
    packageLengthCm: dimensions.lengthCm,
    packageWidthCm: dimensions.widthCm,
    packageHeightCm: dimensions.heightCm,
    packageDimensionEvidence: dimensionEvidence({
      dimensions,
      structuredDimensions: currentEvidence.structuredCm || {},
      optionDimensions: currentEvidence.sourceOptionCm || {},
      fieldSources,
      option: sku.option || {},
      platformCode,
    }),
  };
}

function productDimensionEvidence(dimensions, fieldSources, skus) {
  const completeSkuCount = skus.filter(hasCompleteDimensions).length;
  const matchingSkuCount = hasCompleteDimensions(dimensions)
    ? skus.filter((sku) => dimensionsEqual(dimensions, sku)).length
    : 0;
  const sources = [...new Set(Object.values(fieldSources).filter((source) => source !== 'missing'))];
  return {
    source: sources.length ? sources.join('+') : 'missing',
    inherited: false,
    fieldSources: { ...fieldSources },
    normalizedCm: dimensionSnapshot(dimensions),
    calculatedVolumeCm3: dimensionVolumeCm3(dimensions),
    skuComparison: {
      totalSkuCount: skus.length,
      completeSkuCount,
      matchingSkuCount,
      differentSkuCount: hasCompleteDimensions(dimensions) ? completeSkuCount - matchingSkuCount : 0,
      missingSkuCount: skus.length - completeSkuCount,
      allMatch: Boolean(skus.length && completeSkuCount === skus.length && matchingSkuCount === skus.length),
    },
  };
}

function normalizeEditorSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    textModelId: text(source.textModelId || 'auto', 260),
    imageModelId: text(source.imageModelId || 'auto', 260),
    imageSize: text(source.imageSize || '1008x1344', 40),
    imageQuality: text(source.imageQuality || 'high', 40),
  };
}

function normalizeSkuImages(values, skus) {
  const rows = [];
  const add = (value, index = 0) => {
    const source = value && typeof value === 'object' ? value : { imageUrl: value };
    const imageUrl = safeUrl(source.imageUrl || source.image || source.url || source.src);
    if (!imageUrl || !isProductImageUrl(imageUrl)) return;
    const matchingSku = skus.find((sku) => sku.id === text(source.skuId || source.id, 260)) || skus[index] || null;
    const row = {
      skuId: text(source.skuId || source.id || matchingSku?.id, 260),
      skuName: text(source.skuName || source.name || source.variant || matchingSku?.name, 500),
      imageUrl,
    };
    const key = `${row.skuId}|${row.skuName}|${row.imageUrl}`;
    if (!rows.some((item) => `${item.skuId}|${item.skuName}|${item.imageUrl}` === key)) rows.push(row);
  };
  (Array.isArray(values) ? values : []).forEach(add);
  skus.forEach((sku, index) => {
    if (sku.imageUrl) add({ skuId: sku.id, skuName: sku.name, imageUrl: sku.imageUrl }, index);
  });
  return rows.slice(0, IMAGE_LIMITS.sku);
}

function normalizeAttributes(values) {
  const rows = [];
  for (const value of Array.isArray(values) ? values : []) {
    const source = value && typeof value === 'object' ? value : {};
    const name = text(source.name || source.key || source.label || source.property, 240);
    const rawValue = Array.isArray(source.value || source.values)
      ? (source.value || source.values).join(' / ')
      : source.value || source.values || source.text;
    const attributeValue = text(rawValue, 1200);
    if (!name || !attributeValue) continue;
    const key = `${name}|${attributeValue}`;
    if (!rows.some((item) => `${item.name}|${item.value}` === key)) rows.push({ name, value: attributeValue });
    if (rows.length >= 200) break;
  }
  return rows;
}

export function platformCodeFromCapture(value) {
  const platform = text(value, 80).toLowerCase();
  if (platform === '1688' || platform.includes('阿里巴巴')) return '1688';
  if (platform.includes('拼多多') || platform === 'pdd' || platform === 'pinduoduo') return 'pdd';
  if (platform.includes('淘宝') || platform === 'taobao') return 'taobao';
  if (platform.includes('天猫') || platform === 'tmall') return 'tmall';
  if (platform.includes('ozon')) return 'ozon-buyer';
  if (platform.includes('京东') || platform === 'jd') return 'jd';
  if (platform.includes('wildberries')) return 'wildberries';
  if (platform.includes('amazon')) return 'amazon';
  if (platform.includes('temu')) return 'temu';
  if (platform.includes('aliexpress') || platform.includes('ali express')) return 'aliexpress';
  return 'supplier';
}

function defaultCurrencyForPlatform(platformCode = '') {
  if (['1688', 'pdd', 'taobao', 'tmall', 'jd'].includes(platformCode)) return 'CNY';
  if (['ozon-buyer', 'wildberries'].includes(platformCode)) return 'RUB';
  // Amazon/Temu/AliExpress can localize prices per country.  Do not silently
  // turn an unknown foreign price into RMB; that would corrupt SKU profit.
  return 'UNKNOWN';
}

export function normalizeCollectedProduct(capture = {}) {
  const sourceUrl = canonicalSourceUrl(capture.sourceUrl || capture.pageUrl);
  const platformCode = platformCodeFromCapture(capture.platformCode || capture.platform);
  const attributes = normalizeAttributes(capture.attributes);
  const normalizedSkus = (Array.isArray(capture.skus) ? capture.skus : [])
    .map((sku, index) => normalizeSku(sku, index, { platformCode }))
    .filter((item) => item.id || item.name || item.price || item.imageUrl);
  const explicitProductDimensions = readDimensions(capture);
  const consensusDimensions = skuDimensionConsensus(normalizedSkus) || {};
  const productDimensions = mergeDimensions(explicitProductDimensions, consensusDimensions);
  const productDimensionFieldSources = Object.fromEntries(DIMENSION_AXES.map((axis) => [
    axis,
    preservedFieldSource(
      capture.packageDimensionEvidence,
      axis,
      productDimensions[axis],
      explicitProductDimensions[axis] ? 'product-structured' : consensusDimensions[axis] ? 'sku-consensus' : 'missing'
    ),
  ]));
  const skus = normalizedSkus.map((sku) => inheritProductDimensions(sku, productDimensions, platformCode));
  const priceRange = normalizedPositiveRange([
    capture.purchasePriceMin,
    capture.purchasePriceMax,
    capture.purchasePrice ?? capture.amount,
    skus.map((sku) => sku.price),
  ]);
  const explicitWeightG = productWeightG(capture);
  const skuWeights = skuWeightRange(skus);
  const weightRange = normalizedPositiveRange([
    capture.weightMinG,
    capture.weightMaxG,
    explicitWeightG,
    skus.map((sku) => sku.weightG),
  ]);
  const consensusWeightG = skuWeights.minimum && skuWeights.minimum === skuWeights.maximum
    ? skuWeights.minimum
    : '';
  const weightG = explicitWeightG || consensusWeightG;
  const categoryAttribute = attributes.find((item) => /^(?:产品类别|商品类别|产品分类|商品分类|品类|类别)$/iu.test(item.name));
  const sourceCategoryName = text(
    capture.sourceCategoryName || capture.category || categoryAttribute?.value,
    800
  );
  const sourceCategoryPath = text(capture.sourceCategoryPath || sourceCategoryName, 1200);
  let shippingStatus = normalizedStatus(
    capture.shippingStatus,
    ['free', 'fixed', 'starting', 'destination', 'unknown']
  );
  let shippingFeeMin = nonNegativeNumberOrEmpty(capture.shippingFeeMin);
  let shippingFeeMax = nonNegativeNumberOrEmpty(capture.shippingFeeMax);
  if (shippingStatus === 'free') {
    shippingFeeMin = '0';
    shippingFeeMax = '0';
  } else if (shippingStatus === 'unknown' && (shippingFeeMin || shippingFeeMax)) {
    shippingStatus = shippingFeeMin === shippingFeeMax && shippingFeeMin ? 'fixed' : 'destination';
  }
  const mixedBatchStatus = typeof capture.mixedBatchAllowed === 'boolean'
    ? (capture.mixedBatchAllowed ? 'yes' : 'no')
    : normalizedStatus(capture.mixedBatchStatus, ['yes', 'no', 'unknown']);
  const legacyImages = Array.isArray(capture.images) ? capture.images : [];
  const mainImages = uniqueImageUrls([
    ...(Array.isArray(capture.mainImages) && capture.mainImages.length ? capture.mainImages : legacyImages),
    capture.imageUrl,
    capture.primaryImage,
  ], IMAGE_LIMITS.main);
  const skuImages = normalizeSkuImages(capture.skuImages, skus);
  const occupiedImages = new Set([...mainImages, ...skuImages.map((item) => item.imageUrl)]);
  const detailImages = uniqueImageUrls(capture.detailImages, IMAGE_LIMITS.detail)
    .filter((url) => !occupiedImages.has(url));
  const images = uniqueImageUrls([
    ...mainImages,
    ...skuImages.map((item) => item.imageUrl),
    ...detailImages,
  ], IMAGE_LIMITS.all);
  const sourceProductId = text(capture.sourceProductId, 260);
  const product = {
    id: `${platformCode}:${sourceProductId || sourceUrl || Date.now()}`,
    platform: text(capture.platform || capture.platformCode || 'unknown', 80),
    platformCode,
    pageType: text(capture.pageType || 'unknown', 80),
    sourceUrl,
    sourceProductId,
    title: text(capture.productTitle || capture.title || capture.pageTitle, 1200),
    description: text(capture.description, 8000),
    attributes,
    variant: text(capture.variant, 500),
    purchasePrice: priceRange.minimum,
    purchasePriceMin: priceRange.minimum,
    purchasePriceMax: priceRange.maximum,
    priceRangeEvidence: {
      source: skus.some((sku) => Number(sku.price) > 0) ? 'sku-range' : priceRange.minimum ? 'product-range' : 'missing',
      pricedSkuCount: skus.filter((sku) => Number(sku.price) > 0).length,
      totalSkuCount: skus.length,
    },
    currency: text(capture.currency || defaultCurrencyForPlatform(platformCode), 12).toUpperCase(),
    brand: text(capture.brand, 300),
    category: sourceCategoryName,
    sourceCategoryId: text(capture.sourceCategoryId, 260),
    sourceCategoryName,
    sourceCategoryPath,
    weightG,
    weightMinG: weightRange.minimum,
    weightMaxG: weightRange.maximum,
    weightEvidence: {
      source: explicitWeightG ? 'product-structured' : consensusWeightG ? 'sku-consensus' : weightRange.minimum ? 'sku-range' : 'missing',
      measuredSkuCount: skuWeights.measuredSkuCount,
      totalSkuCount: skus.length,
      allMeasuredSkusMatch: Boolean(skuWeights.measuredSkuCount && skuWeights.minimum === skuWeights.maximum),
      normalizedUnit: 'g',
    },
    packageLengthCm: productDimensions.lengthCm,
    packageWidthCm: productDimensions.widthCm,
    packageHeightCm: productDimensions.heightCm,
    packageDimensionEvidence: productDimensionEvidence(productDimensions, productDimensionFieldSources, skus),
    shippingStatus,
    shippingFeeMin,
    shippingFeeMax,
    shippingCurrency: text(
      capture.shippingCurrency || capture.currency || defaultCurrencyForPlatform(platformCode),
      12,
    ).toUpperCase(),
    shippingRuleText: text(capture.shippingRuleText, 500),
    minimumOrderQuantity: positiveNumberOrEmpty(capture.minimumOrderQuantity),
    minimumOrderUnit: text(capture.minimumOrderUnit, 40),
    mixedBatchStatus,
    perSkuMinimumQuantity: positiveNumberOrEmpty(capture.perSkuMinimumQuantity),
    purchaseMultiple: positiveNumberOrEmpty(capture.purchaseMultiple),
    deliveryLeadTimeHours: positiveNumberOrEmpty(capture.deliveryLeadTimeHours),
    deliveryText: text(capture.deliveryText, 300),
    mainImages,
    skuImages,
    detailImages,
    images,
    videoUrl: safeUrl(capture.videoUrl),
    skus,
    capturedAt: text(capture.capturedAt || new Date().toISOString(), 80),
    captureStatus: text(capture.captureStatus, 40),
    sourceMethod: text(capture.sourceMethod, 80),
    rejectionReasons: Array.isArray(capture.rejectionReasons)
      ? capture.rejectionReasons.map((value) => text(value, 180)).filter(Boolean).slice(0, 20)
      : [],
    fieldConfidence: capture.fieldConfidence && typeof capture.fieldConfidence === 'object'
      ? { ...capture.fieldConfidence }
      : {},
    editorSettings: normalizeEditorSettings(capture.editorSettings),
    ozonListingDraft: normalizeCollectionProductListingDraft(capture.ozonListingDraft, capture),
    ozonListingDrafts: normalizeCollectionProductListingDrafts(capture.ozonListingDrafts, capture),
    ozonPublication: normalizeCollectionProductPublication(capture.ozonPublication),
  };
  return { ...product, completeness: validateCollectedProduct(product) };
}
